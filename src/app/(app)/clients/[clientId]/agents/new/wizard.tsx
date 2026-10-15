"use client";

import { useActionState, useState, useTransition } from "react";
import { Plus, Wand2 } from "lucide-react";
import { createAgent, generateAgent } from "@/app/actions/agents";
import { TEMPLATES, type TemplateCategory } from "@/lib/agent/templates";
import { SKILL_MAP } from "@/lib/agent/skills";
import { useI18n } from "@/lib/i18n/client";
import { Button, Card, Spinner, Textarea, cx } from "@/components/ui";

const CATEGORIES: TemplateCategory[] = ["sales", "support", "booking", "social"];

export function NewAgentWizard({ clientId }: { clientId: string }) {
  const { t, locale } = useI18n();
  const [category, setCategory] = useState<TemplateCategory | "all">("all");
  const [picked, setPicked] = useState<string | null>(null);
  const [creating, startCreate] = useTransition();
  const [genState, genAction, generating] = useActionState(generateAgent.bind(null, clientId), undefined);

  const busy = creating || generating;
  const pick = (key: string | null) => {
    setPicked(key ?? "__blank");
    startCreate(() => createAgent(clientId, key));
  };

  const templates = TEMPLATES.filter((tp) => category === "all" || tp.category === category);

  return (
    <div className="space-y-10">
      <Card className="relative overflow-hidden border-accent/30 p-6">
        <div className="pointer-events-none absolute -right-20 -top-20 size-64 rounded-full bg-accent/10 blur-3xl" />
        <div className="relative">
          <div className="mb-1 flex items-center gap-2 font-semibold">
            <Wand2 className="size-5 text-accent" />
            {t.newAgent.describeTitle}
          </div>
          <p className="mb-4 text-sm text-muted">{t.newAgent.describeHint}</p>
          <form action={genAction} className="space-y-3">
            <Textarea
              name="brief"
              rows={4}
              required
              minLength={10}
              placeholder={t.newAgent.describePlaceholder}
              disabled={busy}
            />
            {genState?.error && genState.error !== "brief" && (
              <p className="text-sm text-danger">
                {t.playground.error}: {genState.error}
              </p>
            )}
            <div className="flex justify-end">
              <Button disabled={busy}>
                {generating ? <Spinner /> : <Wand2 className="size-4" />}
                {generating ? t.newAgent.generating : t.newAgent.generate}
              </Button>
            </div>
          </form>
        </div>
      </Card>

      <div>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">{t.newAgent.orTemplate}</h2>
          <div className="flex flex-wrap gap-1.5">
            {(["all", ...CATEGORIES] as const).map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setCategory(c)}
                className={cx(
                  "rounded-full px-3 py-1.5 text-sm transition",
                  category === c ? "bg-text text-bg" : "bg-surface-2 text-muted hover:text-text",
                )}
              >
                {c === "all" ? t.newAgent.all : t.newAgent.categories[c]}
              </button>
            ))}
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <TemplateCard
            icon={<Plus className="size-5" />}
            title={t.newAgent.blank}
            description={t.newAgent.blankDesc}
            dashed
            loading={creating && picked === "__blank"}
            disabled={busy}
            onClick={() => pick(null)}
          />
          {templates.map((tp) => (
            <TemplateCard
              key={tp.key}
              icon={<span className="text-xl">{tp.icon}</span>}
              title={tp.name[locale]}
              description={tp.description[locale]}
              tags={(tp.config.skills ?? []).map((k) => SKILL_MAP.get(k)?.icon ?? "").join(" ")}
              loading={creating && picked === tp.key}
              disabled={busy}
              onClick={() => pick(tp.key)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function TemplateCard({
  icon,
  title,
  description,
  tags,
  dashed,
  loading,
  disabled,
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  tags?: string;
  dashed?: boolean;
  loading?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cx(
        "flex gap-3 rounded-2xl border bg-surface p-4 text-left transition enabled:hover:border-accent/50 enabled:hover:shadow-lg enabled:hover:shadow-black/5 disabled:opacity-60",
        dashed ? "border-dashed border-border" : "border-border",
      )}
    >
      <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-surface-2 text-muted">
        {loading ? <Spinner /> : icon}
      </span>
      <span className="min-w-0">
        <span className="block font-semibold">{title}</span>
        <span className="mt-0.5 line-clamp-2 block text-sm text-muted">{description}</span>
        {tags && <span className="mt-2 block text-sm tracking-widest">{tags}</span>}
      </span>
    </button>
  );
}
