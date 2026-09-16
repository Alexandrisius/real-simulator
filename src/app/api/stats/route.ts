import { NextResponse } from "next/server";
import { jsonError } from "@/lib/api";
import {
  countSceneEvents,
  getCharacter,
  getSceneParticipants,
  listCharacters,
  listProviders,
  listScenes,
  listTools,
} from "@/db/queries";

/** GET /api/stats — счётчики для дашборда + последние сцены. */
export async function GET() {
  try {
    const scenes = listScenes();
    const recent = scenes.slice(0, 6).map((s) => ({
      ...s,
      eventCount: countSceneEvents(s.id),
      participants: getSceneParticipants(s.id)
        .map((cid) => getCharacter(cid))
        .filter((c): c is NonNullable<typeof c> => c !== null)
        .map((c) => ({ id: c.id, name: c.name, emoji: c.emoji })),
    }));
    return NextResponse.json({
      characters: listCharacters().length,
      tools: listTools().length,
      providers: listProviders().length,
      scenes: scenes.length,
      running: scenes.filter((s) => s.status === "running").length,
      recent,
    });
  } catch (e) {
    return jsonError(e);
  }
}
