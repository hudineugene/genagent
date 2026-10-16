import { after } from "next/server";
import { getMetaSettings } from "@/lib/settings";
import { validSignature, verifyChallenge } from "@/lib/channels/meta/webhook";
import { findChannelByAccount, handleThreadsReply } from "@/lib/channels/meta/inbound";
import { markWebhook } from "@/lib/channels/health";

export const GET = verifyChallenge;

type ReplyValue = {
  id: string;
  text?: string;
  username?: string;
  permalink?: string;
  replied_to?: { id: string };
  root_post?: { id: string; text?: string; permalink?: string; owner_id?: string };
  is_reply_owned_by_me?: boolean;
};
type Event = { target_id?: string; values?: { field?: string; value?: ReplyValue } };

/** События Threads (field=replies) — ответы под постами подключённых аккаунтов. */
export async function POST(req: Request) {
  const raw = await req.text();
  const app = (await getMetaSettings()).threads;
  if (!app) return new Response("Not configured", { status: 404 });
  // Подпись Meta для Threads в документации не описана явно: проверяем, если заголовок пришёл.
  const sig = req.headers.get("x-hub-signature-256");
  if (sig && !validSignature(raw, sig, app.appSecret)) return new Response("Bad signature", { status: 401 });

  let body: Event | { entry?: Event[] } | Event[];
  try {
    body = JSON.parse(raw);
  } catch {
    return new Response("Bad JSON", { status: 400 });
  }
  const events: Event[] = Array.isArray(body) ? body : "entry" in body && body.entry ? body.entry : [body as Event];

  after(async () => {
    for (const ev of events) {
      const v = ev.values?.value;
      if (ev.values?.field !== "replies" || !v?.id || !ev.target_id) continue;
      const channel = await findChannelByAccount("threads", String(ev.target_id));
      if (!channel) continue;
      await markWebhook(channel.id).catch(() => {});
      await handleThreadsReply(channel, {
        id: v.id,
        text: v.text,
        username: v.username,
        owned: v.is_reply_owned_by_me,
        repliedToId: v.replied_to?.id,
        rootPostId: v.root_post?.id,
        postUrl: v.root_post?.permalink,
        postText: v.root_post?.text,
      }).catch((e) => console.error("threads webhook handling failed", e));
    }
  });
  return new Response("OK");
}
