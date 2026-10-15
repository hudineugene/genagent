import { requireAdmin } from "@/lib/auth";
import { getT } from "@/lib/i18n/server";
import { getMetaSettings, metaUrls, publicUrl } from "@/lib/settings";
import { PageHeader } from "@/components/ui";
import { getGoogleSettings } from "@/lib/google/calendar";
import { GoogleCard, IntegrationsForm } from "./form";
import { NotifyCard } from "./notify-card";
import { getNotifySettings } from "@/lib/notify/telegram";
import { getOffsiteSettings } from "@/lib/offsite-backup";
import { getWeeklyTests, weeklyCoverage } from "@/lib/tests/weekly";

export default async function IntegrationsPage() {
  const { t } = await getT();
  await requireAdmin();
  const meta = await getMetaSettings();
  const base = publicUrl();
  const google = await getGoogleSettings();
  const notify = await getNotifySettings();
  const offsite = await getOffsiteSettings();
  const [weekly, coverage] = await Promise.all([getWeeklyTests(), weeklyCoverage()]);
  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title={t.integrations.title} subtitle={t.integrations.subtitle} />
      <IntegrationsForm
        instagram={meta.instagram ? { appId: meta.instagram.appId, hasSecret: true } : null}
        threads={meta.threads ? { appId: meta.threads.appId, hasSecret: true } : null}
        verifyToken={meta.verifyToken}
        urls={base ? metaUrls(base) : null}
      />
      <div className="mt-6">
        <NotifyCard
          notify={
            notify?.token
              ? {
                  botUsername: notify.botUsername,
                  link: `https://t.me/${notify.botUsername}?start=${notify.linkCode}`,
                  subscribers: notify.subscribers,
                }
              : null
          }
          offsite={
            offsite
              ? {
                  enabled: offsite.enabled,
                  chatId: offsite.chatId,
                  hasPassword: Boolean(offsite.key),
                  lastSentAt: offsite.lastSentAt ?? null,
                  lastError: offsite.lastError ?? null,
                }
              : null
          }
          weekly={{
            enabled: weekly.enabled,
            weekday: weekly.weekday,
            hour: weekly.hour,
            lastRunAt: weekly.lastRunAt ?? null,
            lastSummary: weekly.lastSummary ?? null,
            ...coverage,
          }}
        />
      </div>
      <div className="mt-6">
        <GoogleCard email={google?.clientEmail ?? null} />
      </div>
    </div>
  );
}

export const instant = false;
