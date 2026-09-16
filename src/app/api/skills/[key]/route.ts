import { NextResponse } from "next/server";
import { deleteSkill, syncSkillAttribute, updateSkill } from "@/db/queries";
import { ApiError, jsonError, parseBody, skillPatchSchema } from "@/lib/api";

type Ctx = { params: Promise<{ key: string }> };

export async function PATCH(req: Request, { params }: Ctx) {
  try {
    const { key } = await params;
    const data = await parseBody(req, skillPatchSchema);
    const skill = updateSkill(key, data);
    if (!skill) throw new ApiError(404, "Навык не найден");
    syncSkillAttribute(skill);
    return NextResponse.json(skill);
  } catch (e) {
    return jsonError(e);
  }
}

export async function DELETE(_req: Request, { params }: Ctx) {
  try {
    const { key } = await params;
    if (!deleteSkill(key)) throw new ApiError(404, "Навык не найден");
    return NextResponse.json({ ok: true });
  } catch (e) {
    return jsonError(e);
  }
}
