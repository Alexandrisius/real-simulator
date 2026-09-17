import { NextResponse } from "next/server";
import { createCombo, listCharacters, listCombos, listTools } from "@/db/queries";
import { ApiError, jsonError, parseBody, comboSchema } from "@/lib/api";
import type { ComboStep } from "@/lib/types";

/**
 * Ссылки комбо должны быть живыми: шаги — только существующие инструменты,
 * фильтры ролей и knowers — только существующие персонажи.
 */
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

export async function GET() {
  try {
    return NextResponse.json(listCombos());
  } catch (e) {
    return jsonError(e);
  }
}

export async function POST(req: Request) {
  try {
    const data = await parseBody(req, comboSchema);
    validateComboRefs(data.steps, data.knowers);
    try {
      return NextResponse.json(createCombo(data), { status: 201 });
    } catch (e) {
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
