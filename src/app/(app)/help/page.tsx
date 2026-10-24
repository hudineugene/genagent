import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { getT } from "@/lib/i18n/server";
import { parseHelp } from "@/lib/help-md";
import { HELP_MD } from "@/content/help";
import { CHANGELOG } from "@/content/changelog";
import { Card, PageHeader, cx } from "@/components/ui";
import { HelpGuide } from "./guide";

/** Помощь: инструкция по программе (поиск, оглавление) и хроника изменений по датам. */
export default async function HelpPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  await requireUser();
  const { t, locale } = await getT();
  const h = t.help;
  const tab = (await searchParams).tab === "changes" ? "changes" : "guide";
  const date = new Intl.DateTimeFormat(locale === "uk" ? "uk-UA" : "ru-RU", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader title={h.title} subtitle={h.subtitle} />
      <div className="flex gap-1 rounded-xl bg-surface-2/60 p-1 text-sm font-medium sm:w-fit">
        {(["guide", "changes"] as const).map((k) => (
          <Link
            key={k}
            href={k === "guide" ? "/help" : "/help?tab=changes"}
            className={cx("flex-1 rounded-lg px-4 py-1.5 text-center transition sm:flex-none", tab === k ? "bg-surface text-text shadow-sm ring-1 ring-border" : "text-muted hover:text-text")}
          >
            {k === "guide" ? h.tabGuide : h.tabChanges}
          </Link>
        ))}
      </div>
      {tab === "guide" ? (
        <HelpGuide sections={parseHelp(HELP_MD)} />
      ) : (
        <div className="max-w-3xl space-y-4">
          {CHANGELOG.map((d) => (
            <Card key={d.date} className="p-5">
              <h2 className="mb-3 text-base font-semibold">{date.format(new Date(`${d.date}T12:00:00Z`))}</h2>
              <ul className="space-y-3">
                {d.items.map((it) => (
                  <li key={it.title} className="flex gap-3 text-sm">
                    <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-accent" />
                    <span>
                      <span className="font-medium">{it.title}.</span> <span className="text-muted">{it.text}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

// Страница зависит от сессии и свежих данных — собирается по запросу.
export const instant = false;
