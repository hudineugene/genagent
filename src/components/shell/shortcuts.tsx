"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "@/lib/i18n/client";
import { OPEN_PALETTE } from "../command-palette";
import { useShell } from "./frame";

/** Событие, которым поиск открывает список горячих клавиш. */
export const OPEN_SHORTCUTS = "genagent:shortcuts";

/** «G, затем буква» — переход в раздел. По физической клавише (e.code): работает и в русской раскладке. */
const GO: Record<string, string> = { KeyH: "/", KeyI: "/inbox", KeyC: "/clients", KeyA: "/analytics", KeyT: "/templates", KeyS: "/settings", KeyP: "/profile" };

function typing(target: EventTarget | null) {
  const el = target as HTMLElement | null;
  return Boolean(el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)));
}

/** Горячие клавиши программы и окно-подсказка («?»). Не мешают вводу текста: в полях не срабатывают. */
export function Shortcuts() {
  const { t } = useI18n();
  const router = useRouter();
  const { togglePanel } = useShell();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let prefix = 0;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || typing(e.target)) return;
      if (e.key === "Escape") return setOpen(false);
      if (e.key === "?" || (e.code === "Slash" && e.shiftKey)) {
        e.preventDefault();
        return setOpen((v) => !v);
      }
      if (Date.now() - prefix < 1200 && GO[e.code]) {
        e.preventDefault();
        prefix = 0;
        setOpen(false);
        return router.push(GO[e.code]);
      }
      prefix = 0;
      if (e.code === "KeyG") prefix = Date.now();
      else if (e.code === "Slash") {
        e.preventDefault();
        window.dispatchEvent(new Event(OPEN_PALETTE));
      } else if (e.code === "BracketLeft") togglePanel();
    };
    const show = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener(OPEN_SHORTCUTS, show);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(OPEN_SHORTCUTS, show);
    };
  }, [router, togglePanel]);
  if (!open) return null;
  const rows: [string[], string][] = [
    [["Ctrl", "K"], t.nav.search],
    [["/"], t.nav.search],
    [["G", "H"], t.nav.today],
    [["G", "I"], t.nav.inbox],
    [["G", "C"], t.nav.clients],
    [["G", "A"], t.nav.analytics],
    [["G", "T"], t.nav.templates],
    [["G", "S"], t.nav.settings],
    [["G", "P"], t.nav.profile],
    [["["], t.palette.togglePanel],
    [["?"], t.palette.shortcuts],
  ];
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 px-4 pt-[14vh]" onMouseDown={() => setOpen(false)}>
      <div role="dialog" aria-modal="true" aria-label={t.palette.shortcuts} className="animate-pop-in w-full max-w-md rounded-2xl border border-border bg-surface p-5 shadow-2xl" onMouseDown={(e) => e.stopPropagation()}>
        <h2 className="mb-3 text-base font-bold">{t.palette.shortcuts}</h2>
        <ul className="divide-y divide-border text-sm">
          {rows.map(([keys, label]) => (
            <li key={keys.join("+") + label} className="flex items-center justify-between gap-3 py-2">
              <span>{label}</span>
              <span className="flex items-center gap-1">
                {keys.map((k, i) => (
                  <kbd key={i} className="min-w-6 rounded-md border border-border bg-surface-2 px-1.5 py-0.5 text-center text-xs font-semibold">
                    {k}
                  </kbd>
                ))}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>,
    document.body,
  );
}
