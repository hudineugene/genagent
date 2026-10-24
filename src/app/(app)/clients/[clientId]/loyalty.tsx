"use client";

import { useState, useTransition } from "react";
import { Copy, Gift, KeyRound, Minus, Pencil, Plus, Trash2, X } from "lucide-react";
import { adjustPoints, deleteAccount, renewProgramKey, saveProgram } from "@/app/actions/loyalty";
import { useI18n } from "@/lib/i18n/client";
import { Badge, Button, Card, Field, Input, Textarea } from "@/components/ui";
import type { LoyaltyReward } from "@/db/schema";
import { ask } from "@/components/confirm-dialog";

export type ProgramRow = {
  id: string;
  name: string;
  unit: string;
  rules: string;
  rewards: LoyaltyReward[];
  welcome: number;
  peerAllowance: number;
  notifyCustomer: boolean;
  enabled: boolean;
  apiKey: string;
  usedBy: string[];
};
export type AccountRow = { id: string; contact: string; name: string; balance: number; updatedAt: number };
export type TxRow = { contact: string; name: string; delta: number; balance: number; reason: string; source: string; at: number };
export type PeerStats = { top: { who: string; points: number }[]; recent: { to: string; delta: number; reason: string; at: number }[] };
type Draft = Omit<ProgramRow, "id" | "apiKey" | "usedBy">;

const EMPTY: Draft = { name: "Бонусы", unit: "баллов", rules: "", rewards: [{ name: "", cost: 100 }], welcome: 0, peerAllowance: 0, notifyCustomer: true, enabled: true };

export function LoyaltyManager({
  clientId,
  program,
  accounts,
  tx,
  apiBase,
  peer,
}: {
  clientId: string;
  program: ProgramRow | null;
  accounts: AccountRow[];
  tx: TxRow[];
  apiBase: string;
  peer?: PeerStats;
}) {
  const { t, locale } = useI18n();
  const l = t.loyalty;
  const [editing, setEditing] = useState(!program);
  const [q, setQ] = useState("");
  const fmt = new Intl.DateTimeFormat(locale === "uk" ? "uk-UA" : "ru-RU", { dateStyle: "short", timeStyle: "short" });
  const shown = accounts.filter((a) => !q.trim() || `${a.contact} ${a.name}`.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <div className="space-y-6">
      <p className="max-w-3xl text-sm text-muted">{l.subtitle}</p>
      {editing ? (
        <ProgramEditor clientId={clientId} id={program?.id ?? null} initial={program ?? EMPTY} onDone={() => setEditing(false)} canCancel={Boolean(program)} />
      ) : (
        program && (
          <Card className="p-5">
            <div className="flex flex-wrap items-start gap-3">
              <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-surface-2 text-accent">
                <Gift className="size-5" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold">{program.name}</span>
                  {!program.enabled && <Badge tone="warning">{t.status.paused}</Badge>}
                </div>
                {program.rules && <p className="mt-1 text-sm text-muted">{program.rules}</p>}
                <p className="mt-1 text-xs text-muted">
                  {l.rewardsList}: {program.rewards.map((r) => `${r.name} — ${r.cost}`).join(" · ") || "—"}
                  {program.welcome > 0 && ` · ${l.welcomeShort.replace("{n}", String(program.welcome))}`}
                  {program.peerAllowance > 0 && ` · ${l.peerShort.replace("{n}", String(program.peerAllowance))}`}
                  {program.usedBy.length > 0 && ` · ${t.tools.usedBy}: ${program.usedBy.join(", ")}`}
                </p>
              </div>
              <Button variant="ghost" size="sm" title={l.edit} onClick={() => setEditing(true)}>
                <Pencil className="size-4" />
              </Button>
            </div>
            <ApiBox program={program} apiBase={apiBase} />
          </Card>
        )
      )}
      {program && (
        <>
          <AdjustForm programId={program.id} unit={program.unit} />
          {program.peerAllowance > 0 && peer && (
            <section className="space-y-2">
              <h2 className="text-base font-semibold">{l.peerTitle}</h2>
              {peer.recent.length === 0 ? (
                <p className="text-sm text-muted">{l.peerEmpty}</p>
              ) : (
                <div className="grid gap-3 lg:grid-cols-2">
                  <Card className="p-4">
                    <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">{l.peerTop}</div>
                    <ol className="space-y-1 text-sm">
                      {peer.top.map((x, i) => (
                        <li key={i} className="flex justify-between gap-2">
                          <span>
                            {i + 1}. {x.who}
                          </span>
                          <b>+{x.points}</b>
                        </li>
                      ))}
                    </ol>
                  </Card>
                  <Card className="divide-y divide-border text-sm">
                    {peer.recent.map((x, i) => (
                      <div key={i} className="px-4 py-2">
                        <b className="text-success">+{x.delta}</b> {x.to} · <span className="text-muted">{x.reason}</span>
                      </div>
                    ))}
                  </Card>
                </div>
              )}
            </section>
          )}
          <section className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-base font-semibold">
                {l.accounts} · {accounts.length}
              </h2>
              <Input className="w-64" value={q} placeholder={l.search} onChange={(e) => setQ(e.target.value)} />
            </div>
            {shown.length === 0 ? (
              <p className="text-sm text-muted">{l.noAccounts}</p>
            ) : (
              <Card className="divide-y divide-border">
                {shown.slice(0, 200).map((a) => (
                  <AccountLine key={a.id} row={a} unit={program.unit} when={fmt.format(a.updatedAt)} />
                ))}
              </Card>
            )}
          </section>
          {tx.length > 0 && (
            <section className="space-y-2">
              <h2 className="text-base font-semibold">{l.history}</h2>
              <Card className="divide-y divide-border text-sm">
                {tx.map((x, i) => (
                  <div key={i} className="flex flex-wrap items-center gap-2 px-4 py-2">
                    <span className={x.delta > 0 ? "w-20 font-semibold text-success" : "w-20 font-semibold text-danger"}>
                      {x.delta > 0 ? "+" : ""}
                      {x.delta}
                    </span>
                    <span className="min-w-0 flex-1 truncate">
                      {x.name || x.contact} · {x.reason || "—"}
                    </span>
                    <span className="text-xs text-muted">
                      {l.sources[x.source as keyof typeof l.sources] ?? x.source} · {l.balanceAfter.replace("{n}", String(x.balance))} · {fmt.format(x.at)}
                    </span>
                  </div>
                ))}
              </Card>
            </section>
          )}
        </>
      )}
    </div>
  );
}

function ApiBox({ program, apiBase }: { program: ProgramRow; apiBase: string }) {
  const { t } = useI18n();
  const l = t.loyalty;
  const [show, setShow] = useState(false);
  const [pending, start] = useTransition();
  const url = `${apiBase}/api/loyalty/${program.id}`;
  const curl = `curl -X POST ${url} \\\n  -H "Authorization: Bearer ${show ? program.apiKey : "<ключ>"}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"contact":"+380671234567","name":"Иван","delta":50,"reason":"Покупка №1024"}'`;
  return (
    <div className="mt-4 space-y-2 border-t border-border pt-3">
      <div className="flex items-center gap-2 text-sm font-semibold">
        <KeyRound className="size-4 text-accent" />
        {l.api}
      </div>
      <p className="text-xs text-muted">{l.apiHint}</p>
      <div className="flex flex-wrap items-center gap-2">
        <code className="rounded bg-surface-2 px-2 py-1 font-mono text-xs">{show ? program.apiKey : "lp_••••••••••••"}</code>
        <Button variant="ghost" size="sm" onClick={() => setShow(!show)}>
          {show ? l.hide : l.show}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => void navigator.clipboard.writeText(program.apiKey)}>
          <Copy className="size-4" />
        </Button>
        <Button variant="ghost" size="sm" disabled={pending} onClick={async () => await ask(l.confirmRenew) && start(() => renewProgramKey(program.id))}>
          {l.renew}
        </Button>
      </div>
      <pre className="overflow-x-auto rounded-lg bg-surface-2 p-3 font-mono text-xs">{curl}</pre>
    </div>
  );
}

function ProgramEditor({ clientId, id, initial, onDone, canCancel }: { clientId: string; id: string | null; initial: Draft; onDone: () => void; canCancel: boolean }) {
  const { t } = useI18n();
  const l = t.loyalty;
  const [d, setD] = useState<Draft>({ name: initial.name, unit: initial.unit, rules: initial.rules, rewards: initial.rewards.length ? initial.rewards : EMPTY.rewards, welcome: initial.welcome, peerAllowance: initial.peerAllowance ?? 0, notifyCustomer: initial.notifyCustomer, enabled: initial.enabled });
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD({ ...d, [k]: v });
  const setReward = (i: number, p: Partial<LoyaltyReward>) => set("rewards", d.rewards.map((r, j) => (j === i ? { ...r, ...p } : r)));
  const submit = () =>
    start(async () => {
      const r = await saveProgram(clientId, id, { ...d, rewards: d.rewards.filter((x) => x.name.trim()) });
      if (r.error) setError((l.errors as Record<string, string>)[r.error] ?? r.error);
      else onDone();
    });
  return (
    <Card className="space-y-4 p-5">
      <div className="flex items-center gap-2 font-semibold">
        <Gift className="size-4 text-accent" />
        {id ? l.editTitle : l.newTitle}
      </div>
      <div className="flex flex-wrap gap-3">
        <Field label={l.name}>
          <Input className="w-56" value={d.name} maxLength={100} onChange={(e) => set("name", e.target.value)} />
        </Field>
        <Field label={l.unit} hint={l.unitHint}>
          <Input className="w-40" value={d.unit} maxLength={30} onChange={(e) => set("unit", e.target.value)} />
        </Field>
        <Field label={l.peerAllowance} hint={l.peerHint}>
          <Input type="number" min={0} className="w-32" value={d.peerAllowance} onChange={(e) => set("peerAllowance", Math.max(0, Math.round(Number(e.target.value) || 0)))} />
        </Field>
        <Field label={l.welcome}>
          <Input type="number" min={0} className="w-32" value={d.welcome} onChange={(e) => set("welcome", Math.max(0, Math.round(Number(e.target.value) || 0)))} />
        </Field>
      </div>
      <Field label={l.rules} hint={l.rulesHint}>
        <Textarea rows={3} value={d.rules} maxLength={3000} placeholder={l.rulesPlaceholder} onChange={(e) => set("rules", e.target.value)} />
      </Field>
      <div className="space-y-2">
        <div className="text-sm font-semibold">{l.rewardsTitle}</div>
        {d.rewards.map((r, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2">
            <Input className="min-w-56 flex-1" value={r.name} maxLength={200} placeholder={l.rewardName} onChange={(e) => setReward(i, { name: e.target.value })} />
            <Input type="number" min={1} className="w-32" value={r.cost} title={l.rewardCost} onChange={(e) => setReward(i, { cost: Math.max(1, Math.round(Number(e.target.value) || 1)) })} />
            <span className="text-xs text-muted">{d.unit}</span>
            <Button variant="ghost" size="sm" onClick={() => set("rewards", d.rewards.filter((_, j) => j !== i))}>
              <X className="size-4" />
            </Button>
          </div>
        ))}
        <Button variant="secondary" size="sm" onClick={() => set("rewards", [...d.rewards, { name: "", cost: 100 }])}>
          <Plus className="size-4" />
          {l.addReward}
        </Button>
      </div>
      <div className="flex flex-wrap gap-6">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" className="size-4 accent-[var(--accent)]" checked={d.notifyCustomer} onChange={(e) => set("notifyCustomer", e.target.checked)} />
          {l.notifyCustomer}
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" className="size-4 accent-[var(--accent)]" checked={d.enabled} onChange={(e) => set("enabled", e.target.checked)} />
          {l.enabled}
        </label>
      </div>
      {error && <p className="text-sm text-danger">{error}</p>}
      <div className="flex gap-2">
        <Button disabled={pending || !d.name.trim() || !d.unit.trim()} onClick={submit}>
          {l.save}
        </Button>
        {canCancel && (
          <Button variant="ghost" onClick={onDone}>
            {l.cancel}
          </Button>
        )}
      </div>
    </Card>
  );
}

function AdjustForm({ programId, unit }: { programId: string; unit: string }) {
  const { t } = useI18n();
  const l = t.loyalty;
  const [v, setV] = useState({ contact: "", name: "", amount: 50, reason: "" });
  const [msg, setMsg] = useState<{ error?: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const go = (sign: 1 | -1) =>
    start(async () => {
      const r = await adjustPoints(programId, { contact: v.contact, name: v.name, delta: sign * v.amount, reason: v.reason });
      if (r.error) setMsg({ error: true, text: (l.errors as Record<string, string>)[r.error] ?? r.error });
      else {
        setMsg({ text: l.done.replace("{n}", `${r.balance} ${unit}`) });
        setV({ ...v, reason: "" });
      }
    });
  return (
    <Card className="space-y-3 p-5">
      <div className="text-sm font-semibold">{l.adjust}</div>
      <div className="flex flex-wrap items-end gap-2">
        <Field label={l.contact} hint={l.contactHint}>
          <Input className="w-56" value={v.contact} maxLength={200} placeholder="@ivan / +380… / 123456789" onChange={(e) => setV({ ...v, contact: e.target.value })} />
        </Field>
        <Field label={l.personName}>
          <Input className="w-44" value={v.name} maxLength={100} onChange={(e) => setV({ ...v, name: e.target.value })} />
        </Field>
        <Field label={unit}>
          <Input type="number" min={1} className="w-28" value={v.amount} onChange={(e) => setV({ ...v, amount: Math.max(1, Math.round(Number(e.target.value) || 1)) })} />
        </Field>
        <Field label={l.reason}>
          <Input className="w-56" value={v.reason} maxLength={300} placeholder={l.reasonPlaceholder} onChange={(e) => setV({ ...v, reason: e.target.value })} />
        </Field>
      </div>
      <div className="flex gap-2">
        <Button size="sm" disabled={pending || !v.contact.trim()} onClick={() => go(1)}>
          <Plus className="size-4" />
          {l.add}
        </Button>
        <Button size="sm" variant="secondary" disabled={pending || !v.contact.trim()} onClick={() => go(-1)}>
          <Minus className="size-4" />
          {l.subtract}
        </Button>
      </div>
      {msg && <p className={msg.error ? "text-sm text-danger" : "text-sm text-success"}>{msg.text}</p>}
    </Card>
  );
}

function AccountLine({ row, unit, when }: { row: AccountRow; unit: string; when: string }) {
  const { t } = useI18n();
  const [pending, start] = useTransition();
  return (
    <div className="flex flex-wrap items-center gap-2 px-4 py-2 text-sm">
      <span className="min-w-0 flex-1 truncate">
        <span className="font-medium">{row.name || row.contact}</span>
        {row.name && <span className="ml-2 font-mono text-xs text-muted">{row.contact}</span>}
      </span>
      <span className="font-semibold">
        {row.balance} {unit}
      </span>
      <span className="w-28 text-right text-xs text-muted">{when}</span>
      <Button variant="ghost" size="sm" disabled={pending} title={t.loyalty.deleteAccount} onClick={async () => await ask(t.loyalty.confirmDeleteAccount) && start(() => deleteAccount(row.id))}>
        <Trash2 className="size-4" />
      </Button>
    </div>
  );
}
