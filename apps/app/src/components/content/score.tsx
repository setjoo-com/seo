"use client";

import type { ContentBrief, ContentScore } from "@openseo/shared";
import { CircleCheck, CircleMinus, CircleX } from "lucide-react";
import { Card, CardHeader, cx } from "@/components/ui";
import { num } from "@/lib/api";
import { scoreTone } from "./types";

const TONE_TEXT = { pos: "text-pos", warn: "text-warn", neg: "text-neg" } as const;
const TERM_TEXT = { ok: "text-pos", high: "text-warn", low: "text-warn", missing: "text-muted" } as const;
const TERM_HINT = { ok: "Used enough", high: "Used much more than competitors", low: "Used, but less than competitors", missing: "Not used yet" } as const;

/** The live score beside the editor: the checklist, then every brief term with its count. */
export function ScorePanel({ score, brief }: { score: ContentScore; brief: ContentBrief | null }) {
  const tone = scoreTone(score.score);
  return (
    <div className="space-y-4">
      <Card>
        <div className="flex items-end justify-between gap-3 border-b border-line px-4 py-3">
          <div>
            <p className="font-mono text-[11px] uppercase tracking-wide text-muted">Content score</p>
            <p className={cx("font-display text-4xl font-semibold tabular", TONE_TEXT[tone])} aria-live="polite">
              {score.score}
              <span className="text-base text-muted">/100</span>
            </p>
          </div>
          <div className="text-right font-mono text-xs text-muted tabular">
            <p>{num(score.wordCount)} words</p>
            {brief?.wordCount && (
              <p>
                aim {num(brief.wordCount.min)}–{num(brief.wordCount.max)}
              </p>
            )}
          </div>
        </div>
        <ul className="divide-y divide-line">
          {score.checks.map((check) => {
            const Icon = check.status === "pass" ? CircleCheck : check.status === "partial" ? CircleMinus : CircleX;
            return (
              <li key={check.id} className="flex gap-2.5 px-4 py-2.5 text-[13px]">
                <Icon className={cx("mt-0.5 size-4 shrink-0", check.status === "pass" ? "text-pos" : check.status === "partial" ? "text-warn" : "text-neg")} aria-label={check.status} />
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{check.label}</p>
                  <p className="text-xs text-muted">{check.detail}</p>
                </div>
                <span className="shrink-0 font-mono text-xs text-muted tabular">
                  {check.points}/{check.max}
                </span>
              </li>
            );
          })}
        </ul>
      </Card>

      {score.terms.length > 0 && (
        <Card>
          <CardHeader title="Terms" description="How often competitors use each term, and how often you do." />
          <ul className="max-h-[28rem] divide-y divide-line overflow-y-auto">
            {score.terms.map((term) => (
              <li key={term.term} className="flex items-center justify-between gap-3 px-4 py-1.5 text-[13px]" title={TERM_HINT[term.status]}>
                <span className={cx("min-w-0 truncate", term.status === "missing" && "text-muted")}>{term.term}</span>
                <span className="shrink-0 font-mono text-xs tabular">
                  <span className={TERM_TEXT[term.status]}>{term.count}</span>
                  <span className="text-faint">
                    {" "}
                    / {term.min === term.max ? term.min : `${term.min}–${term.max}`}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {brief && brief.questions.length > 0 && (
        <Card>
          <CardHeader title="Questions to answer" />
          <ul className="list-disc space-y-1 py-3 pr-4 pl-8 text-[13px]">
            {brief.questions.slice(0, 12).map((question) => (
              <li key={question.text}>{question.text}</li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
