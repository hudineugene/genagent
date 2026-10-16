"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { Check, Copy, RefreshCw, Send, UserRound, X } from "lucide-react";
import { ownerLinkAction, removeOwnerAction, sendOwnerGapsAction } from "@/app/actions/owners";
import { useI18n } from "@/lib/i18n/client";
import { Button, Card, Spinner } from "@/components/ui";

export type OwnerView = { chatId: string; name: string; since: number };

/** Владелец бизнеса в Telegram: раз в неделю получает вопросы без ответа и отвечает на них — ответы идут в базу знаний. */
export function OwnersCard({ clientId, botReady, owners, openGaps }: { clientId: string; botReady: boolean; owners: OwnerView[]; openGaps: number }) {
  const { t, locale } = useI18n();
  const s = t.client;
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const fmt = new Intl.DateTimeFormat(locale === "uk" ? "uk-UA" : "ru-RU", { dateStyle: "medium" });
  const getLink = (renew: boolean) =>
    start(async () => {
      const r = await ownerLinkAction(clientId, renew);
      setLink(r.link);
      setCopied(false);
    });

  return (
    <Card className="mt-6 space-y-3 p-5">
      <div className="flex items-center gap-2 font-semibold">
        <UserRound className="size-4 text-accent" />
        {s.ownersTitle}
        {pending && <Spinner className="text-muted" />}
      </div>
      <p className="text-sm text-muted">{s.ownersHint}</p>
      {!botReady ? (
        <p className="text-sm">
          {s.ownersNoBot}{" "}
          <Link href="/integrations" className="text-accent hover:underline">
            {t.nav.integrations}
          </Link>
        </p>
      ) : (
        <>
          {link ? (
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded-lg bg-surface-2 px-3 py-2 text-xs">{link}</code>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  void navigator.clipboard.writeText(link);
                  setCopied(true);
                }}
              >
                {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
              </Button>
              <Button size="sm" variant="secondary" title={s.ownersRenew} disabled={pending} onClick={() => getLink(true)}>
                <RefreshCw className="size-4" />
              </Button>
            </div>
          ) : (
            <Button size="sm" variant="secondary" disabled={pending} onClick={() => getLink(false)}>
              {s.ownersLink}
            </Button>
          )}
          {owners.length ? (
            <ul className="divide-y divide-border rounded-xl border border-border">
              {owners.map((o) => (
                <li key={o.chatId} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                  <span>{o.name}</span>
                  <span className="flex items-center gap-2 text-xs text-muted">
                    {fmt.format(o.since)}
                    <button
                      type="button"
                      title={s.ownersRemove}
                      disabled={pending}
                      className="rounded p-1 hover:bg-surface-2 hover:text-danger"
                      onClick={() => start(() => removeOwnerAction(clientId, o.chatId))}
                    >
                      <X className="size-3.5" />
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-muted">{s.ownersNone}</p>
          )}
          {owners.length > 0 && (
            <div className="flex flex-wrap items-center gap-3">
              <Button
                size="sm"
                variant="secondary"
                disabled={pending || !openGaps}
                onClick={() =>
                  start(async () => {
                    const r = await sendOwnerGapsAction(clientId);
                    setNote(s.ownersSent.replace("{n}", String(r.sent)));
                  })
                }
              >
                <Send className="size-4" />
                {s.ownersSend}
              </Button>
              <span className="text-xs text-muted">{note ?? s.ownersOpenGaps.replace("{n}", String(openGaps))}</span>
            </div>
          )}
        </>
      )}
    </Card>
  );
}
