"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { Check, EyeOff, MessageSquareText, RefreshCw, RotateCcw } from "lucide-react";
import { analyzeGapsNow, resolveGap, setGapStatus } from "@/app/actions/gaps";
import { useI18n } from "@/lib/i18n/client";
import { Badge, Button, Card, Spinner, Textarea, cx } from "@/components/ui";

type Gap = {
  id: string;
  question: string;
  missing: string;
  count: number;
  status: "open" | "resolved" | "ignored";
  answer: string | null;
  lastSeenAt: number;
  examples: { conversationId: string; quote: string; at: number }[];
};

/** Вопросы, на которые агенту не хватило информации: добавить ответ в базу знаний или скрыть. */
export function GapsManager({ agentId, clientId, gaps }: { agentId: string; clientId: string; gaps: Gap[] }) {
  const { t } = useI18n();
  const g = t.gaps;
  const [tab, setTab] = useState<"open" | "resolved" | "ignored">("open");
  const [pending, start] = useTransition();
  const [result, setResult] = useState<string | null>(null);
  const shown = gaps.filter((x) => x.status === tab);
  const counts = { open: 0, resolved: 0, ignored: 0 };
  for (const x of gaps) counts[x.status]++;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-2xl text-sm text-muted">{g.subtitle}</p>
        <div className="flex items-center gap-2">
          {result && <span className="text-sm text-muted">{result}</span>}
          <Button
            variant="secondary"
            size="sm"
            disabled={pending}
            onClick={() =>
              start(async () => {
                const r = await analyzeGapsNow(agentId);
                setResult(r.error ? r.error : g.checked.replace("{n}", String(r.found ?? 0)));
              })
            }
          >
            {pending ? <Spinner /> : <RefreshCw className="size-4" />}
            {g.checkNow}
          </Button>
        </div>
      </div>

      <div className="flex gap-1">
        {(["open", "resolved", "ignored"] as const).map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => setTab(k)}
            className={cx("rounded-full px-3 py-1.5 text-sm", tab === k ? "bg-text text-bg" : "bg-surface-2 text-muted hover:text-text")}
          >
            {g.tabs[k]} {counts[k] > 0 && <span className="opacity-70">· {counts[k]}</span>}
          </button>
        ))}
      </div>

      {shown.length === 0 ? (
        <Card className="p-8 text-center text-sm text-muted">{tab === "open" ? g.emptyOpen : g.empty}</Card>
      ) : (
        shown.map((gap) => <GapCard key={gap.id} gap={gap} clientId={clientId} />)
      )}
    </div>
  );
}

function GapCard({ gap, clientId }: { gap: Gap; clientId: string }) {
  const { t, locale } = useI18n();
  const g = t.gaps;
  const [answer, setAnswer] = useState("");
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const fmt = new Intl.DateTimeFormat(locale === "uk" ? "uk-UA" : "ru-RU", { dateStyle: "medium" });

  return (
    <Card className="space-y-3 p-5">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="font-medium">{gap.question}</div>
          {gap.missing && <div className="mt-0.5 text-sm text-muted">{g.missing}: {gap.missing}</div>}
        </div>
        <Badge tone={gap.count > 2 ? "warning" : "neutral"}>{g.times.replace("{n}", String(gap.count))}</Badge>
      </div>

      {gap.examples.length > 0 && (
        <div className="space-y-1.5">
          {gap.examples.slice(0, 3).map((e, i) => (
            <Link
              key={i}
              href={`/inbox?c=${e.conversationId}`}
              className="flex items-start gap-2 rounded-xl bg-surface-2 px-3 py-2 text-sm hover:bg-surface-2/70"
            >
              <MessageSquareText className="mt-0.5 size-4 shrink-0 text-muted" />
              <span className="min-w-0 flex-1 line-clamp-2">{e.quote}</span>
              <span className="shrink-0 text-xs text-muted">{fmt.format(new Date(e.at))}</span>
            </Link>
          ))}
        </div>
      )}

      {gap.status === "resolved" && gap.answer && (
        <div className="rounded-xl border border-success/30 bg-success/5 px-3 py-2 text-sm">
          <span className="font-medium text-success">{g.answered}: </span>
          {gap.answer}
        </div>
      )}

      {gap.status === "open" && editing && (
        <div className="space-y-2">
          <Textarea rows={3} value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder={g.answerPlaceholder} autoFocus />
          <p className="text-xs text-muted">
            {g.answerHint}{" "}
            <Link href={`/clients/${clientId}?tab=kb`} className="text-accent hover:underline">
              {t.builder.kbManage} →
            </Link>
          </p>
        </div>
      )}
      {error && <p className="text-sm text-danger">{error}</p>}

      <div className="flex flex-wrap justify-end gap-2">
        {gap.status === "open" && !editing && (
          <>
            <Button size="sm" variant="ghost" disabled={pending} onClick={() => start(async () => void (await setGapStatus(gap.id, "ignored")))}>
              <EyeOff className="size-4" />
              {g.hide}
            </Button>
            <Button size="sm" onClick={() => setEditing(true)}>
              {g.addAnswer}
            </Button>
          </>
        )}
        {gap.status === "open" && editing && (
          <>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              {t.common.cancel}
            </Button>
            <Button
              size="sm"
              disabled={pending || answer.trim().length < 2}
              onClick={() =>
                start(async () => {
                  const r = await resolveGap(gap.id, answer);
                  if (r.error) setError(g.errors[r.error as keyof typeof g.errors] ?? r.error);
                })
              }
            >
              {pending ? <Spinner /> : <Check className="size-4" />}
              {g.save}
            </Button>
          </>
        )}
        {gap.status === "ignored" && (
          <Button size="sm" variant="ghost" disabled={pending} onClick={() => start(async () => void (await setGapStatus(gap.id, "open")))}>
            <RotateCcw className="size-4" />
            {g.restore}
          </Button>
        )}
      </div>
    </Card>
  );
}
