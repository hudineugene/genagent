import type { ReactNode } from "react";

/** Каждая страница студии появляется мягко: шаблон пересоздаётся при каждом переходе. */
export default function Template({ children }: { children: ReactNode }) {
  return <div className="animate-page-in">{children}</div>;
}
