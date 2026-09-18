"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, Plug, Plus, ShieldAlert, Trash2, XCircle } from "lucide-react";
import {
  Badge,
  Btn,
  Card,
  EmptyState,
  ErrorText,
  Field,
  IconBtn,
  Input,
  PageHeader,
  Select,
  Toggle,
} from "@/components/ui";
import { api, apiDelete, apiPatch, apiPost } from "@/components/api";
import type { Provider, ProviderKind, ProviderThinkingMode } from "@/lib/types";

const KIND_OPTIONS: { value: ProviderKind; label: string; hint: string; defaultUrl: string }[] = [
  {
    value: "lmstudio",
    label: "LM Studio (локально)",
    hint: "Сервер LM Studio: Developer → Start Server. Ключ не нужен.",
    defaultUrl: "http://localhost:1234/v1",
  },
  {
    value: "openrouter",
    label: "OpenRouter (облако)",
    hint: "Любые модели по одному API. Нужен ключ с openrouter.ai/keys.",
    defaultUrl: "https://openrouter.ai/api/v1",
  },
  {
    value: "opencode",
    label: "OpenCode Go / Zen (облако)",
    hint: "Подписка OpenCode Go: дешёвые открытые модели (GLM, Kimi, DeepSeek…). Ключ — в консоли opencode.ai/auth (подпишитесь на Go и скопируйте API-ключ). Список моделей — кнопкой «Проверить».",
    defaultUrl: "https://opencode.ai/zen/go/v1",
  },
  {
    value: "openai-compatible",
    label: "Другой OpenAI-совместимый",
    hint: "llama.cpp, vLLM, Ollama (+openai), TabbyAPI, Z.AI/GLM и т.п.",
    defaultUrl: "http://localhost:8080/v1",
  },
  {
    value: "mock",
    label: "Mock (для теста интерфейса)",
    hint: "Фиктивные ответы без модели — проверить движок и UI.",
    defaultUrl: "http://localhost/v1",
  },
];

const THINKING_OPTIONS = [
  { value: "default", label: "по умолчанию провайдера" },
  { value: "max", label: "включить по максимуму" },
  { value: "off", label: "выключить" },
];

interface TestResult {
  ok: boolean;
  models: number;
  error?: string;
}

type ProviderForm = {
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  apiKey: string;
  thinkingMode: ProviderThinkingMode;
};
const emptyForm: ProviderForm = { name: "", kind: "lmstudio", baseUrl: "", apiKey: "", thinkingMode: "default" };

export default function ProvidersPage() {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [form, setForm] = useState<typeof emptyForm>(emptyForm);
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [tests, setTests] = useState<Record<number, "loading" | TestResult>>({});
  const [insecureTls, setInsecureTls] = useState(false);
  const [tlsBusy, setTlsBusy] = useState(false);
  // Реф карточки формы: «Изменить» открывает форму наверху страницы — прокручиваем к ней
  const formRef = useRef<HTMLDivElement>(null);

  const load = useCallback(() => {
    api<Provider[]>("/api/providers").then(setProviders).catch((e) => setError(e.message));
  }, []);

  useEffect(load, [load]);

  useEffect(() => {
    api<{ insecureTls: boolean }>("/api/network-settings")
      .then((r) => setInsecureTls(r.insecureTls))
      .catch(() => {});
  }, []);

  const toggleTls = async (next: boolean) => {
    setTlsBusy(true);
    try {
      await apiPatch("/api/network-settings", { insecureTls: next });
      setInsecureTls(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setTlsBusy(false);
    }
  };

  const startCreate = () => {
    setEditingId(null);
    const kind = KIND_OPTIONS[0];
    setForm({ ...emptyForm, baseUrl: kind.defaultUrl });
    setFormOpen(true);
  };

  const startEdit = (p: Provider) => {
    setEditingId(p.id);
    setForm({ name: p.name, kind: p.kind, baseUrl: p.baseUrl, apiKey: p.apiKey, thinkingMode: p.thinkingMode ?? "default" });
    setFormOpen(true);
    requestAnimationFrame(() =>
      formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })
    );
  };

  const save = async () => {
    setSaving(true);
    setError("");
    try {
      if (editingId) await apiPatch(`/api/providers/${editingId}`, form);
      else await apiPost("/api/providers", form);
      setForm(emptyForm);
      setEditingId(null);
      setFormOpen(false);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (p: Provider) => {
    if (!confirm(`Удалить провайдера «${p.name}»?`)) return;
    setError("");
    try {
      await apiDelete(`/api/providers/${p.id}`);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const test = async (p: Provider) => {
    setTests((t) => ({ ...t, [p.id]: "loading" }));
    try {
      const r = await api<TestResult>(`/api/providers/${p.id}/models?test=1`);
      setTests((t) => ({ ...t, [p.id]: r }));
    } catch (e) {
      setTests((t) => ({
        ...t,
        [p.id]: { ok: false, models: 0, error: e instanceof Error ? e.message : String(e) },
      }));
    }
  };

  const kindInfo = KIND_OPTIONS.find((k) => k.value === form.kind)!;

  return (
    <div className="mx-auto max-w-4xl px-8 py-10">
      <PageHeader
        title="Провайдеры"
        subtitle="Откуда берутся модели: локальный LM Studio, облако OpenRouter или любой OpenAI-совместимый сервер."
        actions={
          <Btn variant="primary" onClick={startCreate}>
            <Plus className="h-4 w-4" /> Добавить
          </Btn>
        }
      />
      <ErrorText>{error}</ErrorText>

      {(formOpen || editingId !== null) && (
        <div ref={formRef}>
        <Card className="mb-6 p-5">
          <div className="mb-4 text-sm font-medium">
            {editingId ? "Редактирование провайдера" : "Новый провайдер"}
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Название">
              <Input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="Мой LM Studio"
              />
            </Field>
            <Field label="Тип">
              <Select
                value={form.kind}
                onChange={(kind) => {
                  const info = KIND_OPTIONS.find((k) => k.value === kind)!;
                  setForm((f) => ({
                    ...f,
                    kind: kind as ProviderKind,
                    baseUrl: f.baseUrl === "" || KIND_OPTIONS.some((k) => k.defaultUrl === f.baseUrl) ? info.defaultUrl : f.baseUrl,
                  }));
                }}
                options={KIND_OPTIONS.map((k) => ({ value: k.value, label: k.label }))}
              />
            </Field>
            <Field
              label="Размышления (thinking)"
              hint="Для GLM/Z.AI-совместимых API: «по максимуму» — глубокие рассуждения (точнее, медленнее), «выключить» — мгновенные ответы. Другие API могут не знать этот параметр — оставляйте «по умолчанию»."
            >
              <Select
                value={form.thinkingMode}
                onChange={(v) => setForm({ ...form, thinkingMode: v as ProviderThinkingMode })}
                options={THINKING_OPTIONS}
              />
            </Field>
            <Field label="Base URL" className="sm:col-span-2">
              <Input
                value={form.baseUrl}
                onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
                placeholder={kindInfo.defaultUrl}
              />
            </Field>
            {form.kind !== "mock" && (
              <Field
                label="API-ключ"
                hint={form.kind === "lmstudio" ? "Для LM Studio не нужен — оставьте пустым" : undefined}
                className="sm:col-span-2"
              >
                <Input
                  type="password"
                  value={form.apiKey}
                  onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
                  placeholder="sk-or-v1-..."
                />
              </Field>
            )}
          </div>
          <p className="mt-3 text-xs text-muted">{kindInfo.hint}</p>
          <div className="mt-4 flex gap-2">
            <Btn variant="primary" onClick={save} loading={saving}>
              Сохранить
            </Btn>
            <Btn variant="ghost" onClick={() => { setForm(emptyForm); setEditingId(null); setFormOpen(false); }}>
              Отмена
            </Btn>
          </div>
        </Card>
        </div>
      )}

      {providers.length === 0 ? (
        <EmptyState
          icon={<Plug className="h-8 w-8" />}
          title="Провайдеров пока нет"
          hint="Добавьте LM Studio (локально, бесплатно) или OpenRouter (доступ ко множеству моделей по одному ключу)."
        />
      ) : (
        <div className="flex flex-col gap-2">
          {providers.map((p) => {
            const t = tests[p.id];
            return (
              <Card key={p.id} className="flex flex-wrap items-center gap-3 p-4">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{p.name}</span>
                    <Badge color={p.kind === "mock" ? "warn" : "accent"}>
                      {KIND_OPTIONS.find((k) => k.value === p.kind)?.label ?? p.kind}
                    </Badge>
                    {(p.thinkingMode === "off" || p.thinkingMode === "max") && (
                      <Badge>{p.thinkingMode === "off" ? "💭 размышления выкл" : "💭 размышления макс"}</Badge>
                    )}
                    {t && t !== "loading" &&
                      (t.ok ? (
                        <Badge color="ok">
                          <CheckCircle2 className="h-3 w-3" /> {t.models} моделей
                        </Badge>
                      ) : (
                        <Badge color="err">
                          <XCircle className="h-3 w-3" /> ошибка
                        </Badge>
                      ))}
                  </div>
                  <div className="mt-1 truncate font-mono text-xs text-muted">{p.baseUrl}</div>
                  {t && t !== "loading" && !t.ok && (
                    <p className="mt-1 line-clamp-2 text-xs text-err/80">{t.error}</p>
                  )}
                </div>
                <Btn onClick={() => test(p)} loading={t === "loading"}>
                  Проверить
                </Btn>
                <Btn variant="ghost" onClick={() => startEdit(p)}>
                  Изменить
                </Btn>
                <IconBtn variant="danger" label="Удалить провайдера" onClick={() => remove(p)}>
                  <Trash2 className="h-[18px] w-[18px]" />
                </IconBtn>
              </Card>
            );
          })}
        </div>
      )}

      <div className="mt-10">
        <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted">
          Корпоративная сеть
        </div>
        <Card className="p-5">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-sm font-medium">
                <ShieldAlert className="h-4 w-4 text-warn" />
                Корпоративный режим
              </div>
              <p className="mt-1 max-w-xl text-xs leading-relaxed text-muted">
                Отключает проверку SSL-сертификатов у вызовов провайдеров. Включите, если
                работаете в корпоративной сети с SSL-инспекцией (DLP, прокси), а «Проверить»
                падает с «self-signed certificate in certificate chain».
              </p>
            </div>
            <Toggle
              checked={insecureTls}
              onChange={toggleTls}
              disabled={tlsBusy}
              label="Корпоративный режим (отключение проверки SSL)"
            />
          </div>
          <div
            className={`mt-3 rounded-lg border px-3 py-2 text-xs leading-relaxed ${
              insecureTls ? "border-warn/30 bg-warn/10 text-warn" : "border-ok/30 bg-ok/10 text-ok"
            }`}
          >
            {insecureTls
              ? "Режим включён: проверка SSL-сертификатов отключена. Используйте только в доверенной корпоративной сети."
              : "Режим выключен: полная проверка SSL-сертификатов (рекомендуется)."}
          </div>
        </Card>
      </div>
    </div>
  );
}
