"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Clapperboard,
  FileText,
  LayoutDashboard,
  ListChecks,
  Plug,
  ShoppingCart,
  SlidersHorizontal,
  Sparkles,
  Users,
  Waypoints,
  Wrench,
  Zap,
} from "lucide-react";

const NAV = [
  { href: "/", label: "Дашборд", icon: LayoutDashboard },
  { href: "/flows", label: "Сценарии", icon: Waypoints },
  { href: "/scenes", label: "Сцены", icon: Clapperboard },
  { href: "/characters", label: "Персонажи", icon: Users },
  { href: "/tools", label: "Инструменты", icon: Wrench },
  { href: "/shop", label: "Магазин", icon: ShoppingCart },
  { href: "/attributes", label: "Характеристики", icon: SlidersHorizontal },
  { href: "/skills", label: "Навыки", icon: Zap },
  { href: "/prompt", label: "Промпт", icon: FileText },
  { href: "/schemas", label: "Схемы", icon: ListChecks },
  { href: "/providers", label: "Провайдеры", icon: Plug },
];

export default function Sidebar() {
  const pathname = usePathname();
  return (
    <aside className="sticky top-0 flex h-screen w-60 shrink-0 flex-col border-r border-line bg-panel/60 backdrop-blur">
      <Link href="/" className="flex items-center gap-2.5 px-5 pb-4 pt-6">
        <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-accent to-accent-2 text-white shadow-lg shadow-accent/20">
          <Sparkles className="h-5 w-5" />
        </span>
        <span>
          <span className="block text-sm font-semibold leading-tight">Real Simulator</span>
          <span className="block text-[11px] text-muted">социальные ИИ-агенты</span>
        </span>
      </Link>

      <nav className="mt-2 flex flex-col gap-0.5 px-3">
        {NAV.map(({ href, label, icon: Icon }) => {
          const active =
            href === "/" ? pathname === "/" : pathname.startsWith(href);
          return (
            <Link
              key={href}
              href={href}
              className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors ${
                active
                  ? "bg-accent/15 text-accent"
                  : "text-muted hover:bg-panel-2 hover:text-fg"
              }`}
            >
              <Icon className="h-4 w-4" />
              {label}
            </Link>
          );
        })}
      </nav>

      <div className="mt-auto px-5 pb-5 text-[11px] leading-relaxed text-muted/70">
        LM Studio · OpenRouter
        <br />
        локальная симуляция
      </div>
    </aside>
  );
}
