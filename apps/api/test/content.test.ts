import http from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, schema } from "../src/db";
import { processBrief } from "../src/services/content";
import { readyUser, signUp } from "./client";
import { harness } from "./harness";

/** Three competitor articles, one 404 and one that is not HTML, served locally. */
let server: http.Server;
let base = "";

const article = (title: string, sections: string[], words: number) =>
  `<!doctype html><html><head><title>${title}</title></head><body><nav><a href="/">Home</a> Shop Blog</nav><main><h1>${title}</h1>` +
  `<p>Winter boots need waterproof leather and good grip on ice. ${Array.from({ length: words }, (_, i) => `${title[0]}filler${i}`).join(" ")}</p>` +
  sections.map((s) => `<h2>${s}</h2><p>Insulation and waterproof leather matter for winter boots.</p>`).join("") +
  `</main><footer>Copyright</footer></body></html>`;

const pages: Record<string, (res: http.ServerResponse) => void> = {
  "/a": (res) => res.end(article("Best winter boots", ["How to choose winter boots?", "Waterproofing"], 400)),
  "/b": (res) => res.end(article("Winter boots guide", ["Waterproofing", "Sizing"], 600)),
  "/c": (res) => res.end(article("Our winter boots picks", ["How to choose winter boots?", "Waterproofing", "Care"], 800)),
  "/data.json": (res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  },
};

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const handler = pages[new URL(req.url ?? "/", "http://x").pathname];
    if (!handler) {
      res.writeHead(404, { "content-type": "text/html" });
      return res.end("<html><body>Not found</body></html>");
    }
    if (!res.headersSent) res.setHeader("content-type", "text/html; charset=utf-8");
    handler(res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

// The SSRF guard refuses loopback addresses; tests open it for the fixture's port only.
const net = () => ({ allowPrivateNetwork: true, allowedPorts: [Number(new URL(base).port)] });

async function usageRows(userId: string, feature: string) {
  let rows: (typeof schema.usageLog.$inferSelect)[] = [];
  for (let i = 0; i < 50 && rows.length === 0; i++) {
    rows = await db.select().from(schema.usageLog).where(eq(schema.usageLog.userId, userId));
    rows = rows.filter((r) => r.feature === feature);
    if (!rows.length) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return rows;
}

describe("content briefs from pasted URLs", () => {
  let user: Awaited<ReturnType<typeof readyUser>>;
  let briefId: string;

  beforeAll(async () => {
    user = await readyUser();
    harness.enqueued.length = 0;
    const urls = [`${base}/a`, `${base}/missing`, `${base}/b`, `${base}/data.json`, `${base}/c`];
    const before = harness.fake.requests.length;
    const created = await user.api.post(`/projects/${user.project.id}/content/briefs`, { source: "urls", keyword: "Winter Boots", urls });
    expect(created.status).toBe(202);
    expect(created.body.data).toMatchObject({ status: "queued", keyword: "winter boots", source: "urls", urls, costUsd: 0, estimate: { min: 0, max: 0 } });
    expect(harness.fake.requests.length).toBe(before);
    briefId = created.body.data.id;
    expect(harness.enqueued).toEqual([{ name: "content.brief", data: { briefId } }]);
    await processBrief(briefId, net());
  });

  it("reads the pages, records failures and builds the brief", async () => {
    const brief = await user.api.ok("GET", `/projects/${user.project.id}/content/briefs/${briefId}`);
    expect(brief).toMatchObject({ status: "completed", error: null, drafts: [] });
    const { competitors, wordCount, headings, terms, questions } = brief.brief;
    // In the order pasted, failed pages in their place.
    expect(competitors.map((c: { url: string; ok: boolean }) => [c.url.replace(base, ""), c.ok])).toEqual([
      ["/a", true],
      ["/missing", false],
      ["/b", true],
      ["/data.json", false],
      ["/c", true],
    ]);
    expect(competitors[1].error).toBe("HTTP 404");
    expect(competitors[3].error).toMatch(/^Not an HTML page/);
    // The navigation and footer are not content.
    expect(competitors[0].wordCount).toBeGreaterThan(400);
    expect(competitors[0].wordCount).toBeLessThan(440);
    expect(competitors[0].headings[0]).toEqual({ level: 1, text: "Best winter boots" });
    expect(wordCount.median).toBe(competitors[2].wordCount);
    expect(headings[0]).toMatchObject({ text: "Waterproofing", pages: 3 });
    expect(terms.find((t: { term: string }) => t.term === "waterproof leather")).toMatchObject({ pages: 3 });
    expect(terms.some((t: { term: string }) => t.term === "home" || t.term === "copyright")).toBe(false);
    expect(questions).toEqual([{ text: "How to choose winter boots?", pages: 2, google: false }]);
    // Each h2 is followed by a paragraph starting "Insulation": no phrase runs across the two blocks.
    expect(terms.some((t: { term: string }) => t.term === "waterproofing insulation")).toBe(false);
    expect(terms.find((t: { term: string }) => t.term === "waterproofing")).toMatchObject({ pages: 3 });

    const list = await user.api.ok("GET", `/projects/${user.project.id}/content/briefs`);
    expect(list).toEqual([expect.objectContaining({ id: briefId, status: "completed", pages: 5, drafts: 0, bestScore: null, wordCount })]);
  });

  it("refuses private addresses without the test's network override", async () => {
    const created = await user.api.ok("POST", `/projects/${user.project.id}/content/briefs`, { source: "urls", keyword: "boots", urls: [`${base}/a`] });
    await processBrief(created.id);
    const brief = await user.api.ok("GET", `/projects/${user.project.id}/content/briefs/${created.id}`);
    expect(brief).toMatchObject({ status: "failed", error: "None of the pages could be read" });
    expect(brief.brief.competitors[0]).toMatchObject({ ok: false });
    expect(brief.brief.competitors[0].error).toMatch(/not allowed|not publicly routable/);
  });

  it("validates the input", async () => {
    const path = `/projects/${user.project.id}/content/briefs`;
    expect((await user.api.post(path, { source: "urls", keyword: "boots", urls: [] })).status).toBe(400);
    expect((await user.api.post(path, { source: "urls", keyword: "boots", urls: Array.from({ length: 11 }, (_, i) => `https://e${i}.com/`) })).status).toBe(400);
    expect((await user.api.post(path, { source: "urls", keyword: "boots", urls: ["ftp://example.com/x"] })).status).toBe(400);
    expect((await user.api.post(path, { source: "nope", keyword: "boots" })).status).toBe(400);
  });

  it("saves drafts with the shared score, and keeps them to the project", async () => {
    const created = await user.api.ok("POST", `/projects/${user.project.id}/content/briefs/${briefId}/drafts`, { title: "Winter boots", body: "" });
    // Keyword in the title, which stands in for the H1: 20 of 100.
    expect(created.score).toBe(20);
    expect(created.scoreDetail.checks.find((c: { id: string }) => c.id === "keyword-title")).toMatchObject({ status: "pass" });

    const body = `# Winter boots: how to choose\n\nWinter boots need waterproof leather, insulation and grip.\n\n## Waterproofing\n\n${"Waterproof leather keeps feet dry and warm. ".repeat(40)}\n\n## How to choose winter boots?\n\n${"Check the grip and the insulation in the shop. ".repeat(40)}`;
    const saved = await user.api.ok("PUT", `/projects/${user.project.id}/content/drafts/${created.id}`, { title: "Winter boots buying guide", body });
    expect(saved.score).toBeGreaterThan(50);
    expect(saved.score).toBe(saved.scoreDetail.score);
    expect(saved.wordCount).toBe(saved.scoreDetail.wordCount);

    // A title-only update keeps the text, and the score follows the merged draft.
    const retitled = await user.api.ok("PUT", `/projects/${user.project.id}/content/drafts/${created.id}`, { title: "Boots" });
    expect(retitled).toMatchObject({ title: "Boots", body, wordCount: saved.wordCount });
    expect(retitled.score).toBeLessThan(saved.score);
    const bodyOnly = await user.api.ok("PUT", `/projects/${user.project.id}/content/drafts/${created.id}`, { body: "Short." });
    expect(bodyOnly).toMatchObject({ title: "Boots", body: "Short." });
    await user.api.ok("PUT", `/projects/${user.project.id}/content/drafts/${created.id}`, { title: "Winter boots buying guide", body });

    const opened = await user.api.ok("GET", `/projects/${user.project.id}/content/drafts/${created.id}`);
    expect(opened).toMatchObject({ title: "Winter boots buying guide", body, score: saved.score, brief: { id: briefId, keyword: "winter boots" } });
    const list = await user.api.ok("GET", `/projects/${user.project.id}/content/briefs`);
    expect(list.find((b: { id: string }) => b.id === briefId)).toMatchObject({ drafts: 1, bestScore: saved.score });

    // Another user sees none of it.
    const other = await readyUser();
    expect((await other.api.get(`/projects/${user.project.id}/content/briefs`)).status).toBe(404);
    expect((await other.api.get(`/projects/${user.project.id}/content/briefs/${briefId}`)).status).toBe(404);
    expect((await other.api.get(`/projects/${other.project.id}/content/briefs/${briefId}`)).status).toBe(404);
    expect((await other.api.get(`/projects/${other.project.id}/content/drafts/${created.id}`)).status).toBe(404);
    expect((await other.api.put(`/projects/${other.project.id}/content/drafts/${created.id}`, { title: "x", body: "y" })).status).toBe(404);
    expect((await other.api.post(`/projects/${other.project.id}/content/briefs/${briefId}/write`, {})).status).toBe(404);
    expect((await other.api.delete(`/projects/${other.project.id}/content/briefs/${briefId}`)).status).toBe(404);
    expect((await user.api.get(`/projects/${user.project.id}/content/drafts/not-a-uuid`)).status).toBe(404);

    await user.api.ok("DELETE", `/projects/${user.project.id}/content/drafts/${created.id}`);
    expect((await user.api.get(`/projects/${user.project.id}/content/drafts/${created.id}`)).status).toBe(404);
  });

  it("writes a draft with the AI writer, charged through YepAPI and logged", async () => {
    const path = `/projects/${user.project.id}/content/briefs/${briefId}/write`;
    const dry = await user.api.ok("POST", `${path}?dryRun=1`, { mode: "draft" });
    expect(dry).toMatchObject({ dryRun: true, estimate: { min: 0.01, max: null } });
    expect(dry.estimate.upTo).toBeGreaterThan(0.01);
    expect((await user.api.post(path, { model: "made/up-model" })).status).toBe(400);
    expect((await user.api.post(`${path}?maxCostUsd=0.001`, {})).body.error?.code).toBe("cost_ceiling_exceeded");

    const before = harness.fake.requests.length;
    const written = await user.api.ok("POST", path, { mode: "draft", model: "anthropic/claude-sonnet-5" });
    expect(written.costUsd).toBeCloseTo(0.034, 5);
    expect(written.draft).toMatchObject({ title: "A guide to winter boots", aiModel: "anthropic/claude-sonnet-5", aiCostUsd: 0.034, briefId });
    expect(written.draft.body).toContain("## Getting started");
    expect(written.draft.score).toBeGreaterThan(0);
    const calls = harness.fake.requests.slice(before).filter((r) => r.path === "/v1/ai/chat");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toMatchObject({ model: "anthropic/claude-sonnet-5" });
    expect(calls[0]!.body.messages[1].content).toContain("waterproof leather");
    const rows = await usageRows(user.userId, "content_writer");
    expect(rows).toEqual([expect.objectContaining({ endpoint: "/v1/ai/chat", costUsd: 0.034, projectId: user.project.id, ok: true })]);
  });

  it("deletes a brief with its drafts", async () => {
    const created = await user.api.ok("POST", `/projects/${user.project.id}/content/briefs/${briefId}/drafts`, { title: "x" });
    await user.api.ok("DELETE", `/projects/${user.project.id}/content/briefs/${briefId}`);
    expect((await user.api.get(`/projects/${user.project.id}/content/briefs/${briefId}`)).status).toBe(404);
    expect((await user.api.get(`/projects/${user.project.id}/content/drafts/${created.id}`)).status).toBe(404);
  });
});

describe("content briefs from Google's top 10", () => {
  it("refuses without a YepAPI key, before spending or queueing anything", async () => {
    const { api } = await signUp();
    const project = await api.ok("POST", "/projects", { name: "No key", domain: "nokey.com" });
    const before = harness.fake.requests.length;
    harness.enqueued.length = 0;
    const res = await api.post(`/projects/${project.id}/content/briefs`, { source: "serp", keyword: "winter boots" });
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe("yepapi_key_missing");
    expect(harness.fake.requests.length).toBe(before);
    expect(harness.enqueued).toEqual([]);
    // The writer refuses the same way.
    const brief = await api.ok("POST", `/projects/${project.id}/content/briefs`, { source: "urls", keyword: "boots", urls: [`${base}/a`] });
    await processBrief(brief.id, net());
    const write = await api.post(`/projects/${project.id}/content/briefs/${brief.id}/write`, {});
    expect(write.body.error?.code).toBe("yepapi_key_missing");
  });

  it("prices the lookup, then runs it once and queues the top results", async () => {
    const user = await readyUser();
    const path = `/projects/${user.project.id}/content/briefs`;
    const dry = await user.api.ok("POST", `${path}?dryRun=1`, { source: "serp", keyword: "winter boots" });
    expect(dry).toEqual({ dryRun: true, estimate: expect.objectContaining({ min: 0.01, max: 0.01 }) });
    expect((await user.api.post(`${path}?maxCostUsd=0.001`, { source: "serp", keyword: "winter boots" })).body.error?.code).toBe("cost_ceiling_exceeded");

    const before = harness.fake.requests.length;
    harness.enqueued.length = 0;
    const created = await user.api.ok("POST", path, { source: "serp", keyword: "winter boots" });
    const serpCalls = harness.fake.requests.slice(before).filter((r) => r.path === "/v1/serp/google");
    expect(serpCalls).toHaveLength(1);
    expect(serpCalls[0]!.body).toMatchObject({ query: "winter boots", depth: 10 });
    expect(created).toMatchObject({ source: "serp", status: "queued", costUsd: 0.01, serpQuestions: ["What is winter boots?"] });
    expect(created.urls.length).toBeGreaterThan(5);
    expect(created.urls.length).toBeLessThanOrEqual(10);
    expect(created.urls.every((u: string) => u.startsWith("https://"))).toBe(true);
    expect(harness.enqueued).toEqual([{ name: "content.brief", data: { briefId: created.id } }]);
    expect(await usageRows(user.userId, "serp")).toEqual([expect.objectContaining({ endpoint: "/v1/serp/google", projectId: user.project.id })]);

    // The same search again within the hour is served from the cache, free.
    const again = await user.api.ok("POST", path, { source: "serp", keyword: "winter boots" });
    expect(again).toMatchObject({ costUsd: 0, urls: created.urls });
  });

  it("records a paid search that finds nothing, and says what it cost", async () => {
    const user = await readyUser();
    const res = await user.api.post(`/projects/${user.project.id}/content/briefs`, { source: "serp", keyword: "no organic results here" });
    expect(res.status).toBe(404);
    expect(res.body.error?.code).toBe("no_results");
    expect(res.body.error?.message).toContain("The Google search cost $0.01");
    const [brief] = await user.api.ok("GET", `/projects/${user.project.id}/content/briefs`);
    expect(brief).toMatchObject({ status: "failed", costUsd: 0.01, pages: 0 });
  });

  it("says what a paid search cost when the queue is down", async () => {
    const user = await readyUser();
    harness.queueDown = true;
    try {
      const res = await user.api.post(`/projects/${user.project.id}/content/briefs`, { source: "serp", keyword: "queue down boots" });
      expect(res.status).toBe(503);
      expect(res.body.error?.message).toMatch(/^The background queue is unavailable\. The Google search cost \$0\.01/);
      expect(res.body.error?.message).not.toContain("Nothing was spent");
    } finally {
      harness.queueDown = false;
    }
    const [brief] = await user.api.ok("GET", `/projects/${user.project.id}/content/briefs`);
    expect(brief).toMatchObject({ status: "failed", costUsd: 0.01 });
  });

  it("fails the brief straight away when the queue is down", async () => {
    const user = await readyUser();
    harness.queueDown = true;
    try {
      const res = await user.api.post(`/projects/${user.project.id}/content/briefs`, { source: "urls", keyword: "boots", urls: [`${base}/a`] });
      expect(res.status).toBe(503);
      // Pasted URLs cost nothing, so the queue's own message is true.
      expect(res.body.error?.message).toContain("Nothing was spent");
    } finally {
      harness.queueDown = false;
    }
    const [brief] = await user.api.ok("GET", `/projects/${user.project.id}/content/briefs`);
    expect(brief).toMatchObject({ status: "failed" });
    expect(brief.error).toMatch(/^Could not be queued/);
  });
});
