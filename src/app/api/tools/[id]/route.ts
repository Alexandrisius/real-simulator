import { NextResponse } from "next/server";
import type { z } from "zod";
import type { Tool } from "@/lib/types";
import { ApiError, jsonError, parseBody, parseId, toolSchema } from "@/lib/api";
import { deleteTool, getTool, toolInUse, updateTool } from "@/db/queries";
import { relationEffectAllowed } from "@/lib/tools";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    const t = getTool(parseId(id));
    if (!t) throw new ApiError(404, "Инструмент не найден");
    return NextResponse.json(t);
  } catch (e) {
    return jsonError(e);
  }
}

export async function PATCH(req: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    const data = await parseBody(req, toolSchema.partial());
    const cur = getTool(parseId(id));
    if (!cur) throw new ApiError(404, "Инструмент не найден");
  const merged = { ...cur, ...data } as z.infer<typeof toolSchema>;
  const relErr = relationEffectAllowed(merged, merged.effects, merged.outcomes);
  if (relErr) throw new ApiError(400, relErr);
  let t: Tool | null;
  try {
    t = updateTool(parseId(id), merged);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("UNIQUE"))
      throw new ApiError(409, `Инструмент "${merged.name}" уже существует`);
    throw e;
  }
  if (!t) throw new ApiError(404, "Инструмент не найден");
  return NextResponse.json(t);
  } catch (e) {
    return jsonError(e);
  }
}

export async function DELETE(_req: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    const tid = parseId(id);
    if (toolInUse(tid))
      throw new ApiError(409, "Инструмент используется персонажами — сначала отвяжите их");
    if (!deleteTool(tid)) throw new ApiError(404, "Инструмент не найден");
    return NextResponse.json({ ok: true });
  } catch (e) {
    return jsonError(e);
  }
}
