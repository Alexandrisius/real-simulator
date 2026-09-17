// Гардероб: переиспользуемая математика эффектов одежды + редакторские операции
// надевания/снятия (без сцен правил — это настройка мира, не действие в сцене).
// Одно семейство эффектов используют все пути: undress/wear в сцене
// (clothing.ts), покупка одежды (shop.ts) и гардероб-REST. Эффекты одежды
// обратимы: снятие применяет их с обратным знаком, поэтому имеет смысл только
// численный add — set-эффекты и эффекты на чужие state/relation не применяются.

import type { Character, ClothingSlot, Garment, ToolEffect } from "./types";
import { CARRIED_PREFIX, WORN_PREFIX } from "./types";
import {
  addGarmentToCharacter,
  findOwnedGarmentByName,
  getClothingSlot,
  getCharacter,
  getGarmentById,
  listAttributes,
  listCharacterGarments,
  listClothingSlots,
  updateCharacter,
} from "@/db/queries";
import { clampStateValues } from "./tools";

/** Формат изменений state для событий (как в ToolExecResult.stateChanges). */
export interface StateChange {
  characterId: number;
  key: string;
  value: unknown;
}

/**
 * Эффекты ношения: garment.effects с направлением dir (+1 надели, −1 сняли) и
 * bareEffects слота с ПРОТИВОПОЛОЖНЫМ (пустой слот действует, надетый — нет).
 * Применяются только self-эффекты с числовым значением: одежда влияет на
 * носителя, а не на отношения/химию/получателя. set при снятии пропускается —
 * обратного значения у него нет.
 *
 * ВАЖНО: клампинг по min/max реестра делает обращение приблизительным —
 * если «+1» упёрся в max 10, «−1» при снятии не вернёт исходные 9. Это
 * осознанный компромисс ради честных диапазонов характеристик.
 */
export function applyWearEffects(
  char: Character,
  garment: Garment | null,
  slot: ClothingSlot,
  wearing: boolean,
  otherSlots: ClothingSlot[] = []
): Character {
  void otherSlots; // зарезервировано: логика других надетых слотов пока не нужна
  const dir = wearing ? 1 : -1;
  const state = { ...char.state };
  const defs = listAttributes();
  const apply = (effects: ToolEffect[], d: number) => {
    for (const eff of effects) {
      if (eff.target !== "self") continue;
      const raw = typeof eff.value === "number" ? eff.value : Number(eff.value);
      if (!Number.isFinite(raw)) continue;
      if (eff.op === "set") {
        if (d > 0) state[eff.key] = eff.value; // set обратим только «вперёд»
        continue;
      }
      const cur = typeof state[eff.key] === "number" ? (state[eff.key] as number) : 0;
      state[eff.key] = cur + raw * d;
    }
  };
  if (garment) apply(garment.effects, dir);
  apply(slot.bareEffects, -dir);
  return { ...char, state: clampStateValues(state, defs) };
}

/**
 * Диф состояния «до/после» в формат stateChanges события (одежда меняет
 * числовые ключи самочувствия — их видно в транскрипте наравне с worn/carried).
 */
export function diffState(
  characterId: number,
  before: Record<string, unknown>,
  after: Record<string, unknown>
): StateChange[] {
  const out: StateChange[] = [];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const k of keys) {
    if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) {
      out.push({ characterId, key: k, value: after[k] });
    }
  }
  return out;
}

/** Что сейчас надето в слоте (строка-название или null). */
export function wornName(state: Record<string, unknown>, slot: string): string | null {
  const v = state[WORN_PREFIX + slot];
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

/**
 * Редакторское надевание (первичная одежда персонажа / гардероб-REST):
 * без проверок места и слоёв — это настройка, а не действие в сцене.
 * Если в слоте уже что-то надето, сначала «снимается» оно (его эффекты −1).
 */
export function dressCharacter(charId: number, garmentId: number): { ok: boolean; message: string } {
  const char = getCharacter(charId);
  if (!char) return { ok: false, message: "Персонаж не найден" };
  const garment = getGarmentById(garmentId);
  if (!garment) return { ok: false, message: "Предмет одежды не найден" };
  const slotName = garment.slot.trim();
  if (slotName === "") {
    return { ok: false, message: `У «${garment.name}» не задан слот — надевать не на что.` };
  }
  const slot = getClothingSlot(slotName);
  if (!slot) {
    return { ok: false, message: `Слота «${slotName}» нет в реестре слотов одежды.` };
  }
  // Надеть в редакторе = выдать в гардероб: в сцене undress найдёт предмет
  // по владельцу и корректно обратит «эффекты ношения».
  addGarmentToCharacter(charId, garmentId);
  // Свежий state из БД: несколько операций подряд не затирают записи друг друга
  const fresh = getCharacter(charId) ?? char;
  let state = { ...fresh.state };
  const prev = wornName(state, slotName);
  if (prev) {
    const prevGarment = findOwnedGarmentByName(charId, prev);
    state = applyWearEffects({ ...char, state }, prevGarment, slot, false).state;
  }
  state = applyWearEffects({ ...char, state }, garment, slot, true).state;
  state[WORN_PREFIX + slotName] = garment.name;
  state[CARRIED_PREFIX + slotName] = "";
  updateCharacter(charId, { state });
  return { ok: true, message: `Надето: ${garment.name} (слот ${slotName}).` };
}

/**
 * Редакторское снятие слота: worn → carried, эффекты предмета −1,
 * эффекты пустого слота +1. Без проверок места/слоёв (см. dressCharacter).
 */
export function undressCharacterSlot(charId: number, slot: string): { ok: boolean; message: string } {
  const char = getCharacter(charId);
  if (!char) return { ok: false, message: "Персонаж не найден" };
  const clothingSlot = getClothingSlot(slot);
  if (!clothingSlot) {
    return { ok: false, message: `Слота «${slot}» нет в реестре слотов одежды.` };
  }
  const fresh = getCharacter(charId) ?? char;
  const prev = wornName(fresh.state, slot);
  if (!prev) return { ok: false, message: `В слоте ${slot} ничего не надето.` };
  const garment = findOwnedGarmentByName(charId, prev);
  let state = { ...fresh.state };
  state = applyWearEffects({ ...char, state }, garment, clothingSlot, false).state;
  state[WORN_PREFIX + slot] = "";
  state[CARRIED_PREFIX + slot] = prev;
  updateCharacter(charId, { state });
  return { ok: true, message: `Снято: ${prev} (слот ${slot}).` };
}

// ---------- Агентские тулы гардероба (виртуальные: wardrobe_browse / wear_garment) ----------

/** Краткая сводка эффектов предмета для текста тула. */
function garmentEffectSummary(garment: Garment): string {
  const parts = garment.effects
    .filter((e) => e.target === "self")
    .map((e) => `${e.key} ${e.op === "add" ? (Number(e.value) >= 0 ? "+" : "") + e.value : "=" + e.value}`);
  return parts.length > 0 ? parts.join(", ") : "без эффектов";
}

/** Витрина личного гардероба для агента: что надето, что в шкафу, эффекты предметов. */
export function wardrobeTextFor(char: Character): string {
  const owned = listCharacterGarments(char.id);
  const slots = listClothingSlots();
  const lines: string[] = [`Твой гардероб (${owned.length} предм.):`];
  for (const s of slots) {
    const worn = wornName(char.state, s.slot);
    const inCloset = owned.filter((g) => g.slot === s.slot && g.name !== worn);
    lines.push(
      `— ${s.slot}: ${worn ? `надето «${worn}»` : "пусто"}` +
        (inCloset.length > 0
          ? `; в шкафу: ${inCloset.map((g) => `«${g.name}» (${garmentEffectSummary(g)})`).join(", ")}`
          : "")
    );
  }
  if (owned.length === 0) lines.push("(шкаф пуст — покупка одежды в магазине)");
  lines.push("Переодеться — инструмент wear_garment (предмет из шкафа).");
  return lines.join("\n");
}

/** Переодевание агентом: надеть предмет из СВОЕГО гардероба (обмен со шкафом). */
export function wearOwnedGarment(input: {
  actor: Character;
  args: Record<string, unknown>;
}): {
  ok: boolean;
  result: string;
  observation: string;
  stateChanges: StateChange[];
} {
  const { actor, args } = input;
  const owned = listCharacterGarments(actor.id);
  const fail = (result: string) => ({ ok: false, result, observation: "", stateChanges: [] });
  if (owned.length === 0) {
    return fail("Твой гардероб пуст — купить одежду можно в магазине (shop_browse/shop_buy).");
  }
  const garment = findOwnedGarmentByName(actor.id, args.garment);
  if (!garment) {
    const list = owned.map((g) => g.name).join(", ");
    return fail(`Предмета «${String(args.garment ?? "")}» нет в твоём гардеробе. Твои предметы: ${list}.`);
  }
  const worn = wornName(actor.state, garment.slot);
  if (worn === garment.name) {
    return fail(`«${garment.name}» на тебе уже надето.`);
  }
  const before = { ...actor.state };
  const res = dressCharacter(actor.id, garment.id);
  if (!res.ok) return fail(res.message);
  const after = getCharacter(actor.id);
  const stateChanges = after ? diffState(actor.id, before, after.state) : [];
  const observation = worn
    ? `${actor.name} переодевается: «${worn}» → «${garment.name}» (${garment.slot})`
    : `${actor.name} надевает «${garment.name}» (${garment.slot})`;
  return {
    ok: true,
    result: `Ты надел(а) «${garment.name}» (слот ${garment.slot}). ${res.message}${
      stateChanges.length > 0
        ? ` Самочувствие: ${stateChanges.map((c) => `${c.key}=${JSON.stringify(c.value)}`).join(", ")}.`
        : ""
    }`,
    observation,
    stateChanges,
  };
}

/** Спецификации виртуальных тулов гардероба (enum предметов подставляет движок). */
import type { ToolSpec } from "./types";
import { WARDROBE_BROWSE_TOOL_NAME, WEAR_GARMENT_TOOL_NAME } from "./types";

export const WARDROBE_BROWSE_SPEC: ToolSpec = {
  name: WARDROBE_BROWSE_TOOL_NAME,
  description:
    "Посмотреть свой гардероб: что надето, что лежит в шкафу и как одежда влияет на самочувствие. Только тебе.",
  parameters: { type: "object", properties: {} },
};

export const WEAR_GARMENT_SPEC: ToolSpec = {
  name: WEAR_GARMENT_TOOL_NAME,
  description:
    "Надеть предмет из своего шкафа (обмен с тем, что надето). Переодевание — осмысленное действие: одежда меняет самочувствие.",
  parameters: {
    type: "object",
    properties: {
      garment: { type: "string", description: "Название предмета из твоего гардероба" },
    },
    required: ["garment"],
  },
};
