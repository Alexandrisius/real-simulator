import { NextResponse } from "next/server";
import { createValidationSchema, listValidationSchemas } from "@/db/queries";
import { jsonError, parseBody, validationSchemaSchema } from "@/lib/api";

export async function GET() {
  try {
    return NextResponse.json(listValidationSchemas());
  } catch (e) {
    return jsonError(e);
  }
}

export async function POST(req: Request) {
  try {
    const data = await parseBody(req, validationSchemaSchema);
    return NextResponse.json(createValidationSchema(data), { status: 201 });
  } catch (e) {
    return jsonError(e);
  }
}
