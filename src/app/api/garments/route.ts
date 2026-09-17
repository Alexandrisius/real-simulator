import { NextResponse } from "next/server";
import { createGarment, getClothingSlot, listGarments } from "@/db/queries";
import { ApiError, jsonError, parseBody, garmentSchema } from "@/lib/api";

export async function GET() {
  try {
    return NextResponse.json(listGarments());
  } catch (e) {
    return jsonError(e);
  }
}

export async function POST(req: Request) {
  try {
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
      return NextResponse.json(createGarment(data), { status: 201 });
    } catch (e) {
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
