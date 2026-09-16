import { NextResponse } from "next/server";
import { getProvider } from "@/db/queries";
import { fetchProviderModels, testProvider } from "@/lib/llm";
import { ApiError, jsonError, parseId } from "@/lib/api";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/providers/:id/models?test=1 — список моделей или проверка соединения. */
export async function GET(req: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    const provider = getProvider(parseId(id));
    if (!provider) throw new ApiError(404, "Провайдер не найден");
    const url = new URL(req.url);
    if (url.searchParams.get("test")) {
      return NextResponse.json(await testProvider(provider));
    }
    const models = await fetchProviderModels(provider);
    return NextResponse.json({ models });
  } catch (e) {
    return jsonError(e);
  }
}
