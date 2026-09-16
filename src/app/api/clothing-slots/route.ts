import { NextResponse } from "next/server";
import { createClothingSlot, listClothingSlots } from "@/db/queries";
import { clothingSlotSchema, jsonError, parseBody } from "@/lib/api";

export async function GET() {
  try {
    return NextResponse.json(listClothingSlots());
  } catch (e) {
    return jsonError(e);
  }
}

export async function POST(req: Request) {
  try {
    const data = await parseBody(req, clothingSlotSchema);
    try {
      return NextResponse.json(createClothingSlot(data), { status: 201 });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("UNIQUE")) throw new Error(`Слот "${data.slot}" уже существует`);
      throw e;
    }
  } catch (e) {
    return jsonError(e);
  }
}
