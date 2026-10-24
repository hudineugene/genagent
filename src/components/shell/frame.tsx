"use client";

import { usePathname } from "next/navigation";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { navContext, type NavCtx } from "@/app/actions/nav";

type Shell = {
  /** Данные для панели и пути вверху; для другой страницы — прошлые, пока не пришли новые (без мигания) */
  ctx: NavCtx | null;
  /** Для какого адреса ctx */
  ctxPath: string;
  panel: boolean;
  togglePanel: () => void;
};

const ShellContext = createContext<Shell>({ ctx: null, ctxPath: "", panel: true, togglePanel: () => {} });
export const useShell = () => useContext(ShellContext);

/**
 * Каркас программы (компьютер): рельса разделов, панель текущего клиента или агента и содержимое. Панель
 * сворачивается (выбор хранится в cookie — страница сразу рисуется как надо). data-panel на обёртке: CSS прячет
 * дубли меню панели внутри страниц, пока панель открыта.
 */
export function ShellFrame({ initialPanel, children }: { initialPanel: boolean; children: ReactNode }) {
  const pathname = usePathname();
  const [panel, setPanel] = useState(initialPanel);
  const [state, setState] = useState<{ ctx: NavCtx | null; path: string }>({ ctx: null, path: "" });
  // Счётчики раздела обновляются при каждом переходе: на другой вкладке клиента они могли измениться
  useEffect(() => {
    let alive = true;
    navContext(pathname)
      .then((ctx) => alive && setState({ ctx, path: pathname }))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [pathname]);
  const togglePanel = () => {
    setPanel((v) => {
      document.cookie = `panel=${v ? "off" : "on"}; path=/; max-age=31536000; samesite=lax`;
      return !v;
    });
  };
  return (
    <ShellContext.Provider value={{ ctx: state.ctx, ctxPath: state.path, panel, togglePanel }}>
      <div data-panel={panel ? "on" : "off"} className="flex min-h-dvh flex-col md:flex-row">
        {children}
      </div>
    </ShellContext.Provider>
  );
}
