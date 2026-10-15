"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";
import { useI18n } from "@/lib/i18n/client";
import { cx } from "./ui";

/** Выбор клиента выпадающим списком: меняет ?client= в адресе (остальные параметры сохраняет). */
export function ClientSelect({ clients }: { clients: { id: string; name: string }[] }) {
  const { t } = useI18n();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [pending, start] = useTransition();
  const value = params.get("client") ?? "";
  return (
    <select
      value={value}
      disabled={pending}
      onChange={(e) => {
        const next = new URLSearchParams(params.toString());
        if (e.target.value) next.set("client", e.target.value);
        else next.delete("client");
        const s = next.toString();
        start(() => router.replace(`${pathname}${s ? `?${s}` : ""}`));
      }}
      className={cx(
        "h-9 max-w-64 min-w-0 truncate rounded-xl border border-border bg-surface pr-8 pl-3 text-sm outline-none focus:border-accent",
        value && "border-accent/50 text-accent",
        pending && "opacity-60",
      )}
    >
      <option value="">{t.inbox.allClients}</option>
      {clients.map((c) => (
        <option key={c.id} value={c.id}>
          {c.name}
        </option>
      ))}
    </select>
  );
}
