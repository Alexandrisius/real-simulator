"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  ArrowRight,
  Clapperboard,
  Plug,
  Sparkles,
  Users,
  Wrench,
} from "lucide-react";
import { Badge, Card, PageHeader, StatusBadge } from "@/components/ui";
import { api } from "@/components/api";
import type { Scene } from "@/lib/types";

interface Stats {
  characters: number;
  tools: number;
  providers: number;
  scenes: number;
  running: number;
  recent: (Scene & {
    eventCount: number;
    participants: { id: number; name: string; emoji: string }[];
  })[];
}

export default function DashboardPage() {
  const [stats, setStats] = useState<Stats | null>(null);

  useEffect(() => {
    api<Stats>("/api/stats").then(setStats).catch(console.error);
  }, []);

  const cards = [
    { label: "Персонажи", value: stats?.characters, href: "/characters", icon: Users },
    { label: "Инструменты", value: stats?.tools, href: "/tools", icon: Wrench },
    { label: "Провайдеры", value: stats?.providers, href: "/providers", icon: Plug },
    { label: "Сцены", value: stats?.scenes, href: "/scenes", icon: Clapperboard },
  ];

  return (
    <div className="mx-auto max-w-5xl px-8 py-10">
      <PageHeader
        title="Дашборд"
        subtitle="Локальный симулятор социальных ИИ-агентов: персонажи живут, общаются и действуют сами."
      />

      {/* Пустая база пугает полями — главный вход для новичка: собрать мир с ассистентом */}
      <Link href="/setup" className="block">
        <Card
          className={`mb-6 flex items-center gap-4 p-5 transition-colors hover:border-accent/50 ${
            stats && stats.characters === 0 ? "border-accent/40 bg-accent/5" : ""
          }`}
        >
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-accent/40 bg-accent/10">
            <Sparkles className="h-5 w-5 text-accent" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium">Настроить с помощью ИИ</div>
            <p className="mt-0.5 text-xs leading-relaxed text-muted">
              {stats && stats.characters === 0
                ? "Мир пока пуст — опишите идею, и ассистент создаст персонажей, инструменты и первую сцену за вас."
                : "Опишите идею — ассистент дополнит мир: новые персонажи, инструменты, сценарии."}
            </p>
          </div>
          <ArrowRight className="h-4 w-4 shrink-0 text-muted/40" />
        </Card>
      </Link>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {cards.map((c) => (
          <Link key={c.href} href={c.href}>
            <Card className="group p-4 transition-colors hover:border-accent/40">
              <div className="flex items-center justify-between">
                <c.icon className="h-4 w-4 text-muted transition-colors group-hover:text-accent" />
                <ArrowRight className="h-3.5 w-3.5 text-muted/40 transition-transform group-hover:translate-x-0.5" />
              </div>
              <div className="mt-3 text-2xl font-semibold tabular-nums">
                {c.value ?? "—"}
              </div>
              <div className="text-xs text-muted">{c.label}</div>
            </Card>
          </Link>
        ))}
      </div>

      <h2 className="mb-3 mt-8 text-sm font-semibold uppercase tracking-wide text-muted">
        Последние сцены
      </h2>
      {stats?.recent.length ? (
        <div className="flex flex-col gap-2">
          {stats.recent.map((s) => (
            <Link key={s.id} href={`/scenes/${s.id}`}>
              <Card className="flex items-center gap-4 p-4 transition-colors hover:border-accent/40">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium">{s.name}</span>
                    <StatusBadge status={s.status} />
                    {s.status === "running" && (
                      <Badge color="accent">ход {s.cursor + 1}</Badge>
                    )}
                  </div>
                  <div className="mt-1 flex items-center gap-2 text-xs text-muted">
                    <span className="flex -space-x-1.5">
                      {s.participants.map((p) => (
                        <span
                          key={p.id}
                          className="flex h-5 w-5 items-center justify-center rounded-full border border-panel bg-panel-2 text-[10px]"
                          title={p.name}
                        >
                          {p.emoji}
                        </span>
                      ))}
                    </span>
                    <span>{s.eventCount} событий</span>
                  </div>
                </div>
                <ArrowRight className="h-4 w-4 shrink-0 text-muted/40" />
              </Card>
            </Link>
          ))}
        </div>
      ) : (
        <Card className="p-6">
          <div className="flex items-start gap-4">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent/15 text-accent">
              <Sparkles className="h-5 w-5" />
            </span>
            <div className="text-sm leading-relaxed text-muted">
              <b className="text-fg">С чего начать:</b> 1) добавьте{" "}
              <Link href="/providers" className="text-accent hover:underline">
                провайдера
              </Link>{" "}
              (LM Studio или OpenRouter), 2) создайте{" "}
              <Link href="/characters" className="text-accent hover:underline">
                персонажей
              </Link>{" "}
              с характерами и инструментами, 3) соберите{" "}
              <Link href="/scenes" className="text-accent hover:underline">
                сцену
              </Link>{" "}
              и нажмите «Старт». Хотите сначала посмотреть, как всё работает, не поднимая
              модель? Создайте провайдера с типом «Mock».
            </div>
          </div>
        </Card>
      )}
    </div>
  );
}
