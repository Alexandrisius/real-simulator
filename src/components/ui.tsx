"use client";

import { Loader2 } from "lucide-react";
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from "react";
import { Dropdown, type DropdownOption } from "./Dropdown";

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Card({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`rounded-xl border border-line bg-panel ${className}`}>{children}</div>
  );
}

type BtnVariant = "primary" | "ghost" | "outline" | "danger";export function Btn({
  variant = "outline",
  loading,
  className = "",
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: BtnVariant; loading?: boolean }) {
  const styles: Record<BtnVariant, string> = {
    primary:
      "bg-accent text-white hover:bg-accent/90 border-transparent shadow-lg shadow-accent/25",
    ghost: "border-transparent text-muted hover:text-fg hover:bg-panel-2",
    outline: "border-line bg-panel-2/50 text-fg hover:border-accent/50 hover:bg-panel-2",
    danger: "border-transparent bg-err/15 text-err hover:bg-err/25",
  };
  return (
    <button
      {...rest}
      disabled={rest.disabled || loading}
      className={`inline-flex h-9 items-center justify-center gap-2 rounded-lg border px-3.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${styles[variant]} ${className}`}
    >
      {loading && <Loader2 className="h-4 w-4 animate-spin" />}
      {children}
    </button>
  );
}

/**
 * Кнопка-иконка: заметная область нажатия, крупный значок,
 * живой ховер (контур + цвет + лёгкий скейл) и тултип.
 */
export function IconBtn({
  variant = "outline",
  label,
  size = "md",
  loading,
  className = "",
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "ghost" | "outline" | "danger";
  /** Тултип и aria-label */
  label: string;
  size?: "sm" | "md";
  loading?: boolean;
}) {
  const styles = {
    ghost: "border-transparent bg-transparent text-muted hover:bg-panel-2 hover:text-fg",
    outline:
      "border-line-2 bg-panel-3 text-fg/75 hover:border-accent/60 hover:bg-accent/10 hover:text-accent",
    danger:
      "border-line-2 bg-panel-3 text-fg/60 hover:border-err/60 hover:bg-err/10 hover:text-err",
  } as const;
  const sizes = { sm: "h-8 w-8 rounded-lg", md: "h-10 w-10 rounded-xl" } as const;
  return (
    <button
      {...rest}
      title={label}
      aria-label={label}
      disabled={rest.disabled || loading}
      className={`inline-flex ${sizes[size]} shrink-0 items-center justify-center border transition-all duration-150 hover:scale-[1.06] active:scale-95 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:scale-100 ${styles[variant]} ${className}`}
    >
      {loading ? (
        <Loader2 className="h-[18px] w-[18px] animate-spin" />
      ) : (
        children
      )}
    </button>
  );
}

export function Field({
  label,
  hint,
  children,
  className = "",
}: {
  label: string;
  hint?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={`block ${className}`}>
      <span className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-muted">
        {label}
      </span>
      {children}
      {hint && <span className="mt-1.5 block text-xs leading-relaxed text-muted/80">{hint}</span>}
    </label>
  );
}

const inputCls =
  "w-full rounded-lg border border-line bg-black/30 px-3 py-2 text-sm text-fg outline-none transition-colors placeholder:text-muted/50 focus:border-accent/60 focus:ring-2 focus:ring-accent/20";

/**
 * В base зашита ширина w-full. При явной ширине в className (w-20, max-w-…)
 * Tailwind-классы конфликтуют, и побеждает непредсказуемый — поэтому явная
 * ширина отключает вшитый w-full.
 */
const hasExplicitWidth = (cls?: string) => !!cls && /(?:^|\s)(?:w|max-w|min-w)-/.test(cls);

function mergeCls(base: string, extra?: string): string {
  if (hasExplicitWidth(extra)) return `${base.replace(/\bw-full\s*/, "")} ${extra}`;
  return `${base} ${extra ?? ""}`;
}

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={mergeCls(inputCls, props.className)} />;
}

export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea {...props} className={mergeCls(`${inputCls} resize-y leading-relaxed`, props.className)} />
  );
}

/**
 * Выпадающий список в стиле полей ввода. Нативный <select> не используем:
 * его попап браузер рисует сам (светлый/серый, мимо поля). Все списки
 * приложения рисуются кастомным Dropdown в тёмной теме.
 */
export function Select({
  value,
  onChange,
  options,
  direction = "down",
  className = "",
  disabled,
  title,
}: {
  value: string;
  onChange: (value: string) => void;
  options: DropdownOption[];
  direction?: "up" | "down";
  className?: string;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <Dropdown
      size="md"
      value={value}
      options={options}
      onChange={onChange}
      direction={direction}
      className={className}
      disabled={disabled}
      title={title}
    />
  );
}

export function Badge({
  children,
  color = "muted",
}: {
  children: ReactNode;
  color?: "muted" | "accent" | "ok" | "warn" | "err";
}) {
  const map = {
    muted: "bg-panel-2 text-muted border-line",
    accent: "bg-accent/15 text-accent border-accent/30",
    ok: "bg-ok/10 text-ok border-ok/30",
    warn: "bg-warn/10 text-warn border-warn/30",
    err: "bg-err/10 text-err border-err/30",
  } as const;
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium ${map[color]}`}
    >
      {children}
    </span>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const map: Record<string, "muted" | "accent" | "ok" | "warn" | "err"> = {
    idle: "muted",
    running: "ok",
    paused: "warn",
    finished: "muted",
  };
  const label: Record<string, string> = {
    idle: "не запущена",
    running: "идёт",
    paused: "пауза",
    finished: "завершена",
  };
  return (
    <Badge color={map[status] ?? "muted"}>
      {status === "running" && <span className="pulse-dot h-1.5 w-1.5 rounded-full bg-ok" />}
      {label[status] ?? status}
    </Badge>
  );
}

export function EmptyState({
  icon,
  title,
  hint,
}: {
  icon?: ReactNode;
  title: string;
  hint?: string;
}) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-line px-6 py-14 text-center">
      {icon && <div className="text-muted/60">{icon}</div>}
      <div className="text-sm font-medium text-muted">{title}</div>
      {hint && <div className="max-w-md text-xs leading-relaxed text-muted/70">{hint}</div>}
    </div>
  );
}

export function ErrorText({ children }: { children?: ReactNode }) {
  if (!children) return null;
  return (
    <p className="mt-2 rounded-lg border border-err/30 bg-err/10 px-3 py-2 text-xs leading-relaxed text-err">
      {children}
    </p>
  );
}

export function OkText({ children }: { children?: ReactNode }) {
  if (!children) return null;
  return (
    <p className="mt-2 rounded-lg border border-ok/30 bg-ok/10 px-3 py-2 text-xs leading-relaxed text-ok">
      {children}
    </p>
  );
}

/**
 * Тумблер-переключатель (role="switch"). Нативный чекбокс не используем —
 * его галочка рисуется ОС и выбивается из тёмной темы.
 */
export function Toggle({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  /** Тултип и aria-label */
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative h-6 w-11 shrink-0 rounded-full border transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
        checked ? "border-warn/60 bg-warn/70" : "border-line bg-panel-2"
      }`}
    >
      <span
        className={`absolute top-[2px] h-[18px] w-[18px] rounded-full bg-white shadow transition-all ${
          checked ? "left-[23px]" : "left-[3px]"
        }`}
      />
    </button>
  );
}
