"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, HelpCircle } from "lucide-react";
import { useI18n } from "@/lib/i18n/client";
import { Button, cx } from "./ui";

type Request = { message: string; resolve: (ok: boolean) => void };
const EVENT = "genagent:confirm";
let mounted = 0;

/**
 * Подтверждение действия фирменным окном вместо системного confirm(): await ask("Удалить безвозвратно?").
 * Первая строка — заголовок, остальные — пояснение. Без окна на странице (окно не подключено) — системный confirm.
 */
export function ask(message: string): Promise<boolean> {
  if (!mounted) return Promise.resolve(window.confirm(message));
  return new Promise((resolve) => window.dispatchEvent(new CustomEvent<Request>(EVENT, { detail: { message, resolve } })));
}

/** Окно подтверждения (одно на раскладку). Enter — подтвердить, Esc или щелчок мимо — отмена. */
export function ConfirmHost() {
  const { t } = useI18n();
  const [req, setReq] = useState<Request | null>(null);
  useEffect(() => {
    mounted++;
    const on = (e: Event) => setReq((e as CustomEvent<Request>).detail);
    window.addEventListener(EVENT, on);
    return () => {
      mounted--;
      window.removeEventListener(EVENT, on);
    };
  }, []);
  useEffect(() => {
    if (!req) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  if (!req) return null;
  function close(ok: boolean) {
    req?.resolve(ok);
    setReq(null);
  }
  const [title, ...rest] = req.message.split("\n");
  // Удаление — красная кнопка «Удалить», остальное — обычное подтверждение
  const danger = /удал|видал|delete|безвозвратно|безповоротно/i.test(req.message);
  const Icon = danger ? AlertTriangle : HelpCircle;
  return createPortal(
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/45 p-4 backdrop-blur-[2px]" onMouseDown={() => close(false)}>
      <div role="alertdialog" aria-modal="true" aria-label={title} className="animate-pop-in w-full max-w-sm rounded-2xl border border-border bg-surface p-5 shadow-2xl shadow-black/25" onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex gap-3.5">
          <span className={cx("grid size-10 shrink-0 place-items-center rounded-full", danger ? "bg-danger/10 text-danger" : "bg-accent-soft text-accent")}>
            <Icon className="size-5" />
          </span>
          <div className="min-w-0 pt-0.5">
            <h2 className="text-base font-bold break-words">{title}</h2>
            {rest.length > 0 && <p className="mt-1 text-sm break-words whitespace-pre-wrap text-muted">{rest.join("\n").trim()}</p>}
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => close(false)}>
            {t.common.cancel}
          </Button>
          <Button autoFocus className={danger ? "bg-danger text-white hover:brightness-110" : undefined} onClick={() => close(true)}>
            {danger ? t.common.delete : t.common.confirm}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
