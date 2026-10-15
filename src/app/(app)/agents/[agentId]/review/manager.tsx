"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { Check, Lightbulb, MessageSquareText, RefreshCw, Target, X } from "lucide-react";
import { applyReviewProposal, rejectReviewProposal, reviewAgentNow } from "@/app/actions/review";
import type { AgentReview, ReviewProposal } from "@/lib/agent/review";
import { useI18n } from "@/lib/i18n/client";
import { Badge, Button, Card, Spinner } from "@/components/ui";

/** Разбор недели: «Чего хотят клиенты» и предложенные правки правил агента. */
export function ReviewManager({ agentId, review }: { agentId: string; review: AgentReview | null }) {
  const { t, locale } = useI18n();
  const r = t.review;
  const [pending, start] = useTransition();
  const [note, setNote] = useState<string | null>(null);
  const fmt = new Intl.DateTimeFormat(locale === "uk" ? "uk-UA" : "ru-RU", { dateStyle: "medium" });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-2xl text-sm text-muted">{r.subtitle}</p>
        <div className="flex items-center gap-2">
          {note && <span className="text-sm text-muted">{note}</span>}
          <Button
            variant="secondary"
            size="sm"
            disabled={pending}
            onClick={() =>
              start(async () => {
                const res = await reviewAgentNow(agentId);
                setNote(res.error ? (r.errors[res.error as keyof typeof r.errors] ?? res.error) : r.done);
              })
            }
          >
            {pending ? <Spinner /> : <RefreshCw className="size-4" />}
            {r.runNow}
          </Button>
        </div>
      </div>

      {!review ? (
        <Card className="p-8 text-center text-sm text-muted">{r.empty}</Card>
      ) : (
        <>
          <Card className="space-y-4 p-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="font-medium">{r.demandTitle}</div>
              <span className="text-xs text-muted">
                {fmt.format(new Date(review.since))} — {fmt.format(new Date(review.at))} · {r.conversations.replace("{n}", String(review.conversations))}
              </span>
            </div>
            {review.summary && <p className="text-sm">{review.summary}</p>}
            {review.unmet.length > 0 && (
              <div className="space-y-2">
                <div className="flex items-center gap-1.5 text-sm font-medium">
                  <Target className="size-4 text-warning" />
                  {r.unmet}
                </div>
                {review.unmet.map((u, i) => (
                  <div key={i} className="rounded-xl bg-surface-2 px-3 py-2 text-sm">
                    <div className="flex items-start justify-between gap-2">
                      <span className="font-medium">{u.demand}</span>
                      <Badge tone={u.count > 2 ? "warning" : "neutral"}>{r.times.replace("{n}", String(u.count))}</Badge>
                    </div>
                    {u.detail && <div className="mt-0.5 text-muted">{u.detail}</div>}
                  </div>
                ))}
              </div>
            )}
            {review.topics.length > 0 && (
              <div className="space-y-1.5">
                <div className="text-sm font-medium">{r.topics}</div>
                <div className="flex flex-wrap gap-1.5">
                  {review.topics.map((tp, i) => (
                    <span key={i} className="rounded-full bg-surface-2 px-3 py-1 text-sm">
                      {tp.topic} <span className="text-muted">· {tp.count}</span>
                    </span>
                  ))}
                </div>
              </div>
            )}
            {review.ideas.length > 0 && (
              <div className="space-y-1.5">
                <div className="flex items-center gap-1.5 text-sm font-medium">
                  <Lightbulb className="size-4 text-accent" />
                  {r.ideas}
                </div>
                <ul className="list-disc space-y-1 pl-5 text-sm">
                  {review.ideas.map((idea, i) => (
                    <li key={i}>{idea}</li>
                  ))}
                </ul>
              </div>
            )}
          </Card>

          <div className="pt-2 font-medium">{r.proposalsTitle}</div>
          <p className="-mt-2 text-sm text-muted">{r.proposalsHint}</p>
          {review.proposals.length === 0 ? (
            <Card className="p-6 text-center text-sm text-muted">{r.noProposals}</Card>
          ) : (
            review.proposals.map((p) => <ProposalCard key={p.id} agentId={agentId} p={p} />)
          )}
        </>
      )}
    </div>
  );
}

function ProposalCard({ agentId, p }: { agentId: string; p: ReviewProposal }) {
  const { t } = useI18n();
  const r = t.review;
  const [pending, start] = useTransition();
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  return (
    <Card className="space-y-3 p-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="font-medium">{p.title}</div>
          <div className="mt-0.5 text-sm text-muted">{p.why}</div>
        </div>
        {p.status !== "new" && <Badge tone={p.status === "applied" ? "success" : "neutral"}>{r.status[p.status]}</Badge>}
      </div>
      <div className="space-y-1.5 rounded-xl border border-border px-3 py-2 text-sm">
        <div className="text-xs text-muted">
          {r.field[p.field]} · {r.action[p.action]}
        </div>
        {p.action === "replace" && <div className="text-danger line-through">{p.find}</div>}
        <div className="text-success">{p.text}</div>
      </div>
      {p.conversationIds.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {p.conversationIds.map((id, i) => (
            <Link key={id} href={`/inbox?c=${id}`} className="flex items-center gap-1 rounded-full bg-surface-2 px-2.5 py-1 text-xs hover:text-accent">
              <MessageSquareText className="size-3.5" />
              {r.example} {i + 1}
            </Link>
          ))}
        </div>
      )}
      {error && <p className="text-sm text-danger">{error}</p>}
      {note && <p className="text-sm text-success">{note}</p>}
      {p.status === "new" && (
        <div className="flex flex-wrap justify-end gap-2">
          <Button size="sm" variant="ghost" disabled={pending} onClick={() => start(async () => void (await rejectReviewProposal(agentId, p.id)))}>
            <X className="size-4" />
            {r.reject}
          </Button>
          <Button
            size="sm"
            disabled={pending}
            onClick={() =>
              start(async () => {
                const res = await applyReviewProposal(agentId, p.id);
                if (res.error) setError(r.errors[res.error as keyof typeof r.errors] ?? res.error);
                else setNote(res.tests ? r.appliedTests : r.applied);
              })
            }
          >
            {pending ? <Spinner /> : <Check className="size-4" />}
            {r.apply}
          </Button>
        </div>
      )}
    </Card>
  );
}
