import { NextResponse } from "next/server";
import { createSkill, listSkills, syncSkillAttribute } from "@/db/queries";
import { jsonError, parseBody, skillSchema } from "@/lib/api";

export async function GET() {
  try {
    return NextResponse.json(listSkills());
  } catch (e) {
    return jsonError(e);
  }
}

export async function POST(req: Request) {
  try {
    const data = await parseBody(req, skillSchema);
    try {
      const skill = createSkill(data);
      // Связанная скрытая характеристика создаётся/обновляется автоматически.
      syncSkillAttribute(skill);
      return NextResponse.json(skill, { status: 201 });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("UNIQUE")) throw new Error(`Навык "${data.key}" уже существует`);
      throw e;
    }
  } catch (e) {
    return jsonError(e);
  }
}
