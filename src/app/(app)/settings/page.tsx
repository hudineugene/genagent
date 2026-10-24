import { requireAdmin } from "@/lib/auth";
import { getT } from "@/lib/i18n/server";
import { getGeneral } from "@/lib/general";
import { studioMonthSpend } from "@/lib/usage";
import { MODELS } from "@/lib/models";
import { PageHeader } from "@/components/ui";
import { GeneralForm } from "./form";

/** Общие настройки программы: студия и время, новые агенты, рассылки, расходы ИИ студии. */
export default async function SettingsPage() {
  await requireAdmin();
  const { t } = await getT();
  const [general, spent] = await Promise.all([getGeneral(), studioMonthSpend()]);
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader title={t.general.title} subtitle={t.general.subtitle} />
      <GeneralForm initial={general} spent={spent} models={MODELS.map((m) => ({ id: m.id, label: m.label }))} timeZones={Intl.supportedValuesOf("timeZone")} />
    </div>
  );
}
