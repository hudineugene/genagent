import "server-only";
import { getSetting, setSetting } from "./settings";

/** Бренд студии для кабинета клиента и входа: название, цвет, логотип (адрес картинки или эмодзи), контакт поддержки. */
export type Brand = { name: string; color: string; logo: string; support: string };

export const DEFAULT_BRAND: Brand = { name: "GenAgent", color: "#6366f1", logo: "", support: "" };

export async function getBrand(): Promise<Brand> {
  return { ...DEFAULT_BRAND, ...((await getSetting<Partial<Brand>>("whitelabel")) ?? {}) };
}

export async function saveBrand(b: Brand) {
  await setSetting("whitelabel", b);
}
