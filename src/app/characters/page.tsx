"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Plus, Users } from "lucide-react";
import { Badge, Btn, Card, EmptyState, ErrorText, PageHeader } from "@/components/ui";
import { api } from "@/components/api";
import type { Character, Provider, Tool } from "@/lib/types";

interface Row extends Character {
  providerName?: string;
}

export default function CharactersPage() {
  const [chars, setChars] = useState<Row[]>([]);
  const [tools, setTools] = useState<Tool[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    Promise.all([
      api<Character[]>("/api/characters"),
      api<Tool[]>("/api/tools"),
      api<Provider[]>("/api/providers"),
    ])
      .then(([c, t, p]) => {
        setChars(c);
        setTools(t);
        setProviders(p);
      })
      .catch((e) => setError(e.message));
  }, []);
  useEffect(load, [load]);

  const toolName = (id: number) => tools.find((t) => t.id === id);

  return (
    <div className="mx-auto max-w-5xl px-8 py-10">
      <PageHeader
        title="Персонажи"
        subtitle="Каждый персонаж — отдельная личность со своим характером, моделью и набором инструментов."
        actions={
          <Btn variant="primary" onClick={() => (location.href = "/characters/new")}>
            <Plus className="h-4 w-4" /> Создать
          </Btn>
        }
      />
      <ErrorText>{error}</ErrorText>

      {chars.length === 0 ? (
        <EmptyState
          icon={<Users className="h-8 w-8" />}
          title="Персонажей пока нет"
          hint={
            providers.length === 0
              ? "Сначала добавьте провайдера (моделей), затем создавайте персонажей."
              : "Создайте первого персонажа: имя, характер, модель и инструменты."
          }
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {chars.map((c) => (
            <Link key={c.id} href={`/characters/${c.id}`}>
              <Card className="h-full p-5 transition-colors hover:border-accent/40">
                <div className="flex items-center gap-3">
                  <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-panel-2 text-xl">
                    {c.emoji}
                  </span>
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5 truncate font-medium">
                      {c.name}
                      {c.isHuman && <Badge color="warn">вы</Badge>}
                    </div>
                    <div className="truncate text-xs text-muted">
                      {c.isHuman ? "управляется человеком" : c.model || "модель не выбрана"}
                    </div>
                  </div>
                </div>
                {c.persona && (
                  <p className="mt-3 line-clamp-2 text-xs leading-relaxed text-muted/80">
                    {c.persona}
                  </p>
                )}
                <div className="mt-3 flex flex-wrap gap-1">
                  {c.toolIds.slice(0, 5).map((tid) => {
                    const t = toolName(tid);
                    return t ? (
                      <Badge key={tid}>{t.title || t.name}</Badge>
                    ) : null;
                  })}
                  {c.toolIds.length > 5 && <Badge>+{c.toolIds.length - 5}</Badge>}
                  {c.toolIds.length === 0 && (
                    <span className="text-xs text-muted/60">без инструментов</span>
                  )}
                </div>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
