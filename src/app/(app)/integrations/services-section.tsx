"use client";

import { useState, useTransition } from "react";
import { Check, Globe, KeyRound, MapPinned } from "lucide-react";
import { saveServicesAction } from "@/app/actions/integrations";
import { useI18n } from "@/lib/i18n/client";
import { Button, Card, Field, Input, Select, Spinner } from "@/components/ui";

export type ServicesView = {
  webSearch: { enabled: boolean; maxUses: number };
  openai: "server" | "set" | "none";
  maps: "server" | "set" | "none";
};

/** Платные внешние сервисы: владелец сам включает поиск и вставляет ключи, без правки сервера. */
export function ServicesSection({ services }: { services: ServicesView }) {
  const { t } = useI18n();
  const s = t.integrations;
  const [search, setSearch] = useState(services.webSearch);
  const [saved, setSaved] = useState(false);
  const [pending, start] = useTransition();
  const save = (patch: Parameters<typeof saveServicesAction>[0]) =>
    start(async () => {
      await saveServicesAction(patch);
      setSaved(true);
    });

  return (
    <Card className="space-y-6 p-5">
      <div>
        <div className="font-semibold">{s.svcTitle}</div>
        <p className="mt-1 text-sm text-muted">{s.svcHint}</p>
      </div>

      <div className="space-y-3 border-t border-border pt-4">
        <div className="flex items-center gap-2 font-medium">
          <Globe className="size-4 text-accent" />
          {s.svcSearch}
        </div>
        <p className="text-sm text-muted">{s.svcSearchHint}</p>
        <label className="flex cursor-pointer items-center gap-2.5 text-sm">
          <input
            type="checkbox"
            checked={search.enabled}
            disabled={pending}
            onChange={(e) => {
              const next = { ...search, enabled: e.target.checked };
              setSearch(next);
              save({ webSearch: next });
            }}
            className="size-4 accent-[var(--accent)]"
          />
          {s.svcSearchEnabled}
        </label>
        <Field label={s.svcSearchMax}>
          <Select
            className="w-28"
            value={search.maxUses}
            disabled={pending || !search.enabled}
            onChange={(e) => {
              const next = { ...search, maxUses: Number(e.target.value) };
              setSearch(next);
              save({ webSearch: next });
            }}
          >
            {[1, 2, 3, 5, 10].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <KeyField icon={<KeyRound className="size-4 text-accent" />} title={s.svcOpenai} hint={s.svcOpenaiHint} state={services.openai} onSave={(v) => save({ openaiKey: v })} pending={pending} />
      <KeyField icon={<MapPinned className="size-4 text-accent" />} title={s.svcMaps} hint={s.svcMapsHint} state={services.maps} onSave={(v) => save({ googleMapsKey: v })} pending={pending} />

      {(pending || saved) && (
        <p className="flex items-center gap-1.5 text-sm text-muted">
          {pending ? <Spinner /> : <Check className="size-4 text-success" />}
          {!pending && s.svcSaved}
        </p>
      )}
    </Card>
  );
}

function KeyField({
  icon,
  title,
  hint,
  state,
  onSave,
  pending,
}: {
  icon: React.ReactNode;
  title: string;
  hint: string;
  state: "server" | "set" | "none";
  onSave: (v: string) => void;
  pending: boolean;
}) {
  const { t } = useI18n();
  const s = t.integrations;
  const [value, setValue] = useState("");
  return (
    <div className="space-y-2 border-t border-border pt-4">
      <div className="flex items-center gap-2 font-medium">
        {icon}
        {title}
        {state !== "none" && <span className="text-xs font-normal text-success">· {state === "server" ? s.svcKeyServer : s.svcKeySet}</span>}
      </div>
      <p className="text-sm text-muted">{hint}</p>
      {state !== "server" && (
        <div className="flex flex-wrap gap-2">
          <Input type="password" autoComplete="off" className="max-w-sm flex-1" value={value} placeholder={s.svcKeyPlaceholder} onChange={(e) => setValue(e.target.value)} />
          <Button
            variant="secondary"
            disabled={pending || !value.trim()}
            onClick={() => {
              onSave(value.trim());
              setValue("");
            }}
          >
            {s.svcSave}
          </Button>
          {state === "set" && (
            <Button variant="ghost" disabled={pending} onClick={() => onSave("")}>
              {s.svcRemove}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
