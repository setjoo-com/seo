import type { BriefSource, ContentBrief } from "@openseo/shared";
import type { RunStatus } from "@/components/tracking/kit";

export type BriefRow = {
  id: string;
  keyword: string;
  source: BriefSource;
  status: RunStatus;
  pages: number;
  wordCount: ContentBrief["wordCount"];
  costUsd: number;
  error: string | null;
  createdAt: string;
  drafts: number;
  bestScore: number | null;
};

export type DraftSummary = { id: string; title: string; score: number; wordCount: number; aiModel: string | null; updatedAt: string };

export type BriefDetail = {
  id: string;
  keyword: string;
  source: BriefSource;
  urls: string[];
  status: RunStatus;
  brief: ContentBrief | null;
  costUsd: number;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
  drafts: DraftSummary[];
};

export type Draft = {
  id: string;
  briefId: string;
  title: string;
  body: string;
  score: number;
  wordCount: number;
  aiModel: string | null;
  aiCostUsd: number | null;
  updatedAt: string;
  brief: { id: string; keyword: string; status: RunStatus; brief: ContentBrief | null };
};

/** Token-priced: $0.01 minimum, `upTo` from the model's list price and the output allowance. */
export type WriterEstimate = { min: number; max: null; upTo: number | null; formula: string };

export const scoreTone = (score: number) => (score >= 70 ? "pos" : score >= 40 ? "warn" : "neg");
