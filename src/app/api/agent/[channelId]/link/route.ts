import { z } from "zod";
import { apiChannel } from "@/lib/channels/api-auth";
import { linkWidgetConversation } from "@/lib/channels/link";

/**
 * Свой бот: клиент пришёл по ссылке «Продолжить в Telegram» из чата на сайте (/start w_<код>).
 * Переписка с сайта переносится в разговор бота — агент продолжает с того же места.
 * Ответ: { linked: true, copied } или { linked: false } (код неизвестен, устарел или уже использован).
 */
const bodySchema = z.object({
  token: z.string().regex(/^[A-Za-z0-9]{8,40}$/),
  user: z.object({
    id: z.union([z.string(), z.number()]).transform(String).pipe(z.string().min(1).max(100)),
    name: z.string().max(200).optional(),
    username: z.string().max(100).optional(),
  }),
});

export async function POST(req: Request, { params }: { params: Promise<{ channelId: string }> }) {
  const { channelId } = await params;
  const channel = await apiChannel(channelId, req.headers.get("authorization"));
  if (!channel) return Response.json({ error: "unauthorized" }, { status: 401 });
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "bad_request", details: parsed.error.issues[0]?.message }, { status: 400 });
  const { token, user } = parsed.data;
  const r = await linkWidgetConversation(channel, token, {
    id: user.id,
    name: user.name?.trim() || undefined,
    handle: user.username ? `@${user.username.replace(/^@/, "")}` : undefined,
  });
  return Response.json(r.linked ? { linked: true, copied: r.copied } : { linked: false });
}
