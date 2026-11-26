/**
 * Content briefs and the content score. The API builds a brief from competitor pages and scores
 * saved drafts; the app scores a draft live while it is typed. Both use these functions, so the
 * score on screen is the score that is saved.
 */

/** Where a brief's pages come from: pasted by the user (free), or Google's top results (one paid SERP lookup). */
export type BriefSource = "urls" | "serp";
/** Pages one brief reads at most. */
export const BRIEF_MAX_URLS = 10;
export type WriterMode = "draft" | "outline";
export const DEFAULT_WRITER_MODEL = "anthropic/claude-sonnet-5";

export type OutlineHeading = { level: number; text: string };
export type TermCount = { term: string; count: number };

/** A competitor page as read for a brief: what the brief shows per page. */
export type CompetitorPage = {
  url: string;
  /** Google position, when the URLs came from the search results. */
  position: number | null;
  ok: boolean;
  error: string | null;
  title: string | null;
  wordCount: number;
  headings: OutlineHeading[];
  /** The page's most frequent terms and two-word phrases. */
  topTerms: TermCount[];
  questions: string[];
};

/** What the API read from one page: its outline, and its text with the headings in it. */
export type PageInput = {
  url: string;
  position?: number | null;
  /** Place in the list the pages were given in; orders pages that have no Google position. */
  order?: number;
  title: string | null;
  headings: OutlineHeading[];
  text: string;
  wordCount: number;
};
export type FailedPage = { url: string; position?: number | null; order?: number; error: string };

/** A question to answer: from Google's People Also Ask, competitors' headings (`pages`), or both. */
export type BriefQuestion = { text: string; pages: number; google: boolean };

/** A term competitors use, and how often a page that uses it does (lower and upper quartile). */
export type BriefTerm = { term: string; pages: number; min: number; max: number };

export type ContentBrief = {
  keyword: string;
  /** The recommended length, around the competitors' median. Null when no page could be read. */
  wordCount: { min: number; max: number; median: number } | null;
  /** h2 and h3 headings competitors share, most shared first. */
  headings: { text: string; level: number; pages: number }[];
  terms: BriefTerm[];
  /** Google's People Also Ask questions first (`google`), then competitors' question headings. */
  questions: BriefQuestion[];
  competitors: CompetitorPage[];
};

// English function words and web boilerplate. Briefs are built from the page text as it is, so
// other languages get frequent terms without stopword removal.
const STOPWORDS = new Set(
  (
    "a about above after again against all almost also although always am among an and another any anyone anything are aren't around as at " +
    "be became because become been before being below between both but by can can't cannot could couldn't did didn't do does doesn't doing " +
    "don't done down during each either else enough even ever every few for from further get gets getting go goes going got had hadn't has " +
    "hasn't have haven't having he he'd he'll he's her here here's hers herself him himself his how how's however i i'd i'll i'm i've if in " +
    "into is isn't it it's its itself just let let's like made make makes many may me might more most much must mustn't my myself need " +
    "needs never no nor not now of off often on once one only or other others otherwise our ours ourselves out over own per quite rather " +
    "really same say says see seen shall shan't she she'd she'll she's should shouldn't since so some something still such than that that's " +
    "the their theirs them themselves then there there's these they they'd they'll they're they've thing things this those though through " +
    "thus to too under until up upon us use used using very via want was wasn't way ways we we'd we'll we're we've well were weren't what " +
    "what's when when's where where's whether which while who who's whom whose why why's will with within without won't would wouldn't yet " +
    "you you'd you'll you're you've your yours yourself yourselves " +
    "click read more share menu home search cookie cookies privacy policy terms login sign subscribe newsletter skip content copyright " +
    "reserved rights posted updated published comments reply"
  ).split(" "),
);

const SEGMENTER = new Intl.Segmenter(undefined, { granularity: "word" });

/** Words as a reader counts them; the crawler counts competitor pages the same way. */
export function countWords(text: string): number {
  let count = 0;
  for (const segment of SEGMENTER.segment(text)) if (segment.isWordLike) count++;
  return count;
}

const WORD = /[\p{L}\p{N}]+(?:['’][\p{L}]+)*/gu;

/** Lower-case word tokens, apostrophes kept inside words ("don't"). */
export function wordTokens(text: string): string[] {
  return (text.toLowerCase().match(WORD) ?? []).map((w) => w.replace(/’/g, "'"));
}

const isTerm = (word: string) => word.length >= 3 && !STOPWORDS.has(word) && !/^\d+$/.test(word);

/**
 * How often each term and two-word phrase occurs, stopwords left out. Phrases do not cross
 * punctuation, so "boots. Warm" is not a phrase.
 */
export function termCounts(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  const add = (term: string) => counts.set(term, (counts.get(term) ?? 0) + 1);
  for (const chunk of text.split(/[.!?;:,()[\]{}"“”|•·–—\n]+/)) {
    const tokens = wordTokens(chunk);
    for (let i = 0; i < tokens.length; i++) {
      const word = tokens[i]!;
      if (!isTerm(word)) continue;
      add(word);
      const next = tokens[i + 1];
      if (next && isTerm(next)) add(`${word} ${next}`);
    }
  }
  return counts;
}

/** True when `phrase` occurs in `text` as whole words, ignoring case and punctuation. */
export function hasPhrase(text: string, phrase: string): boolean {
  const needle = wordTokens(phrase).join(" ");
  return needle !== "" && ` ${wordTokens(text).join(" ")} `.includes(` ${needle} `);
}

const QUESTION_START = /^(what|how|why|when|where|who|which|whose|can|could|does|do|did|is|are|was|were|should|will|would)\b/i;

export const isQuestion = (text: string) => text.trim().endsWith("?") || QUESTION_START.test(text.trim());

// "1. Fit", "Step 2: Fit" and "Fit:" are the same subtopic as "Fit".
const headingKey = (text: string) =>
  wordTokens(text.replace(/^\s*(?:step\s+)?\d+\s*[.):-]?\s*/i, "")).join(" ");

function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  const at = (sorted.length - 1) * q;
  const low = Math.floor(at);
  const high = Math.ceil(at);
  return sorted[low]! + (sorted[high]! - sorted[low]!) * (at - low);
}

const round50 = (n: number) => Math.max(50, Math.round(n / 50) * 50);

/** Pages this short were most likely not read properly (rendered by script, a wall, an error page). */
const THIN_PAGE = 100;
const MAX_TERMS = 25;
const MAX_PHRASES = 15;
const MAX_QUESTIONS = 30;
/** Google's questions are what searchers ask; up to this many keep a place ahead of heading questions. */
const MAX_GOOGLE_QUESTIONS = 10;

/**
 * Builds a brief from the competitor pages that could be read. Failed pages are listed with
 * their error and otherwise left out. `extraQuestions` are Google's People Also Ask questions.
 */
export function buildBrief(keyword: string, pages: PageInput[], failed: FailedPage[] = [], extraQuestions: string[] = []): ContentBrief {
  // The text already holds the headings, as a draft's text does; the title is counted for both.
  const read = pages.map((page) => ({ page, counts: termCounts([page.title ?? "", page.text].join("\n")) }));

  const lengths = pages.map((p) => p.wordCount).filter((n) => n >= THIN_PAGE);
  const sortedLengths = (lengths.length ? lengths : pages.map((p) => p.wordCount).filter((n) => n > 0)).sort((a, b) => a - b);
  const median = Math.round(quantile(sortedLengths, 0.5));
  const wordCount = sortedLengths.length ? { min: round50(median * 0.9), max: round50(median * 1.2), median } : null;

  // A term must be on several pages to be worth recommending: 30% of them, at least two.
  const minPages = read.length <= 2 ? 1 : Math.max(2, Math.ceil(read.length * 0.3));
  const usage = new Map<string, number[]>();
  for (const { counts } of read) {
    for (const [term, count] of counts) {
      const list = usage.get(term);
      if (list) list.push(count);
      else usage.set(term, [count]);
    }
  }
  const keywordWords = new Set(wordTokens(keyword));
  const candidates = [...usage]
    .filter(([term, counts]) => counts.length >= minPages && !term.split(" ").every((w) => keywordWords.has(w)))
    .map(([term, counts]) => {
      const sorted = [...counts].sort((a, b) => a - b);
      const min = Math.max(1, Math.round(quantile(sorted, 0.25)));
      return { term, pages: counts.length, min, max: Math.max(min, Math.round(quantile(sorted, 0.75))), total: counts.reduce((a, b) => a + b, 0) };
    })
    .sort((a, b) => b.pages - a.pages || b.total - a.total || a.term.localeCompare(b.term));
  const terms = [
    ...candidates.filter((c) => !c.term.includes(" ")).slice(0, MAX_TERMS),
    ...candidates.filter((c) => c.term.includes(" ")).slice(0, MAX_PHRASES),
  ]
    .sort((a, b) => b.pages - a.pages || b.total - a.total || a.term.localeCompare(b.term))
    .map(({ total: _total, ...term }) => term);

  const headingGroups = new Map<string, { text: string; level: number; urls: Set<string> }>();
  const questionGroups = new Map<string, { text: string; urls: Set<string> }>();
  for (const page of pages) {
    for (const heading of page.headings) {
      const key = headingKey(heading.text);
      if (!key) continue;
      if (heading.level >= 2) {
        const group = headingGroups.get(key) ?? { text: heading.text, level: heading.level, urls: new Set<string>() };
        group.urls.add(page.url);
        headingGroups.set(key, group);
      }
      if (isQuestion(heading.text)) {
        const group = questionGroups.get(key) ?? { text: heading.text, urls: new Set<string>() };
        group.urls.add(page.url);
        questionGroups.set(key, group);
      }
    }
  }
  const headings = [...headingGroups.values()]
    .map((g) => ({ text: g.text, level: g.level, pages: g.urls.size }))
    .sort((a, b) => b.pages - a.pages || a.level - b.level)
    .slice(0, 40);
  const google = new Map<string, BriefQuestion>();
  for (const text of extraQuestions) {
    const key = headingKey(text);
    if (key && !google.has(key) && google.size < MAX_GOOGLE_QUESTIONS) google.set(key, { text, pages: questionGroups.get(key)?.urls.size ?? 0, google: true });
  }
  const questions: BriefQuestion[] = [
    ...google.values(),
    ...[...questionGroups]
      .filter(([key]) => !google.has(key))
      .map(([, g]) => ({ text: g.text, pages: g.urls.size, google: false }))
      .sort((a, b) => b.pages - a.pages),
  ].slice(0, MAX_QUESTIONS);

  const competitors: CompetitorPage[] = [
    ...read.map(({ page, counts }) => ({
      url: page.url,
      position: page.position ?? null,
      order: page.order,
      ok: true,
      error: null,
      title: page.title,
      wordCount: page.wordCount,
      headings: page.headings,
      topTerms: [...counts]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 10)
        .map(([term, count]) => ({ term, count })),
      questions: page.headings.filter((h) => isQuestion(h.text)).map((h) => h.text),
    })),
    ...failed.map((page) => ({ url: page.url, position: page.position ?? null, order: page.order, ok: false, error: page.error, title: null, wordCount: 0, headings: [], topTerms: [], questions: [] })),
  ]
    // Google order, or the order the pages were given in, failed ones in their place.
    .sort((a, b) => (a.position ?? a.order ?? 1e9) - (b.position ?? b.order ?? 1e9))
    .map(({ order: _order, ...page }) => page);

  return { keyword, wordCount, headings, terms, questions, competitors };
}

// ── Draft analysis ──────────────────────────────────────────────────────────

export type ParsedDraft = { headings: OutlineHeading[]; paragraphs: string[]; text: string };

const inline = (line: string) =>
  line
    .replace(/<[^>]+>/g, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_`~]+/g, "")
    .replace(/^\s*>\s?/, "")
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "")
    .trim();

/** Headings and paragraphs of a Markdown draft, as plain text. List items are paragraphs of their own. */
export function parseMarkdown(markdown: string): ParsedDraft {
  const headings: OutlineHeading[] = [];
  const paragraphs: string[] = [];
  let block: string[] = [];
  const flush = () => {
    const text = block.join(" ").replace(/\s+/g, " ").trim();
    if (text) paragraphs.push(text);
    block = [];
  };
  let fenced = false;
  for (const line of markdown.replace(/\r\n?/g, "\n").split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      flush();
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      flush();
      const text = inline(heading[2] ?? "");
      if (text) headings.push({ level: heading[1]!.length, text });
    } else if (!line.trim() || /^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) flush();
    else {
      if (/^\s*(?:[-*+]|\d+[.)])\s+/.test(line)) flush();
      block.push(inline(line));
    }
  }
  flush();
  return { headings, paragraphs, text: [...headings.map((h) => h.text), ...paragraphs].join("\n") };
}

function syllables(word: string): number {
  let w = word.toLowerCase().replace(/[^a-z]/g, "");
  if (!w) return 0;
  if (w.length <= 3) return 1;
  w = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, "").replace(/^y/, "");
  return Math.max(1, w.match(/[aeiouy]{1,2}/g)?.length ?? 1);
}

/**
 * Flesch reading ease of the paragraphs: about 60 to 70 is plain English, below 30 is hard going.
 * Null under 30 words, where it means little. The formula is tuned for English.
 */
export function readingEase(paragraphs: string[]): number | null {
  let sentences = 0;
  let wordTotal = 0;
  let syllableTotal = 0;
  for (const paragraph of paragraphs) {
    const parts = paragraph.split(/[.!?]+(?=\s|$)/).filter((s) => /[\p{L}\p{N}]/u.test(s));
    sentences += parts.length;
    for (const word of wordTokens(paragraph)) {
      wordTotal++;
      syllableTotal += syllables(word);
    }
  }
  if (wordTotal < 30 || sentences === 0) return null;
  return Math.round((206.835 - 1.015 * (wordTotal / sentences) - 84.6 * (syllableTotal / wordTotal)) * 10) / 10;
}

// ── Content score ───────────────────────────────────────────────────────────

export type CheckStatus = "pass" | "partial" | "fail";
export type ContentCheck = { id: string; label: string; detail: string; status: CheckStatus; points: number; max: number };
export type TermUse = BriefTerm & { count: number; status: "missing" | "low" | "ok" | "high" };

export type ContentScore = {
  /** 0 to 100: points earned out of the checks that apply (a brief with no terms has no term check). */
  score: number;
  checks: ContentCheck[];
  wordCount: number;
  readingEase: number | null;
  terms: TermUse[];
};

export type ScoreInput = {
  keyword: string;
  title: string;
  /** Markdown. */
  body: string;
  brief?: Pick<ContentBrief, "wordCount" | "terms"> | null;
};

const statusOf = (points: number, max: number): CheckStatus => (points >= max ? "pass" : points > 0 ? "partial" : "fail");

function check(id: string, label: string, points: number, max: number, detail: string): ContentCheck {
  const rounded = Math.round(Math.max(0, Math.min(max, points)) * 10) / 10;
  return { id, label, detail, status: statusOf(rounded, max), points: rounded, max };
}

/**
 * Scores a draft against its brief. Weights: terms 35, length 20, keyword in the title 10, in the
 * H1 10 and in the first paragraph 5, headings 10, readability 10.
 */
export function scoreContent({ keyword, title, body, brief }: ScoreInput): ContentScore {
  const draft = parseMarkdown(body);
  const wordCount = countWords(draft.text);
  const counts = termCounts([title, draft.text].join("\n"));
  const checks: ContentCheck[] = [];

  const terms: TermUse[] = (brief?.terms ?? []).map((term) => {
    const count = counts.get(term.term) ?? 0;
    const status = count === 0 ? "missing" : count < term.min ? "low" : count > term.max * 2 ? "high" : "ok";
    return { ...term, count, status };
  });
  if (terms.length) {
    // Each term counts once used often enough, half when used at all. Overuse is flagged in the term list, not scored.
    const earned = terms.reduce((sum, t) => sum + (t.status === "missing" ? 0 : t.status === "low" ? 0.5 : 1), 0);
    const enough = terms.filter((t) => t.status === "ok" || t.status === "high").length;
    const missing = terms.filter((t) => t.status === "missing").length;
    checks.push(check("terms", "Covers the brief's terms", (35 * earned) / terms.length, 35, `${enough} of ${terms.length} used enough, ${missing} missing`));
  }

  const range = brief?.wordCount;
  if (range) {
    let points = 20;
    let detail = `${wordCount} words; aim for ${range.min} to ${range.max}`;
    if (wordCount < range.min) points = (20 * wordCount) / range.min;
    else if (wordCount > range.max * 1.25) {
      points = 12;
      detail = `${wordCount} words, well above the ${range.min} to ${range.max} competitors write; cut what does not help the reader`;
    }
    checks.push(check("length", "Length matches competitors", points, 20, detail));
  }

  const inTitle = hasPhrase(title, keyword);
  checks.push(check("keyword-title", "Keyword in the title", inTitle ? 10 : 0, 10, inTitle ? `"${keyword}" is in the title` : `Add "${keyword}" to the title`));

  const firstH1 = draft.headings.find((h) => h.level === 1);
  // Without a # heading in the body, the title is the page's H1, as most sites publish it.
  const h1 = firstH1?.text ?? title;
  const inH1 = hasPhrase(h1, keyword);
  checks.push(
    check("keyword-h1", "Keyword in the H1", inH1 ? 10 : 0, 10, inH1 ? `"${keyword}" is in the H1${firstH1 ? "" : " (the title)"}` : `Add "${keyword}" to the H1${firstH1 ? "" : " (the title, as no # heading is in the text)"}`),
  );

  const first = draft.paragraphs[0] ?? "";
  const inIntro = hasPhrase(first, keyword);
  checks.push(check("keyword-intro", "Keyword in the first paragraph", inIntro ? 5 : 0, 5, inIntro ? "Mentioned early" : first ? `Mention "${keyword}" in the opening paragraph` : "Write an opening paragraph"));

  const h1Count = draft.headings.filter((h) => h.level === 1).length;
  const h2Count = draft.headings.filter((h) => h.level === 2).length;
  let skipped = false;
  let previous = 1;
  for (const heading of draft.headings) {
    if (heading.level > previous + 1) skipped = true;
    previous = heading.level;
  }
  // Order and a single H1 only earn points once there are headings to order.
  const headingPoints = draft.headings.length ? (h2Count >= 2 ? 5 : h2Count === 1 ? 2 : 0) + (skipped ? 0 : 3) + (h1Count <= 1 ? 2 : 0) : 0;
  const headingNotes = [
    h2Count >= 2 ? `${h2Count} H2 sections` : `Break the text into sections with H2 headings (${h2Count} so far)`,
    skipped ? "a heading skips a level (e.g. H3 straight after the H1)" : null,
    h1Count > 1 ? `${h1Count} H1 headings; keep one` : null,
  ].filter(Boolean);
  checks.push(check("headings", "Clear heading structure", headingPoints, 10, headingNotes.join("; ")));

  const ease = readingEase(draft.paragraphs);
  const easePoints = ease == null ? 0 : ease >= 60 ? 10 : ease <= 30 ? 0 : ((ease - 30) / 30) * 10;
  checks.push(
    check(
      "readability",
      "Easy to read",
      easePoints,
      10,
      ease == null ? "Write at least 30 words to measure" : ease >= 60 ? `Reading ease ${ease}: plain English` : `Reading ease ${ease}; shorter sentences and simpler words raise it (60+ is plain English)`,
    ),
  );

  const max = checks.reduce((sum, c) => sum + c.max, 0);
  const earned = checks.reduce((sum, c) => sum + c.points, 0);
  return { score: max ? Math.round((100 * earned) / max) : 0, checks, wordCount, readingEase: ease, terms };
}
