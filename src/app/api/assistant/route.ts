import { NextResponse } from "next/server";
import { z } from "zod";
import { getProvider, getSetting, listProviders, setSetting } from "@/db/queries";
import { ApiError, jsonError, parseBody } from "@/lib/api";
import { runAssistantTurn } from "@/lib/assistant";

/** Ключи настроек ассистента: провайдер и модель для «Настроить с помощью ИИ». */
const CFG_PROVIDER = "assistant.providerId";
const CFG_MODEL = "assistant.model";

/** Дефолт: первый не-mock провайдер; модель не угадываем — выберет пользователь. */
function resolveConfig(): { providerId: number; model: string; fallbackUsed: boolean } {
  const savedProvider = Number(getSetting(CFG_PROVIDER) ?? "");
  const savedModel = getSetting(CFG_MODEL) ?? "";
  if (Number.isFinite(savedProvider) && savedProvider > 0 && getProvider(savedProvider)) {
    return { providerId: savedProvider, model: savedModel, fallbackUsed: false };
  }
  const first = listProviders().find((p) => p.kind !== "mock");
  if (!first) return { providerId: 0, model: "", fallbackUsed: false };
  return { providerId: first.id, model: savedModel, fallbackUsed: true };
}

/** GET /api/assistant — текущая конфигурация ассистента. */
export async function GET() {
  try {
    const cfg = resolveConfig();
    return NextResponse.json({
      providerId: cfg.providerId,
      model: cfg.model,
      providers: listProviders().map((p) => ({ id: p.id, name: p.name, kind: p.kind })),
      configured: getSetting(CFG_PROVIDER) != null,
    });
  } catch (e) {
    return jsonError(e);
  }
}

const configSchema = z.object({
  providerId: z.number().int().positive(),
  model: z.string().trim().min(1, "Укажите модель"),
});

/** PUT /api/assistant — сохранить провайдера/модель ассистента. */
export async function PUT(req: Request) {
  try {
    const data = await parseBody(req, configSchema);
    if (!getProvider(data.providerId)) throw new ApiError(404, "Провайдер не найден");
    setSetting(CFG_PROVIDER, String(data.providerId));
    setSetting(CFG_MODEL, data.model);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return jsonError(e);
  }
}

const chatSchema = z.object({
  message: z.string().trim().min(1, "Пустое сообщение").max(4000),
  history: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().max(8000),
      })
    )
    .max(40)
    .optional()
    .default([]),
});

/** POST /api/assistant — ход ассистента: ответ + выполненные действия. */
export async function POST(req: Request) {
  try {
    const data = await parseBody(req, chatSchema);
    const cfg = resolveConfig();
    if (!cfg.providerId) {
      throw new ApiError(
        400,
        "Сначала создайте провайдера в разделе «Провайдеры» (LM Studio, OpenRouter, OpenCode Go…) и выберите его здесь"
      );
    }
    if (!cfg.model.trim()) {
      throw new ApiError(400, "Выберите модель ассистента в настройках сверху (список подтягивается кнопкой ⟳)");
    }
    const result = await runAssistantTurn({
      providerId: cfg.providerId,
      model: cfg.model,
      history: data.history,
      message: data.message,
    });
    return NextResponse.json(result);
  } catch (e) {
    return jsonError(e);
  }
}
