"use server";

import { refresh } from "next/cache";
import { requireUser } from "@/lib/auth";
import { hideExample, refreshExamples } from "@/lib/agent/examples";

/** Убрать удачный ответ из образцов агента. */
export async function hideExampleAction(agentId: string, messageId: string) {
  await requireUser();
  await hideExample(agentId, messageId);
  refresh();
}

/** Пересобрать образцы сейчас (не дожидаясь утра). */
export async function refreshExamplesAction(agentId: string): Promise<number> {
  await requireUser();
  const n = await refreshExamples(agentId);
  refresh();
  return n;
}
