"use client";

import { CURATED_MODELS, type ContentBrief, DEFAULT_WRITER_MODEL, type WriterMode } from "@openseo/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, Plus, Sparkles, Trash2 } from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import { type BriefDetail, type Draft, scoreTone, type WriterEstimate } from "@/components/content/types";
import { ConfirmDialog, ExtLink, isActive, Note, Segmented, StatusBadge } from "@/components/tracking/kit";
import { Badge, Button, Card, CardHeader, EmptyState, ErrorNote, Field, PageHeader, Select, Spinner, Stat, Table } from "@/components/ui";
import { api, dateTime, num, usd } from "@/lib/api";
import { useMe } from "@/lib/hooks";

function Outline({ brief }: { brief: ContentBrief }) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader title="Terms to use" description="Used on several competitor pages. Uses: how often a page that uses the term does." />
        {brief.terms.length === 0 ? (
          <p className="p-4 text-[13px] text-muted">No term is shared by enough pages.</p>
        ) : (
          <Table className="max-h-[32rem] overflow-y-auto">
            <thead>
              <tr>
                <th scope="col">Term</th>
                <th scope="col" className="text-right">
                  Pages
                </th>
                <th scope="col" className="text-right">
                  Uses
                </th>
              </tr>
            </thead>
            <tbody>
              {brief.terms.map((term) => (
                <tr key={term.term}>
                  <td>{term.term}</td>
                  <td className="text-right font-mono tabular">{term.pages}</td>
                  <td className="text-right font-mono tabular">{term.min === term.max ? term.min : `${term.min}–${term.max}`}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      <div className="space-y-4">
        <Card>
          <CardHeader title="Subtopics" description="H2 and H3 headings competitors use, most shared first." />
          {brief.headings.length === 0 ? (
            <p className="p-4 text-[13px] text-muted">No headings found.</p>
          ) : (
            <ul className="max-h-80 divide-y divide-line overflow-y-auto">
              {brief.headings.map((heading) => (
                <li key={`${heading.level}:${heading.text}`} className="flex items-center justify-between gap-3 px-4 py-1.5 text-[13px]">
                  <span className={heading.level === 3 ? "pl-4 text-muted" : ""}>{heading.text}</span>
                  <span className="shrink-0 font-mono text-xs text-muted tabular">
                    {heading.pages} {heading.pages === 1 ? "page" : "pages"}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card>
          <CardHeader title="Questions to answer" description="Question headings on competitor pages, and Google's People Also Ask." />
          {brief.questions.length === 0 ? (
            <p className="p-4 text-[13px] text-muted">No questions found.</p>
          ) : (
            <ul className="divide-y divide-line">
              {brief.questions.map((question) => (
                <li key={question.text} className="flex items-center justify-between gap-3 px-4 py-1.5 text-[13px]">
                  <span>{question.text}</span>
                  <span className="shrink-0 font-mono text-xs text-muted">{[question.google && "Google", question.pages > 0 && `${question.pages} ${question.pages === 1 ? "page" : "pages"}`].filter(Boolean).join(" · ")}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}

function Competitors({ brief }: { brief: ContentBrief }) {
  return (
    <Card>
      <CardHeader title="Competitor pages" description="Open a page to see its outline and most used terms." />
      <ul className="divide-y divide-line">
        {brief.competitors.map((page, index) => (
          <li key={page.url} className="px-4 py-2.5 text-[13px]">
            <details>
              <summary className="flex cursor-pointer list-none items-start gap-3">
                <span className="w-5 shrink-0 font-mono text-xs text-muted tabular">{page.position ?? index + 1}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{page.title ?? page.url}</span>
                  <span className="block truncate font-mono text-xs text-muted">{page.url}</span>
                </span>
                {page.ok ? (
                  <span className="shrink-0 font-mono text-xs tabular">
                    {num(page.wordCount)} words · {page.headings.length} headings
                  </span>
                ) : (
                  <Badge tone="neg">Not read</Badge>
                )}
              </summary>
              <div className="mt-2 space-y-2 pl-8">
                <ExtLink href={page.url} className="text-xs">
                  Open page
                </ExtLink>
                {page.error && <p className="text-xs text-neg">{page.error}</p>}
                {page.headings.length > 0 && (
                  <ul className="space-y-0.5 text-xs">
                    {page.headings.map((heading, i) => (
                      <li key={i} style={{ paddingLeft: `${(heading.level - 1) * 12}px` }}>
                        <span className="mr-1.5 font-mono text-faint">H{heading.level}</span>
                        {heading.text}
                      </li>
                    ))}
                  </ul>
                )}
                {page.topTerms.length > 0 && (
                  <p className="text-xs text-muted">
                    Top terms: {page.topTerms.map((t) => `${t.term} (${t.count})`).join(", ")}
                  </p>
                )}
              </div>
            </details>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function Writer({ projectId, brief }: { projectId: string; brief: BriefDetail }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const me = useMe();
  const hasKey = Boolean(me.data?.settings.hasYepapiKey);
  const [mode, setMode] = useState<WriterMode>("draft");
  const [model, setModel] = useState(DEFAULT_WRITER_MODEL);
  const path = `/projects/${projectId}/content/briefs/${brief.id}/write`;
  const estimate = useQuery({
    queryKey: ["content-writer-estimate", brief.id, mode, model],
    queryFn: () => api<{ estimate: WriterEstimate }>(path, { method: "POST", body: { mode, model }, query: { dryRun: 1 } }).then((r) => r.estimate),
    enabled: hasKey,
    staleTime: Infinity,
    retry: false,
  });
  const write = useMutation({
    mutationFn: () => api<{ draft: Draft; costUsd: number }>(path, { method: "POST", body: { mode, model } }),
    onSuccess: ({ draft }) => {
      void queryClient.invalidateQueries({ queryKey: ["content-brief", brief.id] });
      router.push(`/p/${projectId}/content/drafts/${draft.id}`);
    },
  });

  return (
    <Card>
      <CardHeader title="AI writer" description="Writes a first draft or an outline from this brief, saved as a new draft you can edit." />
      <div className="space-y-3 p-4">
        {!hasKey ? (
          <Note tone="warn">
            The AI writer runs on your YepAPI key.{" "}
            <Link href="/settings" className="font-semibold underline underline-offset-2">
              Add it in Settings
            </Link>{" "}
            to use it.
          </Note>
        ) : (
          <>
            <Segmented
              label="What to write"
              value={mode}
              onChange={setMode}
              options={[
                { id: "draft", label: "Full draft" },
                { id: "outline", label: "Outline" },
              ]}
            />
            <Field label="Model">
              <Select value={model} onChange={(event) => setModel(event.target.value)}>
                {CURATED_MODELS.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.assistant} ({option.id})
                  </option>
                ))}
              </Select>
            </Field>
            <p className="text-xs text-muted">
              {estimate.data
                ? `Priced per token: ${usd(estimate.data.min)} minimum${estimate.data.upTo != null ? `, up to about ${usd(estimate.data.upTo)} at list price` : ""}. Charged to your YepAPI balance.`
                : "Checking price…"}
            </p>
          </>
        )}
        <Button variant="primary" onClick={() => write.mutate()} loading={write.isPending} disabled={!hasKey || !estimate.data}>
          <Sparkles className="size-4" aria-hidden /> {mode === "draft" ? "Write a draft" : "Write an outline"}
        </Button>
        {write.isPending && <p className="text-xs text-muted">Writing; a full draft can take a minute.</p>}
        <ErrorNote error={write.error ?? estimate.error} />
      </div>
    </Card>
  );
}

function Drafts({ projectId, brief }: { projectId: string; brief: BriefDetail }) {
  const router = useRouter();
  const create = useMutation({
    mutationFn: () => api<Draft>(`/projects/${projectId}/content/briefs/${brief.id}/drafts`, { method: "POST", body: { title: "", body: "" } }),
    onSuccess: (draft) => router.push(`/p/${projectId}/content/drafts/${draft.id}`),
  });
  return (
    <Card>
      <CardHeader
        title="Drafts"
        action={
          <Button size="sm" onClick={() => create.mutate()} loading={create.isPending}>
            <Plus className="size-4" aria-hidden /> New draft
          </Button>
        }
      />
      {brief.drafts.length === 0 ? (
        <p className="p-4 text-[13px] text-muted">No drafts yet. Start one, or let the AI writer draft it.</p>
      ) : (
        <ul className="divide-y divide-line">
          {brief.drafts.map((draft) => (
            <li key={draft.id} className="flex items-center gap-3 px-4 py-2.5 text-[13px]">
              <Badge tone={scoreTone(draft.score)}>{draft.score}</Badge>
              <Link href={`/p/${projectId}/content/drafts/${draft.id}`} className="min-w-0 flex-1 truncate font-medium underline decoration-line underline-offset-2 hover:decoration-ink">
                {draft.title || "Untitled draft"}
              </Link>
              <span className="shrink-0 font-mono text-xs text-muted tabular">{num(draft.wordCount)} words</span>
              <span className="hidden shrink-0 text-xs text-muted sm:inline">{dateTime(draft.updatedAt)}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="px-4 pb-3">
        <ErrorNote error={create.error} />
      </div>
    </Card>
  );
}

export default function BriefPage() {
  const { projectId, briefId } = useParams<{ projectId: string; briefId: string }>();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const query = useQuery({
    queryKey: ["content-brief", briefId],
    queryFn: () => api<BriefDetail>(`/projects/${projectId}/content/briefs/${briefId}`),
    refetchInterval: (q) => (isActive(q.state.data?.status) ? 2000 : false),
  });
  const remove = useMutation({
    mutationFn: () => api(`/projects/${projectId}/content/briefs/${briefId}`, { method: "DELETE" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["content-briefs", projectId] });
      router.push(`/p/${projectId}/content`);
    },
  });

  if (query.isPending) return <Spinner label="Loading brief" />;
  if (query.error) return <ErrorNote error={query.error} />;
  const data = query.data;
  const brief = data.brief;
  const read = brief?.competitors.filter((c) => c.ok).length ?? 0;

  return (
    <div className="space-y-6">
      <div>
        <Link href={`/p/${projectId}/content`} className="mb-3 inline-flex items-center gap-1 text-xs text-muted hover:text-ink">
          <ChevronLeft className="size-3.5" aria-hidden /> All briefs
        </Link>
        <PageHeader
          title={data.keyword}
          description={
            <>
              {data.source === "serp" ? "Google's top results" : "Pasted pages"} · created {dateTime(data.createdAt)}
              {data.costUsd > 0 && ` · ${usd(data.costUsd)}`}
            </>
          }
          action={
            <div className="flex items-center gap-2">
              <StatusBadge status={data.status} />
              <Button variant="danger" size="sm" onClick={() => setConfirming(true)}>
                <Trash2 className="size-4" aria-hidden /> Delete
              </Button>
            </div>
          }
        />
      </div>

      {isActive(data.status) && <Spinner label={`Reading ${data.urls.length} ${data.urls.length === 1 ? "page" : "pages"}`} />}
      {data.error && <ErrorNote error={data.error} />}

      {brief && (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Recommended length" value={brief.wordCount ? `${num(brief.wordCount.min)}–${num(brief.wordCount.max)}` : "—"} sub={brief.wordCount ? `words; median ${num(brief.wordCount.median)}` : undefined} />
            <Stat label="Pages read" value={`${read} of ${brief.competitors.length}`} />
            <Stat label="Terms" value={num(brief.terms.length)} />
            <Stat label="Questions" value={num(brief.questions.length)} />
          </div>
          {read > 0 && (
            <div className="grid gap-4 lg:grid-cols-2">
              <Drafts projectId={projectId} brief={data} />
              <Writer projectId={projectId} brief={data} />
            </div>
          )}
          {read > 0 ? <Outline brief={brief} /> : <EmptyState title="No page could be read">Try other URLs: each page&apos;s error is listed below.</EmptyState>}
          <Competitors brief={brief} />
        </>
      )}

      <ConfirmDialog
        open={confirming}
        onClose={() => setConfirming(false)}
        onConfirm={() => remove.mutate()}
        title="Delete this brief?"
        confirmLabel="Delete brief"
        danger
        pending={remove.isPending}
        error={remove.error}
      >
        <p>
          The brief for <span className="font-medium text-ink">{data.keyword}</span> and its {num(data.drafts.length)} {data.drafts.length === 1 ? "draft" : "drafts"} will be deleted. This cannot be undone.
        </p>
      </ConfirmDialog>
    </div>
  );
}
