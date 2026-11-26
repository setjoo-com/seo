"use client";

import { scoreContent } from "@openseo/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, Save, Trash2 } from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { ScorePanel } from "@/components/content/score";
import type { Draft } from "@/components/content/types";
import { ConfirmDialog } from "@/components/tracking/kit";
import { Button, Card, ErrorNote, Field, Input, Spinner, Textarea } from "@/components/ui";
import { api, dateTime, usd } from "@/lib/api";

function Editor({ projectId, draft }: { projectId: string; draft: Draft }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [title, setTitle] = useState(draft.title);
  const [body, setBody] = useState(draft.body);
  const [confirming, setConfirming] = useState(false);
  const dirty = title !== draft.title || body !== draft.body;

  // Scored from deferred values, so typing stays smooth on long drafts.
  const deferredTitle = useDeferredValue(title);
  const deferredBody = useDeferredValue(body);
  const score = useMemo(
    () => scoreContent({ keyword: draft.brief.keyword, title: deferredTitle, body: deferredBody, brief: draft.brief.brief }),
    [draft.brief, deferredTitle, deferredBody],
  );

  const save = useMutation({
    mutationFn: () => api<Draft>(`/projects/${projectId}/content/drafts/${draft.id}`, { method: "PUT", body: { title, body } }),
    onSuccess: (saved) => {
      queryClient.setQueryData<Draft>(["content-draft", draft.id], (old) => (old ? { ...old, ...saved, brief: old.brief } : old));
      void queryClient.invalidateQueries({ queryKey: ["content-brief", draft.briefId] });
    },
  });
  const remove = useMutation({
    mutationFn: () => api(`/projects/${projectId}/content/drafts/${draft.id}`, { method: "DELETE" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["content-brief", draft.briefId] });
      router.push(`/p/${projectId}/content/${draft.briefId}`);
    },
  });

  // Ctrl/Cmd+S saves; leaving with unsaved changes asks first.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "s") {
        event.preventDefault();
        if (dirty && !save.isPending) save.mutate();
      }
    };
    const onLeave = (event: BeforeUnloadEvent) => {
      if (dirty) event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("beforeunload", onLeave);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("beforeunload", onLeave);
    };
  }, [dirty, save]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <Link href={`/p/${projectId}/content/${draft.briefId}`} className="inline-flex items-center gap-1 text-xs text-muted hover:text-ink">
            <ChevronLeft className="size-3.5" aria-hidden /> Brief: {draft.brief.keyword}
          </Link>
          <p className="mt-1 text-xs text-muted">
            {dirty ? "Unsaved changes" : `Saved ${dateTime(draft.updatedAt)}`}
            {draft.aiModel && ` · first written by ${draft.aiModel}${draft.aiCostUsd != null ? ` for ${usd(draft.aiCostUsd)}` : ""}`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="danger" size="sm" onClick={() => setConfirming(true)}>
            <Trash2 className="size-4" aria-hidden /> Delete
          </Button>
          <Button variant="primary" onClick={() => save.mutate()} loading={save.isPending} disabled={!dirty}>
            <Save className="size-4" aria-hidden /> Save
          </Button>
        </div>
      </div>
      <ErrorNote error={save.error} />

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
        <Card className="space-y-3 p-4">
          <Field label="Title" hint="The page title. Without a # heading in the text, it is also the H1.">
            <Input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={300} placeholder={`A title with "${draft.brief.keyword}"`} />
          </Field>
          <Field label="Text" hint="Markdown: # for the H1, ## and ### for sections, - for lists.">
            <Textarea
              value={body}
              onChange={(event) => setBody(event.target.value)}
              rows={30}
              maxLength={200_000}
              spellCheck
              className="font-mono text-[13px] leading-relaxed"
              placeholder={`# ${draft.brief.keyword}\n\nOpen with what the reader came for…\n\n## First section`}
            />
          </Field>
        </Card>
        <div className="lg:sticky lg:top-4">
          <ScorePanel score={score} brief={draft.brief.brief} />
        </div>
      </div>

      <ConfirmDialog
        open={confirming}
        onClose={() => setConfirming(false)}
        onConfirm={() => remove.mutate()}
        title="Delete this draft?"
        confirmLabel="Delete draft"
        danger
        pending={remove.isPending}
        error={remove.error}
      >
        <p>This cannot be undone.</p>
      </ConfirmDialog>
    </div>
  );
}

export default function DraftPage() {
  const { projectId, draftId } = useParams<{ projectId: string; draftId: string }>();
  const draft = useQuery({
    queryKey: ["content-draft", draftId],
    queryFn: () => api<Draft>(`/projects/${projectId}/content/drafts/${draftId}`),
    refetchOnWindowFocus: false,
  });
  if (draft.isPending) return <Spinner label="Loading draft" />;
  if (draft.error) return <ErrorNote error={draft.error} />;
  // Keyed by draft, so the editor's text starts from the saved version of the draft it shows.
  return <Editor key={draft.data.id} projectId={projectId} draft={draft.data} />;
}
