import "server-only";
import { createDb, type Db } from "./client";

// Один экземпляр на процесс (в dev переживает hot reload). Подключение ленивое:
// база открывается при первом запросе, а не при импорте модуля (важно для `next build`).
const g = globalThis as unknown as { __db?: Db };

function real(): Db {
  return (g.__db ??= createDb());
}

export const db = new Proxy({} as Db, {
  get(_, prop) {
    const target = real();
    const value = Reflect.get(target, prop, target);
    return typeof value === "function" ? value.bind(target) : value;
  },
});
