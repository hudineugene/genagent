"use server";

import { refresh } from "next/cache";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { dataTables } from "@/db/schema";
import { requireUser } from "@/lib/auth";
import { askData, type ChartSpec } from "@/lib/data/analyst";
import { refreshTable } from "@/lib/data/tables";

export type DataResult = { error?: string; id?: string };

const metaSchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(1000),
  enabled: z.boolean(),
});

/** Название, описание и включение таблицы (данные меняются загрузкой файла или обновлением из Google). */
export async function saveTableMeta(clientId: string, id: string, input: z.input<typeof metaSchema>): Promise<DataResult> {
  await requireUser();
  const parsed = metaSchema.safeParse(input);
  if (!parsed.success) return { error: "invalid" };
  await db
    .update(dataTables)
    .set({ ...parsed.data, updatedAt: new Date() })
    .where(and(eq(dataTables.id, id), eq(dataTables.clientId, clientId)));
  refresh();
  return { id };
}

const sheetSchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(1000),
  url: z.string().trim().min(1).max(1000),
  sheet: z.string().trim().max(100),
});

/** Подключить Google Таблицу: читаем сразу, ошибку показываем (доступ, неверная ссылка). */
export async function addSheetTable(clientId: string, input: z.input<typeof sheetSchema>): Promise<DataResult> {
  await requireUser();
  const parsed = sheetSchema.safeParse(input);
  if (!parsed.success) return { error: "invalid" };
  const { spreadsheetId } = await import("@/lib/google/sheets");
  if (!spreadsheetId(parsed.data.url)) return { error: "sheet_url" };
  const d = parsed.data;
  const [row] = await db.insert(dataTables).values({ clientId, name: d.name, description: d.description, source: "sheet", sheetUrl: d.url, sheetName: d.sheet }).returning();
  const fresh = await refreshTable(row, true);
  refresh();
  return fresh.error ? { id: row.id, error: fresh.error } : { id: row.id };
}

export async function refreshTableNow(id: string): Promise<DataResult> {
  await requireUser();
  const [t] = await db.select().from(dataTables).where(eq(dataTables.id, id));
  if (!t) return { error: "not_found" };
  const fresh = await refreshTable(t, true);
  refresh();
  return fresh.error ? { error: fresh.error } : { id };
}

export async function deleteTable(id: string) {
  await requireUser();
  await db.delete(dataTables).where(eq(dataTables.id, id));
  refresh();
}

const askSchema = z.object({
  question: z.string().trim().min(1).max(2000),
  history: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(8000) })).max(16),
  tableIds: z.array(z.string()).max(20).optional(),
});

export async function askDataAction(
  clientId: string,
  input: z.input<typeof askSchema>,
): Promise<{ answer: string; charts: ChartSpec[]; queries: number; error?: string }> {
  await requireUser();
  const parsed = askSchema.safeParse(input);
  if (!parsed.success) return { answer: "", charts: [], queries: 0, error: "invalid" };
  try {
    return await askData(clientId, parsed.data.question, parsed.data.history, parsed.data.tableIds);
  } catch (e) {
    console.error("ask data failed", e);
    return { answer: "", charts: [], queries: 0, error: "failed" };
  }
}
