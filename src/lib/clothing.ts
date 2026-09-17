// Одежда: слоты со слоями и местами. Ношение — плоские ключи state
// (worn_top = «Куртка»); снятое запоминается в carried_top и возвращается
// wear-ом. Физика без флагов: нельзя снять бельё поверх верхнего, нельзя
// обнажаться на улице. Обнажение слота физически верифицирует прикрытые
// им скрытые характеристики для всех присутствующих — ложь вскрывается.
// Эффекты одежды: у предмета свои (пока надет), у пустого слота — свои
// (bareEffects); применяются той же математикой, что и гардероб/магазин
// (wardrobe.applyWearEffects), одним write-ом на персонажа.

import type { Audience, Character, ClothingSlot, ToolSpec } from "./types";
import { CARRIED_PREFIX, UNDRESS_TOOL_NAME, WEAR_TOOL_NAME, WORN_PREFIX } from "./types";
import {
  findOwnedGarmentByName,
  getCharacter,
  getScene,
  listAttributes,
  listClothingSlots,
  updateCharacter,
} from "@/db/queries";
import { verifyForKeyObservers } from "./knowledge";
import { applyWearEffects, diffState, wornName } from "./wardrobe";

export { UNDRESS_TOOL_NAME, WEAR_TOOL_NAME } from "./types";

export const UNDRESS_SPEC: ToolSpec = {
  name: UNDRESS_TOOL_NAME,
  description:
    "Снять предмет одежды со слота (top / bottom / underwear — как задано в этом мире). " +
    "Снимать можно только там, где это уместно, и верхнее раньше нижнего. Снятое остаётся при тебе — вернёшь wear-ом. " +
    "Учти: у снятого предмета пропадают его эффекты, а пустой слот получает свои (голое тело — это состояние).",
  parameters: {
    type: "object",
    properties: {
      slot: { type: "string", description: "Слот одежды: top, bottom, underwear…" },
    },
    required: ["slot"],
  },
};

export const WEAR_SPEC: ToolSpec = {
  name: WEAR_TOOL_NAME,
  description:
    "Надеть обратно последнее снятое со слота (top / bottom / underwear…). " +
    "Возврат возвращает эффекты предмета и гасит эффекты пустого слота.",
  parameters: {
    type: "object",
    properties: {
      slot: { type: "string", description: "Слот одежды: top, bottom, underwear…" },
    },
    required: ["slot"],
  },
};

export interface ClothingActionResult {
  ok: boolean;
  result: string;
  observation: string;
  audience: Audience;
  stateChanges: { characterId: number; key: string; value: unknown }[];
}

function fail(result: string): ClothingActionResult {
  return { ok: false, result, observation: "", audience: "none", stateChanges: [] };
}

function wornItem(c: Character, slot: string): string | null {
  const v = c.state[WORN_PREFIX + slot];
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

/** Снятие: место -> порядок слоёв -> эффекты одежды -> верификация скрытого. */
export function executeUndress(input: {
  sceneId: number;
  turn: number;
  actor: Character;
  participants: Character[];
  args: Record<string, unknown>;
}): ClothingActionResult {
  const { actor, args } = input;
  const slots = listClothingSlots();
  if (slots.length === 0) return fail("В этом мире одежда не моделируется.");

  const slotName = String(args.slot ?? "").trim().toLowerCase();
  const slot = slots.find((s) => s.slot.toLowerCase() === slotName);
  if (!slot) {
    return fail(`Неизвестный слот «${slotName}». Доступны: ${slots.map((s) => s.slot).join(", ")}.`);
  }

  // Свежий state из БД: другие тулы той же итерации уже могли менять состояние
  const fresh = getCharacter(actor.id) ?? actor;
  const current: Character = { ...actor, state: fresh.state };
  const item = wornName(fresh.state, slot.slot);
  if (!item) return fail(`На тебе ничего не надето в слоте ${slot.slot}.`);

  // Место: слот можно обнажить только там, где это уместно (пусто = где угодно).
  // Сравнение без учёта регистра — реестр мест хранит имена с заглавных.
  const place = (getScene(input.sceneId)?.config.place ?? "").trim().toLowerCase();
  const allowed = slot.undressPlaces.map((p) => p.trim().toLowerCase());
  if (allowed.length > 0 && !allowed.includes(place)) {
    return fail(
      `Здесь так не делают: обнажить ${slot.slot} можно только в ${slot.undressPlaces.join(", ")}` +
        (place ? `, а вы — «${place}»` : "")
    );
  }

  // Порядок слоёв: нижнее не снимается поверх надетого верхнего
  const outer = slots.filter(
    (s) => s.slot !== slot.slot && s.layer < slot.layer && wornItem(current, s.slot) != null
  );
  if (outer.length > 0) {
    return fail(
      `Сначала сними верхнее: мешает ${outer.map((s) => `${s.slot} (${wornItem(current, s.slot)})`).join(", ")}.`
    );
  }

  // Снятие: слот пустеет, предмет — в руках (carried). Эффекты (предмет −1,
  // пустой слот +1) сливаются в ту же запись state — один write на персонажа.
  const before = fresh.state;
  const garment = findOwnedGarmentByName(actor.id, item);
  let state: Record<string, unknown> = {
    ...before,
    [WORN_PREFIX + slot.slot]: "",
    [CARRIED_PREFIX + slot.slot]: item,
  };
  state = applyWearEffects({ ...actor, state }, garment, slot, false).state;
  updateCharacter(actor.id, { state });

  // Верификация: скрытые характеристики, которые прикрывал этот слот
  // (все прикрывающие слоты теперь пусты), проверяются для присутствующих.
  const actorAfter: Character = { ...actor, state };
  const defs = listAttributes();
  const observers = input.participants.filter((p) => p.id !== actor.id);
  const verifiedNotices: string[] = [];
  for (const def of defs) {
    if (def.visibility !== "hidden") continue;
    if (!def.coveredBy.includes(slot.slot)) continue;
    const stillCovered = def.coveredBy.some((cs) => wornItem(actorAfter, cs) != null);
    if (stillCovered) continue;
    const trueValue = actorAfter.state[def.key];
    if (trueValue === undefined || trueValue === null) continue;
    for (const o of observers) {
      verifyForKeyObservers({
        sceneId: input.sceneId,
        turn: input.turn,
        subject: actorAfter,
        observers: [o],
        key: def.key,
      });
    }
    verifiedNotices.push(`${def.label}: ${String(trueValue)}`);
  }

  const stateChanges = diffState(actor.id, before, state);
  const observation = `${actor.name} снимает: ${item}`;
  let result = `Снято: ${item} (слот ${slot.slot}). Предмет при тебе — вернёшь его инструментом ${WEAR_TOOL_NAME}.`;
  if (verifiedNotices.length > 0) {
    result += ` Присутствующие теперь видят: ${verifiedNotices.join(", ")}.`;
  }
  result += wearEffectsText(stateChanges);
  return {
    ok: true,
    result,
    observation,
    audience: "all",
    stateChanges,
  };
}

/** Хвост tool-ответа про самочувствие: только ключи эффектов, не worn/carried. */
function wearEffectsText(stateChanges: ClothingActionResult["stateChanges"]): string {
  const eff = stateChanges.filter(
    (c) => !c.key.startsWith(WORN_PREFIX) && !c.key.startsWith(CARRIED_PREFIX)
  );
  if (eff.length === 0) return "";
  return ` Самочувствие: ${eff.map((c) => `${c.key}=${JSON.stringify(c.value)}`).join(", ")}.`;
}

/** Надевание обратно: предмет из carried возвращается в слот. */
export function executeWear(input: {
  actor: Character;
  args: Record<string, unknown>;
}): ClothingActionResult {
  const { actor, args } = input;
  const slots = listClothingSlots();
  if (slots.length === 0) return fail("В этом мире одежда не моделируется.");

  const slotName = String(args.slot ?? "").trim().toLowerCase();
  const slot = slots.find((s) => s.slot.toLowerCase() === slotName);
  if (!slot) {
    return fail(`Неизвестный слот «${slotName}». Доступны: ${slots.map((s) => s.slot).join(", ")}.`);
  }
  // Свежий state из БД: другие тулы той же итерации уже могли менять состояние
  const fresh = getCharacter(actor.id) ?? actor;
  const current: Character = { ...actor, state: fresh.state };
  if (wornItem(current, slot.slot)) {
    return fail(`В слоте ${slot.slot} уже надето: ${wornItem(current, slot.slot)}.`);
  }
  const carried = current.state[CARRIED_PREFIX + slot.slot];
  if (typeof carried !== "string" || carried.trim() === "") {
    return fail(`У тебя нет снятого предмета для слота ${slot.slot}.`);
  }

  // Надевание: предмет возвращается в слот. Эффекты (предмет +1, пустой слот
  // −1) сливаются в ту же запись state — один write на персонажа.
  const before = fresh.state;
  const garment = findOwnedGarmentByName(actor.id, carried);
  let state: Record<string, unknown> = {
    ...before,
    [WORN_PREFIX + slot.slot]: carried,
    [CARRIED_PREFIX + slot.slot]: "",
  };
  state = applyWearEffects({ ...actor, state }, garment, slot, true).state;
  updateCharacter(actor.id, { state });

  const stateChanges = diffState(actor.id, before, state);
  const observation = `${actor.name} надевает: ${carried}`;
  const result = `Надето: ${carried} (слот ${slot.slot}).${wearEffectsText(stateChanges)}`;
  return {
    ok: true,
    result,
    observation,
    audience: "all",
    stateChanges,
  };
}

/** Ключи state для формы редактора: по слоту — worn и carried. */
export function clothingStateKeys(): { slot: string; wornKey: string; carriedKey: string }[] {
  return listClothingSlots().map((s: ClothingSlot) => ({
    slot: s.slot,
    wornKey: WORN_PREFIX + s.slot,
    carriedKey: CARRIED_PREFIX + s.slot,
  }));
}
