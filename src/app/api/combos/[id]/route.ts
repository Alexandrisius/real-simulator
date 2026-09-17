import { NextResponse } from "next/server";
import { deleteCombo, listCharacters, listTools, updateCombo } from "@/db/queries";
import { ApiError, jsonError, parseBody, parseId, comboSchema } from "@/lib/api";
import type { ComboStep } from "@/lib/types";

type Ctx = { params: Promise<{ id: string }> };

/** Ссылки комбо должны быть живыми: шаги — инструменты, knowers — персонажи. */
function validateComboRefs(steps: ComboStep[], knowers: number[]): void {
  const tools = listTools();
  const missing = [...new Set(steps.map((s) => s.toolName))].filter(
    (n) => !tools.some((t) => t.name === n)
  );
  if (missing.length > 0) {
    throw new ApiError(
      400,
      `Инструментов нет в реестре: ${missing.join(", ")}. Доступные инструменты: ${
        tools.map((t) => t.name).join(", ") || "пока нет ни одного"
      }`
    );
  }
  const chars = listCharacters();
  const badKnowers = [...new Set(knowers)].filter((id) => !chars.some((c) => c.id === id));
  if (badKnowers.length > 0) {
    throw new ApiError(
      400,
      `Персонажей с такими id нет: ${badKnowers.join(", ")}. Сначала создайте их в разделе «Персонажи».`
    );
  }
  const names = steps
    .flatMap((s) => [s.actorName, s.targetName])
    .filter((n): n is string => Boolean(n));
  const badNames = [...new Set(names)].filter(
    (n) => !chars.some((c) => c.name.toLowerCase() === n!.trim().toLowerCase())
  );
  if (badNames.length > 0) {
    throw new ApiError(
      400,
      `В шагах указаны незнакомые персонажи: ${badNames.join(", ")}. Имена должны совпадать с разделом «Персонажи».`
    );
  }
}

export async function PATCH(req: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    const cid = parseId(id);
    const data = await parseBody(req, comboSchema);
    validateComboRefs(data.steps, data.knowers);
    try {
      const combo = updateCombo(cid, data);
      if (!combo) throw new ApiError(404, "Комбо не найдено");
      return NextResponse.json(combo);
    } catch (e) {
      if (e instanceof ApiError) throw e;
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("UNIQUE")) {
        throw new ApiError(409, `Комбо «${data.name}» уже существует`);
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
    if (!deleteCombo(parseId(id))) throw new ApiError(404, "Комбо не найдено");
    return NextResponse.json({ ok: true });
  } catch (e) {
    return jsonError(e);
  }
}
