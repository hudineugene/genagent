"use client";

import { useState, useTransition } from "react";
import { Check, ClipboardCheck, X } from "lucide-react";
import { decideApprovalAction } from "@/app/actions/approvals";
import { useI18n } from "@/lib/i18n/client";
import { Badge, Button, Card, EmptyState, Input } from "@/components/ui";

export type ApprovalRow = {
  id: string;
  number: number;
  requester: string;
  agent: string;
  subject: string;
  details: string;
  amount: string;
  status: "pending" | "approved" | "rejected";
  decidedBy: string;
  comment: string;
  at: number;
  decidedAt: number | null;
};

export function ApprovalsManager({ rows }: { rows: ApprovalRow[] }) {
  const { t, locale } = useI18n();
  const a = t.approvals;
  const fmt = new Intl.DateTimeFormat(locale === "uk" ? "uk-UA" : "ru-RU", { dateStyle: "short", timeStyle: "short" });
  return (
    <div className="space-y-4">
      <p className="max-w-3xl text-sm text-muted">{a.subtitle}</p>
      {rows.length === 0 && <EmptyState icon={<ClipboardCheck />} text={a.empty} />}
      {rows.map((r) => (
        <ApprovalCard key={r.id} row={r} when={fmt.format(r.at)} decided={r.decidedAt ? fmt.format(r.decidedAt) : ""} />
      ))}
    </div>
  );
}

function ApprovalCard({ row, when, decided }: { row: ApprovalRow; when: string; decided: string }) {
  const { t } = useI18n();
  const a = t.approvals;
  const [comment, setComment] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const decide = (approve: boolean) =>
    start(async () => {
      const r = await decideApprovalAction(row.id, approve, comment);
      if (r.error) setError(a.errors[r.error as keyof typeof a.errors] ?? r.error);
    });
  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold">
          №{row.number} · {row.subject}
        </span>
        <Badge tone={row.status === "pending" ? "warning" : row.status === "approved" ? "success" : "neutral"}>{a.statuses[row.status]}</Badge>
      </div>
      <p className="mt-1 text-xs text-muted">
        {when} · {row.requester || "—"} · {row.agent}
      </p>
      {row.details && <p className="mt-2 whitespace-pre-wrap text-sm">{row.details}</p>}
      {row.amount && <p className="mt-1 text-sm font-medium">💶 {row.amount}</p>}
      {row.status !== "pending" ? (
        <p className="mt-2 text-xs text-muted">
          {decided} · {row.decidedBy}
          {row.comment && ` · «${row.comment}»`}
        </p>
      ) : (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Input className="min-w-56 flex-1" value={comment} maxLength={1000} placeholder={a.comment} onChange={(e) => setComment(e.target.value)} />
          <Button size="sm" disabled={pending} onClick={() => decide(true)}>
            <Check className="size-4" />
            {a.approve}
          </Button>
          <Button size="sm" variant="secondary" disabled={pending} onClick={() => decide(false)}>
            <X className="size-4" />
            {a.reject}
          </Button>
        </div>
      )}
      {error && <p className="mt-2 text-sm text-danger">{error}</p>}
    </Card>
  );
}
