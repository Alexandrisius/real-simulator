"use client";

// Пикер эмодзи: свои попапы вместо нативных (тёмная тема, в пределах окна).
// Эмодзи в формах раньше вводились копипастой извне — теперь выбор в один клик.

import { useEffect, useRef, useState } from "react";

interface Category {
  label: string;
  emojis: string[];
}

const CATEGORIES: Category[] = [
  {
    label: "Люди и эмоции",
    emojis: [
      "👩","👨","🧑","👧","👦","🧓","👵","👴","👰","🤵","💃","🕺","👮","🕵️","🤴","👸",
      "😎","🥰","😍","😘","😗","😙","😉","😊","🙂","🙃","😏","😌","😅","😂","🤣","🥲",
      "😢","😭","😞","😔","😟","😕","🙁","😣","😖","😫","😩","🥺","😤","😠","😡","🤬",
      "🤔","🤫","🤭","😶","😐","😯","😦","😧","🥱","😴","🤤","😷","🤒","🤕","🤢","🥴",
      "😈","👿","🤡","👻","💀","👽","🤖","🎃","😺","😸","😹","😻","🙈","🙉","🙊","🤗",
    ],
  },
  {
    label: "Жесты и отношения",
    emojis: [
      "👋","🤚","✋","🖖","👌","🤌","✌️","🤞","🫰","🤟","🤘","👈","👉","👆","👇","👍",
      "👎","✊","👊","🤛","🤜","👏","🙌","🫶","👐","🤲","🤝","🙏","💪","🦾","💅","🫰",
      "❤️","🧡","💛","💚","💙","💜","🖤","🤍","🤎","💔","❣️","💕","💞","💓","💗","💖",
      "💘","💝","💟","💜","💋","👩‍❤️‍👨","💍","🌹","🥀","💐","🍒","🔒","🔓","⛓️","🚪","🗝️",
    ],
  },
  {
    label: "Одежда и вещи",
    emojis: [
      "👕","👖","🧥","🥼","👩‍🎤","🤵","👰","🧦","🩳","👗","🥻","🩱","👙","🩲","🧣","🧤",
      "🧢","🥳","🧑‍🎤","🎓","🎩","👑","👒","👞","👟","🥾","🥿","👠","👡","🩰","👢","🧦",
      "💍","💎","🎒","👝","👛","👜","💼","🧳","👓","🕶️","🥇","🥈","🥉","🏅","🎖️","🏆",
      "⌚","📱","💻","🖥️","📷","🎥","🎧","🎤","🎸","🎹","🥁","🎻","📚","📖","✍️","🧸",
    ],
  },
  {
    label: "Еда и напитки",
    emojis: [
      "☕","🍵","🧋","🥤","🍺","🍻","🥂","🍷","🍸","🍹","🍾","🥃","🧊","🥛","🍼","🧃",
      "🍕","🍔","🍟","🌭","🥪","🌮","🌯","🥗","🍝","🍜","🍲","🍛","🍣","🍱","🥟","🍤",
      "🍚","🍘","🍥","🥠","🍢","🍡","🍧","🍨","🍦","🥧","🧁","🍰","🎂","🍮","🍭","🍬",
      "🍫","🍿","🧂","🍩","🍪","🌰","🥜","🍯","🥐","🥖","🥨","🧀","🥚","🍳","🥓","🥩",
    ],
  },
  {
    label: "Природа и животные",
    emojis: [
      "🌸","🌺","🌻","🌷","🌱","🪴","🌲","🌳","🌴","🌵","🍀","🎍","🍃","🍂","🍁","🌾",
      "🐶","🐱","🐭","🐹","🐰","🦊","🐻","🐼","🐨","🐯","🦁","🐮","🐷","🐸","🐵","🙈",
      "🐔","🐧","🐦","🦆","🦅","🦉","🦇","🐺","🐗","🐴","🦄","🐝","🦋","🐞","🐢","🐍",
      "🌊","🔥","✨","🌟","💫","⚡","☀️","🌙","⛅","🌧️","❄️","🌈","🕊️","🦢","🦩","🦚",
    ],
  },
  {
    label: "Места и деятельность",
    emojis: [
      "🏠","🏡","🏢","🏥","🏦","🏨","🏫","🏭","🏰","💒","🗼","🗽","⛲","🌁","🌃","🏙️",
      "🏖️","🏝️","⛰️","🌋","🗻","🏕️","🎡","🎢","🎠","🎭","🎨","🎤","🎧","🎬","🎮","🎯",
      "🚗","🚕","🚙","🚌","🏎️","🚓","🚑","🚲","🛵","✈️","🚢","🚂","🚀","🛸","🧭","🗺️",
      "⚽","🏀","🏈","⚾","🎾","🏐","🏉","🎱","🏓","🏸","🥊","🥋","⛸️","🎿","🏄","🏊",
    ],
  },
  {
    label: "Символы и разное",
    emojis: [
      "😀","😃","😄","😁","😆","🤖","👾","🎃","🛠️","🔧","🔨","⚙️","🧰","🧲","🧪","🔬",
      "💰","🪙","💵","💳","🏦","📈","📉","📊","📋","📁","🗂️","📌","📎","🔒","🔑","🗝️",
      "⏰","⏳","📅","📆","🗓️","🔔","📣","💬","💭","🫧","🧿","🪄","🔮","🕯️","🧞","🧜",
      "✅","❌","❗","❓","💯","🚫","⚠️","♻️","🎯","🏆","🎖️","👑","💎","🎁","🎈","🎉",
    ],
  },
];

export function EmojiPicker({
  value,
  onChange,
  title = "Выбрать эмодзи",
}: {
  value: string;
  onChange: (emoji: string) => void;
  title?: string;
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

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        title={title}
        onClick={() => setOpen((v) => !v)}
        className="flex h-9 w-full items-center justify-between gap-2 rounded-lg border border-line bg-black/30 px-3 text-lg outline-none transition-colors hover:border-accent/50 focus:border-accent/60"
      >
        <span className="leading-none">{value?.trim() ? value : "😀"}</span>
        <span className="text-[10px] text-muted">выбрать ▾</span>
      </button>
      {open && (
        <div className="absolute left-0 top-10 z-50 max-h-72 w-72 overflow-y-auto rounded-xl border border-line bg-panel p-3 shadow-2xl">
          {CATEGORIES.map((cat) => (
            <div key={cat.label} className="mb-3 last:mb-0">
              <div className="mb-1.5 text-[10px] font-medium uppercase tracking-wide text-muted/70">
                {cat.label}
              </div>
              <div className="grid grid-cols-8 gap-0.5">
                {cat.emojis.map((em, i) => (
                  <button
                    key={cat.label + i}
                    type="button"
                    onClick={() => {
                      onChange(em);
                      setOpen(false);
                    }}
                    className={`flex h-8 w-8 items-center justify-center rounded-md text-lg leading-none transition-colors hover:bg-accent/15 ${
                      em === value ? "bg-accent/25 ring-1 ring-accent/50" : ""
                    }`}
                  >
                    {em}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
