import Image from "next/image";
import mark from "@/assets/brand/genagent-mark.png";
import logo from "@/assets/brand/genagent-logo.png";
import { cx } from "./ui";

/*
 * Логотип GenAgent. Картинки подключены из src/assets, чтобы попасть в /_next/static (адрес открыт снаружи —
 * нужен на странице входа). unoptimized — без /_next/image: тот снаружи закрыт.
 */

/** Знак «G» на белой плитке: металлический знак читается и в светлой, и в тёмной теме. */
export function BrandMark({ size = 32, className }: { size?: number; className?: string }) {
  return (
    <span className={cx("grid shrink-0 place-items-center rounded-lg bg-white shadow-sm ring-1 ring-black/5", className)} style={{ width: size, height: size }}>
      <Image src={mark} alt="GenAgent" width={Math.round(size * 0.78)} height={Math.round(size * 0.78)} unoptimized priority />
    </span>
  );
}

/** Полный логотип «G | GenAgent · AI AGENTS PLATFORM»; в тёмной теме — светлый. */
export function BrandLogo({ width = 220, className }: { width?: number; className?: string }) {
  return <Image src={logo} alt="GenAgent — AI agents platform" width={width} height={Math.round((width * logo.height) / logo.width)} unoptimized priority className={cx("dark:invert", className)} />;
}
