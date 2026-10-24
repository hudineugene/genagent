"use client";

import { useActionState, useState, useTransition } from "react";
import { Check, Copy, KeyRound, ShieldOff, Trash2, UserPlus } from "lucide-react";
import {
  addMember,
  deleteMember,
  resetMemberTwoFactor,
  setMemberClients,
  resetMemberPassword,
  setMemberRole,
  type TeamResult,
} from "@/app/actions/team";
import { useI18n } from "@/lib/i18n/client";
import { Badge, Button, Card, Field, Input, Select, Spinner, cx } from "@/components/ui";

type Role = "admin" | "member";
type Member = { id: string; name: string; email: string; role: Role; createdAt: Date; clientIds: string[] | null; totp: boolean };
type ErrorKey = keyof ReturnType<typeof useI18n>["t"]["team"]["errors"];

export function TeamManager({ members, meId, clients }: { members: Member[]; meId: string; clients: { id: string; name: string }[] }) {
  const { t, locale } = useI18n();
  const [creds, setCreds] = useState<{ title: string; email: string; password: string } | null>(null);
  const [addState, addAction, adding] = useActionState(
    async (prev: TeamResult | undefined, formData: FormData) => {
      const r = await addMember(prev, formData);
      if (r.password && r.email) setCreds({ title: t.team.created, email: r.email, password: r.password });
      return r;
    },
    undefined,
  );
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [, start] = useTransition();
  const fmt = new Intl.DateTimeFormat(locale === "uk" ? "uk-UA" : "ru-RU", { dateStyle: "medium" });

  const errText = (code?: string) => (code ? (t.team.errors[code as ErrorKey] ?? code) : null);

  const act = (id: string, fn: () => Promise<TeamResult>, onOk?: (r: TeamResult) => void) => {
    setError(null);
    setBusyId(id);
    start(async () => {
      const r = await fn();
      setBusyId(null);
      if (r.error) setError(errText(r.error));
      else onOk?.(r);
    });
  };

  return (
    <div className="space-y-6">
      {creds && <CredsCard {...creds} onClose={() => setCreds(null)} />}

      <Card className="p-6">
        <h2 className="mb-4 flex items-center gap-2 font-semibold">
          <UserPlus className="size-[18px] text-accent" />
          {t.team.add}
        </h2>
        <form
          action={addAction}
          className="grid grid-cols-1 gap-4 sm:grid-cols-[1fr_1fr_180px_auto] sm:items-end"
          key={addState?.password ?? "form"}
        >
          <Field label={t.team.name}>
            <Input name="name" required maxLength={200} />
          </Field>
          <Field label={t.team.email}>
            <Input name="email" type="email" required />
          </Field>
          <Field label={t.team.role}>
            <Select name="role" defaultValue="member">
              <option value="member">{t.team.roles.member}</option>
              <option value="admin">{t.team.roles.admin}</option>
            </Select>
          </Field>
          <Button disabled={adding}>
            {adding ? <Spinner /> : <UserPlus className="size-4" />}
            {t.common.create}
          </Button>
        </form>
        <p className="mt-3 text-xs text-muted">{t.team.roleHint}</p>
        {addState?.error && <p className="mt-2 text-sm text-danger">{errText(addState.error)}</p>}
      </Card>

      {error && (
        <div className="rounded-xl border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-danger">{error}</div>
      )}

      <Card className="divide-y divide-border">
        {members.map((m) => {
          const isMe = m.id === meId;
          const busy = busyId === m.id;
          return (
            <div key={m.id} className="flex flex-wrap items-center gap-3 px-5 py-4">
              <span className="grid size-10 shrink-0 place-items-center rounded-full bg-accent-soft font-semibold text-accent">
                {m.name.trim().charAt(0).toUpperCase() || "?"}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 font-medium">
                  <span className="truncate">{m.name}</span>
                  {isMe && <Badge tone="accent">{t.team.you}</Badge>}
                  <Badge tone={m.totp ? "success" : "neutral"}>{m.totp ? t.team.twoFactorOn : t.team.twoFactorOff}</Badge>
                </div>
                <div className="truncate text-sm text-muted">
                  {m.email} · {t.team.since} {fmt.format(new Date(m.createdAt))}
                </div>
                {m.role === "member" && <ClientAccess member={m} clients={clients} onSave={(ids) => act(m.id, () => setMemberClients(m.id, ids))} />}
              </div>
              <div className="flex items-center gap-2">
                {busy && <Spinner className="text-muted" />}
                <Select
                  value={m.role}
                  disabled={isMe || busy}
                  className="h-9 w-44"
                  aria-label={t.team.role}
                  onChange={(e) => act(m.id, () => setMemberRole(m.id, e.target.value as Role))}
                >
                  <option value="member">{t.team.roles.member}</option>
                  <option value="admin">{t.team.roles.admin}</option>
                </Select>
                <Button
                  variant="ghost"
                  size="sm"
                  title={t.team.resetPassword}
                  disabled={busy}
                  className={cx(isMe && "invisible")}
                  onClick={() => {
                    if (!confirm(t.team.confirmReset)) return;
                    act(m.id, () => resetMemberPassword(m.id), (r) =>
                      setCreds({ title: t.team.passwordReset, email: r.email!, password: r.password! }),
                    );
                  }}
                >
                  <KeyRound className="size-4" />
                </Button>
                {m.totp && !isMe && (
                  <Button variant="ghost" size="sm" title={t.team.resetTwoFactor} disabled={busy} onClick={() => confirm(t.team.resetTwoFactorConfirm) && act(m.id, () => resetMemberTwoFactor(m.id))}>
                    <ShieldOff className="size-4" />
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  title={t.common.delete}
                  disabled={busy}
                  className={cx("hover:text-danger", isMe && "invisible")}
                  onClick={() => {
                    if (confirm(`${t.common.confirmDelete}\n${m.name} (${m.email})`)) act(m.id, () => deleteMember(m.id));
                  }}
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
            </div>
          );
        })}
      </Card>
    </div>
  );
}

function CredsCard({
  title,
  email,
  password,
  onClose,
}: {
  title: string;
  email: string;
  password: string;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const text = `${email}\n${password}`;
  return (
    <Card className="border-success/40 bg-success/5 p-6">
      <div className="mb-3 flex items-center gap-2 font-semibold text-success">
        <Check className="size-5" />
        {title}
      </div>
      <div className="grid gap-1 rounded-xl bg-surface p-4 font-mono text-sm">
        <div>
          <span className="text-muted">{t.team.email}: </span>
          {email}
        </div>
        <div>
          <span className="text-muted">{t.login.password}: </span>
          <span className="select-all font-semibold">{password}</span>
        </div>
      </div>
      <p className="mt-3 text-sm text-muted">{t.team.credsHint}</p>
      <div className="mt-4 flex gap-2">
        <Button
          variant="secondary"
          onClick={async () => {
            await navigator.clipboard.writeText(text);
            setCopied(true);
          }}
        >
          {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
          {copied ? t.team.copied : t.team.copy}
        </Button>
        <Button onClick={onClose}>{t.team.close}</Button>
      </div>
    </Card>
  );
}

/** Доступ сотрудника: ко всем клиентам или только к отмеченным. */
function ClientAccess({ member, clients, onSave }: { member: Member; clients: { id: string; name: string }[]; onSave: (ids: string[] | null) => void }) {
  const { t } = useI18n();
  const [all, setAll] = useState(member.clientIds === null);
  const [ids, setIds] = useState<string[]>(member.clientIds ?? []);
  const label = all ? t.team.accessAll : t.team.accessSome.replace("{n}", String(ids.length));
  return (
    <details className="mt-1 text-sm">
      <summary className="cursor-pointer text-xs text-accent">{t.team.access}: {label}</summary>
      <div className="mt-2 space-y-2 rounded-lg border border-border p-3">
        <label className="flex items-center gap-2">
          <input type="checkbox" className="size-4 accent-[var(--accent)]" checked={all} onChange={(e) => setAll(e.target.checked)} />
          {t.team.accessAll}
        </label>
        {!all && (
          <div className="grid max-h-56 grid-cols-1 gap-1 overflow-y-auto sm:grid-cols-2">
            {clients.map((c) => (
              <label key={c.id} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  className="size-4 accent-[var(--accent)]"
                  checked={ids.includes(c.id)}
                  onChange={(e) => setIds(e.target.checked ? [...ids, c.id] : ids.filter((x) => x !== c.id))}
                />
                <span className="truncate">{c.name}</span>
              </label>
            ))}
          </div>
        )}
        <p className="text-xs text-muted">{t.team.accessHint}</p>
        <Button size="sm" variant="secondary" onClick={() => onSave(all ? null : ids)}>
          {t.common.save}
        </Button>
      </div>
    </details>
  );
}
