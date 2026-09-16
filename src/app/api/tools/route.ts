import { NextResponse } from "next/server";
import { createTool, listTools } from "@/db/queries";
import { ApiError, jsonError, parseBody, toolSchema } from "@/lib/api";
import { relationEffectAllowed } from "@/lib/tools";

export async function GET() {
  try {
    return NextResponse.json(listTools());
  } catch (e) {
    return jsonError(e);
  }
}

export async function POST(req: Request) {
  try {
    const data = await parseBody(req, toolSchema);
    const relErr = relationEffectAllowed(data, data.effects, data.outcomes);
    if (relErr) throw new ApiError(400, relErr);
    try {
      return NextResponse.json(createTool(data), { status: 201 });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("UNIQUE")) throw new ApiError(409, `Инструмент "${data.name}" уже существует`);
      throw e;
    }
  } catch (e) {
    return jsonError(e);
  }
}
