import { NextResponse } from "next/server";
import { listFlowRuns } from "@/db/queries";
import { getFlowRunner } from "@/lib/flow/runner";
import { ApiError, flowRunStartSchema, jsonError, parseBody, parseId } from "@/lib/api";

type Ctx = { params: Promise<{ id: string }> };

/** GET — прогоны флоу. */
export async function GET(_req: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    const fid = parseId(id);
    return NextResponse.json(listFlowRuns(fid));
  } catch (e) {
    return jsonError(e);
  }
}

/** POST — старт нового прогона выбранным составом. */
export async function POST(req: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    const fid = parseId(id);
    const data = await parseBody(req, flowRunStartSchema);
    const run = await getFlowRunner().start(fid, data.characterIds);
    return NextResponse.json(run, { status: 201 });
  } catch (e) {
    return jsonError(e);
  }
}
