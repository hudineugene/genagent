"use client";

import { Download, FileText } from "lucide-react";
import type { AgentConfig } from "@/lib/agent/types";
import type { MapStats } from "@/lib/agent/map-modules";
import { useI18n } from "@/lib/i18n/client";
import { MapCanvas, type MapChannel } from "@/components/agent-map/canvas";
import { downloadMapPng } from "@/components/agent-map/export";

/** Кабинет владельца: устройство агента картой — только просмотр, с работой за 7 дней и картинкой PNG. */
export function PortalAgentMap({ name, config, channels, stats, modelLabel, reportHref }: { name: string; config: AgentConfig; channels: MapChannel[]; stats: MapStats; modelLabel: string; reportHref: string }) {
  const { t, locale } = useI18n();
  const uk = locale === "uk";
  const coreLines = [
    { k: uk ? "Модель" : "Модель", v: modelLabel },
    { k: "Тон", v: t.builder.tones[config.tone] },
    { k: uk ? "Мова" : "Язык", v: t.builder.languages[config.replyLanguage] },
  ];
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <h2 className="min-w-0 flex-1 truncate font-semibold">
          {config.icon} {name}
        </h2>
        <a href={reportHref} target="_blank" rel="noopener" className="flex items-center gap-1.5 rounded-xl border border-border px-3 py-1.5 text-sm text-muted transition hover:text-text">
          <FileText className="size-4" />
          {uk ? "Звіт PDF" : "Отчёт PDF"}
        </a>
        <button
          type="button"
          onClick={() => void downloadMapPng({ config, agentName: name, coreLines, channels, ctx: null, locale, fileName: `agent-${name}`.replace(/[^\p{L}\p{N}-]+/gu, "-"), title: name })}
          className="flex items-center gap-1.5 rounded-xl border border-border px-3 py-1.5 text-sm text-muted transition hover:text-text"
        >
          <Download className="size-4" />
          {uk ? "Зберегти картинкою" : "Сохранить картинкой"}
        </button>
      </div>
      <MapCanvas config={config} agentName={name} coreLines={coreLines} channels={channels} ctx={null} stats={stats} locale={locale} coreTitle={uk ? "Ваш ШІ-агент" : "Ваш ИИ-агент"} />
    </div>
  );
}
