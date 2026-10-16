"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

type Msg = { id: string; role: "user" | "agent"; text: string; pending?: boolean };
type Config = { title: string; subtitle: string; color: string; greeting: string; icon: string; telegramBot?: string; quick?: string[] };

// Язык окна: как у страницы сайта (?lang=), иначе — язык браузера посетителя.
const TEXTS = {
  ru: { placeholder: "Напишите сообщение…", online: "онлайн", typing: "печатает…", operator: "Менеджер на связи", error: "Не удалось отправить. Попробуйте ещё раз.", close: "Закрыть", unavailable: "Чат временно недоступен", telegram: "Продолжить в Telegram" },
  uk: { placeholder: "Напишіть повідомлення…", online: "онлайн", typing: "друкує…", operator: "Менеджер на зв'язку", error: "Не вдалося надіслати. Спробуйте ще раз.", close: "Закрити", unavailable: "Чат тимчасово недоступний", telegram: "Продовжити в Telegram" },
  en: { placeholder: "Type a message…", online: "online", typing: "typing…", operator: "A manager has joined", error: "Couldn't send. Please try again.", close: "Close", unavailable: "Chat is temporarily unavailable", telegram: "Continue in Telegram" },
  es: { placeholder: "Escribe un mensaje…", online: "en línea", typing: "escribiendo…", operator: "Un gestor se ha unido", error: "No se pudo enviar. Inténtalo de nuevo.", close: "Cerrar", unavailable: "El chat no está disponible por ahora", telegram: "Continuar en Telegram" },
};

type Lang = keyof typeof TEXTS;

// Язык окна: ?lang= от страницы сайта, иначе язык браузера; незнакомый — английский
function pickLang(): Lang {
  const fromPage = typeof location !== "undefined" ? new URLSearchParams(location.search).get("lang") : null;
  const l = (fromPage || (typeof navigator !== "undefined" ? navigator.language : "ru")).toLowerCase();
  return l.startsWith("uk") ? "uk" : l.startsWith("ru") ? "ru" : l.startsWith("es") ? "es" : "en";
}

const noopSubscribe = () => () => {};

function visitorId(channelId: string) {
  const key = `genagent:v:${channelId}`;
  try {
    let v = localStorage.getItem(key);
    if (!v) {
      v = crypto.randomUUID();
      localStorage.setItem(key, v);
    }
    return v;
  } catch {
    // Хранилище недоступно (приватный режим) — живём в рамках вкладки.
    return ((window as unknown as { __gv?: string }).__gv ??= crypto.randomUUID());
  }
}

export function WidgetChat({ channelId }: { channelId: string }) {
  // На сервере языка браузера нет — там русский, в браузере подставится язык посетителя.
  const lang = useSyncExternalStore(noopSubscribe, pickLang, () => "ru" as const);
  const t = TEXTS[lang];
  // Что посетитель смотрит на сайте: страница и контекст от сайта (widget.js → postMessage)
  const page = useRef<{ page?: { url?: string; title?: string }; context?: string }>({});
  const [config, setConfig] = useState<Config | null>(null);
  const [failed, setFailed] = useState(false);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [typing, setTyping] = useState(false);
  const [operator, setOperator] = useState(false);
  const [input, setInput] = useState("");
  const [error, setError] = useState(false);
  // Ссылка «Продолжить в Telegram» с кодом этого разговора — бот продолжит с того же места.
  const [tgUrl, setTgUrl] = useState<string | null>(null);
  const visitor = useRef<string>("");
  const loaded = useRef(false);
  const endRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/widget/${channelId}?visitor=${visitor.current}&lang=${lang}`, { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      const data = await res.json();
      setConfig(data.config);
      loaded.current = true;
      setTyping(Boolean(data.typing));
      setOperator(Boolean(data.operator));
      // Сервер — источник истины; неотправленные локальные сообщения держим в конце.
      setMsgs((prev) => [...data.messages, ...prev.filter((m) => m.pending)]);
      setFailed(false);
    } catch {
      if (!loaded.current) setFailed(true);
    }
  }, [channelId, lang]);

  useEffect(() => {
    visitor.current = visitorId(channelId);
    void load();
    const id = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, 2000);
    return () => clearInterval(id);
  }, [channelId, load]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [msgs.length, typing]);

  const send = async (preset?: string) => {
    const text = (preset ?? input).trim();
    if (!text) return;
    if (!preset) setInput("");
    setError(false);
    const tmp: Msg = { id: `tmp-${Date.now()}`, role: "user", text, pending: true };
    setMsgs((m) => [...m, tmp]);
    setTyping(true);
    try {
      const res = await fetch(`/api/widget/${channelId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ visitor: visitor.current, text, lang, ...page.current }),
      });
      if (!res.ok) throw new Error(String(res.status));
      setMsgs((m) => m.filter((x) => x.id !== tmp.id));
      await load();
    } catch {
      setMsgs((m) => m.filter((x) => x.id !== tmp.id));
      if (!preset) setInput(text);
      setError(true);
      setTyping(false);
    }
  };

  // Сообщения от страницы сайта: контекст и вопрос «спросить об этом объекте»
  const sendRef = useRef(send);
  useEffect(() => {
    sendRef.current = send;
  });
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source !== window.parent || !e.data || typeof e.data !== "object") return;
      if (e.data.type === "genagent:context") {
        page.current = {
          page: { url: String(e.data.page?.url ?? "").slice(0, 500), title: String(e.data.page?.title ?? "").slice(0, 200) },
          context: String(e.data.context ?? "").slice(0, 1000),
        };
      }
      if (e.data.type === "genagent:ask" && typeof e.data.text === "string") void sendRef.current(e.data.text.slice(0, 4000));
    };
    window.addEventListener("message", onMessage);
    window.parent?.postMessage({ type: "genagent:ready" }, "*");
    return () => window.removeEventListener("message", onMessage);
  }, []);

  const talked = msgs.some((m) => m.role === "user" && !m.pending);
  useEffect(() => {
    if (!config?.telegramBot || !talked || tgUrl) return;
    fetch(`/api/widget/${channelId}/link`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ visitor: visitor.current }) })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d?.url && setTgUrl(d.url))
      .catch(() => {});
  }, [config?.telegramBot, talked, tgUrl, channelId]);

  const color = config?.color ?? "#5b5bf0";
  const shown: Msg[] =
    msgs.length === 0 && config?.greeting ? [{ id: "greeting", role: "agent", text: config.greeting }] : msgs;

  return (
    <div className="flex h-dvh flex-col bg-white text-[#141824]" style={{ colorScheme: "light" }}>
      <header className="flex items-center gap-3 px-4 py-3 text-white" style={{ background: color }}>
        <span className="grid size-10 place-items-center rounded-full bg-white/20 text-xl">{config?.icon ?? "💬"}</span>
        <div className="min-w-0 flex-1">
          <div className="truncate font-semibold">{config?.title ?? "…"}</div>
          <div className="truncate text-xs opacity-85">
            {typing ? t.typing : operator ? t.operator : config?.subtitle || t.online}
          </div>
        </div>
        <button
          type="button"
          aria-label={t.close}
          onClick={() => window.parent?.postMessage({ type: "genagent:close" }, "*")}
          className="grid size-9 place-items-center rounded-full hover:bg-white/15"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      </header>

      <div className="flex-1 space-y-2 overflow-y-auto bg-[#f6f7fb] px-3 py-4">
        {failed && <p className="py-10 text-center text-sm text-[#667085]">{t.unavailable}</p>}
        {shown.map((m) => (
          <div key={m.id} className={m.role === "user" ? "flex justify-end" : "flex justify-start"}>
            <div
              className={
                "max-w-[85%] whitespace-pre-wrap break-words rounded-2xl px-3.5 py-2 text-[15px] leading-snug " +
                (m.role === "user" ? "rounded-br-md text-white" : "rounded-bl-md bg-white shadow-sm")
              }
              style={m.role === "user" ? { background: color, opacity: m.pending ? 0.7 : 1 } : undefined}
            >
              {m.text}
            </div>
          </div>
        ))}
        {typing && (
          <div className="flex justify-start">
            <div className="flex gap-1 rounded-2xl rounded-bl-md bg-white px-4 py-3 shadow-sm">
              {[0, 1, 2].map((i) => (
                <span
                  key={i}
                  className="size-2 animate-bounce rounded-full bg-[#98a2b3]"
                  style={{ animationDelay: `${i * 150}ms` }}
                />
              ))}
            </div>
          </div>
        )}
        {!talked && !typing && (config?.quick?.length ?? 0) > 0 && (
          <div className="flex flex-wrap justify-end gap-1.5 pt-1">
            {config!.quick!.map((q) => (
              <button
                key={q}
                type="button"
                onClick={() => void send(q)}
                className="rounded-full border bg-white px-3 py-1.5 text-sm transition hover:opacity-80"
                style={{ borderColor: color, color }}
              >
                {q}
              </button>
            ))}
          </div>
        )}
        <div ref={endRef} />
      </div>

      {tgUrl && (
        <a
          href={tgUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center justify-center gap-2 border-t border-[#e3e6ef] bg-white py-2 text-sm font-medium text-[#229ed9] hover:bg-[#f6f7fb]"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M21.9 4.3 18.6 20c-.2 1.1-.9 1.4-1.8.9l-5-3.7-2.4 2.3c-.3.3-.5.5-1 .5l.4-5.1 9.3-8.4c.4-.4-.1-.6-.6-.2L6 13.5l-4.9-1.5c-1.1-.3-1.1-1.1.2-1.6L20.5 3c.9-.3 1.7.2 1.4 1.3z" />
          </svg>
          {t.telegram}
        </a>
      )}
      {error && <p className="bg-[#fff1f2] px-4 py-2 text-xs text-[#dc3545]">{t.error}</p>}
      <form
        className="flex items-end gap-2 border-t border-[#e3e6ef] bg-white p-3"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          rows={1}
          maxLength={4000}
          placeholder={t.placeholder}
          className="max-h-28 min-h-11 flex-1 resize-none rounded-xl border border-[#e3e6ef] px-3 py-2.5 text-[15px] outline-none focus:border-[#98a2b3]"
        />
        <button
          type="submit"
          disabled={!input.trim() || !config}
          className="grid size-11 shrink-0 place-items-center rounded-xl text-white disabled:opacity-40"
          style={{ background: color }}
          aria-label="Send"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m22 2-7 20-4-9-9-4z" />
            <path d="M22 2 11 13" />
          </svg>
        </button>
      </form>
    </div>
  );
}
