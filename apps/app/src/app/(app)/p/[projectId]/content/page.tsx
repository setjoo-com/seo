"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import { type BriefDetail, type BriefRow, type BriefSource, scoreTone } from "@/components/content/types";
import { isActive, lines, Note, Segmented, StatusBadge } from "@/components/tracking/kit";
import { Badge, Button, Card, CardHeader, EmptyState, ErrorNote, Field, Input, PageHeader, Spinner, Table, Textarea } from "@/components/ui";
import { api, dateTime, num, usd } from "@/lib/api";
import { type Project, useMe, useProject } from "@/lib/hooks";
import type { Estimate } from "@/lib/lookup";

const MAX_URLS = 10;

function NewBrief({ project, onDone }: { project: Project; onDone: () => void }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const me = useMe();
  const hasKey = Boolean(me.data?.settings.hasYepapiKey);
  const [keyword, setKeyword] = useState("");
  const [source, setSource] = useState<BriefSource>("urls");
  const [text, setText] = useState("");
  const urls = lines(text);
  const tooMany = urls.length > MAX_URLS;
  const ready = keyword.trim().length > 0 && (source === "serp" ? hasKey : urls.length > 0 && !tooMany);

  // The SERP lookup's price does not depend on the keyword, so it is asked once.
  const estimate = useQuery({
    queryKey: ["content-brief-estimate", project.id],
    queryFn: () =>
      api<{ estimate: Estimate }>(`/projects/${project.id}/content/briefs`, { method: "POST", body: { source: "serp", keyword: "price check" }, query: { dryRun: 1 } }).then((r) => r.estimate),
    enabled: source === "serp" && hasKey,
    staleTime: Infinity,
    retry: false,
  });

  const create = useMutation({
    mutationFn: () =>
      api<BriefDetail>(`/projects/${project.id}/content/briefs`, {
        method: "POST",
        body: source === "serp" ? { source, keyword: keyword.trim() } : { source, keyword: keyword.trim(), urls },
      }),
    onSuccess: (brief) => {
      void queryClient.invalidateQueries({ queryKey: ["content-briefs", project.id] });
      router.push(`/p/${project.id}/content/${brief.id}`);
    },
  });

  return (
    <Card className="mb-6">
      <CardHeader title="New content brief" description="Competitor pages for a keyword, read and summarised: length, subtopics, terms and questions to cover." />
      <form
        className="space-y-4 p-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (ready) create.mutate();
        }}
      >
        <Field label="Target keyword">
          <Input value={keyword} onChange={(event) => setKeyword(event.target.value)} maxLength={200} placeholder="winter boots for women" required />
        </Field>
        <div className="space-y-2">
          <Segmented
            label="Competitor pages"
            value={source}
            onChange={setSource}
            options={[
              { id: "urls", label: "Paste URLs (free)" },
              { id: "serp", label: "Google's top 10 (paid)" },
            ]}
          />
          {source === "urls" ? (
            <Field label="Competitor URLs" hint={`One per line, up to ${MAX_URLS}. Pages that cannot be read are listed and skipped.`}>
              <Textarea value={text} onChange={(event) => setText(event.target.value)} rows={6} className="font-mono text-[13px]" placeholder={"https://example.com/best-winter-boots\nhttps://another.com/boots-guide"} />
              {tooMany && <span className="mt-1.5 block text-xs text-neg">{urls.length} URLs entered; a brief reads up to {MAX_URLS}.</span>}
            </Field>
          ) : hasKey ? (
            <p className="text-[13px] text-muted">
              Looks up Google&apos;s first page for the keyword in {project.locationName} and reads the top {MAX_URLS} results.{" "}
              {estimate.data ? (
                <>
                  Costs <span className="font-mono text-ink">{usd(estimate.data.max ?? estimate.data.min)}</span> from your YepAPI balance, nothing if the same search ran in the last hour.
                </>
              ) : (
                "Checking price…"
              )}
            </p>
          ) : (
            <Note tone="warn">
              Using Google&apos;s results needs your YepAPI key.{" "}
              <Link href="/settings" className="font-semibold underline underline-offset-2">
                Add it in Settings
              </Link>
              , or paste the URLs yourself for free.
            </Note>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button type="submit" variant="primary" loading={create.isPending} disabled={!ready || (source === "serp" && !estimate.data)}>
            Create brief
          </Button>
          <Button variant="ghost" onClick={onDone}>
            Cancel
          </Button>
        </div>
        <ErrorNote error={create.error ?? estimate.error} />
      </form>
    </Card>
  );
}

export default function ContentPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const project = useProject(projectId);
  const briefs = useQuery({
    queryKey: ["content-briefs", projectId],
    queryFn: () => api<BriefRow[]>(`/projects/${projectId}/content/briefs`),
    refetchInterval: (query) => (query.state.data?.some((brief) => isActive(brief.status)) ? 3000 : false),
  });
  const [creating, setCreating] = useState(false);

  return (
    <>
      <PageHeader
        title="Content"
        description="Briefs built from the pages that rank, and an editor that scores your draft against them as you write."
        action={
          !creating &&
          project.data && (
            <Button variant="primary" onClick={() => setCreating(true)}>
              <Plus className="size-4" aria-hidden /> New brief
            </Button>
          )
        }
      />
      {creating && project.data && <NewBrief project={project.data} onDone={() => setCreating(false)} />}
      {(briefs.isPending || project.isPending) && <Spinner />}
      <ErrorNote error={briefs.error ?? project.error} />
      {briefs.data?.length === 0 && !creating && (
        <EmptyState
          title="No briefs yet"
          action={
            <Button variant="primary" onClick={() => setCreating(true)}>
              Create a brief
            </Button>
          }
        >
          Pick a keyword and the pages you compete with. The brief tells you how long to write, what to cover and which terms to use.
        </EmptyState>
      )}
      {briefs.data && briefs.data.length > 0 && (
        <Card>
          <Table>
            <thead>
              <tr>
                <th scope="col">Keyword</th>
                <th scope="col">Pages from</th>
                <th scope="col">Status</th>
                <th scope="col" className="text-right">
                  Length
                </th>
                <th scope="col" className="text-right">
                  Drafts
                </th>
                <th scope="col" className="text-right">
                  Best score
                </th>
                <th scope="col">Created</th>
              </tr>
            </thead>
            <tbody>
              {briefs.data.map((brief) => (
                <tr key={brief.id}>
                  <td className="min-w-48">
                    <Link href={`/p/${projectId}/content/${brief.id}`} className="font-medium underline decoration-line underline-offset-2 hover:decoration-ink">
                      {brief.keyword}
                    </Link>
                  </td>
                  <td className="whitespace-nowrap text-muted">
                    {brief.source === "serp" ? "Google top 10" : "Pasted"} · {num(brief.pages)}
                  </td>
                  <td>
                    <StatusBadge status={brief.status} />
                  </td>
                  <td className="text-right font-mono whitespace-nowrap tabular">{brief.wordCount ? `${num(brief.wordCount.min)}–${num(brief.wordCount.max)}` : "—"}</td>
                  <td className="text-right font-mono tabular">{num(brief.drafts)}</td>
                  <td className="text-right">{brief.bestScore == null ? <span className="text-faint">—</span> : <Badge tone={scoreTone(brief.bestScore)}>{brief.bestScore}</Badge>}</td>
                  <td className="whitespace-nowrap text-muted">{dateTime(brief.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}
    </>
  );
}
