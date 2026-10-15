import { Suspense } from "react";
import type { Metadata } from "next";
import { WidgetChat } from "./widget-chat";

export const metadata: Metadata = { title: "Chat", robots: { index: false } };

export const instant = false;

/** Окно чата виджета. Открывается в iframe на сайте клиента студии, без входа в систему. */
export default function WidgetPage({ params }: { params: Promise<{ channelId: string }> }) {
  return (
    <Suspense>
      <Chat params={params} />
    </Suspense>
  );
}

async function Chat({ params }: { params: Promise<{ channelId: string }> }) {
  const { channelId } = await params;
  return <WidgetChat channelId={channelId} />;
}
