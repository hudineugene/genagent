"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** Обновляет ленту диалогов каждые 3 секунды, пока вкладка видна. */
export function InboxPoller() {
  const router = useRouter();
  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, 3000);
    return () => clearInterval(id);
  }, [router]);
  return null;
}
