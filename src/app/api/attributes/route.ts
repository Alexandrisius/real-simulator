import { NextResponse } from "next/server";
import { createAttribute, listAttributes } from "@/db/queries";
import { jsonError, parseBody, attributeSchema } from "@/lib/api";

export async function GET() {
  try {
    return NextResponse.json(listAttributes());
  } catch (e) {
    return jsonError(e);
  }
}

export async function POST(req: Request) {
  try {
    const data = await parseBody(req, attributeSchema);
    return NextResponse.json(createAttribute(data), { status: 201 });
  } catch (e) {
    return jsonError(e);
  }
}
