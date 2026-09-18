import { NextResponse } from "next/server";
import {
  findOwnedGarmentByName,
  getCharacter,
  getGarmentById,
  listCharacterGarments,
  listClothingSlots,
  recordWardrobeEdit,
} from "@/db/queries";
import { ApiError, jsonError, parseBody, parseId, wardrobeActionSchema } from "@/lib/api";
import { dressCharacter, undressCharacterSlot, wornName } from "@/lib/wardrobe";

type Ctx = { params: Promise<{ id: string }> };

/** Вид гардероба: что лежит в гардеробе и что надето по слотам. */
function wardrobeView(charId: number) {
  const char = getCharacter(charId);
  if (!char) throw new ApiError(404, "Персонаж не найден");
  const owned = listCharacterGarments(charId);
  const slots = listClothingSlots().map((s) => {
    const worn = wornName(char.state, s.slot);
    return {
      slot: s.slot,
      worn,
      garmentId: worn ? (findOwnedGarmentByName(charId, worn)?.id ?? null) : null,
    };
  });
  return { owned, slots };
}

export async function GET(_req: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    return NextResponse.json(wardrobeView(parseId(id)));
  } catch (e) {
    return jsonError(e);
  }
}

export async function POST(req: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    const charId = parseId(id);
    const charBefore = getCharacter(charId);
    if (!charBefore) throw new ApiError(404, "Персонаж не найден");
    const data = await parseBody(req, wardrobeActionSchema);
    if (data.action === "wear") {
      const r = dressCharacter(charId, data.garmentId);
      if (!r.ok) throw new ApiError(400, r.message);
    } else {
      const garment = getGarmentById(data.garmentId);
      if (!garment) throw new ApiError(404, "Предмет одежды не найден");
      const slot = garment.slot.trim();
      if (slot === "") throw new ApiError(400, `У «${garment.name}» не задан слот — снимать нечего.`);
      const r = undressCharacterSlot(charId, slot);
      if (!r.ok) throw new ApiError(400, r.message);
    }
    // Переодевание в редакторе — правка Архитектора: дельта state (ключи
    // слотов и эффекты) уходит в зеркало+оверлей, чтобы «Заново» сцены
    // вернул прогресс, но не конфигурацию одежды из редактора.
    const charAfter = getCharacter(charId);
    if (charAfter) recordWardrobeEdit(charId, charBefore.state, charAfter.state);
    return NextResponse.json(wardrobeView(charId));
  } catch (e) {
    return jsonError(e);
  }
}
