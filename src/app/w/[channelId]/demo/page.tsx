import { Suspense } from "react";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Предпросмотр виджета", robots: { index: false } };

export const instant = false;

/** Условная страница сайта клиента со вставленным виджетом — для проверки перед установкой. */
export default function WidgetDemoPage({ params }: { params: Promise<{ channelId: string }> }) {
  return (
    <div className="min-h-dvh bg-white text-[#141824]" style={{ colorScheme: "light" }}>
      <header className="border-b border-[#e3e6ef] px-6 py-4">
        <div className="mx-auto flex max-w-4xl items-center justify-between">
          <div className="h-5 w-32 rounded bg-[#e3e6ef]" />
          <div className="flex gap-4">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="h-3 w-16 rounded bg-[#eef0f5]" />
            ))}
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-4xl space-y-6 px-6 py-12">
        <div className="h-9 w-2/3 rounded-lg bg-[#e3e6ef]" />
        {[0, 1, 2].map((i) => (
          <div key={i} className="space-y-2">
            <div className="h-3 w-full rounded bg-[#eef0f5]" />
            <div className="h-3 w-11/12 rounded bg-[#eef0f5]" />
            <div className="h-3 w-4/5 rounded bg-[#eef0f5]" />
          </div>
        ))}
        <p className="pt-8 text-sm text-[#667085]">
          Это условная страница сайта. Кнопка чата в углу работает так же, как на настоящем сайте клиента.
        </p>
      </main>
      <Suspense>
        <WidgetScript params={params} />
      </Suspense>
    </div>
  );
}

async function WidgetScript({ params }: { params: Promise<{ channelId: string }> }) {
  const { channelId } = await params;
  return <script src="/widget.js" data-channel={channelId} async />;
}
