import { and, eq, isNotNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { kbSources } from "@/db/schema";
import { apiChannel } from "@/lib/channels/api-auth";
import { indexSource, removeIndexForSource } from "@/lib/kb/store";
import { normalizeText } from "@/lib/kb/text";

/**
 * Свой бот присылает базу знаний целиком: { sources: [{ key, title, content }] }.
 * Документы с теми же ключами обновляются (если текст изменился), новые добавляются,
 * присланные раньше, но пропавшие из списка — удаляются. Источники, добавленные в студии вручную, не трогаем.
 */
const bodySchema = z.object({
  sources: z
    .array(
      z.object({
        key: z.string().regex(/^[a-z0-9_-]{1,40}$/),
        title: z.string().trim().min(1).max(200),
        content: z.string().max(200_000),
      }),
    )
    .max(30)
    .refine((list) => new Set(list.map((s) => s.key)).size === list.length, "duplicate keys"),
});

export async function POST(req: Request, { params }: { params: Promise<{ channelId: string }> }) {
  const { channelId } = await params;
  const channel = await apiChannel(channelId, req.headers.get("authorization"));
  if (!channel) return Response.json({ error: "unauthorized" }, { status: 401 });

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "bad_request", details: parsed.error.issues[0]?.message }, { status: 400 });

  const existing = await db
    .select({ id: kbSources.id, key: kbSources.externalKey, title: kbSources.title, content: kbSources.content, status: kbSources.status })
    .from(kbSources)
    .where(and(eq(kbSources.clientId, channel.clientId), isNotNull(kbSources.externalKey)));
  const byKey = new Map(existing.map((s) => [s.key, s]));
  const result = { created: 0, updated: 0, unchanged: 0, removed: 0 };

  for (const source of parsed.data.sources) {
    const content = normalizeText(source.content);
    const old = byKey.get(source.key);
    if (old) {
      byKey.delete(source.key);
      if (old.title === source.title && old.content === content && old.status === "ready") {
        result.unchanged++;
        continue;
      }
      await db.update(kbSources).set({ title: source.title }).where(eq(kbSources.id, old.id));
      indexSource(old.id, channel.clientId, source.title, content);
      result.updated++;
    } else {
      const [row] = await db
        .insert(kbSources)
        .values({ clientId: channel.clientId, type: "text", title: source.title, externalKey: source.key })
        .returning({ id: kbSources.id });
      indexSource(row.id, channel.clientId, source.title, content);
      result.created++;
    }
  }

  // Чего бот больше не присылает (например, объект сняли с продажи и документ пропал) — убираем.
  for (const gone of byKey.values()) {
    removeIndexForSource(gone.id);
    await db.delete(kbSources).where(eq(kbSources.id, gone.id));
    result.removed++;
  }

  return Response.json({ ok: true, ...result });
}
