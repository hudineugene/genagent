"use client";

import { useTransition } from "react";
import { forgetClientMemory } from "@/app/actions/inbox";

/** «Забыть»: стереть, что агент помнит о клиенте. */
export function ForgetMemory({ conversationId, label, confirm }: { conversationId: string; label: string; confirm: string }) {
  const [pending, start] = useTransition();
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => window.confirm(confirm) && start(async () => void (await forgetClientMemory(conversationId)))}
      className="rounded-md px-1.5 py-0.5 text-xs text-muted transition hover:bg-surface-2 hover:text-danger disabled:opacity-50"
    >
      {label}
    </button>
  );
}
