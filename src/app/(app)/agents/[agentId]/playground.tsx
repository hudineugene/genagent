"use client";

import { useEffect, useRef, useState } from "react";
import { BookOpen, CalendarCheck, CalendarSearch, FlaskConical, Hand, RotateCcw, SendHorizontal, Square, TriangleAlert } from "lucide-react";
import type { AgentConfig } from "@/lib/agent/types";
import { useI18n } from "@/lib/i18n/client";
import { Button, Card, Spinner, cx } from "@/components/ui";
import { ChannelIcon } from "@/components/agent-map/channel-icon";

/**
 * Вид тест-чата «как в канале»: фон и пузыри Telegram, WhatsApp, Instagram или виджета на сайте — чтобы показать
 * клиенту, как ответ увидят его покупатели. limit — длина сообщения, после которой канал его разобьёт или обрежет.
 */
const SKINS = {
  plain: { area: "bg-surface-2/50", user: "rounded-br-md bg-accent text-accent-text", bot: "rounded-bl-md border border-border bg-surface", limit: 0 },
  telegram: { area: "bg-[#cfe3c4] dark:bg-[#0e1621]", user: "rounded-br-sm bg-[#effdde] text-[#0f1419] shadow-sm dark:bg-[#2b5278] dark:text-white", bot: "rounded-bl-sm bg-white text-[#0f1419] shadow-sm dark:bg-[#182533] dark:text-white", limit: 4096 },
  whatsapp: { area: "bg-[#efeae2] dark:bg-[#0b141a]", user: "rounded-tr-sm bg-[#d9fdd3] text-[#111b21] shadow-sm dark:bg-[#005c4b] dark:text-[#e9edef]", bot: "rounded-tl-sm bg-white text-[#111b21] shadow-sm dark:bg-[#202c33] dark:text-[#e9edef]", limit: 4096 },
  instagram: { area: "bg-white dark:bg-black", user: "rounded-3xl bg-[#3797f0] text-white", bot: "rounded-3xl bg-[#efefef] text-black dark:bg-[#262626] dark:text-white", limit: 1000 },
  widget: { area: "bg-surface", user: "rounded-br-md bg-accent text-accent-text", bot: "rounded-bl-md bg-surface-2", limit: 0 },
} as const;
type Skin = keyof typeof SKINS;

type Msg = { role: "user" | "assistant"; content: string };
type KbInfo = { mode: "full" | "search"; sources: { title: string; url: string | null }[] } | null;
type Meta = {
  inputTokens: number;
  outputTokens: number;
  servedBy: string;
  ms: number;
  cost?: number;
  kb: KbInfo;
  handoff: boolean;
};

const HANDOFF = "[[HANDOFF]]";
/** Служебная метка передачи менеджеру не показывается — в том числе недописанная во время потока. */
function visibleText(s: string) {
  return s.replaceAll(HANDOFF, "").replace(/[[[A-Z]*]?$/, "").trimEnd();
}
type ErrorInfo = { code: string; message: string };
type ToolCall = { name: string; input: unknown; result: string; error?: boolean };

export function Playground({ clientId, config }: { clientId: string; config: AgentConfig }) {
  const { t } = useI18n();
  const greeting = config.greeting.trim();
  const [messages, setMessages] = useState<Msg[]>([]);
  const [meta, setMeta] = useState<Record<number, Meta>>({});
  const [tools, setTools] = useState<Record<number, ToolCall[]>>({});
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorInfo | null>(null);
  const [skin, setSkin] = useState<Skin>("plain");
  const look = SKINS[skin];
  const abortRef = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages, busy]);

  const reset = () => {
    abortRef.current?.abort();
    setMessages([]);
    setMeta({});
    setTools({});
    setError(null);
  };

  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    setError(null);

    const base: Msg[] = [...(messages.length === 0 && greeting ? [{ role: "assistant" as const, content: greeting }] : []), ...messages];
    const history: Msg[] = [...base, { role: "user", content: text }];
    const replyIndex = history.length;
    setMessages([...history, { role: "assistant", content: "" }]);
    setBusy(true);

    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const res = await fetch("/api/playground", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientId, config, messages: history }),
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) throw { code: `http_${res.status}`, message: await res.text() };

      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buf = "";
      let reply = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += value;
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line) continue;
          const ev = JSON.parse(line);
          if (ev.t === "text") {
            reply += ev.v;
            const shown = visibleText(reply);
            setMessages((m) => m.map((x, i) => (i === replyIndex ? { ...x, content: shown } : x)));
          } else if (ev.t === "tool") {
            const call: ToolCall = { name: ev.name, input: ev.input, result: ev.result, error: ev.error };
            setTools((m) => ({ ...m, [replyIndex]: [...(m[replyIndex] ?? []), call] }));
          } else if (ev.t === "done") {
            if (ev.stopReason === "refusal" && !reply) {
              setError({ code: "refusal", message: t.playground.refusal });
            }
            setMeta((m) => ({
              ...m,
              [replyIndex]: {
                inputTokens: ev.usage.inputTokens,
                outputTokens: ev.usage.outputTokens,
                servedBy: ev.servedBy,
                ms: ev.ms,
                kb: ev.kb ?? null,
                handoff: reply.includes(HANDOFF),
                // стоимость считает сервер (с учётом кэша промпта)
                cost: typeof ev.cost === "number" ? ev.cost : undefined,
              },
            }));
          } else if (ev.t === "error") {
            setError({ code: ev.code, message: ev.message });
          }
        }
      }
    } catch (e) {
      if (!ctrl.signal.aborted) {
        setError(
          typeof e === "object" && e && "code" in e
            ? (e as ErrorInfo)
            : { code: "network", message: e instanceof Error ? e.message : String(e) },
        );
      }
    } finally {
      setBusy(false);
      abortRef.current = null;
      // Пустой ответ (ошибка или стоп до первого токена) не оставляем в истории.
      setMessages((m) => (m[replyIndex]?.content ? m : m.slice(0, replyIndex)));
    }
  };

  const shown: Msg[] = messages.length === 0 && greeting ? [{ role: "assistant", content: greeting }] : messages;

  return (
    <Card className="flex h-[640px] flex-col overflow-hidden xl:h-full">
      <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
        <div>
          <div className="flex items-center gap-2 font-semibold" title={t.playground.hint}>
            <FlaskConical className="size-4 text-accent" />
            {t.playground.title}
          </div>
        </div>
        <div className="flex items-center gap-1">
          <div className="flex items-center gap-0.5 rounded-lg bg-surface-2 p-0.5" role="group" aria-label={t.playground.skin}>
            {(Object.keys(SKINS) as Skin[]).map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => setSkin(k)}
                aria-pressed={skin === k}
                title={t.playground.skins[k]}
                aria-label={t.playground.skins[k]}
                className={cx("grid h-6 min-w-6 place-items-center rounded-md px-1 text-[11px] font-medium transition", skin === k ? "bg-surface shadow-sm" : "opacity-60 hover:opacity-100")}
              >
                {k === "plain" ? "Aa" : <ChannelIcon type={k} size={18} />}
              </button>
            ))}
          </div>
          <Button variant="ghost" size="sm" onClick={reset} title={t.playground.reset}>
            <RotateCcw className="size-4" />
          </Button>
        </div>
      </div>

      <div className={cx("flex-1 space-y-3 overflow-y-auto px-4 py-4 transition-colors", look.area)}>
        {shown.length === 0 && (
          <div className="grid h-full place-items-center text-center">
            <div className="max-w-64">
              <p className="text-sm text-muted">{t.playground.empty}</p>
              <div className="mt-3 flex flex-wrap justify-center gap-1.5">
                {t.playground.examples.map((q) => (
                  <button
                    key={q}
                    type="button"
                    onClick={() => setInput(q)}
                    className="rounded-full border border-border bg-surface px-3 py-1 text-xs text-muted transition hover:border-accent/40 hover:text-accent"
                  >
                    {q}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
        {shown.map((m, i) => (
          <div key={i} className={cx("flex flex-col", m.role === "user" ? "items-end" : "items-start")}>
            <div
              className={cx("max-w-[85%] whitespace-pre-wrap rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed", m.role === "user" ? look.user : look.bot)}
            >
              {m.content || <Spinner className="size-3.5 text-muted" />}
            </div>
            {m.role === "assistant" && look.limit > 0 && m.content.length > look.limit && (
              <div className="mt-1 flex items-center gap-1 px-1 text-[11px] font-medium text-amber-700 dark:text-amber-400">
                <TriangleAlert className="size-3" />
                {t.playground.tooLong.replace("{n}", String(look.limit))}
              </div>
            )}
            {tools[i]?.map((c, j) => <ToolNote key={j} call={c} />)}
            {meta[i] && (
              <div className="mt-1 px-1 text-[11px] text-muted">
                {meta[i].servedBy.split(":").slice(1).join(":")} · {(meta[i].ms / 1000).toFixed(1)}s ·{" "}
                {meta[i].inputTokens + meta[i].outputTokens} {t.playground.tokens}
                {meta[i].cost !== undefined && ` · ≈${meta[i].cost.toFixed(4)}`}
              </div>
            )}
            {meta[i]?.kb && <KbNote kb={meta[i].kb} />}
            {meta[i]?.handoff && (
              <div className="mt-1 flex items-center gap-1 px-1 text-[11px] font-medium text-amber-600 dark:text-amber-400">
                <Hand className="size-3" />
                {t.playground.handoff}
              </div>
            )}
          </div>
        ))}
        {error && (
          <div className="rounded-xl border border-danger/30 bg-danger/5 px-3 py-2 text-sm text-danger">
            {error.code === "missing_key"
              ? `${t.playground.missingKey}: ${error.message}`
              : error.code === "refusal"
                ? error.message
                : `${t.playground.error} (${error.code}): ${error.message}`}
          </div>
        )}
        <div ref={endRef} />
      </div>

      <form
        className="flex items-end gap-2 border-t border-border p-3"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          rows={1}
          placeholder={t.playground.placeholder}
          className="max-h-32 min-h-10 flex-1 resize-none rounded-xl border border-border bg-surface px-3 py-2.5 text-sm outline-none focus:border-accent focus:ring-4 focus:ring-accent/15"
        />
        {busy ? (
          <Button type="button" variant="secondary" onClick={() => abortRef.current?.abort()} title={t.playground.stop}>
            <Square className="size-4" />
          </Button>
        ) : (
          <Button type="submit" disabled={!input.trim()} title={t.playground.send}>
            <SendHorizontal className="size-4" />
          </Button>
        )}
      </form>
    </Card>
  );
}

function KbNote({ kb }: { kb: NonNullable<KbInfo> }) {
  const { t } = useI18n();
  const text =
    kb.mode === "full"
      ? t.playground.kbFull
      : kb.sources.length
        ? `${t.playground.kbUsed}: ${kb.sources.map((s) => s.title).join(", ")}`
        : t.playground.kbNothing;
  return (
    <div className="mt-1 flex max-w-[85%] items-start gap-1 px-1 text-[11px] text-muted">
      <BookOpen className="mt-px size-3 shrink-0" />
      <span>{text}</span>
    </div>
  );
}

/** Вызов инструмента в тест-чате: что агент сделал и что получил (раскрывается по клику). */
function ToolNote({ call }: { call: ToolCall }) {
  const { t } = useI18n();
  const labels = t.playground.tools;
  const Icon = call.error ? TriangleAlert : call.name === "book_appointment" ? CalendarCheck : CalendarSearch;
  const label = labels[call.name as keyof typeof labels] ?? call.name;
  return (
    <details className="group mt-1 max-w-[85%] px-1 text-[11px]">
      <summary
        className={cx(
          "flex cursor-pointer list-none items-center gap-1 font-medium",
          call.error ? "text-danger" : "text-accent",
        )}
      >
        <Icon className="size-3 shrink-0" />
        {call.error ? `${labels.error}: ${label}` : label}
      </summary>
      <pre className="mt-1 whitespace-pre-wrap rounded-lg bg-surface px-2 py-1.5 font-mono text-[10.5px] leading-relaxed text-muted">
        {JSON.stringify(call.input)}
        {"\n→ "}
        {call.result}
      </pre>
    </details>
  );
}
