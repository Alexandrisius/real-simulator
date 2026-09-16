"use client";

import { Check, ChevronDown } from "lucide-react";
import { useEffect, useRef, useState } from "react";

export interface DropdownOption {
  value: string;
  label: string;
}

/**
 * Кастомный дропдаун вместо нативного <select>: нативный попап браузер
 * рисует сам — его нельзя стилизовать под тёмную тему, а позицию он
 * выбирает непредсказуемо. Меню позиционируется явно и в теме приложения.
 * size "sm" — компактный (чипы, строки таблиц), "md" — как поля ввода.
 * direction "auto" (по умолчанию): меню открывается вниз, а вверх — только
 * если снизу не хватает места; высота ограничивается свободным местом.
 */
export function Dropdown({
  value,
  options,
  onChange,
  direction = "auto",
  size = "sm",
  disabled,
  className = "",
  title,
}: {
  value: string;
  options: DropdownOption[];
  onChange: (value: string) => void;
  direction?: "up" | "down" | "auto";
  size?: "sm" | "md";
  disabled?: boolean;
  className?: string;
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  const [dir, setDir] = useState<"up" | "down">("down");
  const [menuMax, setMenuMax] = useState(256);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || direction !== "auto") return;
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const below = window.innerHeight - r.bottom;
    const above = r.top;
    const wanted = Math.min(256, 24 + options.length * 34); // примерная высота меню
    if (below >= Math.min(wanted, 180) || below >= above) {
      setDir("down");
      setMenuMax(Math.max(120, below - 12));
    } else {
      setDir("up");
      setMenuMax(Math.max(120, above - 12));
    }
  }, [open, direction, options.length]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const effective = direction === "auto" ? dir : direction;
  const triggerCls =
    size === "md"
      ? `flex h-[38px] min-w-0 w-full items-center justify-between gap-2 rounded-lg border px-3 text-sm outline-none transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
          open
            ? "border-accent/60 bg-black/40 text-fg ring-2 ring-accent/20"
            : "border-line bg-black/30 text-fg hover:border-accent/50"
        }`
      : `flex h-9 min-w-0 items-center justify-between gap-1.5 rounded-lg border px-2.5 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
          open
            ? "border-accent/60 bg-black/40 text-fg"
            : "border-line bg-black/30 text-muted hover:text-fg"
        }`;

  const current = options.find((o) => o.value === value);
  return (
    <div ref={ref} className={`relative ${className}`}>
      <button
        type="button"
        title={title}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        className={triggerCls}
      >
        <span className="truncate">{current?.label ?? "—"}</span>
        <ChevronDown
          className={`shrink-0 transition-transform ${size === "md" ? "h-4 w-4" : "h-3.5 w-3.5"} ${
            open ? "rotate-180" : ""
          }`}
        />
      </button>
      {open && (
        <div
          style={{ maxHeight: direction === "auto" ? menuMax : undefined }}
          className={`anim-in absolute z-50 max-h-64 w-max min-w-full max-w-[min(24rem,calc(100vw-2rem))] overflow-y-auto rounded-lg border border-line bg-panel py-1 shadow-2xl ${
            effective === "up" ? "bottom-full left-0 mb-1.5" : "top-full left-0 mt-1.5"
          }`}
        >
          {options.length === 0 && (
            <div className="px-3 py-2 text-xs text-muted">Нет вариантов</div>
          )}
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              onClick={() => {
                onChange(o.value);
                setOpen(false);
              }}
              className={`flex w-full items-center gap-2 whitespace-nowrap px-3 transition-colors ${
                size === "md" ? "py-2 text-sm" : "py-1.5 text-xs"
              } ${
                o.value === value
                  ? "bg-accent/15 text-fg"
                  : "text-muted hover:bg-panel-2 hover:text-fg"
              }`}
            >
              <span className="w-3.5 shrink-0">
                {o.value === value && <Check className="h-3.5 w-3.5 text-accent" />}
              </span>
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
