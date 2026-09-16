import { NextResponse } from "next/server";
import { listSettings, setSetting } from "@/db/queries";
import { PROMPT_SECTIONS } from "@/lib/prompt";
import { jsonError, parseBody } from "@/lib/api";
import { z } from "zod";

/** GET — секции промпта: дефолты + текущие override из настроек. */
export async function GET() {
  try {
    const current = listSettings();
    return NextResponse.json({
      sections: PROMPT_SECTIONS.map((s) => ({
        key: s.key,
        title: s.title,
        hint: s.hint,
        def: s.def,
        current: current["prompt." + s.key] ?? "",
      })),
    });
  } catch (e) {
    return jsonError(e);
  }
}

const putSchema = z.object({
  sections: z.record(z.string()),
});

/** PATCH — сохранить секции: пустая строка = вернуть дефолт. */
export async function PATCH(req: Request) {
  try {
    const data = await parseBody(req, putSchema);
    const valid = new Set(PROMPT_SECTIONS.map((s) => s.key));
    for (const [key, value] of Object.entries(data.sections)) {
      if (!valid.has(key)) continue;
      setSetting("prompt." + key, typeof value === "string" ? value : null);
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    return jsonError(e);
  }
}
