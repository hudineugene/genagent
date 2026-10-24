import Link from "next/link";
import { asc, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { agents, clients, studioTemplates } from "@/db/schema";
import { requireUser } from "@/lib/auth";
import { scopeOf } from "@/lib/access";
import { getT } from "@/lib/i18n/server";
import { agentConfigSchema } from "@/lib/agent/types";
import { diffFields } from "@/lib/agent/studio-templates";
import { Badge, Card, PageHeader, cx } from "@/components/ui";
import { PushForm, SaveAsTemplate } from "./forms";

/** Шаблоны агентов студии: из удачного агента — шаблон; новые версии раскатываются выборочно. */
export default async function TemplatesPage({ searchParams }: { searchParams: Promise<{ id?: string }> }) {
  const user = await requireUser();
  const restricted = Boolean(scopeOf(user));
  const { t } = await getT();
  const s = t.studioTemplates;
  const sp = await searchParams;
  const [list, agentRows] = await Promise.all([
    db.select().from(studioTemplates).orderBy(desc(studioTemplates.updatedAt)),
    db.select({ id: agents.id, name: agents.name, config: agents.config, clientId: agents.clientId, client: clients.name }).from(agents).innerJoin(clients, eq(clients.id, agents.clientId)).orderBy(asc(clients.name)),
  ]);
  const ids = scopeOf(user);
  const visible = agentRows.filter((a) => !ids || ids.includes(a.clientId));
  const current = sp.id ? list.find((x) => x.id === sp.id) : list[0];
  const tplConfig = current ? agentConfigSchema.parse(current.config) : null;
  const linked = current
    ? visible
        .filter((a) => a.config.studioTemplate?.id === current.id)
        .map((a) => ({ id: a.id, name: a.name, client: a.client, version: a.config.studioTemplate?.version ?? 0, diff: diffFields(agentConfigSchema.parse(a.config), tplConfig!) }))
    : [];

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader title={s.title} subtitle={s.subtitle} />
      {!restricted && <SaveAsTemplate agents={visible.map((a) => ({ id: a.id, label: `${a.client} · ${a.name}` }))} templates={list.map((x) => ({ id: x.id, name: x.name }))} />}
      <div className="grid gap-6 md:grid-cols-[260px_minmax(0,1fr)]">
        <Card className="h-fit p-2">
          {list.length === 0 ? (
            <p className="p-3 text-sm text-muted">{s.empty}</p>
          ) : (
            list.map((x) => (
              <Link key={x.id} href={`/templates?id=${x.id}`} className={cx("block rounded-lg px-3 py-2 text-sm", x.id === current?.id ? "bg-surface-2 font-medium" : "hover:bg-surface-2")}>
                {x.name}
                <span className="ml-1 text-xs text-muted">v{x.version}</span>
              </Link>
            ))
          )}
        </Card>
        {current && (
          <Card className="space-y-4 p-5">
            <div>
              <div className="flex items-center gap-2 font-semibold">
                {current.name}
                <Badge tone="accent">v{current.version}</Badge>
              </div>
              {current.description && <p className="text-sm text-muted">{current.description}</p>}
            </div>
            <div className="text-sm">
              {linked.length === 0 ? (
                <p className="text-muted">{s.noAgents}</p>
              ) : (
                <PushForm
                  templateId={current.id}
                  version={current.version}
                  disabled={restricted}
                  agents={linked}
                  fieldLabels={s.fields}
                />
              )}
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}

export const instant = false;
