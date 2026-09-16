// Единый клиент для OpenAI-совместимых API: LM Studio, OpenRouter,
// любой другой endpoint. Плюс встроенный mock-провайдер, чтобы тестировать
// движок и UI без запущенной модели.

import type { ChatMessage, Provider, ToolSpec } from "./types";
import { getSetting } from "@/db/queries";

/** Ключ настройки «Корпоративный режим» (отключение проверки SSL). */
const INSECURE_TLS_KEY = "network.insecureTls";

/**
 * Корпоративные сети с SSL-инспекцией (DLP, прокси) подменяют сертификаты —
 * внешние вызовы падают с «self-signed certificate in certificate chain»
 * (NODE_USE_SYSTEM_CA выручает не всегда). Настройка читается перед каждым
 * исходящим вызовом, так что тумблер в UI работает без перезапуска: Node
 * проверяет NODE_TLS_REJECT_UNAUTHORIZED при каждом новом TLS-соединении.
 * Влияет на весь процесс, но наружу приложение ходит только сюда.
 */
function applyTlsMode(): void {
  const off = getSetting(INSECURE_TLS_KEY) === "1";
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = off ? "0" : "1";
}

export interface CompletionResult {
  message: {
    role: "assistant";
    content: string | null;
    tool_calls?: {
      id: string;
      type: "function";
      function: { name: string; arguments: string };
    }[];
  };
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  raw: unknown;
}

export interface MockContext {
  actor: string;
  others: string[];
  /** Имена доступных инструментов (для разнообразия поведения) */
  tools?: string[];
  /** Названия товаров магазина (для shop_buy) */
  shopItems?: string[];
}

/**
 * Тестовый хук mock-провайдера (e2e): сценарная очередь «настойчивого
 * агента». Каждый ход mock съедает следующий пункт (инструмент + аргументы,
 * опционально content — реплика в том же ответе, для проверки дедупликации).
 * Живёт на globalThis, потому что движок строит mockContext сам.
 */
const g = globalThis as unknown as {
  __simMockScript?: { name: string; args: Record<string, unknown>; content?: string }[];
};

export function setMockScript(
  script: { name: string; args: Record<string, unknown>; content?: string }[] | undefined
): void {
  g.__simMockScript = script;
}

export interface ChatOptions {
  provider: Provider;
  model: string;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  /** Контекст для mock-провайдера */
  mockContext?: MockContext;
}

function normalizeBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

/**
 * Базовый endpoint провайдера. Для LM Studio и OpenRouter автоматически
 * дописываем /v1, если пользователь забыл (частая опечатка).
 */
function endpointUrl(p: Provider): string {
  let base = normalizeBase(p.baseUrl);
  if ((p.kind === "lmstudio" || p.kind === "openrouter") && !/\/v\d+$/.test(base)) {
    base += "/v1";
  }
  return base;
}

function authHeaders(p: Provider): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (p.apiKey) h["Authorization"] = `Bearer ${p.apiKey}`;
  if (p.kind === "openrouter") {
    h["X-Title"] = "Real Simulator";
    h["HTTP-Referer"] = "http://localhost:3000";
  }
  return h;
}

/** Список моделей провайдера (GET /v1/models). */
export async function fetchProviderModels(p: Provider, timeoutMs = 15000): Promise<string[]> {
  if (p.kind === "mock") return ["mock-actor", "mock-chatty"];
  applyTlsMode();
  const res = await fetch(`${endpointUrl(p)}/models`, {
    headers: authHeaders(p),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  const data = JSON.parse(text) as { data?: { id?: string }[] };
  return (data.data ?? [])
    .map((m) => m.id)
    .filter((id): id is string => Boolean(id));
}

/** Проверка соединения с провайдером. */
export async function testProvider(p: Provider): Promise<{ ok: boolean; models: number; error?: string }> {
  try {
    const models = await fetchProviderModels(p);
    return { ok: true, models: models.length };
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    const cause = (err.cause as { code?: string } | undefined)?.code;
    return { ok: false, models: 0, error: `${err.message}${cause ? ` (${cause})` : ""}` };
  }
}

/** Основной вызов: chat/completions с native function calling. */
export async function chatCompletion(opts: ChatOptions): Promise<CompletionResult> {
  if (opts.provider.kind === "mock") {
    return mockCompletion(opts);
  }
  applyTlsMode();

  const body: Record<string, unknown> = {
    model: opts.model,
    messages: opts.messages,
    temperature: opts.temperature ?? 0.8,
    max_tokens: opts.maxTokens ?? 1024,
  };
  if (opts.tools && opts.tools.length > 0) {
    body.tools = opts.tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));
    body.tool_choice = "auto";
  }

  const res = await fetch(`${endpointUrl(opts.provider)}/chat/completions`, {
    method: "POST",
    headers: authHeaders(opts.provider),
    body: JSON.stringify(body),
    signal: opts.signal,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 500)}`);
  }
  let data: {
    error?: unknown;
    choices?: { message?: CompletionResult["message"] }[];
    usage?: CompletionResult["usage"];
  };
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Провайдер вернул не-JSON ответ: ${text.slice(0, 200)}`);
  }
  if (data.error) {
    const msg =
      typeof data.error === "string"
        ? data.error
        : (data.error as { message?: string })?.message ?? JSON.stringify(data.error);
    throw new Error(`Ошибка API: ${msg}`);
  }
  const message = data.choices?.[0]?.message;
  if (!message) throw new Error("Пустой ответ модели (нет choices[0].message)");
  return { message, usage: data.usage, raw: data };
}

// ---------- Mock-провайдер ----------
// Детерминированное поведение: первый ход — tool call (send_message),
// после результата инструмента — реплика, дальше — только реплики.

function mockCompletion(opts: ChatOptions): CompletionResult {
  const actor = opts.mockContext?.actor ?? "Агент";
  const others = opts.mockContext?.others ?? [];
  const toolNames = opts.mockContext?.tools ?? [];
  const shopItems = opts.mockContext?.shopItems ?? [];
  const msgs = opts.messages;

  const lastIsToolResult = msgs.length > 0 && msgs[msgs.length - 1].role === "tool";
  const actCount = msgs.filter((m) => m.role === "assistant" && m.tool_calls?.length).length;
  // Номер хода из финальной подсказки "(Ход N. …)" и что уже делали в диалоге
  const lastContent = typeof msgs[msgs.length - 1]?.content === "string" ? (msgs[msgs.length - 1].content as string) : "";
  const turnNo = Number(lastContent.match(/Ход (\d+)/)?.[1] ?? 0);
  const calledTools = msgs
    .filter((m) => m.role === "assistant" && m.tool_calls?.length)
    .flatMap((m) => m.tool_calls!.map((tc) => tc.function.name));
  const didBrowse = calledTools.includes("shop_browse");
  const didBuy = calledTools.includes("shop_buy");

  if (lastIsToolResult) {
    return {
      message: { role: "assistant", content: `${actor}: принято, получила сообщение!` },
      raw: { mock: true },
    };
  }
  // Сценарная очередь (тестовый хук): следующий пункт играет первым.
  if (g.__simMockScript && g.__simMockScript.length > 0) {
    const step = g.__simMockScript.shift()!;
    return {
      message: {
        role: "assistant",
        content: step.content ?? null,
        tool_calls: [
          {
            id: `mock_${Date.now()}_${Math.floor(Math.random() * 1e6)}`,
            type: "function",
            function: { name: step.name, arguments: JSON.stringify(step.args ?? {}) },
          },
        ],
      },
      raw: { mock: true },
    };
  }
  if (actCount === 0 && others.length > 0 && toolNames.includes("send_message")) {
    const target = others[0];
    return {
      message: {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: `mock_${Date.now()}_${Math.floor(Math.random() * 1e6)}`,
            type: "function",
            function: {
              name: "send_message",
              arguments: JSON.stringify({ to: target, text: "Привет! Как дела?" }),
            },
          },
        ],
      },
      raw: { mock: true },
    };
  }
  if (actCount === 1 && toolNames.includes("do_activity")) {
    return {
      message: {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: `mock_${Date.now()}_${Math.floor(Math.random() * 1e6)}`,
            type: "function",
            function: {
              name: "do_activity",
              arguments: JSON.stringify({ activity: "сделала себе кофе" }),
            },
          },
        ],
      },
      raw: { mock: true },
    };
  }
  // Третье действие — заявка на новый инструмент (когда сцене это разрешено)
  if (actCount === 2 && toolNames.includes("request_tool")) {
    return {
      message: {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: `mock_${Date.now()}_${Math.floor(Math.random() * 1e6)}`,
            type: "function",
            function: {
              name: "request_tool",
              arguments: JSON.stringify({
                name: "kiss",
                title: "Поцелуй",
                description: "Поцеловать персонажа. Только по обоюдному желанию.",
                parameters: {
                  type: "object",
                  properties: { who: { type: "string", description: "Имя персонажа" } },
                  required: ["who"],
                },
                audience: "target",
                target_param: "who",
                observation_template: "{name} нежно целует {who}",
                effects: [{ target: "tool_target", key: "mood", op: "add", value: 1 }],
                cost: 0,
                reason: "хочу выразить чувства, а такого инструмента нет",
              }),
            },
          },
        ],
      },
      raw: { mock: true },
    };
  }
  // Магазин: на 7-м ходу посмотреть витрину, на 9-м — купить (по одному разу)
  if (toolNames.includes("shop_browse") && !didBrowse && turnNo >= 7) {
    return {
      message: {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: `mock_${Date.now()}_${Math.floor(Math.random() * 1e6)}`,
            type: "function",
            function: { name: "shop_browse", arguments: "{}" },
          },
        ],
      },
      raw: { mock: true },
    };
  }
  if (
    toolNames.includes("shop_buy") &&
    didBrowse &&
    !didBuy &&
    shopItems.length > 0 &&
    turnNo >= 9
  ) {
    const args: Record<string, string> = { item: shopItems[0] };
    if (others.length > 0) args.for = others[0];
    return {
      message: {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: `mock_${Date.now()}_${Math.floor(Math.random() * 1e6)}`,
            type: "function",
            function: { name: "shop_buy", arguments: JSON.stringify(args) },
          },
        ],
      },
      raw: { mock: true },
    };
  }
  return {
    message: { role: "assistant", content: `${actor}: продолжаю разговор, интересно, что дальше.` },
    raw: { mock: true },
  };
}
