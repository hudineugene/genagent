"use client";

import { useState, useTransition } from "react";
import { ExternalLink, MapPin, Plus, Route, Truck, X } from "lucide-react";
import { planRoutes, saveLogistics } from "@/app/actions/logistics";
import { useI18n } from "@/lib/i18n/client";
import { Badge, Button, Card, Field, Input, Spinner, Textarea } from "@/components/ui";
import type { Vehicle } from "@/db/schema";
import type { PlannedRoute, Stop } from "@/lib/logistics/routes";

export type LogisticsRow = { baseAddress: string; stopMinutes: number; vehicles: Vehicle[]; deliveryNote: string };

const localInput = (ms: number) => new Date(ms - new Date(ms).getTimezoneOffset() * 60_000).toISOString().slice(0, 16);

export function LogisticsManager({ clientId, settings, mapsKey }: { clientId: string; settings: LogisticsRow; mapsKey: boolean }) {
  const { t } = useI18n();
  const g = t.logistics;
  return (
    <div className="space-y-6">
      <p className="max-w-3xl text-sm text-muted">{g.subtitle}</p>
      {!mapsKey && <p className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-sm">{g.noKey}</p>}
      <SettingsCard clientId={clientId} initial={settings} />
      {settings.baseAddress && <Planner clientId={clientId} hasVehicles={settings.vehicles.length > 0} />}
    </div>
  );
}

function SettingsCard({ clientId, initial }: { clientId: string; initial: LogisticsRow }) {
  const { t } = useI18n();
  const g = t.logistics;
  const [v, setV] = useState(initial);
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const setVehicle = (i: number, p: Partial<Vehicle>) => setV({ ...v, vehicles: v.vehicles.map((x, j) => (j === i ? { ...x, ...p } : x)) });
  const num = (s: string) => Math.max(0, Number(s.replace(",", ".")) || 0);
  return (
    <Card className="space-y-4 p-5">
      <div className="flex items-center gap-2 font-semibold">
        <MapPin className="size-4 text-accent" />
        {g.settings}
      </div>
      <div className="flex flex-wrap gap-3">
        <Field label={g.base} hint={g.baseHint}>
          <Input className="w-96 max-w-full" value={v.baseAddress} maxLength={300} placeholder={g.basePlaceholder} onChange={(e) => setV({ ...v, baseAddress: e.target.value })} />
        </Field>
        <Field label={g.stopMinutes}>
          <Input type="number" min={0} max={240} className="w-28" value={v.stopMinutes} onChange={(e) => setV({ ...v, stopMinutes: Math.min(240, Math.round(num(e.target.value))) })} />
        </Field>
      </div>
      <div className="space-y-2">
        <div className="text-sm font-semibold">{g.vehicles}</div>
        <p className="text-xs text-muted">{g.vehiclesHint}</p>
        {v.vehicles.map((x, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2">
            <Input className="w-48" value={x.name} maxLength={60} placeholder={g.vehicleName} onChange={(e) => setVehicle(i, { name: e.target.value })} />
            <Input type="number" min={0} className="w-28" value={x.capacityKg} title={g.kg} onChange={(e) => setVehicle(i, { capacityKg: num(e.target.value) })} />
            <span className="text-xs text-muted">{g.kg}</span>
            <Input type="number" min={0} step="0.1" className="w-24" value={x.capacityM3} title={g.m3} onChange={(e) => setVehicle(i, { capacityM3: num(e.target.value) })} />
            <span className="text-xs text-muted">{g.m3}</span>
            <Button variant="ghost" size="sm" onClick={() => setV({ ...v, vehicles: v.vehicles.filter((_, j) => j !== i) })}>
              <X className="size-4" />
            </Button>
          </div>
        ))}
        <Button variant="secondary" size="sm" onClick={() => setV({ ...v, vehicles: [...v.vehicles, { name: `${g.vehicleName} ${v.vehicles.length + 1}`, capacityKg: 1500, capacityM3: 10 }] })}>
          <Plus className="size-4" />
          {g.addVehicle}
        </Button>
      </div>
      <Field label={g.deliveryNote} hint={g.deliveryNoteHint}>
        <Textarea rows={2} value={v.deliveryNote} maxLength={2000} placeholder={g.deliveryNotePlaceholder} onChange={(e) => setV({ ...v, deliveryNote: e.target.value })} />
      </Field>
      <div className="flex items-center gap-3">
        <Button
          disabled={pending}
          onClick={() =>
            start(async () => {
              const r = await saveLogistics(clientId, { ...v, vehicles: v.vehicles.filter((x) => x.name.trim()) });
              setMsg(r.error ? g.errors.invalid : g.saved);
            })
          }
        >
          {g.save}
        </Button>
        {msg && <span className="text-sm text-muted">{msg}</span>}
      </div>
    </Card>
  );
}

function Planner({ clientId, hasVehicles }: { clientId: string; hasVehicles: boolean }) {
  const { t, locale } = useI18n();
  const g = t.logistics;
  const [v, setV] = useState(() => ({ stops: "", departure: localInput(Date.now() + 30 * 60_000), returnToBase: true, split: hasVehicles }));
  const [result, setResult] = useState<{ routes: PlannedRoute[]; unassigned: Stop[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const hm = new Intl.DateTimeFormat(locale === "uk" ? "uk-UA" : "ru-RU", { hour: "2-digit", minute: "2-digit" });
  const submit = () =>
    start(async () => {
      setError(null);
      const r = await planRoutes(clientId, { ...v, departure: new Date(v.departure).getTime() });
      if (r.error) {
        setResult(null);
        setError(r.error.startsWith("google:") ? `${g.errors.google} ${r.error.slice(7)}` : ((g.errors as Record<string, string>)[r.error] ?? r.error));
      } else setResult({ routes: r.routes ?? [], unassigned: r.unassigned ?? [] });
    });
  return (
    <Card className="space-y-4 p-5">
      <div className="flex items-center gap-2 font-semibold">
        <Route className="size-4 text-accent" />
        {g.planner}
      </div>
      <Field label={g.stops} hint={g.stopsHint}>
        <Textarea rows={6} className="font-mono text-[13px]" value={v.stops} maxLength={20_000} placeholder={g.stopsPlaceholder} onChange={(e) => setV({ ...v, stops: e.target.value })} />
      </Field>
      <div className="flex flex-wrap items-end gap-4">
        <Field label={g.departure}>
          <Input type="datetime-local" className="w-56" value={v.departure} onChange={(e) => setV({ ...v, departure: e.target.value })} />
        </Field>
        <label className="flex items-center gap-2 pb-2 text-sm">
          <input type="checkbox" className="size-4 accent-[var(--accent)]" checked={v.returnToBase} onChange={(e) => setV({ ...v, returnToBase: e.target.checked })} />
          {g.returnToBase}
        </label>
        {hasVehicles && (
          <label className="flex items-center gap-2 pb-2 text-sm">
            <input type="checkbox" className="size-4 accent-[var(--accent)]" checked={v.split} onChange={(e) => setV({ ...v, split: e.target.checked })} />
            {g.split}
          </label>
        )}
      </div>
      {error && <p className="text-sm text-danger">{error}</p>}
      <Button disabled={pending || !v.stops.trim()} onClick={submit}>
        {pending ? <Spinner /> : <Route className="size-4" />}
        {g.plan}
      </Button>
      {result && (
        <div className="space-y-4 border-t border-border pt-4">
          {result.unassigned.length > 0 && (
            <p className="text-sm text-danger">
              {g.unassigned}: {result.unassigned.map((s) => s.name).join(", ")}
            </p>
          )}
          {result.routes.map((r, i) => (
            <div key={i} className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                {r.vehicle && (
                  <Badge tone="accent">
                    <Truck className="size-3.5" /> {r.vehicle}
                  </Badge>
                )}
                <span className="text-sm font-semibold">{g.total.replace("{km}", String(r.km)).replace("{h}", String(Math.floor(r.minutes / 60))).replace("{m}", String(r.minutes % 60))}</span>
                {(r.kg > 0 || r.m3 > 0) && (
                  <span className="text-xs text-muted">
                    {r.kg} {g.kg} · {r.m3} {g.m3}
                  </span>
                )}
                <a href={r.mapsUrl} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-xs text-accent hover:underline">
                  <ExternalLink className="size-3.5" />
                  {g.openMaps}
                </a>
              </div>
              <ol className="space-y-1 text-sm">
                {r.stops.map((s, j) => (
                  <li key={j} className="flex flex-wrap gap-2">
                    <span className="w-14 font-semibold">{hm.format(s.eta)}</span>
                    <span className="min-w-0 flex-1">
                      {j + 1}. {s.name !== String(j + 1) && s.name !== s.address ? <b>{s.name} </b> : null}
                      {s.address}
                    </span>
                    <span className="text-xs text-muted">
                      +{s.legKm} {g.km} · {s.legMin} {g.min}
                    </span>
                  </li>
                ))}
              </ol>
              <p className="text-xs text-muted">{(v.returnToBase ? g.backAt : g.endAt).replace("{t}", hm.format(r.back))}</p>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
