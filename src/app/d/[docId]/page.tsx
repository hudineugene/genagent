import { notFound } from "next/navigation";
import { connection } from "next/server";
import { eq } from "drizzle-orm";
import type { Metadata } from "next";
import { db } from "@/db";
import { clients, generatedDocs } from "@/db/schema";
import { PrintButton } from "./print-button";

/**
 * Документ, выданный агентом клиенту (КП, справка, счёт): страница для чтения, печати и сохранения в PDF.
 * Без входа — ссылка неугадываемая. Разметка шаблона: «# заголовок», «- пункт», «**жирный**», пустая строка — абзац.
 */
export const metadata: Metadata = { robots: { index: false, follow: false } };

function inline(text: string) {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, i) => (part.startsWith("**") && part.endsWith("**") ? <strong key={i}>{part.slice(2, -2)}</strong> : part));
}

function render(body: string) {
  const blocks = body.replace(/\r/g, "").split(/\n{2,}/);
  return blocks.map((b, i) => {
    const lines = b.split("\n").filter((l) => l.trim());
    if (!lines.length) return null;
    const h = lines[0].match(/^(#{1,3})\s+(.+)$/);
    if (h && lines.length === 1) {
      const cls = h[1].length === 1 ? "text-2xl font-bold" : h[1].length === 2 ? "text-xl font-semibold" : "text-lg font-semibold";
      return (
        <p key={i} className={cls}>
          {inline(h[2])}
        </p>
      );
    }
    if (lines.every((l) => /^\s*[-*•]\s+/.test(l))) {
      return (
        <ul key={i} className="list-disc space-y-1 pl-6">
          {lines.map((l, j) => (
            <li key={j}>{inline(l.replace(/^\s*[-*•]\s+/, ""))}</li>
          ))}
        </ul>
      );
    }
    return (
      <p key={i} className="whitespace-pre-line">
        {inline(lines.join("\n"))}
      </p>
    );
  });
}

export default async function DocumentPage({ params }: { params: Promise<{ docId: string }> }) {
  await connection();
  const { docId } = await params;
  if (!/^[A-Za-z0-9_-]{10,40}$/.test(docId)) notFound();
  const [row] = await db.select({ doc: generatedDocs, client: clients.name }).from(generatedDocs).innerJoin(clients, eq(clients.id, generatedDocs.clientId)).where(eq(generatedDocs.id, docId));
  if (!row) notFound();
  return (
    <div className="min-h-dvh bg-white text-[#141824] print:bg-white" style={{ colorScheme: "light" }}>
      <div className="mx-auto max-w-3xl px-6 py-10 print:p-0">
        <div className="mb-8 flex items-start justify-between gap-4 border-b border-[#e3e6ef] pb-4 print:border-0">
          <div>
            <div className="text-sm text-[#667085]">{row.client}</div>
            <h1 className="text-2xl font-bold">{row.doc.title}</h1>
          </div>
          <PrintButton />
        </div>
        <article className="space-y-4 text-[15px] leading-relaxed">{render(row.doc.body)}</article>
      </div>
    </div>
  );
}

export const instant = false;
