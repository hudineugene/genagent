"use server";

import { refresh } from "next/cache";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth";

/** Ссылка подписки владельца клиента на вопросы агента (renew — новая, старая перестаёт работать). */
export async function ownerLinkAction(clientId: string, renew = false): Promise<{ link: string | null }> {
  await requireAdmin();
  const { ownerLink } = await import("@/lib/notify/telegram");
  return { link: await ownerLink(z.string().uuid().parse(clientId), renew) };
}

export async function removeOwnerAction(clientId: string, chatId: string) {
  await requireAdmin();
  const { removeOwner } = await import("@/lib/notify/telegram");
  await removeOwner(z.string().uuid().parse(clientId), z.string().min(1).max(40).parse(chatId));
  refresh();
}

/** Отправить владельцам вопросы без ответа сейчас. Возвращает число вопросов. */
export async function sendOwnerGapsAction(clientId: string): Promise<{ sent: number }> {
  await requireAdmin();
  const { sendGapsToOwners } = await import("@/lib/notify/telegram");
  return { sent: await sendGapsToOwners(z.string().uuid().parse(clientId)) };
}
