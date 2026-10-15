import { z } from "zod";
import { apiChannel } from "@/lib/channels/api-auth";
import { upsertConversation } from "@/lib/conversations";
import { saveOrder, writeOrderNote } from "@/lib/agent/orders";

/**
 * Свой бот сообщает о смене статуса заказа клиента. GenAgent запоминает ленту заказа — агент видит её
 * в контексте. Если write и в канале включено «Агент сопровождает заказ», в ответе — живой текст
 * от агента ({ text }), который бот отправляет вместо своего шаблона (fallback); { text: null } — шлите шаблон.
 * Бот ждёт ответа не дольше нескольких секунд и при таймауте тоже шлёт шаблон.
 */
const bodySchema = z.object({
  user: z.object({
    id: z.union([z.string(), z.number()]).transform(String).pipe(z.string().min(1).max(100)),
    name: z.string().trim().max(200).optional(),
    username: z.string().trim().max(100).optional(),
  }),
  order: z.object({
    id: z.union([z.string(), z.number()]).transform(String).pipe(z.string().min(1).max(40)),
    title: z.string().trim().max(120).optional(),
    status: z.string().trim().min(1).max(40),
    label: z.string().trim().min(1).max(120),
    facts: z.string().trim().max(600).optional(),
  }),
  fallback: z.string().trim().max(2000).optional(),
  write: z.boolean().optional(),
});

export async function POST(req: Request, { params }: { params: Promise<{ channelId: string }> }) {
  const { channelId } = await params;
  const channel = await apiChannel(channelId, req.headers.get("authorization"));
  if (!channel) return Response.json({ error: "unauthorized" }, { status: 401 });
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "bad_request", details: parsed.error.issues[0]?.message }, { status: 400 });
  const { user, order, fallback, write } = parsed.data;
  const { conversation } = await upsertConversation(channel, user.id, {
    name: user.name,
    handle: user.username ? `@${user.username.replace(/^@/, "")}` : undefined,
  });
  // Бот ждёт живой текст ~9 с: не успели за 7,5 — пусть шлёт шаблон (и мы не сохраняем текст, которого клиент не увидит)
  const text =
    write && fallback
      ? await Promise.race([writeOrderNote(channel, conversation, order, fallback), new Promise<null>((r) => setTimeout(() => r(null), 7500))])
      : null;
  await saveOrder(conversation, order, text);
  return Response.json({ text });
}
