"use client";

import { useSyncExternalStore } from "react";
import { toast } from "./toast";

/**
 * Удаление с отменой (как в почте): запись сразу пропадает из списка, внизу — «Удалено · Отменить» на 6 секунд;
 * не отменили — удаляем на сервере. Скрытые записи — общий список id, его читают списки через useHiddenIds().
 */
const hidden = new Set<string>();
let version = 0;
const listeners = new Set<() => void>();
const emit = () => {
  version++;
  for (const l of listeners) l();
};
let snapshot: ReadonlySet<string> = new Set();
let snapVersion = -1;

export function useHiddenIds(): ReadonlySet<string> {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => {
      if (snapVersion !== version) {
        snapshot = new Set(hidden);
        snapVersion = version;
      }
      return snapshot;
    },
    () => snapshot,
  );
}

export function deleteWithUndo({ id, text, undoLabel, failText, run }: { id: string; text: string; undoLabel: string; failText: string; run: () => Promise<unknown> }) {
  hidden.add(id);
  emit();
  let undone = false;
  toast(text, "info", {
    duration: 6000,
    action: {
      label: undoLabel,
      onClick: () => {
        undone = true;
        hidden.delete(id);
        emit();
      },
    },
  });
  setTimeout(() => {
    if (undone) return;
    run()
      .catch(() => {
        hidden.delete(id);
        emit();
        toast(failText, "error");
      })
      .finally(() => {
        // Запись уже удалена на сервере и пропадёт из данных страницы; из общего списка — чуть позже
        setTimeout(() => {
          hidden.delete(id);
          emit();
        }, 5000);
      });
  }, 6000);
}
