"use client";

import { useState, useTransition } from "react";
import { portalAnswerGap, portalReply } from "@/app/actions/portal";
import { useI18n } from "@/lib/i18n/client";
import { Button, Textarea } from "@/components/ui";

export function PortalReply({ conversationId }: { conversationId: string }) {
  const { t } = useI18n();
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <div className="space-y-2 border-t border-border pt-3">
      <Textarea rows={2} value={text} maxLength={4000} placeholder={t.portal.replyPlaceholder} onChange={(e) => setText(e.target.value)} />
      <div className="flex items-center gap-3">
        <Button
          size="sm"
          disabled={pending || !text.trim()}
          onClick={() =>
            start(async () => {
              const r = await portalReply(conversationId, text);
              if (r.error) setError(r.error);
              else {
                setText("");
                setError(null);
              }
            })
          }
        >
          {t.portal.send}
        </Button>
        <span className="text-xs text-muted">{t.portal.replyHint}</span>
        {error && <span className="text-sm text-danger">{error}</span>}
      </div>
    </div>
  );
}

export function GapAnswer({ gapId, suggestion }: { gapId: string; suggestion: string }) {
  const { t } = useI18n();
  const [text, setText] = useState(suggestion);
  const [done, setDone] = useState(false);
  const [pending, start] = useTransition();
  if (done) return <p className="text-sm text-success">{t.portal.learned}</p>;
  return (
    <div className="space-y-2">
      <Textarea rows={2} value={text} maxLength={4000} placeholder={t.portal.answerPlaceholder} onChange={(e) => setText(e.target.value)} />
      <Button size="sm" disabled={pending || text.trim().length < 2} onClick={() => start(async () => setDone(!(await portalAnswerGap(gapId, text)).error))}>
        {t.portal.teach}
      </Button>
    </div>
  );
}
