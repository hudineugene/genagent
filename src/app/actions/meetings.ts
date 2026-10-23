"use server";

import { refresh } from "next/cache";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { meetings } from "@/db/schema";
import { requireUser } from "@/lib/auth";
import { deliverMeeting, processMeeting } from "@/lib/meetings/engine";

const schema = z.object({ kind: z.enum(["protocol", "interview", "sales", "custom"]), instructions: z.string().trim().max(3000) });

/** Разобрать ту же расшифровку заново (другой вид разбора или критерии). */
export async function reanalyzeMeeting(id: string, input: z.input<typeof schema>): Promise<{ error?: string }> {
  await requireUser();
  const parsed = schema.safeParse(input);
  if (!parsed.success) return { error: "invalid" };
  const [m] = await db.select({ transcript: meetings.transcript }).from(meetings).where(eq(meetings.id, id));
  if (!m?.transcript) return { error: "no_transcript" };
  await db.update(meetings).set({ ...parsed.data, status: "processing", error: null, updatedAt: new Date() }).where(eq(meetings.id, id));
  void processMeeting(id);
  refresh();
  return {};
}

/** Отправить итоги в Telegram ещё раз (например, владельцу). */
export async function sendMeeting(id: string, to: { team: boolean; owners: boolean }): Promise<{ error?: string }> {
  await requireUser();
  const [m] = await db.select().from(meetings).where(eq(meetings.id, id));
  if (!m || m.status !== "done") return { error: "not_ready" };
  await deliverMeeting({ ...m, delivery: to });
  return {};
}

export async function deleteMeeting(id: string) {
  await requireUser();
  await db.delete(meetings).where(eq(meetings.id, id));
  refresh();
}
