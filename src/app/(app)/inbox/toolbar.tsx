"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { Search, X } from "lucide-react";
import { useI18n } from "@/lib/i18n/client";
import { Spinner, cx } from "@/components/ui";

/** Поиск по диалогам (имя, @ник, текст переписки) и выбор клиента — меняют адрес страницы, список строит сервер. */
export function InboxToolbar({ clients }: { clients: { id: string; name: string }[] }) {
  const { t } = useI18n();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [q, setQ] = useState(params.get("q") ?? "");
  const [pending, start] = useTransition();

  const update = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    next.delete("c");
    const s = next.toString();
    start(() => router.replace(`${pathname}${s ? `?${s}` : ""}`));
  };

  // Ищем, когда человек перестал печатать
  const current = params.get("q") ?? "";
  useEffect(() => {
    if (q.trim() === current) return;
    const timer = setTimeout(() => update({ q: q.trim() || null }), 300);
    return () => clearTimeout(timer);
    // update меняется на каждый рендер — зависим только от текста запроса
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, current]);

  return (
    <div className="flex w-full min-w-0 items-center gap-2 sm:w-auto sm:flex-1">
      <label className="relative min-w-0 flex-1 sm:max-w-80">
        {pending ? (
          <Spinner className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" />
        ) : (
          <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" />
        )}
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t.inbox.search}
          className="h-9 w-full rounded-xl border border-border bg-surface pr-8 pl-9 text-sm outline-none transition placeholder:text-muted/70 focus:border-accent focus:ring-4 focus:ring-accent/15"
        />
        {q && (
          <button type="button" onClick={() => setQ("")} className="absolute top-1/2 right-2 -translate-y-1/2 rounded-md p-0.5 text-muted hover:text-text" aria-label="×">
            <X className="size-3.5" />
          </button>
        )}
      </label>
      {clients.length > 1 && (
        <select
          value={params.get("client") ?? ""}
          onChange={(e) => update({ client: e.target.value || null })}
          className={cx(
            "h-9 w-36 min-w-0 shrink-0 truncate rounded-xl sm:w-auto sm:max-w-56 border border-border bg-surface pr-8 pl-3 text-sm outline-none focus:border-accent",
            params.get("client") && "border-accent/50 text-accent",
          )}
        >
          <option value="">{t.inbox.allClients}</option>
          {clients.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}
