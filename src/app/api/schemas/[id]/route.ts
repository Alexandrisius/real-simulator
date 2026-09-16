import { NextResponse } from "next/server";
import {
  deleteValidationSchema,
  detachSchemaEverywhere,
  getValidationSchema,
  updateValidationSchema,
} from "@/db/queries";
import { ApiError, jsonError, parseBody, parseId, validationSchemaSchema } from "@/lib/api";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    const s = getValidationSchema(parseId(id));
    if (!s) throw new ApiError(404, "Схема не найдена");
    return NextResponse.json(s);
  } catch (e) {
    return jsonError(e);
  }
}

export async function PATCH(req: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    const data = await parseBody(req, validationSchemaSchema.partial());
    const cur = getValidationSchema(parseId(id));
    if (!cur) throw new ApiError(404, "Схема не найдена");
    const s = updateValidationSchema(parseId(id), { ...cur, ...data });
    if (!s) throw new ApiError(404, "Схема не найдена");
    return NextResponse.json(s);
  } catch (e) {
    return jsonError(e);
  }
}

export async function DELETE(_req: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    const sid = parseId(id);
    detachSchemaEverywhere(sid);
    if (!deleteValidationSchema(sid)) throw new ApiError(404, "Схема не найдена");
    return NextResponse.json({ ok: true });
  } catch (e) {
    return jsonError(e);
  }
}
