"use client";

import { useRef, useState, useTransition } from "react";
import { ImageUp, Trash2 } from "lucide-react";
import { removeAvatarAction, uploadAvatar } from "@/app/actions/profile";
import { useI18n } from "@/lib/i18n/client";
import { Button, Card } from "@/components/ui";
import { UserAvatar } from "@/components/user-avatar";
import { toast } from "@/components/toast";

/** Фото профиля: видно в меню и в «Сотрудниках». */
export function AvatarCard({ userId, name, version }: { userId: string; name: string; version: number }) {
  const { t } = useI18n();
  const a = t.shell.avatar;
  const input = useRef<HTMLInputElement>(null);
  const [v, setV] = useState(version);
  const [pending, start] = useTransition();
  return (
    <Card className="mb-6 flex flex-wrap items-center gap-4 p-5">
      <UserAvatar id={userId} name={name} v={v} size={64} />
      <div className="min-w-0 flex-1">
        <div className="font-semibold">{a.title}</div>
        <p className="text-sm text-muted">{a.hint}</p>
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
          fd.set("photo", f);
          start(async () => {
            const r = await uploadAvatar(fd);
            if (r.error) toast(a.errors[r.error], "error");
            else {
              toast(a.saved);
              setV(Date.now());
            }
          });
          e.target.value = "";
        }}
      />
      <div className="flex gap-2">
        <Button variant="secondary" disabled={pending} onClick={() => input.current?.click()}>
          <ImageUp className="size-4" />
          {a.upload}
        </Button>
        {v > 0 && (
          <Button
            variant="ghost"
            disabled={pending}
            aria-label={a.remove}
            title={a.remove}
            onClick={() =>
              start(async () => {
                await removeAvatarAction();
                setV(0);
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
