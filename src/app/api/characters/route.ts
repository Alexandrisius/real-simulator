import { NextResponse } from "next/server";
import { createCharacter, getProvider, listCharacters } from "@/db/queries";
import { ApiError, characterSchema, jsonError, parseBody } from "@/lib/api";

export async function GET() {
  try {
    return NextResponse.json(listCharacters());
  } catch (e) {
    return jsonError(e);
  }
}

export async function POST(req: Request) {
  try {
    const data = await parseBody(req, characterSchema);
    if (!data.isHuman) {
      if (!data.providerId)
        throw new ApiError(400, "Для ИИ-персонажа нужен провайдер (моделей)");
      if (!getProvider(data.providerId))
        throw new ApiError(400, "Провайдер не найден — сначала создайте его");
    }
    return NextResponse.json(
      createCharacter({
        name: data.name,
        emoji: data.emoji,
        persona: data.persona,
        providerId: data.isHuman ? null : data.providerId!,
        model: data.model,
        temperature: data.temperature,
        maxTokens: data.maxTokens,
        toolIds: data.toolIds,
        state: data.state,
        isHuman: data.isHuman,
        boundaries: data.boundaries,
      }),
      { status: 201 }
    );
  } catch (e) {
    return jsonError(e);
  }
}
