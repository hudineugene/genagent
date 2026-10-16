"use server";

import { z } from "zod";
import { requireUser } from "@/lib/auth";

/** Скрыть пункт «Что ещё не настроено» (больше не показывать). */
export async function dismissSetupAction(key: string) {
  await requireUser();
  const { dismissSetupItem } = await import("@/lib/setup-checklist");
  await dismissSetupItem(z.string().min(1).max(120).parse(key));
}
