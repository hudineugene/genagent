"use client";

import { useRef, useState, useTransition } from "react";
import { ImageUp, Trash2 } from "lucide-react";
import { removeClientLogo, uploadClientLogo } from "@/app/actions/clients";
import { useI18n } from "@/lib/i18n/client";
import { Button, Card } from "@/components/ui";

/** Логотип клиента: загрузить свой (PNG, JPEG, WEBP до 1 МБ) или оставить значок с сайта клиента. */
export function ClientLogo({ clientId, hasCustom }: { clientId: string; hasCustom: boolean }) {
  const { locale } = useI18n();
  const uk = locale === "uk";
  const input = useRef<HTMLInputElement>(null);
  const [v, setV] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const errText = (e: string) =>
    e === "too_big" ? (uk ? "Файл більший за 1 МБ" : "Файл больше 1 МБ") : e === "type" ? (uk ? "Потрібна картинка PNG, JPEG або WEBP" : "Нужна картинка PNG, JPEG или WEBP") : uk ? "Не вдалося завантажити" : "Не удалось загрузить";
  return (
    <Card className="mt-6 flex flex-wrap items-center gap-4 p-5">
      {/* eslint-disable-next-line @next/next/no-img-element -- логотип отдаёт наш маршрут */}
      <img src={`/api/client-logo/${clientId}?v=${v}`} alt="" width={64} height={64} className="size-16 rounded-2xl bg-white object-contain ring-1 ring-border" />
      <div className="min-w-0 flex-1">
        <div className="font-semibold">{uk ? "Логотип" : "Логотип"}</div>
        <p className="text-sm text-muted">
          {hasCustom
            ? uk
              ? "Завантажений логотип — у списках, на карті й у звітах."
              : "Загруженный логотип — в списках, на карте и в отчётах."
            : uk
              ? "Зараз — значок із сайту клієнта (або літера). Можна завантажити свій: PNG, JPEG чи WEBP до 1 МБ, краще квадратний на прозорому фоні."
              : "Сейчас — значок с сайта клиента (или буква). Можно загрузить свой: PNG, JPEG или WEBP до 1 МБ, лучше квадратный на прозрачном фоне."}
        </p>
        {error && <p className="mt-1 text-sm text-danger">{error}</p>}
      </div>
      <input
        ref={input}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (!f) return;
          const fd = new FormData();
          fd.set("logo", f);
          start(async () => {
            const r = await uploadClientLogo(clientId, fd);
            setError(r.error ? errText(r.error) : null);
            setV((x) => x + 1);
          });
          e.target.value = "";
        }}
      />
      <div className="flex gap-2">
        <Button variant="secondary" disabled={pending} onClick={() => input.current?.click()}>
          <ImageUp className="size-4" />
          {uk ? "Завантажити" : "Загрузить"}
        </Button>
        {hasCustom && (
          <Button
            variant="ghost"
            disabled={pending}
            onClick={() =>
              start(async () => {
                await removeClientLogo(clientId);
                setV((x) => x + 1);
              })
            }
          >
            <Trash2 className="size-4" />
          </Button>
        )}
      </div>
    </Card>
  );
}
