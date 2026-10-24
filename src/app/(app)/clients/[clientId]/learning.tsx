"use client";

import { useState, useTransition } from "react";
import { BookOpen, GraduationCap, Pencil, Plus, Sparkles, Trash2, X } from "lucide-react";
import { deleteCourse, deleteLesson, generateQuizAction, saveCourse, saveLesson } from "@/app/actions/learning";
import { useI18n } from "@/lib/i18n/client";
import { Badge, Button, Card, EmptyState, Field, Input, Select, Spinner, Textarea } from "@/components/ui";
import type { QuizQuestion } from "@/db/schema";
import { ask } from "@/components/confirm-dialog";

type Level = "beginner" | "intermediate" | "advanced";
export type LessonRow = { id: string; position: number; title: string; body: string; videoUrl: string; quiz: QuizQuestion[]; passScore: number; points: number };
export type CourseRow = { id: string; title: string; description: string; level: Level; topics: string; points: number; programId: string | null; enabled: boolean; position: number; lessons: LessonRow[] };
export type LearningStats = { learners: number; active7: number; points: number; courses: { id: string; title: string; started: number; finished: number; avgScore: number | null; hardest: { title: string; pct: number } | null }[] };
export type LearnerRow = { id: string; name: string; contact: string; goal: string; level: string; points: number; passed: number; lastActivityAt: number | null };
type CourseDraft = Omit<CourseRow, "id" | "lessons">;
type LessonDraft = Omit<LessonRow, "id">;

const LEVELS: Level[] = ["beginner", "intermediate", "advanced"];

export function LearningManager({
  clientId,
  rows,
  learners,
  programs,
  agentOn,
  stats,
}: {
  clientId: string;
  rows: CourseRow[];
  learners: LearnerRow[];
  programs: { id: string; name: string }[];
  agentOn: boolean;
  stats?: LearningStats;
}) {
  const { t, locale } = useI18n();
  const l = t.learning;
  const [editing, setEditing] = useState<string | null>(null);
  const fmt = new Intl.DateTimeFormat(locale === "uk" ? "uk-UA" : "ru-RU", { dateStyle: "short" });
  const total = rows.reduce((n, c) => n + c.lessons.length, 0);
  return (
    <div className="space-y-6">
      <p className="max-w-3xl text-sm text-muted">{l.subtitle}</p>
      {!agentOn && <p className="max-w-3xl rounded-lg bg-amber-500/10 p-3 text-sm">{l.agentOff}</p>}
      {editing !== "new" && (
        <Button onClick={() => setEditing("new")}>
          <Plus className="size-4" />
          {l.newCourse}
        </Button>
      )}
      {editing === "new" && (
        <CourseForm clientId={clientId} programs={programs} initial={{ title: "", description: "", level: "beginner", topics: "", points: 0, programId: programs[0]?.id ?? null, enabled: true, position: rows.length }} onDone={() => setEditing(null)} />
      )}
      {rows.length === 0 && editing !== "new" && <EmptyState icon={<GraduationCap />} text={l.empty} />}
      {rows.map((c) =>
        editing === c.id ? <CourseForm key={c.id} clientId={clientId} programs={programs} id={c.id} initial={c} onDone={() => setEditing(null)} /> : <CourseCard key={c.id} clientId={clientId} row={c} onEdit={() => setEditing(c.id)} />,
      )}
      {stats && stats.learners > 0 && (
        <section className="space-y-2">
          <h2 className="text-base font-semibold">{l.analytics}</h2>
          <div className="grid gap-3 sm:grid-cols-3">
            {[
              [l.statLearners, String(stats.learners)],
              [l.statActive, String(stats.active7)],
              [l.statPoints, String(stats.points)],
            ].map(([k, v]) => (
              <Card key={k} className="p-4">
                <div className="text-xs text-muted">{k}</div>
                <div className="mt-1 text-xl font-semibold">{v}</div>
              </Card>
            ))}
          </div>
          <Card className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted">
                <tr className="border-b border-border">
                  <th className="px-3 py-2">{l.thCourse}</th>
                  <th className="px-3 py-2">{l.thStarted}</th>
                  <th className="px-3 py-2">{l.thFinished}</th>
                  <th className="px-3 py-2">{l.thScore}</th>
                  <th className="px-3 py-2">{l.thHardest}</th>
                </tr>
              </thead>
              <tbody>
                {stats.courses.map((c) => (
                  <tr key={c.id} className="border-b border-border last:border-0">
                    <td className="px-3 py-2 font-medium">{c.title}</td>
                    <td className="px-3 py-2">{c.started}</td>
                    <td className="px-3 py-2">
                      {c.finished}
                      {c.started > 0 && <span className="text-xs text-muted"> ({Math.round((c.finished / c.started) * 100)}%)</span>}
                    </td>
                    <td className="px-3 py-2">{c.avgScore == null ? "—" : `${c.avgScore}%`}</td>
                    <td className="px-3 py-2 text-xs">{c.hardest ? `${c.hardest.title} — ${c.hardest.pct}%` : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </section>
      )}
      {learners.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-base font-semibold">
            {l.learners} · {learners.length}
          </h2>
          <Card className="divide-y divide-border text-sm">
            {learners.map((x) => (
              <div key={x.id} className="flex flex-wrap items-center gap-3 px-4 py-2">
                <span className="min-w-40 font-medium">{x.name || x.contact}</span>
                <span className="text-xs text-muted">{l.passedOf.replace("{n}", String(x.passed)).replace("{total}", String(total))}</span>
                <Badge tone="accent">{l.pointsShort.replace("{n}", String(x.points))}</Badge>
                {x.level && <span className="text-xs text-muted">{l.levels[x.level as Level] ?? x.level}</span>}
                <span className="min-w-0 flex-1 truncate text-xs text-muted">{x.goal}</span>
                <span className="text-xs text-muted">{x.lastActivityAt ? fmt.format(x.lastActivityAt) : "—"}</span>
              </div>
            ))}
          </Card>
        </section>
      )}
    </div>
  );
}

function CourseForm({ clientId, programs, id, initial, onDone }: { clientId: string; programs: { id: string; name: string }[]; id?: string; initial: CourseDraft; onDone: () => void }) {
  const { t } = useI18n();
  const l = t.learning;
  const [d, setD] = useState<CourseDraft>({ title: initial.title, description: initial.description, level: initial.level, topics: initial.topics, points: initial.points, programId: initial.programId, enabled: initial.enabled, position: initial.position });
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <Card className="space-y-3 p-5">
      <div className="flex flex-wrap gap-3">
        <Field label={l.title}>
          <Input className="w-80" value={d.title} maxLength={150} placeholder={l.titlePlaceholder} onChange={(e) => setD({ ...d, title: e.target.value })} />
        </Field>
        <Field label={l.level}>
          <Select className="w-44" value={d.level} onChange={(e) => setD({ ...d, level: e.target.value as Level })}>
            {LEVELS.map((x) => (
              <option key={x} value={x}>
                {l.levels[x]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={l.order}>
          <Input type="number" min={0} className="w-20" value={d.position} onChange={(e) => setD({ ...d, position: Math.max(0, Math.round(Number(e.target.value) || 0)) })} />
        </Field>
      </div>
      <Field label={l.description}>
        <Textarea rows={2} value={d.description} maxLength={2000} onChange={(e) => setD({ ...d, description: e.target.value })} />
      </Field>
      <Field label={l.topics} hint={l.topicsHint}>
        <Input value={d.topics} maxLength={500} placeholder={l.topicsPlaceholder} onChange={(e) => setD({ ...d, topics: e.target.value })} />
      </Field>
      <div className="flex flex-wrap gap-3">
        <Field label={l.coursePoints}>
          <Input type="number" min={0} className="w-28" value={d.points} onChange={(e) => setD({ ...d, points: Math.max(0, Math.round(Number(e.target.value) || 0)) })} />
        </Field>
        <Field label={l.program} hint={programs.length ? l.programHint : l.noPrograms}>
          <Select className="w-64" value={d.programId ?? ""} onChange={(e) => setD({ ...d, programId: e.target.value || null })}>
            <option value="">{l.noProgram}</option>
            {programs.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" className="size-4 accent-[var(--accent)]" checked={d.enabled} onChange={(e) => setD({ ...d, enabled: e.target.checked })} />
        {l.enabled}
      </label>
      {error && <p className="text-sm text-danger">{error}</p>}
      <div className="flex gap-2">
        <Button
          disabled={pending || !d.title.trim()}
          onClick={() =>
            start(async () => {
              const r = await saveCourse(clientId, id ?? null, d);
              if (r.error) setError(l.errors.invalid);
              else onDone();
            })
          }
        >
          {l.save}
        </Button>
        <Button variant="ghost" onClick={onDone}>
          {l.cancel}
        </Button>
      </div>
    </Card>
  );
}

function CourseCard({ clientId, row, onEdit }: { clientId: string; row: CourseRow; onEdit: () => void }) {
  const { t } = useI18n();
  const l = t.learning;
  const [editing, setEditing] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-start gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-surface-2 text-accent">
          <BookOpen className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold">{row.title}</span>
            <Badge tone="neutral">{l.levels[row.level]}</Badge>
            {!row.enabled && <Badge tone="warning">{t.status.paused}</Badge>}
            {row.points > 0 && <Badge tone="accent">{l.bonus.replace("{n}", String(row.points))}</Badge>}
          </div>
          {row.description && <p className="mt-1 text-sm text-muted">{row.description}</p>}
          {row.topics && <p className="mt-1 text-xs text-muted">{row.topics}</p>}
        </div>
        <Button variant="ghost" size="sm" onClick={onEdit}>
          <Pencil className="size-4" />
        </Button>
        <Button variant="ghost" size="sm" disabled={pending} onClick={async () => await ask(l.confirmDeleteCourse) && start(() => deleteCourse(row.id))}>
          <Trash2 className="size-4" />
        </Button>
      </div>
      <div className="mt-3 space-y-2 border-t border-border pt-3">
        {row.lessons.map((x, i) =>
          editing === x.id ? (
            <LessonForm key={x.id} clientId={clientId} courseId={row.id} id={x.id} initial={x} onDone={() => setEditing(null)} />
          ) : (
            <div key={x.id} className="flex flex-wrap items-center gap-2 text-sm">
              <span className="w-6 text-muted">{i + 1}.</span>
              <span className="min-w-0 flex-1 font-medium">{x.title}</span>
              <span className="text-xs text-muted">
                {x.videoUrl ? `${l.video} · ` : ""}
                {l.questions.replace("{n}", String(x.quiz.length))}
                {x.points ? ` · +${x.points}` : ""}
              </span>
              <Button variant="ghost" size="sm" onClick={() => setEditing(x.id)}>
                <Pencil className="size-4" />
              </Button>
              <Button variant="ghost" size="sm" disabled={pending} onClick={async () => await ask(l.confirmDeleteLesson) && start(() => deleteLesson(x.id))}>
                <Trash2 className="size-4" />
              </Button>
            </div>
          ),
        )}
        {editing === "new" ? (
          <LessonForm clientId={clientId} courseId={row.id} initial={{ position: row.lessons.length, title: "", body: "", videoUrl: "", quiz: [], passScore: 70, points: 10 }} onDone={() => setEditing(null)} />
        ) : (
          <Button variant="secondary" size="sm" onClick={() => setEditing("new")}>
            <Plus className="size-4" />
            {l.addLesson}
          </Button>
        )}
      </div>
    </Card>
  );
}

function LessonForm({ clientId, courseId, id, initial, onDone }: { clientId: string; courseId: string; id?: string; initial: LessonDraft; onDone: () => void }) {
  const { t } = useI18n();
  const l = t.learning;
  const [d, setD] = useState<LessonDraft>({ ...initial, quiz: initial.quiz.map((q) => ({ ...q, options: [...q.options] })) });
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const setQ = (i: number, p: Partial<QuizQuestion>) => setD({ ...d, quiz: d.quiz.map((q, j) => (j === i ? { ...q, ...p } : q)) });
  return (
    <div className="space-y-3 rounded-xl border border-border p-4">
      <div className="flex flex-wrap gap-3">
        <Field label={l.lessonTitle}>
          <Input className="w-80" value={d.title} maxLength={200} onChange={(e) => setD({ ...d, title: e.target.value })} />
        </Field>
        <Field label={l.order}>
          <Input type="number" min={0} className="w-20" value={d.position} onChange={(e) => setD({ ...d, position: Math.max(0, Math.round(Number(e.target.value) || 0)) })} />
        </Field>
        <Field label={l.lessonPoints}>
          <Input type="number" min={0} className="w-24" value={d.points} onChange={(e) => setD({ ...d, points: Math.max(0, Math.round(Number(e.target.value) || 0)) })} />
        </Field>
        <Field label={l.passScore}>
          <Input type="number" min={0} max={100} className="w-24" value={d.passScore} onChange={(e) => setD({ ...d, passScore: Math.min(100, Math.max(0, Math.round(Number(e.target.value) || 0))) })} />
        </Field>
      </div>
      <Field label={l.body} hint={l.bodyHint}>
        <Textarea rows={6} value={d.body} maxLength={20000} onChange={(e) => setD({ ...d, body: e.target.value })} />
      </Field>
      <Field label={l.videoUrl}>
        <Input className="font-mono text-[13px]" value={d.videoUrl} maxLength={1000} placeholder="https://youtu.be/…" onChange={(e) => setD({ ...d, videoUrl: e.target.value })} />
      </Field>
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold">{l.quiz}</span>
          <Button
            variant="secondary"
            size="sm"
            disabled={pending || d.body.trim().length < 50}
            onClick={() =>
              start(async () => {
                const r = await generateQuizAction(clientId, d.body);
                if ("quiz" in r && r.quiz) setD({ ...d, quiz: [...d.quiz, ...r.quiz] });
                else setError((l.errors as Record<string, string>)[r.error ?? "failed"] ?? l.errors.failed);
              })
            }
          >
            {pending ? <Spinner /> : <Sparkles className="size-4" />}
            {l.generateQuiz}
          </Button>
        </div>
        {d.quiz.map((q, i) => (
          <div key={i} className="space-y-1.5 rounded-lg bg-surface-2/60 p-3">
            <div className="flex gap-2">
              <Input className="flex-1" value={q.q} maxLength={500} placeholder={l.question} onChange={(e) => setQ(i, { q: e.target.value })} />
              <Button variant="ghost" size="sm" onClick={() => setD({ ...d, quiz: d.quiz.filter((_, j) => j !== i) })}>
                <X className="size-4" />
              </Button>
            </div>
            {q.options.map((o, j) => (
              <label key={j} className="flex items-center gap-2 text-sm">
                <input type="radio" name={`q${i}`} className="size-4 accent-[var(--accent)]" checked={q.correct === j} onChange={() => setQ(i, { correct: j })} title={l.correct} />
                <Input className="flex-1" value={o} maxLength={300} placeholder={`${l.option} ${j + 1}`} onChange={(e) => setQ(i, { options: q.options.map((x, k) => (k === j ? e.target.value : x)) })} />
                {q.options.length > 2 && (
                  <button type="button" className="text-muted" onClick={() => setQ(i, { options: q.options.filter((_, k) => k !== j), correct: q.correct > j ? q.correct - 1 : q.correct === j ? 0 : q.correct })}>
                    <X className="size-3.5" />
                  </button>
                )}
              </label>
            ))}
            {q.options.length < 6 && (
              <button type="button" className="text-xs text-accent hover:underline" onClick={() => setQ(i, { options: [...q.options, ""] })}>
                {l.addOption}
              </button>
            )}
          </div>
        ))}
        <Button variant="ghost" size="sm" onClick={() => setD({ ...d, quiz: [...d.quiz, { q: "", options: ["", ""], correct: 0 }] })}>
          <Plus className="size-4" />
          {l.addQuestion}
        </Button>
        <p className="text-xs text-muted">{l.quizHint}</p>
      </div>
      {error && <p className="text-sm text-danger">{error}</p>}
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={pending || !d.title.trim()}
          onClick={() =>
            start(async () => {
              const r = await saveLesson(courseId, id ?? null, { ...d, quiz: d.quiz.map((q) => ({ ...q, options: q.options.filter((o) => o.trim()) })).filter((q) => q.q.trim()) });
              if (r.error) setError((l.errors as Record<string, string>)[r.error] ?? l.errors.invalid);
              else onDone();
            })
          }
        >
          {l.save}
        </Button>
        <Button variant="ghost" size="sm" onClick={onDone}>
          {l.cancel}
        </Button>
      </div>
    </div>
  );
}
