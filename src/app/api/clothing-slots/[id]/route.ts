import { NextResponse } from "next/server";
import {
  deleteClothingSlot,
  getClothingSlot,
  updateClothingSlot,
} from "@/db/queries";
import { ApiError, clothingSlotSchema, jsonError, parseBody } from "@/lib/api";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    const s = getClothingSlot(id);
    if (!s) throw new ApiError(404, "Слот не найден");
    return NextResponse.json(s);
  } catch (e) {
    return jsonError(e);
  }
}

export async function PATCH(req: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    const data = await parseBody(req, clothingSlotSchema);
    const s = updateClothingSlot(id, data);
    if (!s) throw new ApiError(404, "Слот не найден");
    return NextResponse.json(s);
  } catch (e) {
    return jsonError(e);
  }
}

export async function DELETE(_req: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    if (!deleteClothingSlot(id)) throw new ApiError(404, "Слот не найден");
    return NextResponse.json({ ok: true });
  } catch (e) {
    return jsonError(e);
  }
}
