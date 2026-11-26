import { createSiteFetcher, extractContent } from "@openseo/crawler";
import { buildBrief, CURATED_MODELS, MODEL_CATALOG, scoreContent, type ContentBrief, type FailedPage, type PageInput, type WriterMode } from "@openseo/shared";
import { and, eq, inArray } from "drizzle-orm";
import { dataDb, schema } from "../db";
import { errorMessage, getYep, withUpstreamRetry } from "../lib/yep";
import { mapLimit } from "../lib/pool";
import type { NetOptions } from "./indexing";

type Brief = typeof schema.contentBriefs.$inferSelect;

/** Per page, and few pages at once: ten slow sites finish in well under a minute. */
const PAGE_TIMEOUT_MS = 15_000;
const PAGE_CONCURRENCY = 4;

export async function failBrief(briefId: string, message: string) {
  await dataDb
    .update(schema.contentBriefs)
    .set({ status: "failed", error: message, finishedAt: new Date() })
    .where(and(eq(schema.contentBriefs.id, briefId), inArray(schema.contentBriefs.status, ["queued", "running"])));
}

/**
 * Reads every competitor page through the crawler's guarded fetcher and saves the brief. A page
 * that cannot be fetched or has no readable text is listed as failed; the brief fails only when
 * none could be read. `net` lets tests reach a local server.
 */
export async function processBrief(briefId: string, net: NetOptions = {}) {
  const [row] = await dataDb.select().from(schema.contentBriefs).where(eq(schema.contentBriefs.id, briefId)).limit(1);
  if (!row || row.status !== "queued") return;
  const now = new Date();
  const [claimed] = await dataDb
    .update(schema.contentBriefs)
    .set({ status: "running", startedAt: now, heartbeatAt: now })
    .where(and(eq(schema.contentBriefs.id, briefId), eq(schema.contentBriefs.status, "queued")))
    .returning({ id: schema.contentBriefs.id });
  if (!claimed) return;

  const fetcher = createSiteFetcher({ ...net, timeoutMs: PAGE_TIMEOUT_MS });
  try {
    const pages: PageInput[] = [];
    const failed: FailedPage[] = [];
    await mapLimit(row.urls, PAGE_CONCURRENCY, async (url, index) => {
      const position = row.source === "serp" ? index + 1 : null;
      const order = index;
      try {
        const res = await fetcher.page(url);
        if (!res.html) {
          failed.push({ url, position, order, error: res.error ?? `HTTP ${res.status}` });
        } else {
          const content = extractContent(res.html);
          if (content.wordCount === 0) failed.push({ url, position, order, error: "No readable text; the page may need JavaScript to show it" });
          else pages.push({ url, position, order, ...content });
        }
      } catch (error) {
        failed.push({ url, position, order, error: errorMessage(error) });
      }
      await dataDb.update(schema.contentBriefs).set({ heartbeatAt: new Date() }).where(eq(schema.contentBriefs.id, briefId));
    });
    const brief = buildBrief(row.keyword, pages, failed, row.serpQuestions);
    await dataDb
      .update(schema.contentBriefs)
      .set({
        status: pages.length ? "completed" : "failed",
        brief,
        error: pages.length ? null : "None of the pages could be read",
        finishedAt: new Date(),
      })
      .where(and(eq(schema.contentBriefs.id, briefId), eq(schema.contentBriefs.status, "running")));
  } catch (error) {
    await failBrief(briefId, errorMessage(error));
  } finally {
    fetcher.close();
  }
}

/** The score a draft is saved with: the same function the editor shows while typing. */
export function scoreDraft(brief: Pick<Brief, "keyword" | "brief">, draft: { title: string; body: string }) {
  return scoreContent({ keyword: brief.keyword, title: draft.title, body: draft.body, brief: brief.brief });
}

// ── AI writer ───────────────────────────────────────────────────────────────

export const WRITER_MODELS = CURATED_MODELS.map((m) => m.id);

/** How long one writer call may take. Keep it under the app's proxyTimeout and any proxy in front. */
export const WRITER_TIMEOUT_MS = 150_000;

/** Output tokens allowed: enough for the top of the brief's length range, about 1.4 tokens a word. */
function maxTokensFor(brief: ContentBrief | null, mode: WriterMode): number {
  if (mode === "outline") return 1500;
  const words = brief?.wordCount?.max ?? 1500;
  return Math.min(8000, Math.max(1500, Math.ceil(words * 1.4) + 300));
}

export function writerPrompt(keyword: string, brief: ContentBrief | null, mode: WriterMode) {
  const lines = [`Target keyword: ${keyword}`];
  if (brief?.wordCount) lines.push(`Length: ${brief.wordCount.min} to ${brief.wordCount.max} words (competitors' median is ${brief.wordCount.median}).`);
  if (brief?.headings.length) lines.push(`Subtopics competitors cover (pages using each):\n${brief.headings.slice(0, 20).map((h) => `- ${h.text} (${h.pages})`).join("\n")}`);
  if (brief?.terms.length) lines.push(`Terms to use naturally, with how often competitors use them:\n${brief.terms.map((t) => `- ${t.term}: ${t.min === t.max ? t.min : `${t.min}-${t.max}`}`).join("\n")}`);
  if (brief?.questions.length) {
    // Every Google question (the brief keeps up to 10), then the most shared heading questions.
    const asked = brief.questions.filter((q) => q.google);
    const headed = brief.questions.filter((q) => !q.google).slice(0, Math.max(5, 16 - asked.length));
    lines.push(`Questions to answer:\n${[...asked, ...headed].map((q) => `- ${q.text}`).join("\n")}`);
  }
  lines.push(
    mode === "outline"
      ? "Write a detailed outline: one # title with the keyword, ## sections and ### subsections, each with one or two short bullet notes on what to cover."
      : "Write the full article. Start with one # title that contains the keyword, mention the keyword in the first paragraph, then use ## sections and ### subsections. Short sentences, plain words, no filler.",
  );
  return [
    {
      role: "system" as const,
      content:
        "You are an experienced SEO content writer. Write original, accurate, helpful content for people, not search engines. Reply with Markdown only: no preamble, no closing remarks, no code fences around the answer. Do not invent statistics, quotes or sources.",
    },
    { role: "user" as const, content: lines.join("\n\n") },
  ];
}

/**
 * Price of one writer call. Token-priced: YepAPI charges at least $0.01 and gives no upper price,
 * so `upTo` is this catalog's list price for the prompt plus the full output allowance.
 */
export function estimateWriter(keyword: string, brief: ContentBrief | null, mode: WriterMode, model: string) {
  const messages = writerPrompt(keyword, brief, mode);
  const inputTokens = Math.ceil(messages.reduce((n, m) => n + m.content.length, 0) / 4);
  const outputTokens = maxTokensFor(brief, mode);
  const listed = MODEL_CATALOG.find((m) => m.id === model);
  const upTo =
    listed?.inputPerM != null && listed.outputPerM != null
      ? Math.max(0.01, Math.ceil(((inputTokens * listed.inputPerM + outputTokens * listed.outputPerM) / 1e6) * 100) / 100)
      : null;
  return { min: 0.01, max: null, upTo, formula: `Token-priced: $0.01 minimum; up to ${outputTokens} output tokens on ${model}` };
}

/** Writes a draft or an outline from the brief with one chat call, and saves it as a new draft. */
export async function writeDraft(userId: string, brief: Brief, mode: WriterMode, model: string) {
  const yep = await getYep({ userId, projectId: brief.projectId, feature: "content_writer" });
  // A long draft can take minutes to generate, and the request waits for it: one attempt, with a
  // timeout under the app's /api proxy timeout (apps/app/next.config.ts). An upstream timeout is not
  // billed, so the user can simply try again.
  const res = await withUpstreamRetry(
    () => yep.ai.chat({ model, messages: writerPrompt(brief.keyword, brief.brief, mode), maxTokens: maxTokensFor(brief.brief, mode), temperature: 0.6 }, { timeoutMs: WRITER_TIMEOUT_MS }),
    0,
  );
  const content = typeof res.data.message.content === "string" ? res.data.message.content : "";
  const body = content.replace(/^\s*```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/, "$1").trim();
  const title = /^#\s+(.+)$/m.exec(body)?.[1]?.trim() ?? brief.keyword;
  const score = scoreDraft(brief, { title, body });
  const [draft] = await dataDb
    .insert(schema.contentDrafts)
    .values({ projectId: brief.projectId, briefId: brief.id, title, body, score: score.score, wordCount: score.wordCount, aiModel: model, aiCostUsd: res.costUsd })
    .returning();
  return { draft: draft!, costUsd: res.costUsd };
}
