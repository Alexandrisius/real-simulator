import { NextResponse } from "next/server";
import { getCharacter, getScene, listPendingOffersForScene, listTools } from "@/db/queries";
import { ApiError, jsonError, parseId } from "@/lib/api";

type Ctx = { params: Promise<{ id: string }> };

export interface OfferView {
  id: number;
  toolName: string;
  toolTitle: string;
  fromId: number;
  fromName: string;
  fromEmoji: string;
  toId: number;
  toName: string;
  toEmoji: string;
  args: Record<string, unknown>;
  expiresTurn: number;
}

/** GET /api/scenes/:id/offers — активные предложения сцены (для ручного ответа). */
export async function GET(_req: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    const sid = parseId(id);
    if (!getScene(sid)) throw new ApiError(404, "Сцена не найдена");
    const titleByTool = new Map(listTools().map((t) => [t.name, t.title || t.name]));
    const nameOf = (cid: number) => getCharacter(cid);
    const offers: OfferView[] = listPendingOffersForScene(sid).map((o) => {
      const from = nameOf(o.fromId);
      const to = nameOf(o.toId);
      return {
        id: o.id,
        toolName: o.toolName,
        toolTitle: titleByTool.get(o.toolName) ?? o.toolName,
        fromId: o.fromId,
        fromName: from?.name ?? `#${o.fromId}`,
        fromEmoji: from?.emoji ?? "❓",
        toId: o.toId,
        toName: to?.name ?? `#${o.toId}`,
        toEmoji: to?.emoji ?? "❓",
        args: o.args,
        expiresTurn: o.expiresTurn,
      };
    });
    return NextResponse.json(offers);
  } catch (e) {
    return jsonError(e);
  }
}
