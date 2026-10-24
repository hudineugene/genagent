"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useRef, useState, useTransition } from "react";
import { BookOpen, FileText, Globe, RefreshCw, Sparkles, StickyNote, Trash2, UploadCloud } from "lucide-react";
import { addTextSource, addUrlSource, deleteSource, refreshSource } from "@/app/actions/kb";
import { FULL_CONTEXT_MAX_CHARS, estimateTokens } from "@/lib/kb/text";
import { useI18n } from "@/lib/i18n/client";
import { Badge, Button, Card, EmptyState, Field, Input, Spinner, Textarea, cx } from "@/components/ui";
import { ask } from "@/components/confirm-dialog";

export type SourceRow = {
  id: string;
  type: "file" | "url" | "text";
  title: string;
  url: string | null;
  crawl: "page" | "site" | null;
  filename: string | null;
  status: "processing" | "ready" | "error";
  error: string | null;
  chars: number;
  chunks: number;
  pages: number;
  updatedAt: Date;
  /** Документ присылает свой бот клиента — правки здесь он перезапишет */
  externalKey: string | null;
};

const TYPE_ICON = { file: FileText, url: Globe, text: StickyNote };

export type SemanticState = {
  status: "off" | "loading" | "ready" | "unavailable";
  total: number;
  done: number;
};

export function KnowledgeBase({
  clientId,
  sources,
  semantic,
}: {
  clientId: string;
  sources: SourceRow[];
  semantic: SemanticState;
}) {
  const { t } = useI18n();
  const router = useRouter();
  const [panel, setPanel] = useState<"file" | "url" | "text">("file");

  // Пока что-то обрабатывается (обход сайта), обновляем список.
  const indexing = semantic.status !== "unavailable" && semantic.status !== "off" && semantic.done < semantic.total;
  const processing = sources.some((s) => s.status === "processing") || indexing;
  useEffect(() => {
    if (!processing) return;
    const id = setInterval(() => router.refresh(), 2000);
    return () => clearInterval(id);
  }, [processing, router]);

  const ready = sources.filter((s) => s.status === "ready");
  const chars = ready.reduce((n, s) => n + s.chars, 0);
  const mode = ready.length === 0 ? "none" : chars <= FULL_CONTEXT_MAX_CHARS ? "full" : "search";

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted">{t.kb.subtitle}</p>

      <Card className="p-5">
        <div className="mb-4 inline-flex rounded-xl bg-surface-2 p-1">
          {(
            [
              ["file", t.kb.addFile, UploadCloud],
              ["url", t.kb.addSite, Globe],
              ["text", t.kb.addText, StickyNote],
            ] as const
          ).map(([key, label, Icon]) => (
            <button
              key={key}
              type="button"
              onClick={() => setPanel(key)}
              className={cx(
                "flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm transition",
                panel === key ? "bg-surface font-medium text-text shadow-sm" : "text-muted hover:text-text",
              )}
            >
              <Icon className="size-4" />
              {label}
            </button>
          ))}
        </div>
        {panel === "file" && <FileUpload clientId={clientId} />}
        {panel === "url" && <UrlForm clientId={clientId} />}
        {panel === "text" && <TextForm clientId={clientId} />}
      </Card>

      {sources.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
          <span className="text-muted">
            {t.kb.total}: <b className="text-text">{ready.length}</b> · ≈{estimateTokens(chars).toLocaleString()}{" "}
            {t.kb.tokens}
          </span>
          {mode !== "none" && (
            <span className="flex items-center gap-2">
              <Badge tone={mode === "full" ? "success" : "accent"}>{t.kb.modes[mode]}</Badge>
              <span className="text-xs text-muted">{t.kb.modeHints[mode]}</span>
            </span>
          )}
          {semantic.total > 0 && (
            <span className="flex items-center gap-1.5 text-xs text-muted">
              <Sparkles className="size-3.5 text-accent" />
              {semantic.status === "unavailable" || semantic.status === "off"
                ? t.kb.semanticOff
                : indexing
                  ? `${t.kb.semanticIndexing} ${semantic.done}/${semantic.total}`
                  : t.kb.semanticReady}
            </span>
          )}
        </div>
      )}

      {sources.length === 0 ? (
        <EmptyState icon={<BookOpen />} text={t.kb.empty} />
      ) : (
        <Card className="divide-y divide-border">
          {sources.map((s) => (
            <SourceItem key={s.id} clientId={clientId} s={s} />
          ))}
        </Card>
      )}
    </div>
  );
}

function SourceItem({ clientId, s }: { clientId: string; s: SourceRow }) {
  const { t, locale } = useI18n();
  const [pending, start] = useTransition();
  const Icon = TYPE_ICON[s.type];
  const fmt = new Intl.DateTimeFormat(locale === "uk" ? "uk-UA" : "ru-RU", { dateStyle: "short", timeStyle: "short" });
  const errorText = s.error
    ? (t.kb.errors[s.error.split(":")[0] as keyof typeof t.kb.errors] ?? s.error)
    : null;

  const meta = [
    t.kb.types[s.type],
    s.type === "url" && s.crawl === "site" ? t.kb.crawlSite.split(" (")[0] : null,
    s.pages > 1 || s.type === "url" ? `${s.pages} ${t.kb.pages}` : null,
    s.status === "ready" ? `${s.chunks} ${t.kb.chunks}` : null,
    s.status === "ready" ? `≈${estimateTokens(s.chars).toLocaleString()} ${t.kb.tokens}` : null,
    fmt.format(new Date(s.updatedAt)),
  ].filter(Boolean);

  return (
    <div className="flex flex-wrap items-center gap-3 px-5 py-4">
      <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-surface-2 text-muted">
        <Icon className="size-5" />
      </span>
      <div className="min-w-0 flex-1">
        <Link href={`/clients/${clientId}/kb/${s.id}`} className="block truncate font-medium hover:text-accent">
          {s.title}
        </Link>
        <div className="truncate text-xs text-muted">
          {s.url && <span className="mr-2">{s.url}</span>}
          {meta.join(" · ")}
        </div>
        {errorText && s.status === "error" && <div className="mt-1 text-xs text-danger">{errorText}</div>}
      </div>
      {s.externalKey && (
        <span title={t.kb.syncedHint}>
          <Badge tone="neutral">{t.kb.synced}</Badge>
        </span>
      )}
      <Badge tone={s.status === "ready" ? "success" : s.status === "error" ? "warning" : "accent"}>
        {s.status === "processing" && <Spinner className="size-3" />}
        {t.kb.status[s.status]}
      </Badge>
      <div className="flex">
        <Button
          variant="ghost"
          size="sm"
          title={t.kb.refresh}
          disabled={pending || s.status === "processing"}
          onClick={() => start(async () => void (await refreshSource(s.id)))}
        >
          <RefreshCw className={cx("size-4", pending && "animate-spin")} />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          title={t.common.delete}
          className="hover:text-danger"
          disabled={pending}
          onClick={async () => {
            if (await ask(`${t.common.confirmDelete}\n${s.title}`)) start(async () => void (await deleteSource(s.id)));
          }}
        >
          <Trash2 className="size-4" />
        </Button>
      </div>
    </div>
  );
}

function FileUpload({ clientId }: { clientId: string }) {
  const { t } = useI18n();
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);

  const upload = async (files: FileList | File[]) => {
    const list = [...files];
    if (!list.length) return;
    setBusy(true);
    setErrors([]);
    try {
      const body = new FormData();
      body.set("clientId", clientId);
      for (const f of list) body.append("files", f);
      const res = await fetch("/api/kb/upload", { method: "POST", body });
      const data = (await res.json()) as { results?: { name: string; ok: boolean; error?: string }[]; error?: string };
      const failed = (data.results ?? []).filter((r) => !r.ok);
      setErrors(
        failed.map((r) => {
          const code = (r.error ?? "").split(":")[0] as keyof typeof t.kb.errors;
          return `${r.name}: ${t.kb.errors[code] ?? r.error}`;
        }),
      );
      if (data.error) setErrors([data.error]);
    } catch (e) {
      setErrors([e instanceof Error ? e.message : String(e)]);
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
      router.refresh();
    }
  };

  return (
    <div>
      <button
        type="button"
        disabled={busy}
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          upload(e.dataTransfer.files);
        }}
        className={cx(
          "flex w-full flex-col items-center gap-2 rounded-2xl border-2 border-dashed px-6 py-10 text-center transition",
          drag ? "border-accent bg-accent-soft/50" : "border-border hover:border-accent/50 hover:bg-surface-2",
        )}
      >
        {busy ? <Spinner className="size-6 text-accent" /> : <UploadCloud className="size-8 text-accent" />}
        <span className="text-sm font-medium">{busy ? t.kb.uploading : t.kb.drop}</span>
        <span className="text-xs text-muted">{t.kb.filesHint}</span>
      </button>
      <input
        ref={inputRef}
        type="file"
        multiple
        accept=".pdf,.docx,.txt,.md,.csv,.html,.htm,.json"
        className="hidden"
        onChange={(e) => e.target.files && upload(e.target.files)}
      />
      {errors.map((e) => (
        <p key={e} className="mt-2 text-sm text-danger">
          {e}
        </p>
      ))}
    </div>
  );
}

function UrlForm({ clientId }: { clientId: string }) {
  const { t } = useI18n();
  const [state, action, pending] = useActionState(addUrlSource.bind(null, clientId), undefined);
  return (
    <form action={action} key={state?.id ?? "url"} className="space-y-4">
      <Field label={t.kb.url}>
        <Input name="url" required placeholder="https://example.com" />
      </Field>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-4 text-sm">
          {(["page", "site"] as const).map((v) => (
            <label key={v} className="flex cursor-pointer items-center gap-2">
              <input type="radio" name="crawl" value={v} defaultChecked={v === "page"} className="accent-[var(--accent)]" />
              {v === "page" ? t.kb.crawlPage : t.kb.crawlSite}
            </label>
          ))}
        </div>
        <Button disabled={pending}>
          {pending ? <Spinner /> : <Globe className="size-4" />}
          {t.kb.add}
        </Button>
      </div>
      {state?.error && <p className="text-sm text-danger">{t.kb.errors[state.error as keyof typeof t.kb.errors]}</p>}
    </form>
  );
}

function TextForm({ clientId }: { clientId: string }) {
  const { t } = useI18n();
  const [state, action, pending] = useActionState(addTextSource.bind(null, clientId), undefined);
  return (
    <form action={action} key={state?.id ?? "text"} className="space-y-4">
      <Field label={t.kb.textTitle}>
        <Input name="title" required maxLength={300} placeholder={t.kb.textTitlePlaceholder} />
      </Field>
      <Field label={t.kb.textContent}>
        <Textarea name="content" required rows={8} className="font-mono text-[13px]" />
      </Field>
      <div className="flex items-center justify-end gap-3">
        {state?.error && <p className="text-sm text-danger">{t.kb.errors[state.error as keyof typeof t.kb.errors]}</p>}
        <Button disabled={pending}>
          {pending ? <Spinner /> : <StickyNote className="size-4" />}
          {t.kb.add}
        </Button>
      </div>
    </form>
  );
}
