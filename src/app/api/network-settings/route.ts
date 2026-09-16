import { NextResponse } from "next/server";
import { getSetting, setSetting } from "@/db/queries";
import { jsonError, parseBody } from "@/lib/api";
import { z } from "zod";

const KEY = "network.insecureTls";

/** GET — состояние корпоративного режима (отключение проверки SSL). */
export async function GET() {
  try {
    return NextResponse.json({ insecureTls: getSetting(KEY) === "1" });
  } catch (e) {
    return jsonError(e);
  }
}

const patchSchema = z.object({ insecureTls: z.boolean() });

/** PATCH — включить/выключить режим; действует на исходящие вызовы провайдеров. */
export async function PATCH(req: Request) {
  try {
    const data = await parseBody(req, patchSchema);
    setSetting(KEY, data.insecureTls ? "1" : "");
    return NextResponse.json({ ok: true, insecureTls: data.insecureTls });
  } catch (e) {
    return jsonError(e);
  }
}
