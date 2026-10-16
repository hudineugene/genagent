"use client";

import { useTransition } from "react";
import { FlaskConical } from "lucide-react";
import { setConversationTest } from "@/app/actions/test-accounts";
import { cx } from "@/components/ui";

/** «Это тестовый разговор»: пометить (и запомнить аккаунт) или снять пометку. */
export function TestToggle({ conversationId, isTest, labels }: { conversationId: string; isTest: boolean; labels: { mark: string; unmark: string; hint: string } }) {
  const [pending, start] = useTransition();
  return (
    <button
      type="button"
      disabled={pending}
      title={labels.hint}
      onClick={() => start(async () => void (await setConversationTest(conversationId, !isTest)))}
      className={cx(
        "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] transition disabled:opacity-50",
        isTest ? "bg-amber-500/10 text-amber-700 hover:bg-amber-500/15 dark:text-amber-400" : "text-muted hover:bg-surface-2 hover:text-text",
      )}
    >
      <FlaskConical className="size-4" />
      {isTest ? labels.unmark : labels.mark}
    </button>
  );
}
