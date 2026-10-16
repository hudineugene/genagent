"use client";

import { useState, useTransition } from "react";
import { FlaskConical } from "lucide-react";
import { saveTestAccountsAction } from "@/app/actions/test-accounts";
import { Button, Card, Textarea } from "@/components/ui";
import { InfoHint } from "@/components/hint";
import { useI18n } from "@/lib/i18n/client";

/** Тестовые аккаунты: их разговоры — «тест» (не в аналитике, памяти, обучении и проверках). */
export function TestAccounts({ initial }: { initial: string }) {
  const { t } = useI18n();
  const [value, setValue] = useState(initial);
  const [note, setNote] = useState("");
  const [pending, start] = useTransition();
  return (
    <Card className="mt-6 space-y-3 p-5">
      <h2 className="flex items-center gap-2 font-semibold">
        <FlaskConical className="size-4 text-accent" />
        {t.team.testTitle}
        <InfoHint>{t.team.testHint}</InfoHint>
      </h2>
      <Textarea rows={3} value={value} onChange={(e) => setValue(e.target.value)} placeholder={t.team.testPlaceholder} />
      <div className="flex flex-wrap items-center gap-3">
        <Button
          size="sm"
          disabled={pending}
          onClick={() =>
            start(async () => {
              const r = await saveTestAccountsAction(value);
              setValue(r.list.join("\n"));
              setNote(
                [t.team.testSaved.replace("{n}", String(r.marked)), r.bad.length ? `${t.team.testBad}: ${r.bad.join(", ")}` : ""].filter(Boolean).join(" · "),
              );
            })
          }
        >
          {t.common.save}
        </Button>
        {note && <span className="text-xs text-muted">{note}</span>}
      </div>
    </Card>
  );
}
