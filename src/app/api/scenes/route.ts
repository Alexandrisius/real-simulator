import { NextResponse } from "next/server";
import { createScene, listScenes } from "@/db/queries";
import { jsonError, parseBody, sceneSchema } from "@/lib/api";

export async function GET() {
  try {
    const scenes = listScenes();
    return NextResponse.json(scenes);
  } catch (e) {
    return jsonError(e);
  }
}

export async function POST(req: Request) {
  try {
    const data = await parseBody(req, sceneSchema);
    return NextResponse.json(createScene(data), { status: 201 });
  } catch (e) {
    return jsonError(e);
  }
}
