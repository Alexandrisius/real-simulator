import { NextResponse } from "next/server";
import { createFlow, listFlows } from "@/db/queries";
import { validateGraph } from "@/lib/flow/runner";
import { ApiError, flowSchema, jsonError, parseBody } from "@/lib/api";

export async function GET() {
  try {
    return NextResponse.json(listFlows());
  } catch (e) {
    return jsonError(e);
  }
}

export async function POST(req: Request) {
  try {
    const data = await parseBody(req, flowSchema);
    const errors = validateGraph(data.graph ?? { nodes: [], edges: [] });
    if (errors.length > 0 && (data.graph?.nodes?.length ?? 0) > 0) {
      throw new ApiError(400, errors.join("; "));
    }
    return NextResponse.json(createFlow(data), { status: 201 });
  } catch (e) {
    return jsonError(e);
  }
}
