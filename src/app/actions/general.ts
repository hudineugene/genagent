"use server";

import { refresh } from "next/cache";
import { requireAdmin } from "@/lib/auth";
import { saveGeneral, type General } from "@/lib/general";

/** Общие настройки программы — только администратор. */
export async function saveGeneralAction(input: General): Promise<{ ok?: true; error?: string }> {
  await requireAdmin();
  try {
    await saveGeneral(input);
  } catch {
    return { error: "invalid" };
  }
  refresh();
  return { ok: true };
}
