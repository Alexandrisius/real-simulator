import { NextResponse } from "next/server";
import { createProvider, listProviders } from "@/db/queries";
import { jsonError, parseBody, providerSchema } from "@/lib/api";

export async function GET() {
  try {
    return NextResponse.json(listProviders());
  } catch (e) {
    return jsonError(e);
  }
}

export async function POST(req: Request) {
  try {
    const data = await parseBody(req, providerSchema);
    return NextResponse.json(createProvider(data), { status: 201 });
  } catch (e) {
    return jsonError(e);
  }
}
