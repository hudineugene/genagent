import { notFound } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { clients, kbSources } from "@/db/schema";
import { getT } from "@/lib/i18n/server";
import { estimateTokens } from "@/lib/kb/text";
import { BackLink } from "@/components/back-link";
import { Card, PageHeader } from "@/components/ui";
import { TextSourceEditor } from "./editor";

import { guardPage } from "@/lib/access";
export default async function SourcePage({ params }: { params: Promise<{ clientId: string; sourceId: string }> }) {
  const { clientId, sourceId } = await params;
  await guardPage("client", clientId);
  await guardPage("kbSource", sourceId);
  const { t } = await getT();
  const [row] = await db
    .select({ source: kbSources, clientName: clients.name })
    .from(kbSources)
    .innerJoin(clients, eq(clients.id, kbSources.clientId))
    .where(and(eq(kbSources.id, sourceId), eq(kbSources.clientId, clientId)));
  if (!row) notFound();
  const { source: s, clientName } = row;

  const meta = [
    t.kb.types[s.type],
    s.url,
    s.filename,
    s.pages ? `${s.pages} ${t.kb.pages}` : null,
    `${s.chunks} ${t.kb.chunks}`,
    `≈${estimateTokens(s.chars).toLocaleString()} ${t.kb.tokens}`,
  ].filter(Boolean);

  return (
    <div className="mx-auto max-w-4xl">
      <BackLink href={`/clients/${clientId}?tab=kb`} label={`${clientName} · ${t.kb.tab}`} />
      <PageHeader title={s.title} subtitle={meta.join(" · ")} />
      {s.type === "text" ? (
        <TextSourceEditor id={s.id} title={s.title} content={s.content} />
      ) : (
        <Card className="p-5">
          <div className="mb-3">
            <div className="font-semibold">{t.kb.content}</div>
            <div className="text-xs text-muted">{t.kb.contentHint}</div>
          </div>
          <pre className="max-h-[70vh] overflow-auto whitespace-pre-wrap rounded-xl bg-surface-2 p-4 text-[13px] leading-relaxed">
            {s.content || "—"}
          </pre>
        </Card>
      )}
    </div>
  );
}

// Внутренний инструмент: страница всегда читает свежие данные из БД.
export const instant = false;
