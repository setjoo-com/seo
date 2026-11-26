import { BRIEF_MAX_URLS, cleanText, cleanUrl, DEFAULT_WRITER_MODEL, peopleAlsoAsk, zKeyword } from "@openseo/shared";
import { and, desc, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { dataDb, schema } from "../db";
import { dispatch } from "../jobs/dispatch";
import { requireProject, requireUser } from "../lib/context";
import { AppError, conflict, notFound, parse, uuidParam } from "../lib/errors";
import { runLookup } from "../services/run-lookup";
import { estimateWriter, failBrief, scoreDraft, WRITER_MODELS, writeDraft } from "../services/content";

/** A plain http(s) address, for hosts cleanUrl does not take (an IP address, a port). */
function httpUrl(value: string): string | null {
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
}

// Only the form is checked here. Whether an address may be fetched is the SSRF guard's call when
// the page is read; a refused page is listed in the brief as failed.
const pageUrl = z
  .string()
  .max(2000)
  .transform((value, ctx) => {
    const text = cleanText(value);
    const otherScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) && !/^https?:\/\//i.test(text);
    const url = otherScheme ? null : (cleanUrl(text) ?? httpUrl(text));
    if (!url) ctx.addIssue({ code: "custom", message: `"${value}" is not a web address. Enter a full address like https://example.com/page.` });
    return url ?? z.NEVER;
  });

const briefInput = z.discriminatedUnion("source", [
  z.object({ source: z.literal("urls"), keyword: zKeyword(), urls: z.array(pageUrl).min(1).max(BRIEF_MAX_URLS) }),
  z.object({ source: z.literal("serp"), keyword: zKeyword() }),
]);

const draftInput = z.object({ title: z.string().max(300).default(""), body: z.string().max(200_000).default("") });

const writerInput = z.object({
  mode: z.enum(["draft", "outline"]).default("draft"),
  model: z
    .string()
    .default(DEFAULT_WRITER_MODEL)
    .refine((m) => WRITER_MODELS.includes(m), { message: `Pick one of: ${WRITER_MODELS.join(", ")}` }),
});

// A ceiling that does not parse must be refused, not read as "no ceiling".
const costQuery = z.object({ dryRun: z.string().optional().transform((v) => v === "1"), maxCostUsd: z.coerce.number().positive().finite().optional() });

const spentNote = (costUsd: number) =>
  costUsd > 0
    ? `The Google search cost $${costUsd.toFixed(2)}; it is recorded on a failed brief, and the same search within the hour is free.`
    : "Nothing was spent.";

type P = { Params: { projectId: string }; Querystring: Record<string, string | undefined> };
type BriefParams = { Params: { projectId: string; briefId: string }; Querystring: Record<string, string | undefined> };
type DraftParams = { Params: { projectId: string; draftId: string } };

async function requireBrief(projectId: string, briefId: string) {
  const [brief] = await dataDb
    .select()
    .from(schema.contentBriefs)
    .where(and(eq(schema.contentBriefs.projectId, projectId), eq(schema.contentBriefs.id, uuidParam(briefId, "Brief"))))
    .limit(1);
  if (!brief) throw notFound("Brief");
  return brief;
}

async function requireDraft(projectId: string, draftId: string) {
  const [draft] = await dataDb
    .select()
    .from(schema.contentDrafts)
    .where(and(eq(schema.contentDrafts.projectId, projectId), eq(schema.contentDrafts.id, uuidParam(draftId, "Draft"))))
    .limit(1);
  if (!draft) throw notFound("Draft");
  return draft;
}

const draftSummary = {
  id: schema.contentDrafts.id,
  title: schema.contentDrafts.title,
  score: schema.contentDrafts.score,
  wordCount: schema.contentDrafts.wordCount,
  aiModel: schema.contentDrafts.aiModel,
  updatedAt: schema.contentDrafts.updatedAt,
};

export async function contentRoutes(app: FastifyInstance) {
  app.get<P>("/projects/:projectId/content/briefs", async (request) => {
    const user = await requireUser(request);
    const project = await requireProject(user.id, request.params.projectId);
    const [briefs, drafts] = await Promise.all([
      dataDb
        .select({
          id: schema.contentBriefs.id,
          keyword: schema.contentBriefs.keyword,
          source: schema.contentBriefs.source,
          status: schema.contentBriefs.status,
          pages: sql<number>`cardinality(${schema.contentBriefs.urls})`,
          wordCount: sql<{ min: number; max: number; median: number } | null>`${schema.contentBriefs.brief}->'wordCount'`,
          costUsd: schema.contentBriefs.costUsd,
          error: schema.contentBriefs.error,
          createdAt: schema.contentBriefs.createdAt,
        })
        .from(schema.contentBriefs)
        .where(eq(schema.contentBriefs.projectId, project.id))
        .orderBy(desc(schema.contentBriefs.createdAt))
        .limit(500),
      dataDb
        .select({ briefId: schema.contentDrafts.briefId, drafts: sql<number>`count(*)::int`, bestScore: sql<number>`max(${schema.contentDrafts.score})::int` })
        .from(schema.contentDrafts)
        .where(eq(schema.contentDrafts.projectId, project.id))
        .groupBy(schema.contentDrafts.briefId),
    ]);
    const byBrief = new Map(drafts.map((d) => [d.briefId, d]));
    return { ok: true, data: briefs.map((b) => ({ ...b, drafts: byBrief.get(b.id)?.drafts ?? 0, bestScore: byBrief.get(b.id)?.bestScore ?? null })) };
  });

  /**
   * Starts a brief; the pages are read in the background (job "content.brief"). Pasted URLs are
   * free. source "serp" first runs the paid `serp` lookup for Google's top 10, through the same
   * runner, cache, budget and usage log as every other lookup.
   *   ?dryRun=1        the price only
   *   ?maxCostUsd=0.5  refuse if the worst-case price is higher
   */
  app.post<P>("/projects/:projectId/content/briefs", async (request, reply) => {
    const user = await requireUser(request);
    const project = await requireProject(user.id, request.params.projectId);
    const query = parse(costQuery, { dryRun: request.query.dryRun || undefined, maxCostUsd: request.query.maxCostUsd || undefined });
    const input = parse(briefInput, request.body);

    let urls: string[];
    let serpQuestions: string[] = [];
    let costUsd = 0;
    let estimate: { min: number; max: number | null; formula?: string } = { min: 0, max: 0 };
    if (input.source === "urls") {
      if (query.dryRun) return { ok: true, data: { estimate, dryRun: true } };
      urls = [...new Set(input.urls)];
    } else {
      const lookup = await runLookup(user.id, project, "serp", { query: input.keyword, depth: 10 }, { dryRun: query.dryRun, maxCostUsd: query.maxCostUsd });
      if ("dryRun" in lookup) return { ok: true, data: { estimate: lookup.estimate, dryRun: true } };
      estimate = lookup.estimate;
      costUsd = lookup.costUsd;
      // Read defensively: the lookup is already paid, so a surprising shape must not end in a 500.
      const data = lookup.data as { results?: unknown } | null;
      const results = (Array.isArray(data?.results) ? data.results : []) as { type?: string; url?: unknown; data?: unknown }[];
      const organic = results.filter((r) => r?.type === "organic" && typeof r.url === "string" && r.url).map((r) => r.url as string);
      urls = [...new Set(organic)].slice(0, BRIEF_MAX_URLS);
      serpQuestions = peopleAlsoAsk(results);
    }

    // Once the search is paid, every outcome is saved as a brief, so its cost stays on record.
    const values = { projectId: project.id, keyword: input.keyword, source: input.source, urls, serpQuestions, costUsd };
    if (!urls.length) {
      const error = `Google shows no organic results for "${input.keyword}" in ${project.locationName}`;
      await dataDb.insert(schema.contentBriefs).values({ ...values, status: "failed", error, finishedAt: new Date() });
      throw new AppError(404, "no_results", `${error}. ${spentNote(costUsd)}`);
    }
    const [brief] = await dataDb.insert(schema.contentBriefs).values(values).returning();
    try {
      await dispatch("content.brief", { briefId: brief!.id }, (message) => failBrief(brief!.id, message));
    } catch (error) {
      // dispatch says nothing was spent, which is not so once the search was paid.
      if (costUsd > 0 && error instanceof AppError) throw new AppError(error.status, error.code, `The background queue is unavailable. ${spentNote(costUsd)}`);
      throw error;
    }
    return reply.status(202).send({ ok: true, data: { ...brief, estimate } });
  });

  app.get<BriefParams>("/projects/:projectId/content/briefs/:briefId", async (request) => {
    const user = await requireUser(request);
    const project = await requireProject(user.id, request.params.projectId);
    const brief = await requireBrief(project.id, request.params.briefId);
    const drafts = await dataDb
      .select(draftSummary)
      .from(schema.contentDrafts)
      .where(eq(schema.contentDrafts.briefId, brief.id))
      .orderBy(desc(schema.contentDrafts.updatedAt));
    return { ok: true, data: { ...brief, drafts } };
  });

  // Its drafts go with it.
  app.delete<BriefParams>("/projects/:projectId/content/briefs/:briefId", async (request) => {
    const user = await requireUser(request);
    const project = await requireProject(user.id, request.params.projectId);
    const brief = await requireBrief(project.id, request.params.briefId);
    await dataDb.delete(schema.contentBriefs).where(eq(schema.contentBriefs.id, brief.id));
    return { ok: true };
  });

  app.post<BriefParams>("/projects/:projectId/content/briefs/:briefId/drafts", async (request) => {
    const user = await requireUser(request);
    const project = await requireProject(user.id, request.params.projectId);
    const brief = await requireBrief(project.id, request.params.briefId);
    const input = parse(draftInput, request.body ?? {});
    const score = scoreDraft(brief, input);
    const [draft] = await dataDb
      .insert(schema.contentDrafts)
      .values({ projectId: project.id, briefId: brief.id, ...input, score: score.score, wordCount: score.wordCount })
      .returning();
    return { ok: true, data: { ...draft, scoreDetail: score } };
  });

  /**
   * The AI writer: one chat call (token-priced, $0.01 minimum) writes a draft or an outline from
   * the brief and saves it as a new draft. ?dryRun=1 for the price; ?maxCostUsd refuses a call
   * whose list-price allowance is higher.
   */
  app.post<BriefParams>("/projects/:projectId/content/briefs/:briefId/write", async (request) => {
    const user = await requireUser(request);
    const project = await requireProject(user.id, request.params.projectId);
    const query = parse(costQuery, { dryRun: request.query.dryRun || undefined, maxCostUsd: request.query.maxCostUsd || undefined });
    const brief = await requireBrief(project.id, request.params.briefId);
    const input = parse(writerInput, request.body ?? {});
    const estimate = estimateWriter(brief.keyword, brief.brief, input.mode, input.model);
    if (query.dryRun) return { ok: true, data: { estimate, dryRun: true } };
    if (brief.status !== "completed") throw conflict("The brief is not ready yet");
    const worst = estimate.upTo ?? estimate.min;
    if (query.maxCostUsd != null && worst > query.maxCostUsd) {
      throw new AppError(400, "cost_ceiling_exceeded", `This could cost up to $${worst.toFixed(2)}, above the $${query.maxCostUsd.toFixed(2)} ceiling.`, { estimate });
    }
    const written = await writeDraft(user.id, brief, input.mode, input.model);
    return { ok: true, data: { ...written, estimate } };
  });

  app.get<DraftParams>("/projects/:projectId/content/drafts/:draftId", async (request) => {
    const user = await requireUser(request);
    const project = await requireProject(user.id, request.params.projectId);
    const draft = await requireDraft(project.id, request.params.draftId);
    const brief = await requireBrief(project.id, draft.briefId);
    return { ok: true, data: { ...draft, brief: { id: brief.id, keyword: brief.keyword, status: brief.status, brief: brief.brief } } };
  });

  app.put<DraftParams>("/projects/:projectId/content/drafts/:draftId", async (request) => {
    const user = await requireUser(request);
    const project = await requireProject(user.id, request.params.projectId);
    const draft = await requireDraft(project.id, request.params.draftId);
    const brief = await requireBrief(project.id, draft.briefId);
    const input = parse(draftInput, request.body ?? {});
    const score = scoreDraft(brief, input);
    const [updated] = await dataDb
      .update(schema.contentDrafts)
      .set({ ...input, score: score.score, wordCount: score.wordCount })
      .where(eq(schema.contentDrafts.id, draft.id))
      .returning();
    return { ok: true, data: { ...updated, scoreDetail: score } };
  });

  app.delete<DraftParams>("/projects/:projectId/content/drafts/:draftId", async (request) => {
    const user = await requireUser(request);
    const project = await requireProject(user.id, request.params.projectId);
    const draft = await requireDraft(project.id, request.params.draftId);
    await dataDb.delete(schema.contentDrafts).where(eq(schema.contentDrafts.id, draft.id));
    return { ok: true };
  });
}
