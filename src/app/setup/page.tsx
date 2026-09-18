"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Bot, Loader2, RefreshCw, Send, Sparkles, User } from "lucide-react";
import { Badge, Btn, Card, ErrorText, Field, IconBtn, Input, PageHeader } from "@/components/ui";
import { Dropdown } from "@/components/Dropdown";
import { Combobox } from "@/components/Combobox";
import { api, apiPost } from "@/components/api";

interface ChatMsg {
  role: "user" | "assistant";
  content: string;
  /** Действения, выполненные ассистентом в этом ответе (для карточек) */
  actions?: { tool: string; ok: boolean; summary: string }[];
}

interface AssistantConfig {
  providerId: number;
  model: string;
  providers: { id: number; name: string; kind: string }[];
  configured: boolean;
}

/** Быстрые запросы на пустой чат — чтобы не пугаться чистого листа. */
const QUICK_PROMPTS = [
  "Собери мне мир для романтического свидания с нуля: пара персонажей, место, инструменты и сцена",
  "Придумай драму на троих с конфликтующими целями и собери в сценарий из трёх сцен",
  "Объясни, как всё устроено, и посоветуй, что вообще интересно попробовать",
  "Я играю сам за одного — добавь напарника-ИИ и сцену знакомства",
];

export default function SetupAssistantPage() {
  const [cfg, setCfg] = useState<AssistantConfig | null>(null);
  const [modelDraft, setModelDraft] = useState("");
  const [models, setModels] = useState<string[]>([]);
  const [modelsError, setModelsError] = useState("");
  const [loadingModels, setLoadingModels] = useState(false);
  const [cfgError, setCfgError] = useState("");
  const [cfgSaved, setCfgSaved] = useState(false);
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  /** Список моделей провайдера — как в редакторе персонажа: выбирать, а не вбивать. */
  const loadModels = useCallback(async (providerId: number) => {
    if (!providerId) return;
    setLoadingModels(true);
    setModelsError("");
    try {
      const r = await api<string[]>(`/api/providers/${providerId}/models`);
      setModels(r);
      if (r.length === 0) setModelsError("Список пуст — сервер не отдаёт модели, введите имя вручную");
    } catch (e) {
      setModels([]);
      setModelsError(`${e instanceof Error ? e.message : String(e)} — можно ввести имя модели вручную`);
    } finally {
      setLoadingModels(false);
    }
  }, []);

  const loadCfg = useCallback(() => {
    api<AssistantConfig>("/api/assistant")
      .then((c) => {
        setCfg(c);
        setModelDraft(c.model);
        if (c.providerId) loadModels(c.providerId);
      })
      .catch((e) => setCfgError(e.message));
  }, [loadModels]);
  useEffect(loadCfg, [loadCfg]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, busy]);

  const saveCfg = async (model?: string) => {
    if (!cfg) return;
    const m = (model ?? modelDraft).trim();
    if (!m) {
      setCfgError("Выберите модель из списка (⟳ — обновить)");
      return;
    }
    setCfgError("");
    try {
      await api("/api/assistant", { method: "PUT", body: JSON.stringify({ providerId: cfg.providerId, model: m }) });
      setCfg({ ...cfg, model: m });
      setCfgSaved(true);
      setTimeout(() => setCfgSaved(false), 2000);
    } catch (e) {
      setCfgError(e instanceof Error ? e.message : String(e));
    }
  };

  const send = async (text?: string) => {
    const message = (text ?? draft).trim();
    if (!message || busy) return;
    setError("");
    const history = messages;
    setMessages((m) => [...m, { role: "user", content: message }]);
    setDraft("");
    setBusy(true);
    try {
      const r = await apiPost<{ reply: string; actions: ChatMsg["actions"] }>("/api/assistant", {
        message,
        history: history.map(({ role, content }) => ({ role, content })),
      });
      setMessages((m) => [...m, { role: "assistant", content: r.reply, actions: r.actions }]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const ready = !!cfg?.providerId && !!cfg.model;

  return (
    <div className="mx-auto flex h-screen max-w-4xl flex-col px-8 py-8">
      <PageHeader
        title="Настроить с помощью ИИ"
        subtitle="Ассистент соберёт мир вместе с вами: персонажей, инструменты, одежду, места, сцены и сценарии — просто опишите, во что хотите играть."
      />

      {/* Конфигурация: провайдер + модель ассистента */}
      <Card className="mb-4 p-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-56">
            <Field
              label="Провайдер ассистента"
              hint="Через него работает ассистент; его модель достаётся новым персонажам"
            >
              <Dropdown
                value={String(cfg?.providerId ?? "")}
                options={[
                  ...(cfg?.providers ?? []).map((p) => ({
                    value: String(p.id),
                    label: p.name,
                  })),
                  ...(cfg && cfg.providers.length === 0
                    ? [{ value: "", label: "нет провайдеров — создайте в разделе «Провайдеры»" }]
                    : []),
                ]}
                disabled={!cfg || cfg.providers.length === 0 || busy}
                onChange={(v) => {
                  setModels([]);
                  setModelsError("");
                  setCfg((c) => (c ? { ...c, providerId: Number(v) } : c));
                  loadModels(Number(v));
                }}
              />
            </Field>
          </div>
          <div className="min-w-64 flex-1">
            <Field
              label="Модель"
              hint={modelsError || "Выберите из списка провайдера (⟳ — обновить) или введите вручную"}
            >
              <div className="flex gap-2">
                <Combobox
                  value={modelDraft}
                  onChange={(v) => {
                    setModelDraft(v);
                    // Выбор из списка сохраняет сразу; ручной ввод — кнопкой «Сохранить»
                    if (models.includes(v)) saveCfg(v);
                  }}
                  options={models}
                  placeholder="имя модели, напр. glm-5.3-flash"
                  className="min-w-0 flex-1"
                  inputClassName="font-mono text-xs"
                />
                <IconBtn
                  label="Обновить список моделей"
                  loading={loadingModels}
                  onClick={() => cfg?.providerId && loadModels(cfg.providerId)}
                >
                  {!loadingModels && <RefreshCw className="h-[18px] w-[18px]" />}
                </IconBtn>
                <Btn variant="primary" onClick={() => saveCfg()}>
                  Сохранить
                </Btn>
              </div>
            </Field>
          </div>
          {cfgSaved && <Badge color="ok">сохранено</Badge>}
        </div>
        {cfgError && <ErrorText>{cfgError}</ErrorText>}
        {cfg && !cfg.configured && cfg.providerId > 0 && (
          <p className="mt-2 text-[11px] leading-relaxed text-muted/70">
            Подставлен первый попавшийся провайдер — можно выбрать другой и сохранить.
          </p>
        )}
      </Card>

      {/* Лента чата */}
      <div ref={scrollRef} className="mb-4 min-h-0 flex-1 overflow-y-auto rounded-2xl border border-line bg-black/20 p-4">
        {messages.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center gap-4 py-8 text-center">
            <Sparkles className="h-8 w-8 text-accent" />
            <p className="max-w-md text-sm leading-relaxed text-muted">
              Опишите, во что хотите играть — ассистент придумает персонажей с целями, инструменты,
              места и соберёт сцену или целый сценарий. Можно задавать любые вопросы про устройство
              симулятора.
            </p>
            <div className="flex max-w-lg flex-wrap justify-center gap-2">
              {QUICK_PROMPTS.map((q) => (
                <button
                  key={q}
                  type="button"
                  disabled={!ready || busy}
                  onClick={() => send(q)}
                  className="rounded-full border border-line bg-panel-2/50 px-3 py-1.5 text-xs text-muted transition-colors hover:border-accent/40 hover:text-fg disabled:opacity-40"
                >
                  {q}
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="flex flex-col gap-3">
          {messages.map((m, i) => (
            <div key={i} className={`flex gap-2.5 ${m.role === "user" ? "flex-row-reverse" : ""}`}>
              <span
                className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border ${
                  m.role === "user" ? "border-warn/40 bg-warn/10 text-warn" : "border-accent/40 bg-accent/10 text-accent"
                }`}
              >
                {m.role === "user" ? <User className="h-4 w-4" /> : <Bot className="h-4 w-4" />}
              </span>
              <div className={`min-w-0 max-w-[85%] ${m.role === "user" ? "text-right" : ""}`}>
                <div
                  className={`whitespace-pre-wrap rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
                    m.role === "user"
                      ? "rounded-tr-sm border border-warn/25 bg-warn/5 text-left"
                      : "rounded-tl-sm border border-line bg-panel/70"
                  }`}
                >
                  {m.content}
                </div>
                {m.actions && m.actions.length > 0 && (
                  <div className="mt-1.5 flex flex-col gap-1">
                    {m.actions.map((a, j) => (
                      <div
                        key={j}
                        className={`rounded-lg border px-2.5 py-1 text-left text-[11px] leading-relaxed ${
                          a.ok ? "border-ok/30 bg-ok/5 text-ok/90" : "border-err/30 bg-err/5 text-err/90"
                        }`}
                        title={`инструмент: ${a.tool}`}
                      >
                        {a.ok ? "✓" : "✗"} {a.summary}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ))}
          {busy && (
            <div className="flex items-center gap-2 text-xs text-muted">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> ассистент думает и создаёт…
            </div>
          )}
        </div>
      </div>

      <ErrorText>{error}</ErrorText>

      {/* Ввод */}
      <div className="flex gap-2">
        <Input
          value={draft}
          disabled={!ready || busy}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
          placeholder={
            ready
              ? "Опишите идею: «два студента и тайная влюблённость, я играю за парня»…"
              : "Сначала выберите провайдера и модель ассистента"
          }
        />
        <Btn variant="primary" onClick={() => send()} loading={busy} disabled={!ready}>
          <Send className="h-4 w-4" /> Отправить
        </Btn>
      </div>
      <p className="mt-2 text-center text-[11px] leading-relaxed text-muted/60">
        Ассистент создаёт всё сразу в вашу базу — потом донастройте в разделах{" "}
        <Link href="/characters" className="text-accent/80 hover:underline">Персонажи</Link>,{" "}
        <Link href="/tools" className="text-accent/80 hover:underline">Инструменты</Link> и{" "}
        <Link href="/scenes" className="text-accent/80 hover:underline">Сцены</Link>. Изменения в мире
        сохраняются: созданное можно удалить вручную на тех же страницах.
      </p>
    </div>
  );
}
