import Link from "next/link";
import type { ReactNode } from "react";
import { Bell, BellOff, CalendarDays, DatabaseBackup, FileBarChart2, Plug, Share2 } from "lucide-react";
import { requireAdmin } from "@/lib/auth";
import { getT } from "@/lib/i18n/server";
import { getMetaSettings, metaUrls, publicUrl } from "@/lib/settings";
import { Card, EmptyState, PageHeader, buttonClass, cx } from "@/components/ui";
import { getGoogleSettings } from "@/lib/google/calendar";
import { GoogleCard, IntegrationsForm } from "./form";
import { NotifyCard } from "./notify-card";
import { BackupSection } from "./backup-section";
import { DailyDigestSection } from "./daily-section";
import { WeeklyTestsSection } from "./weekly-section";
import { WaitingSection } from "./waiting-section";
import { ServicesSection } from "./services-section";
import { getServices, serverKeys } from "@/lib/services";
import { getWaitingSettings } from "@/lib/agent/waiting";
import { getNotifySettings } from "@/lib/notify/telegram";
import { getOffsiteSettings } from "@/lib/offsite-backup";
import { getWeeklyTests, weeklyCoverage } from "@/lib/tests/weekly";
import { getAutoTests } from "@/lib/tests/auto";
import { getDailyDigest } from "@/lib/agent/daily";
import { getLeadsSettings } from "@/lib/agent/leads";

const TABS = ["notify", "reports", "backup", "social", "google", "services"] as const;
type Tab = (typeof TABS)[number];

/** Интеграции по вкладкам: у каждой отметка «подключено»; отчёты и копия базы — после бота уведомлений. */
export default async function IntegrationsPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const [{ t }, sp] = await Promise.all([getT(), searchParams]);
  await requireAdmin();
  const tab: Tab = TABS.find((x) => x === sp.tab) ?? "notify";
  const s = t.integrations;
  const [meta, google, notify, offsite, weekly, coverage, daily, waiting, leads, autoTests, services] = await Promise.all([
    getMetaSettings(),
    getGoogleSettings(),
    getNotifySettings(),
    getOffsiteSettings(),
    getWeeklyTests(),
    weeklyCoverage(),
    getDailyDigest(),
    getWaitingSettings(),
    getLeadsSettings(),
    getAutoTests(),
    getServices(),
  ]);
  const srv = serverKeys();
  const base = publicUrl();
  const subscribers = notify?.token ? notify.subscribers : [];
  const notifyReady = subscribers.length > 0;

  const on: Record<Tab, boolean> = {
    notify: notifyReady,
    reports: notifyReady && (daily.enabled || weekly.enabled),
    backup: notifyReady && Boolean(offsite?.enabled),
    social: Boolean(meta.instagram || meta.threads),
    google: Boolean(google?.clientEmail),
    services: services.webSearch.enabled || Boolean(services.openaiKey || srv.openai || services.googleMapsKey || srv.maps),
  };
  const icons: Record<Tab, ReactNode> = {
    notify: <Bell className="size-4" />,
    reports: <FileBarChart2 className="size-4" />,
    backup: <DatabaseBackup className="size-4" />,
    social: <Share2 className="size-4" />,
    google: <CalendarDays className="size-4" />,
    services: <Plug className="size-4" />,
  };

  const needNotify = (
    <EmptyState
      icon={<BellOff />}
      title={s.needNotifyTitle}
      text={s.needNotifyText}
      action={
        <Link href="/integrations" className={buttonClass("secondary", "sm")}>
          {s.needNotifyButton}
        </Link>
      }
    />
  );

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader title={s.title} />
      <div className="grid grid-cols-1 gap-6 md:grid-cols-[220px_minmax(0,1fr)]">
        <nav className="flex gap-1 overflow-x-auto [scrollbar-width:none] md:flex-col md:overflow-visible">
          {TABS.map((key) => (
            <Link
              key={key}
              href={key === "notify" ? "/integrations" : `/integrations?tab=${key}`}
              replace
              className={cx(
                "flex shrink-0 items-center gap-2.5 rounded-xl px-3 py-2 text-sm font-medium transition",
                tab === key ? "bg-surface text-text shadow-sm ring-1 ring-border" : "text-muted hover:bg-surface-2 hover:text-text",
              )}
            >
              <span className={cx(tab === key && "text-accent")}>{icons[key]}</span>
              <span className="flex-1">{s.tabs[key]}</span>
              <span className={cx("size-2 shrink-0 rounded-full", on[key] ? "bg-success" : "bg-muted/30")} title={on[key] ? s.tabOn : s.tabOff} />
            </Link>
          ))}
        </nav>

        <div className="min-w-0 space-y-6">
          {tab === "notify" && (
            <NotifyCard
              notify={
                notify?.token
                  ? { botUsername: notify.botUsername, link: `https://t.me/${notify.botUsername}?start=${notify.linkCode}`, subscribers: notify.subscribers }
                  : null
              }
            />
          )}

          {tab === "reports" &&
            (notifyReady ? (
              <>
                <Section>
                  <WaitingSection waiting={waiting} />
                </Section>
                <Section>
                  <DailyDigestSection daily={{ enabled: daily.enabled, hour: daily.hour }} />
                  <DailyDigestSection kind="leads" daily={{ enabled: leads.enabled, hour: leads.hour }} />
                </Section>
                <Section>
                  <WeeklyTestsSection
                    weekly={{
                      autoEnabled: autoTests.enabled,
                      enabled: weekly.enabled,
                      weekday: weekly.weekday,
                      hour: weekly.hour,
                      lastRunAt: weekly.lastRunAt ?? null,
                      lastSummary: weekly.lastSummary ?? null,
                      ...coverage,
                    }}
                  />
                </Section>
              </>
            ) : (
              needNotify
            ))}

          {tab === "backup" &&
            (notifyReady ? (
              <Section>
                <BackupSection
                  subscribers={subscribers}
                  offsite={
                    offsite
                      ? {
                          enabled: offsite.enabled,
                          chatId: offsite.chatId,
                          hasPassword: Boolean(offsite.key),
                          lastSentAt: offsite.lastSentAt ?? null,
                          lastError: offsite.lastError ?? null,
                          filesNote: offsite.filesNote ?? null,
                        }
                      : null
                  }
                />
              </Section>
            ) : (
              needNotify
            ))}

          {tab === "social" && (
            <IntegrationsForm
              instagram={meta.instagram ? { appId: meta.instagram.appId, hasSecret: true } : null}
              threads={meta.threads ? { appId: meta.threads.appId, hasSecret: true } : null}
              whatsapp={meta.whatsapp ? { appId: meta.whatsapp.appId, hasSecret: true } : null}
              verifyToken={meta.verifyToken}
              urls={base ? metaUrls(base) : null}
            />
          )}

          {tab === "google" && <GoogleCard email={google?.clientEmail ?? null} />}

          {tab === "services" && (
            <ServicesSection
              services={{
                webSearch: services.webSearch,
                openai: srv.openai ? "server" : services.openaiKey ? "set" : "none",
                maps: srv.maps ? "server" : services.googleMapsKey ? "set" : "none",
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}

/** Карточка для раздела, который раньше жил внутри карточки уведомлений (у него своя верхняя линия — убираем). */
function Section({ children }: { children: ReactNode }) {
  return <Card className="p-5 [&>div]:border-t-0 [&>div]:pt-0">{children}</Card>;
}

export const instant = false;
