import type { ReactNode } from "react";

/** Экран ошибки или «не найдено» в фирменном стиле: крупная металлическая цифра с тёплым свечением, текст и кнопки. */
export function ErrorScreen({ code, title, text, children }: { code: string; title: string; text: string; children?: ReactNode }) {
  return (
    <div className="grid min-h-[60vh] place-items-center px-4 py-12">
      <div className="max-w-md text-center">
        <div className="relative mx-auto mb-6 w-fit">
          <span aria-hidden className="absolute inset-0 -z-10 scale-150 rounded-full bg-accent/20 blur-3xl" />
          <span className="bg-gradient-to-b from-text to-muted bg-clip-text font-display text-8xl font-black tracking-tighter text-transparent">{code}</span>
        </div>
        <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
        <p className="mt-2 text-sm text-muted">{text}</p>
        {children && <div className="mt-6 flex flex-wrap justify-center gap-2">{children}</div>}
      </div>
    </div>
  );
}
