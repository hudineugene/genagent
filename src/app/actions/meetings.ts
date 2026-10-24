"use server";

import { refresh } from "next/cache";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { meetings } from "@/db/schema";
import { deliverMeeting, emailParticipants, processMeeting } from "@/lib/meetings/engine";

import { requireOwned } from "@/lib/access";
const schema = z.object({ kind: z.enum(["protocol", "interview", "sales", "custom"]), instructions: z.string().trim().max(3000) });

/** Разобрать ту же расшифровку заново (другой вид разбора или критерии). */
export async function reanalyzeMeeting(id: string, input: z.input<typeof schema>): Promise<{ error?: string }> {
  await requireOwned("meeting", id);
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
  await requireOwned("meeting", id);
  const [m] = await db.select().from(meetings).where(eq(meetings.id, id));
  if (!m || m.status !== "done") return { error: "not_ready" };
  await deliverMeeting({ ...m, delivery: to });
  return {};
}

/** Итоги — участникам на почту (с почтового канала клиента). */
export async function emailMeeting(id: string, emails: string, channelId: string): Promise<{ error?: string }> {
  await requireOwned("meeting", id);
  const [m] = await db.select().from(meetings).where(eq(meetings.id, id));
  if (!m || m.status !== "done") return { error: "not_ready" };
  const list = emails
    .split(/[\s,;]+/)
    .map((e) => e.trim())
    .filter(Boolean)
    .slice(0, 50);
  if (!list.length) return { error: "no_emails" };
  const status = await emailParticipants({ ...m, delivery: { ...m.delivery, emails: list, channelId } });
  refresh();
  return status === "sent" ? {} : { error: status.replace(/^error: /, "") };
}

export async function deleteMeeting(id: string) {
  await requireOwned("meeting", id);
  await db.delete(meetings).where(eq(meetings.id, id));
  refresh();
}
