"use client";

import { useEffect, useRef, useState } from "react";
import { Input } from "./ui";

/**
 * Поле ввода с подсказками (замена нативного <datalist>: его попап браузер
 * рисует сам — тёмным по тёмному и без стилей). Свободный ввод сохранён:
 * можно напечатать любое значение, список лишь фильтруется по подстроке.
 */
export function Combobox({
  value,
  options,
  onChange,
  placeholder,
  className = "",
  inputClassName = "",
}: {
  value: string;
  options: string[];
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  inputClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

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

  const q = value.trim().toLowerCase();
  const matches = q ? options.filter((o) => o.toLowerCase().includes(q)) : options;

  return (
    <div ref={ref} className={`relative ${className}`}>
      <Input
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        className={inputClassName}
      />
      {open && options.length > 0 && (
        <div className="anim-in absolute top-full left-0 z-50 mt-1.5 max-h-56 w-full overflow-y-auto rounded-lg border border-line bg-panel py-1 shadow-2xl">
          {matches.length === 0 ? (
            <div className="px-3 py-2 text-xs leading-relaxed text-muted">
              Совпадений нет — оставьте введённое вручную
            </div>
          ) : (
            matches.map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => {
                  onChange(m);
                  setOpen(false);
                }}
                className={`block w-full truncate px-3 py-2 text-left font-mono text-xs transition-colors ${
                  m === value
                    ? "bg-accent/15 text-fg"
                    : "text-muted hover:bg-panel-2 hover:text-fg"
                }`}
              >
                {m}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
