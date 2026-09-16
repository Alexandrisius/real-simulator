import { NextResponse } from "next/server";
import { chemistryMatrix, setChemistry } from "@/db/queries";
import { ApiError, chemistrySchema, jsonError, parseBody } from "@/lib/api";

/** GET — вся матрица химии (для редакторов персонажей). */
export async function GET() {
  try {
    return NextResponse.json(chemistryMatrix());
  } catch (e) {
    return jsonError(e);
  }
}

/** PATCH — задать химию пары (симметрично, кламп −3..+3). */
export async function PATCH(req: Request) {
  try {
    const data = await parseBody(req, chemistrySchema);
    if (data.aId === data.bId) throw new ApiError(400, "Химия — про пару двух разных персонажей");
    setChemistry(data.aId, data.bId, data.value);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return jsonError(e);
  }
}
