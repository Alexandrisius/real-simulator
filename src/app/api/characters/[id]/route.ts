import { NextResponse } from "next/server";
import {
  characterInScenes,
  deleteCharacter,
  getCharacter,
  getProvider,
  mirrorStateKeysToSceneSnapshots,
  overlayEditorState,
  updateCharacter,
} from "@/db/queries";
import { ApiError, characterSchema, jsonError, parseBody, parseId } from "@/lib/api";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    const c = getCharacter(parseId(id));
    if (!c) throw new ApiError(404, "Персонаж не найден");
    return NextResponse.json(c);
  } catch (e) {
    return jsonError(e);
  }
}

export async function PATCH(req: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    const cid = parseId(id);
    const data = await parseBody(req, characterSchema.partial());
    if (data.providerId != null && !getProvider(data.providerId))
      throw new ApiError(400, "Провайдер не найден");
    if (data.fallbackProviderId != null && !getProvider(data.fallbackProviderId))
      throw new ApiError(400, "Страховочный провайдер не найден");
    if (data.isHuman === true) {
      // Человеку страховка не нужна: движок за него не вызывает модели.
      data.fallbackProviderId = null;
      data.fallbackModel = "";
    }
    // state мёржится по ключам, а не заменяется целиком: редактор мог быть
    // открыт до хода движка, и полная замена стирала бы свежие изменения
    // (деньги, одежда, эффекты). null в значении = удалить ключ.
    if (data.state) {
      const cur = getCharacter(cid);
      if (!cur) throw new ApiError(404, "Персонаж не найден");
      const merged: Record<string, unknown> = { ...cur.state };
      const edited = new Map<string, unknown | null>();
      for (const [k, v] of Object.entries(data.state)) {
        if (v === null) {
          delete merged[k];
          edited.set(k, null);
        } else {
          merged[k] = v;
          edited.set(k, v);
        }
      }
      data.state = merged;
      // Правки из редактора переживают «Заново» сцены: новые ключи попадают
      // и в снимки участий, а все правки — в оверлей, который «Заново»
      // накатывает поверх снимка (существующие значения снимка не трогаем —
      // это прогресс сцен).
      mirrorStateKeysToSceneSnapshots(cid, edited);
      overlayEditorState(cid, edited);
    }
    const c = updateCharacter(cid, data);
    if (!c) throw new ApiError(404, "Персонаж не найден");
    return NextResponse.json(c);
  } catch (e) {
    return jsonError(e);
  }
}

export async function DELETE(_req: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    const cid = parseId(id);
    const used = characterInScenes(cid);
    if (used > 0)
      throw new ApiError(409, `Персонаж участвует в сценах (${used}) — сначала удалите их или уберите его`);
    if (!deleteCharacter(cid)) throw new ApiError(404, "Персонаж не найден");
    return NextResponse.json({ ok: true });
  } catch (e) {
    return jsonError(e);
  }
}
