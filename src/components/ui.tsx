import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { InfoHint } from "./hint";
import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from "react";

/** Склейка классов; при конфликте Tailwind-утилит побеждает последняя (className перекрывает базовые стили). */
export function cx(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

type Variant = "primary" | "secondary" | "ghost" | "danger";

const VARIANTS: Record<Variant, string> = {
  primary: "bg-accent text-accent-text hover:brightness-110",
  secondary: "bg-surface border border-border text-text hover:bg-surface-2",
  ghost: "text-muted hover:text-text hover:bg-surface-2",
  danger: "text-danger border border-border bg-surface hover:bg-danger/10",
};

export function buttonClass(variant: Variant = "primary", size: "sm" | "md" = "md") {
  return cx(
    "inline-flex items-center justify-center gap-2 rounded-xl font-medium transition disabled:opacity-50 disabled:pointer-events-none cursor-pointer",
    size === "md" ? "h-9 px-3.5 text-sm" : "h-8 px-2.5 text-[13px]",
    VARIANTS[variant],
  );
}

export function Button({
  variant = "primary",
  size = "md",
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: "sm" | "md" }) {
  return <button className={cx(buttonClass(variant, size), className)} {...props} />;
}

const field =
  "w-full rounded-xl border border-border bg-surface px-3 text-sm text-text placeholder:text-muted/70 outline-none transition focus:border-accent focus:ring-3 focus:ring-accent/15";

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cx(field, "h-9", className)} {...props} />;
}

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cx(field, "py-2.5 leading-relaxed resize-y", className)} {...props} />;
}

export function Select({ className, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={cx(field, "h-9 pr-8", className)} {...props} />;
}

export function Field({
  label,
  hint,
  children,
  className,
}: {
  label: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={cx("block", className)}>
      <span className="mb-1.5 flex items-center gap-1 text-[13px] font-medium">
        {label}
        {hint && <InfoHint>{hint}</InfoHint>}
      </span>
      {children}
    </label>
  );
}

export function Card({ className, children, id }: { className?: string; children: ReactNode; id?: string }) {
  return (
    <div id={id} className={cx("rounded-2xl border border-border bg-surface", className)}>
      {children}
    </div>
  );
}

export function Badge({
  tone = "neutral",
  children,
}: {
  tone?: "neutral" | "accent" | "success" | "warning";
  children: ReactNode;
}) {
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium",
        tone === "neutral" && "bg-surface-2 text-muted",
        tone === "accent" && "bg-accent-soft text-accent",
        tone === "success" && "bg-success/12 text-success",
        tone === "warning" && "bg-amber-500/12 text-amber-600 dark:text-amber-400",
      )}
    >
      {children}
    </span>
  );
}

export function PageHeader({
  title,
  subtitle,
  actions,
  icon,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
      <div className="flex min-w-0 items-center gap-4">
        {icon}
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
          {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
        </div>
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      className={cx(
        "inline-block size-4 animate-spin rounded-full border-2 border-current border-r-transparent",
        className,
      )}
    />
  );
}

export function ClientAvatar({ name, color, size = 40 }: { name: string; color: string; size?: number }) {
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-xl font-semibold text-white"
      style={{ background: color, width: size, height: size, fontSize: size * 0.42 }}
    >
      {name.trim().charAt(0).toUpperCase() || "?"}
    </span>
  );
}

/** Пустое состояние: значок в круге, заголовок, пояснение и действие — одинаково во всех разделах. */
export function EmptyState({
  icon,
  title,
  text,
  action,
  tone = "neutral",
  className,
}: {
  icon?: ReactNode;
  title?: ReactNode;
  text: ReactNode;
  action?: ReactNode;
  tone?: "neutral" | "success";
  className?: string;
}) {
  return (
    <div className={cx("flex flex-col items-center gap-3 rounded-2xl border border-dashed border-border bg-surface px-6 py-10 text-center", className)}>
      {icon && (
        <span
          className={cx(
            "grid size-12 place-items-center rounded-full [&>svg]:size-5",
            tone === "success" ? "bg-success/10 text-success" : "bg-surface-2 text-muted",
          )}
        >
          {icon}
        </span>
      )}
      {title && <p className="font-medium">{title}</p>}
      <p className="max-w-md text-sm text-muted">{text}</p>
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}
