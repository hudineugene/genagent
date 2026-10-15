"use client";

import { useTransition } from "react";
import { Trash2 } from "lucide-react";
import { useI18n } from "@/lib/i18n/client";
import { Button, Spinner } from "./ui";

export function ConfirmButton({ action, label }: { action: () => Promise<void>; label: string }) {
  const { t } = useI18n();
  const [pending, start] = useTransition();
  return (
    <Button
      type="button"
      variant="danger"
      disabled={pending}
      onClick={() => {
        if (confirm(t.common.confirmDelete)) start(() => action());
      }}
    >
      {pending ? <Spinner /> : <Trash2 className="size-4" />}
      {label}
    </Button>
  );
}
