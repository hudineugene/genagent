"use server";

import { refresh } from "next/cache";
import { hideExample, refreshExamples } from "@/lib/agent/examples";

import { requireOwned } from "@/lib/access";
/** Убрать удачный ответ из образцов агента. */
export async function hideExampleAction(agentId: string, messageId: string) {
  await requireOwned("agent", agentId);
  await hideExample(agentId, messageId);
  refresh();
}

/** Пересобрать образцы сейчас (не дожидаясь утра). */
export async function refreshExamplesAction(agentId: string): Promise<number> {
  await requireOwned("agent", agentId);
  const n = await refreshExamples(agentId);
  refresh();
  return n;
}
