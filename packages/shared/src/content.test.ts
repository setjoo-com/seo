import { describe, expect, it } from "vitest";
import { buildBrief, countWords, hasPhrase, isQuestion, parseMarkdown, readingEase, scoreContent, termCounts, type ContentBrief, type PageInput } from "./content";

const page = (url: string, text: string, headings: PageInput["headings"] = [], position: number | null = null): PageInput => ({
  url,
  position,
  title: `Title of ${url}`,
  headings,
  text,
  wordCount: countWords(text),
});

const filler = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(" ");

describe("termCounts", () => {
  it("counts terms and two-word phrases without stopwords, not across punctuation", () => {
    const counts = termCounts("The winter boots are warm. Winter boots, warm socks and the boots.");
    expect(counts.get("winter boots")).toBe(2);
    expect(counts.get("boots")).toBe(3);
    expect(counts.get("warm socks")).toBe(1);
    expect(counts.has("the")).toBe(false);
    expect(counts.has("boots warm")).toBe(false);
  });
});

describe("hasPhrase and isQuestion", () => {
  it("matches whole words, ignoring case and punctuation", () => {
    expect(hasPhrase("Best Winter-Boots for 2026", "winter boots")).toBe(true);
    expect(hasPhrase("Wintery boots", "winter boots")).toBe(false);
    expect(hasPhrase("anything", "")).toBe(false);
  });
  it("spots question headings", () => {
    expect(isQuestion("How to choose boots")).toBe(true);
    expect(isQuestion("Are boots waterproof")).toBe(true);
    expect(isQuestion("Sizing guide?")).toBe(true);
    expect(isQuestion("Sizing guide")).toBe(false);
  });
});

describe("buildBrief", () => {
  const body = (extra: string) => `Winter boots keep feet warm. Waterproof leather matters. Good grip on ice. ${extra}`;
  const pages = [
    page("https://a.test/1", body(filler(300)), [{ level: 1, text: "Winter boots" }, { level: 2, text: "1. Waterproofing" }, { level: 2, text: "How do I size boots?" }], 1),
    page("https://b.test/1", body(filler(500)), [{ level: 2, text: "Waterproofing:" }, { level: 3, text: "Grip" }], 2),
    page("https://c.test/1", body(`${filler(700)} waterproof leather waterproof leather`), [{ level: 2, text: "Waterproofing" }, { level: 2, text: "How do I size boots?" }], 3),
  ];
  const brief = buildBrief("winter boots", pages, [{ url: "https://d.test/1", position: 4, error: "HTTP 404" }], ["Are winter boots worth it?", "How do I size boots"]);

  it("recommends a length around the competitors' median", () => {
    const median = pages[1]!.wordCount;
    expect(brief.wordCount).toEqual({ median, min: Math.round((median * 0.9) / 50) * 50, max: Math.round((median * 1.2) / 50) * 50 });
  });

  it("keeps terms used on several pages, with quartile counts, and leaves out the keyword itself", () => {
    const leather = brief.terms.find((t) => t.term === "waterproof leather");
    expect(leather).toMatchObject({ pages: 3, min: 1 });
    expect(leather!.max).toBe(2);
    expect(brief.terms.find((t) => t.term === "grip")).toMatchObject({ pages: 3 });
    expect(brief.terms.some((t) => t.term === "winter boots" || t.term === "boots")).toBe(false);
    // filler words appear on one page only
    expect(brief.terms.some((t) => t.term === "word299")).toBe(false);
  });

  it("groups shared headings and questions, and adds Google's questions once", () => {
    expect(brief.headings[0]).toEqual({ text: "1. Waterproofing", level: 2, pages: 3 });
    expect(brief.headings.some((h) => h.level === 1)).toBe(false);
    expect(brief.questions).toEqual([
      { text: "How do I size boots?", pages: 2 },
      { text: "Are winter boots worth it?", pages: 0 },
    ]);
  });

  it("lists every competitor in Google order, failed ones included", () => {
    expect(brief.competitors.map((c) => [c.url, c.ok])).toEqual([
      ["https://a.test/1", true],
      ["https://b.test/1", true],
      ["https://c.test/1", true],
      ["https://d.test/1", false],
    ]);
    expect(brief.competitors[3]).toMatchObject({ error: "HTTP 404", wordCount: 0 });
    expect(brief.competitors[0]!.topTerms.length).toBeGreaterThan(0);
    expect(brief.competitors[0]!.questions).toEqual(["How do I size boots?"]);
  });

  it("has no length when no page could be read", () => {
    expect(buildBrief("x", [], [{ url: "https://a.test", error: "timeout" }]).wordCount).toBeNull();
  });
});

describe("parseMarkdown", () => {
  it("separates headings and paragraphs and strips Markdown syntax", () => {
    const parsed = parseMarkdown("# Title **bold**\n\nFirst [link](https://x.test) line\nsame paragraph.\n\n- item one\n- item two\n\n```\ncode # not a heading\n```\n## Next ##\n");
    expect(parsed.headings).toEqual([
      { level: 1, text: "Title bold" },
      { level: 2, text: "Next" },
    ]);
    expect(parsed.paragraphs).toEqual(["First link line same paragraph.", "item one", "item two"]);
  });
});

describe("readingEase", () => {
  it("rates short plain sentences higher than long complicated ones", () => {
    const plain = Array.from({ length: 8 }, () => "The dog ran to the park. It was fun.").join(" ");
    const hard = Array.from({ length: 4 }, () => "Organisational considerations necessitate comprehensive evaluation of interdependent infrastructural characteristics.").join(" ");
    expect(readingEase([plain])!).toBeGreaterThan(80);
    expect(readingEase([hard])!).toBeLessThan(10);
    expect(readingEase(["Too short."])).toBeNull();
  });
});

describe("scoreContent", () => {
  const brief: Pick<ContentBrief, "wordCount" | "terms"> = {
    wordCount: { min: 100, max: 200, median: 150 },
    terms: [
      { term: "waterproof", pages: 3, min: 2, max: 4 },
      { term: "grip", pages: 3, min: 1, max: 2 },
      { term: "insulation", pages: 2, min: 1, max: 1 },
    ],
  };
  const sentence = "Good boots are waterproof and have grip on ice. ";

  it("gives full marks to a draft that meets every check", () => {
    const body = `# Winter boots guide\n\nWinter boots should keep you warm. Insulation matters.\n\n## Waterproof boots\n\n${sentence.repeat(8)}\n\n## Sizing\n\n${"You can try them on at home. ".repeat(6)}`;
    const result = scoreContent({ keyword: "winter boots", title: "Best winter boots", body, brief });
    expect(result.checks.filter((c) => c.status !== "pass")).toEqual([]);
    expect(result.score).toBe(100);
    expect(result.terms.find((t) => t.term === "grip")).toMatchObject({ count: 8, status: "high" });
    expect(result.terms.find((t) => t.term === "insulation")).toMatchObject({ count: 1, status: "ok" });
  });

  it("scores an empty draft low and says what is missing", () => {
    const result = scoreContent({ keyword: "winter boots", title: "", body: "", brief });
    expect(result.score).toBe(0);
    expect(result.wordCount).toBe(0);
    const byId = Object.fromEntries(result.checks.map((c) => [c.id, c]));
    expect(byId.terms).toMatchObject({ points: 0, detail: "0 of 3 used enough, 3 missing" });
    expect(byId["keyword-title"]!.detail).toBe('Add "winter boots" to the title');
    expect(byId.readability!.detail).toBe("Write at least 30 words to measure");
  });

  it("gives partial credit, uses the title as the H1 when the text has none, and flags skipped levels", () => {
    const body = `Intro without the phrase. Waterproof.\n\n### Deep heading\n\n${"Some text here. ".repeat(10)}`;
    const result = scoreContent({ keyword: "winter boots", title: "Winter boots", body, brief });
    const byId = Object.fromEntries(result.checks.map((c) => [c.id, c]));
    expect(byId["keyword-h1"]).toMatchObject({ status: "pass", detail: '"winter boots" is in the H1 (the title)' });
    expect(byId["keyword-intro"]!.status).toBe("fail");
    expect(byId.terms).toMatchObject({ status: "partial", points: Math.round((35 * 0.5) / 3 * 10) / 10 });
    expect(byId.length!.status).toBe("partial");
    expect(byId.headings!.detail).toContain("skips a level");
    expect(result.score).toBeGreaterThan(0);
    expect(result.score).toBeLessThan(60);
  });

  it("leaves out checks the brief cannot support and rescales to 100", () => {
    const body = `# Winter boots\n\nWinter boots keep you warm.\n\n## One\n\n${"The dog ran to the park. ".repeat(8)}\n\n## Two\n\nMore.`;
    const result = scoreContent({ keyword: "winter boots", title: "Winter boots", body, brief: null });
    expect(result.checks.map((c) => c.id)).toEqual(["keyword-title", "keyword-h1", "keyword-intro", "headings", "readability"]);
    expect(result.score).toBe(100);
  });

  it("is deterministic", () => {
    const input = { keyword: "winter boots", title: "Winter boots", body: `# Winter boots\n\n${sentence.repeat(20)}`, brief };
    expect(scoreContent(input)).toEqual(scoreContent(input));
  });
});
