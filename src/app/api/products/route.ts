import { NextResponse } from "next/server";
import { createProduct, listProducts } from "@/db/queries";
import { jsonError, parseBody, productSchema } from "@/lib/api";

export async function GET() {
  try {
    return NextResponse.json(listProducts());
  } catch (e) {
    return jsonError(e);
  }
}

export async function POST(req: Request) {
  try {
    const data = await parseBody(req, productSchema);
    return NextResponse.json(createProduct(data), { status: 201 });
  } catch (e) {
    return jsonError(e);
  }
}
