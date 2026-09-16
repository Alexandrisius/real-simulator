import { NextResponse } from "next/server";
import { createPlace, listPlaces } from "@/db/queries";
import { jsonError, parseBody, placeSchema } from "@/lib/api";

export async function GET() {
  try {
    return NextResponse.json(listPlaces());
  } catch (e) {
    return jsonError(e);
  }
}

export async function POST(req: Request) {
  try {
    const data = await parseBody(req, placeSchema);
    try {
      return NextResponse.json(createPlace(data), { status: 201 });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("UNIQUE")) throw new Error(`Место «${data.name}» уже существует`);
      throw e;
    }
  } catch (e) {
    return jsonError(e);
  }
}
