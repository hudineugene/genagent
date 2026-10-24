"use client";

import { Fragment, useMemo, useState, type ReactNode } from "react";
import { Search } from "lucide-react";
import { blockText, type HelpBlock, type HelpSection } from "@/lib/help-md";
import { useI18n } from "@/lib/i18n/client";
import { Card, Input } from "@/components/ui";

/** **жирный** внутри строки; при поиске — подсветка найденного. */
function Inline({ text, q }: { text: string; q: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith("**") && p.endsWith("**") ? (
          <strong key={i} className="font-semibold">
            <Mark text={p.slice(2, -2)} q={q} />
          </strong>
        ) : (
          <Mark key={i} text={p} q={q} />
        ),
      )}
    </>
  );
}

function Mark({ text, q }: { text: string; q: string }): ReactNode {
  if (!q) return text;
  const i = text.toLowerCase().indexOf(q);
  if (i < 0) return text;
  return (
    <>
      {text.slice(0, i)}
      <mark className="rounded bg-amber-300/40 text-inherit">{text.slice(i, i + q.length)}</mark>
      <Mark text={text.slice(i + q.length)} q={q} />
    </>
  );
}

function Block({ b, q }: { b: HelpBlock; q: string }) {
  switch (b.k) {
    case "p":
      return (
        <p className="text-sm leading-relaxed">
          <Inline text={b.text} q={q} />
        </p>
      );
    case "h3":
      return (
        <h3 className="pt-1 text-sm font-semibold">
          <Inline text={b.text} q={q} />
        </h3>
      );
    case "ul":
    case "ol": {
      const L = b.k === "ul" ? "ul" : "ol";
      return (
        <L className={b.k === "ul" ? "list-disc space-y-1.5 pl-5 text-sm leading-relaxed" : "list-decimal space-y-1.5 pl-5 text-sm leading-relaxed"}>
          {b.items.map((it, i) => (
            <li key={i}>
              <Inline text={it} q={q} />
            </li>
          ))}
        </L>
      );
    }
    case "table":
      return (
        <div className="overflow-x-auto rounded-xl border border-border">
          <table className="w-full min-w-[520px] text-left text-sm">
            <thead className="bg-surface-2/60 text-xs text-muted">
              <tr>
                {b.head.map((h, i) => (
                  <th key={i} className="px-3 py-2 font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {b.rows.map((r, i) => (
                <tr key={i} className="align-top">
                  {r.map((c, j) => (
                    <td key={j} className={j === 0 ? "px-3 py-2 font-medium" : "px-3 py-2 text-muted"}>
                      <Inline text={c} q={q} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
  }
}

/** Таблица при поиске — только строки с найденным (и заголовок). */
function filterBlock(b: HelpBlock, q: string): HelpBlock | null {
  if (!q) return b;
  if (b.k === "table") {
    const rows = b.rows.filter((r) => r.join(" ").toLowerCase().includes(q));
    return rows.length ? { ...b, rows } : null;
  }
  return blockText(b).toLowerCase().includes(q) ? b : null;
}

export function HelpGuide({ sections }: { sections: HelpSection[] }) {
  const { t } = useI18n();
  const h = t.help;
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const shown = useMemo(
    () =>
      sections
        .map((s) => {
          if (!q || s.title.toLowerCase().includes(q)) return s;
          const blocks = s.blocks.map((b) => filterBlock(b, q)).filter((b): b is HelpBlock => Boolean(b));
          return blocks.length ? { ...s, blocks } : null;
        })
        .filter((s): s is HelpSection => Boolean(s)),
    [sections, q],
  );

  return (
    <div className="grid gap-6 md:grid-cols-[220px_minmax(0,1fr)]">
      <aside className="space-y-3 md:sticky md:top-6 md:h-fit">
        <label className="relative block">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" />
          <Input className="pl-9" placeholder={h.search} value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
        <nav className="hidden space-y-0.5 text-sm md:block">
          <div className="px-2 pb-1 text-xs font-medium text-muted">{h.contents}</div>
          {shown
            .filter((s) => s.title)
            .map((s) => (
              <a key={s.id} href={`#${s.id}`} className="block truncate rounded-lg px-2 py-1 text-muted hover:bg-surface-2 hover:text-text">
                {s.title}
              </a>
            ))}
        </nav>
      </aside>
      <div className="min-w-0 space-y-4">
        {shown.length === 0 && <Card className="p-6 text-sm text-muted">{h.nothing}</Card>}
        {shown.map((s) => (
          <Card key={s.id} id={s.id} className="scroll-mt-6 space-y-3 p-5">
            {s.title && (
              <h2 className="text-base font-semibold">
                <Inline text={s.title} q={q} />
              </h2>
            )}
            {s.blocks.map((b, i) => (
              <Fragment key={i}>
                <Block b={b} q={q} />
              </Fragment>
            ))}
          </Card>
        ))}
      </div>
    </div>
  );
}
