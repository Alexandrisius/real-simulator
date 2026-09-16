import { NextResponse } from "next/server";
import { getEngine } from "@/lib/engine/engine";
import { controlSchema, jsonError, parseBody, parseId } from "@/lib/api";

type Ctx = { params: Promise<{ id: string }> };

/** POST /api/scenes/:id/control { action: start|pause|resume|step|stop } */
export async function POST(req: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    const sid = parseId(id);
    const { action } = await parseBody(req, controlSchema);
    const result = await getEngine().control(sid, action);
    return NextResponse.json(result);
  } catch (e) {
    return jsonError(e);
  }
}
