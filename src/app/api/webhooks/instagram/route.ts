import { after } from "next/server";
import type { InstagramConfig } from "@/db/schema";
import { getMetaSettings } from "@/lib/settings";
import { validSignature, verifyChallenge } from "@/lib/channels/meta/webhook";
import { findChannelByAccount, handleInstagramComment, handleInstagramDm } from "@/lib/channels/meta/inbound";
import { getMedia } from "@/lib/channels/meta/instagram";

export const GET = verifyChallenge;

type Entry = {
  id: string;
  messaging?: {
    sender: { id: string };
    recipient: { id: string };
    message?: { mid: string; text?: string; is_echo?: boolean; attachments?: unknown[] };
  }[];
  changes?: {
    field: string;
    value: {
      id: string;
      text?: string;
      from?: { id: string; username?: string };
      media?: { id: string };
      parent_id?: string;
    };
  }[];
};

/** События Instagram: директ (messaging) и комментарии (changes, field=comments). Отвечаем Meta сразу, обрабатываем после. */
export async function POST(req: Request) {
  const raw = await req.text();
  const app = (await getMetaSettings()).instagram;
  if (!app || !validSignature(raw, req.headers.get("x-hub-signature-256"), app.appSecret)) {
    return new Response("Bad signature", { status: 401 });
  }
  let body: { object?: string; entry?: Entry[] };
  try {
    body = JSON.parse(raw);
  } catch {
    return new Response("Bad JSON", { status: 400 });
  }

  after(async () => {
    for (const entry of body.entry ?? []) {
      const channel = await findChannelByAccount("instagram", String(entry.id));
      if (!channel) continue;
      const cfg = channel.config as InstagramConfig;
      try {
        for (const m of entry.messaging ?? []) {
          if (!m.message || m.message.is_echo) continue;
          await handleInstagramDm(channel, {
            senderId: m.sender.id,
            mid: m.message.mid,
            text: m.message.text ?? (m.message.attachments?.length ? "[вложение]" : ""),
          });
        }
        for (const c of entry.changes ?? []) {
          if (c.field !== "comments" || !c.value?.id) continue;
          const media = c.value.media?.id ? await getMedia(cfg.token, c.value.media.id).catch(() => null) : null;
          await handleInstagramComment(channel, {
            id: c.value.id,
            text: c.value.text ?? "",
            fromId: c.value.from?.id,
            username: c.value.from?.username,
            parentId: c.value.parent_id,
            mediaId: c.value.media?.id,
            postUrl: media?.permalink,
            postText: media?.caption,
          });
        }
      } catch (e) {
        console.error("instagram webhook handling failed", e);
      }
    }
  });
  return new Response("OK");
}
