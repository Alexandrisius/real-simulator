import { NextResponse } from "next/server";
import { UniqueConflictError, deletePlace, updatePlace } from "@/db/queries";
import { ApiError, jsonError, parseBody, placeSchema } from "@/lib/api";

type Ctx = { params: Promise<{ name: string }> };

export async function PATCH(req: Request, { params }: Ctx) {
  try {
    const { name } = await params;
    const data = await parseBody(req, placeSchema);
    let place;
    try {
      // Каскад переименования (сцены/слоты/границы/исходы) внутри queries;
      // коллизия с существующим именем — 409, ничего не меняется.
      place = updatePlace(decodeURIComponent(name), data);
    } catch (e) {
      if (e instanceof UniqueConflictError) throw new ApiError(409, e.message);
      throw e;
    }
    if (!place) throw new ApiError(404, "Место не найдено");
    return NextResponse.json(place);
  } catch (e) {
    return jsonError(e);
  }
}

export async function DELETE(_req: Request, { params }: Ctx) {
  try {
    const { name } = await params;
    if (!deletePlace(decodeURIComponent(name))) throw new ApiError(404, "Место не найдено");
    return NextResponse.json({ ok: true });
  } catch (e) {
    return jsonError(e);
  }
}
