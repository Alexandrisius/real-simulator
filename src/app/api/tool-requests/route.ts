import { NextResponse } from "next/server";
import { getCharacter, getScene, listToolRequests } from "@/db/queries";
import type { ToolRequest, ToolRequestStatus } from "@/lib/types";
import { jsonError } from "@/lib/api";

/** GET /api/tool-requests?sceneId=1&status=pending — очередь заявок с именами. */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const sceneIdRaw = url.searchParams.get("sceneId");
    const statusRaw = url.searchParams.get("status");
    const sceneId = sceneIdRaw ? Number(sceneIdRaw) : undefined;
    const status = (statusRaw as ToolRequestStatus | null) ?? undefined;
    const rows = listToolRequests(
      Number.isInteger(sceneId) && sceneId! > 0 ? sceneId : undefined,
      status
    );
    const out = rows.map((r: ToolRequest) => {
      const c = getCharacter(r.characterId);
      const s = getScene(r.sceneId);
      return {
        ...r,
        characterName: c?.name ?? `#${r.characterId}`,
        characterEmoji: c?.emoji ?? "❓",
        sceneName: s?.name ?? `#${r.sceneId}`,
      };
    });
    return NextResponse.json(out);
  } catch (e) {
    return jsonError(e);
  }
}
