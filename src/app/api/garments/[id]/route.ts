import { NextResponse } from "next/server";
import { deleteGarment, getClothingSlot, getGarmentById, updateGarment } from "@/db/queries";
import { ApiError, jsonError, parseBody, parseId, garmentSchema } from "@/lib/api";

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(req: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    const gid = parseId(id);
    const data = await parseBody(req, garmentSchema);
    // Слот должен существовать в реестре: иначе ношение не смоделировать
    const slot = data.slot.trim();
    if (slot !== "" && !getClothingSlot(slot)) {
      throw new ApiError(
        400,
        `Слота «${slot}» нет в реестре слотов одежды. Создайте его в разделе «Характеристики» или оставьте слот пустым.`
      );
    }
    try {
      const g = updateGarment(gid, data);
      if (!g) throw new ApiError(404, "Одежда не найдена");
      return NextResponse.json(g);
    } catch (e) {
      if (e instanceof ApiError) throw e;
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("UNIQUE")) {
        throw new ApiError(409, `Одежда «${data.name}» уже существует`);
      }
      throw e;
    }
  } catch (e) {
    return jsonError(e);
  }
}

export async function DELETE(_req: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    // Записи гардероба (character_garments) исчезают каскадом по FK
    if (!deleteGarment(parseId(id))) throw new ApiError(404, "Одежда не найдена");
    return NextResponse.json({ ok: true });
  } catch (e) {
    return jsonError(e);
  }
}
