import { NextResponse } from "next/server";
import {
  getCharacter,
  getScene,
  getSceneGoals,
  getSceneParticipants,
  knowledgeOf,
  listAttributes,
  listClothingSlots,
  listProducts,
  listRelationsOf,
  listTools,
} from "@/db/queries";
import { hasHiddenAttributes } from "@/lib/knowledge";
import { buildSystemPrompt } from "@/lib/prompt";
import { ApiError, jsonError, parseBody } from "@/lib/api";
import { z } from "zod";

const schema = z.object({
  characterId: z.number().int().positive(),
  sceneId: z.number().int().positive(),
});

/** POST — готовый системный промпт персонажа в сцене (для предпросмотра). */
export async function POST(req: Request) {
  try {
    const data = await parseBody(req, schema);
    const character = getCharacter(data.characterId);
    if (!character) throw new ApiError(404, "Персонаж не найден");
    const scene = getScene(data.sceneId);
    if (!scene) throw new ApiError(404, "Сцена не найдена");
    const participants = getSceneParticipants(data.sceneId)
      .map((id) => getCharacter(id))
      .filter((c): c is NonNullable<typeof c> => c !== null);
    const tools = character.toolIds
      .map((id) => listTools().find((t) => t.id === id))
      .filter((t): t is NonNullable<typeof t> => t !== null);
    const goals = getSceneGoals(data.sceneId);
    const nameOf = (id: number) => participants.find((p) => p.id === id)?.name ?? `#${id}`;
    const prompt = buildSystemPrompt({
      character,
      scene,
      participants,
      events: [],
      turn: 1,
      goal: goals[character.id] ?? null,
      hasPricedTools:
        tools.some((t) => t.cost > 0) || typeof character.state.money === "number",
      hasShop: listProducts().length > 0,
      attributeDefs: listAttributes(),
      relations: listRelationsOf(character.id).map((r) => ({ ...r, name: nameOf(r.toId) })),
      knowledge: knowledgeOf(character.id),
      hasHiddenAttributes: hasHiddenAttributes(),
      hasClothing: listClothingSlots().length > 0,
    });
    return NextResponse.json({ prompt });
  } catch (e) {
    return jsonError(e);
  }
}
