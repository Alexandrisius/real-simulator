// Магазин: товары — простые карточки с ценой, а не инструменты.
// Агентам дают два виртуальных тула: shop_browse (посмотреть ассортимент)
// и shop_buy (купить / подарить). Покупка списывает деньги с state.money
// и применяет эффекты товара — та же механика, что у инструментов.
// Одежда (гардероб) продаётся здесь же: покупка кладёт предмет в гардероб
// владельца и сразу надевает — эффекты ношения считаются как у undress/wear.

import type { Audience, Character, Garment, ShopProduct, ToolEffect, ToolSpec } from "./types";
import { CARRIED_PREFIX, MONEY_KEY, SHOP_BROWSE_TOOL, SHOP_BUY_TOOL, WORN_PREFIX } from "./types";
import { getDb } from "@/db";
import {
  addGarmentToCharacter,
  addRelation,
  createPendingEffect,
  decrementPendingEffect,
  findGarmentByName,
  findOwnedGarmentByName,
  findProductByName,
  getClothingSlot,
  getCharacter,
  getRelation,
  listAttributes,
  listGarments,
  listPendingEffects,
  listProducts,
  markPendingApplied,
  setRelation,
  updateCharacter,
} from "@/db/queries";
import { applyRelationDelta, clampStateValues, resolveTargetByName } from "./tools";
import { applyWearEffects, diffState, wornName } from "./wardrobe";

export { SHOP_BROWSE_TOOL, SHOP_BUY_TOOL } from "./types";

export const SHOP_BROWSE_SPEC: ToolSpec = {
  name: SHOP_BROWSE_TOOL,
  description:
    "Заглянуть в магазин: показать ассортимент с ценами и описаниями. Бесплатно. Вызови, прежде чем решать, что купить или просить.",
  parameters: { type: "object", properties: {} },
};

export const SHOP_BUY_SPEC: ToolSpec = {
  name: SHOP_BUY_TOOL,
  description:
    "Купить товар из магазина по названию (точное из shop_browse). Деньги спишутся с твоего счёта; при нехватке — отказ. " +
    "Хочешь сделать подарок другому — укажи его имя в параметре for: эффекты подарка подействуют на получателя.",
  parameters: {
    type: "object",
    properties: {
      item: { type: "string", description: "Название товара из shop_browse" },
      for: { type: "string", description: "Имя персонажа, кому подарить (необязательно)" },
    },
    required: ["item"],
  },
};

function moneyOf(c: Character): number {
  return typeof c.state[MONEY_KEY] === "number" ? (c.state[MONEY_KEY] as number) : 0;
}

/** Текст ассортимента для tool-ответа модели (shop_browse). */
export function buildCatalogText(actor: Character): string {
  const products = listProducts();
  // Продаётся только одежда с ценой: гардеробные предметы ($0) — раздача, не товар
  const garments = listGarments().filter((g) => g.price > 0);
  if (products.length === 0 && garments.length === 0) return "Магазин пуст — покупать нечего.";
  const lines: string[] = [`Ассортимент магазина (у тебя $${moneyOf(actor)}):`];
  let category = "";
  for (const p of products) {
    if (p.category && p.category !== category) {
      category = p.category;
      lines.push(`— ${category}:`);
    }
    const effects = effectSummary(p.effects);
    lines.push(
      `  ${p.emoji} ${p.name} — $${p.price}${p.description ? `. ${p.description}` : ""}${
        effects ? ` (${effects})` : ""
      }${p.delayScenes > 0 ? ` [эффект — не сразу, а через ${p.delayScenes} ${
        p.delayScenes === 1 ? "сцену" : "сцен"
      }: наступит, только если дойдёшь до неё]` : ""}`
    );
  }
  // Одежда: живёт в гардеробе владельца и надевается сразу при покупке
  if (garments.length > 0) {
    lines.push("— Одежда:");
    for (const g of garments) {
      lines.push(`  ${g.emoji} ${g.name} — $${g.price}. ${g.description} (слот: ${g.slot})`);
    }
  }
  lines.push(
    "Покупка — shop_buy с названием товара; для подарка укажи получателя в for. " +
      "Одежда попадает в гардероб и надевается сразу."
  );
  return lines.join("\n");
}

function effectSummary(effects: ToolEffect[]): string {
  const parts = effects.map(
    (e) =>
      `${
        e.target === "self"
          ? "себе"
          : e.target === "relation"
            ? "отношение получателя к дарителю"
            : "получателю"
      }: ${e.key} ${e.op === "add" ? "+" : "="} ${
        typeof e.value === "number" ? e.value : JSON.stringify(e.value)
      }`
  );
  return parts.join(", ");
}

export interface ShopBuyResult {
  ok: boolean;
  result: string;
  observation: string;
  audience: Audience;
  stateChanges: { characterId: number; key: string; value: unknown }[];
  /** Изменения отношений (для подарков с эффектом relation) */
  relationChanges: { fromId: number; toId: number; value: number }[];
}

/** Сколько подарков buyer уже сделал этому получателю в текущей сцене. */
function giftCountInScene(sceneId: number, buyerId: number, recipientName: string): number {
  const rows = getDb()
    .prepare(
      "SELECT payload FROM events WHERE scene_id = ? AND actor_id = ? AND type = 'action' ORDER BY id"
    )
    .all(sceneId, buyerId) as unknown as { payload: string }[];
  const needle = recipientName.trim().toLowerCase();
  let count = 0;
  for (const r of rows) {
    try {
      const payload = JSON.parse(r.payload) as {
        calls?: { toolName: string; ok: boolean; args?: { for?: unknown } }[];
      };
      for (const c of payload.calls ?? []) {
        if (!c.ok || c.toolName !== SHOP_BUY_TOOL) continue;
        const to = typeof c.args?.for === "string" ? c.args.for.trim().toLowerCase() : "";
        if (to && (to.includes(needle) || needle.includes(to))) count += 1;
      }
    } catch {
      // битый payload прошлых событий не должен ломать покупки
    }
  }
  return count;
}

/** Сколько подарков одному получателю за сцену выдерживает человек. */
const GIFT_LIMIT_PER_SCENE = 3;

/** Покупка одежды: деньги → гардероб → сразу надеть (эффекты ношения тем же ходом). */
function buyGarment(
  input: { actor: Character; participants: Character[]; args: Record<string, unknown> },
  garment: Garment
): ShopBuyResult {
  const { actor, participants, args } = input;

  const balance = moneyOf(actor);
  if (balance < garment.price) {
    return {
      ok: false,
      result: `Недостаточно денег: «${garment.name}» стоит $${garment.price}, а у тебя $${balance}. Заработай или выбери другое.`,
      observation: "",
      audience: "none",
      stateChanges: [],
      relationChanges: [],
    };
  }

  // Получатель подарка (необязательный) — как у товаров
  const forName = args["for"];
  let recipient: Character | null = null;
  if (typeof forName === "string" && forName.trim() !== "") {
    recipient = resolveTargetByName(participants, forName);
    if (!recipient) {
      const names = participants.map((c) => c.name).join(", ");
      return {
        ok: false,
        result: `Получатель «${forName}» не найден среди участников. Доступны: ${names}`,
        observation: "",
        audience: "none",
        stateChanges: [],
        relationChanges: [],
      };
    }
  }

  // Пресыщение подарками сознательно НЕ действует на одежду: это вещь,
  // попадающая в гардероб, а не знак внимания — лимит товаров её не гасит.

  const stateMap = new Map<number, Record<string, unknown>>();
  const stateOf = (c: Character) => {
    let s = stateMap.get(c.id);
    if (!s) {
      s = { ...(getCharacter(c.id)?.state ?? c.state) }; // свежий state: тулы одной итерации не затирают записи друг друга
      stateMap.set(c.id, s);
    }
    return s;
  };

  const self = stateOf(actor);
  self[MONEY_KEY] = moneyOf(actor) - garment.price;
  const stateChanges: ShopBuyResult["stateChanges"] = [
    { characterId: actor.id, key: MONEY_KEY, value: self[MONEY_KEY] },
  ];

  const wearer = recipient ?? actor;
  const slotName = garment.slot.trim();
  const slot = slotName !== "" ? getClothingSlot(slotName) : null;
  if (slot) {
    const wState = stateOf(wearer);
    const before = { ...wState };
    let cur: Character = { ...wearer, state: wState };
    // Если в слоте уже что-то надето — сначала «снимаем» его: эффекты снятия
    // (предмет −1, пустой слот +1), потом поверх — эффекты новой одежды (+1).
    const prevName = wornName(wState, slotName);
    if (prevName) {
      const prev = findOwnedGarmentByName(wearer.id, prevName);
      cur = applyWearEffects(cur, prev, slot, false);
    }
    cur = applyWearEffects({ ...wearer, state: cur.state }, garment, slot, true);
    cur.state[WORN_PREFIX + slotName] = garment.name;
    cur.state[CARRIED_PREFIX + slotName] = "";
    stateMap.set(wearer.id, cur.state);
    stateChanges.push(
      ...diffState(wearer.id, before, cur.state).filter((c) => c.key !== MONEY_KEY)
    );
  }

  addGarmentToCharacter(wearer.id, garment.id);

  const defs = listAttributes();
  stateMap.forEach((state, id) => updateCharacter(id, { state: clampStateValues(state, defs) }));

  const worn = slot != null;
  const observation = recipient
    ? worn
      ? `${actor.name} дарит ${recipient.name}: ${garment.emoji} ${garment.name} — и ${recipient.name} сразу это надевает`
      : `${actor.name} дарит ${recipient.name}: ${garment.emoji} ${garment.name} (в гардероб)`
    : worn
      ? `${actor.name} покупает и надевает: ${garment.emoji} ${garment.name}`
      : `${actor.name} покупает: ${garment.emoji} ${garment.name} (в гардероб)`;

  let result = `Куплено: ${garment.name} за $${garment.price}. Остаток: $${self[MONEY_KEY]}.`;
  result += worn
    ? ` ${recipient ? recipient.name : "Ты"} надел(а) это (слот ${slotName}); одежда попала в гардероб.`
    : " Одежда отправилась в гардероб" + (slotName !== "" ? ", но слот не зарегистрирован в этом мире — носить не на что." : " (предмет без слота).");
  const wearChanges = stateChanges.filter((c) => c.key !== MONEY_KEY);
  if (wearChanges.length > 0) {
    result += ` | Изменения: ${wearChanges
      .map((c) => `${c.key}=${JSON.stringify(c.value)}`)
      .join(", ")}`;
  }
  return {
    ok: true,
    result,
    observation,
    audience: "all",
    stateChanges,
    relationChanges: [],
  };
}

/** Покупка товара: проверка денег, списание, эффекты на себя/получателя. */
export function executeShopBuy(input: {
  actor: Character;
  participants: Character[];
  args: Record<string, unknown>;
  /** Сцена покупки: для лимита подарков одному получателю за сцену */
  sceneId?: number | null;
}): ShopBuyResult {
  const { actor, participants, args, sceneId } = input;

  const product = findProductByName(args.item);
  if (!product) {
    // Товара нет — пробуем гардероб: одежда продаётся в том же магазине
    // (price > 0; гардеробные предметы без цены через магазин не выдаются).
    const garment = findGarmentByName(args.item);
    if (garment && garment.price > 0) {
      return buyGarment(input, garment);
    }
    if (garment) {
      return {
        ok: false,
        result: `«${garment.name}» не продаётся — это предмет гардероба без цены.`,
        observation: "",
        audience: "none",
        stateChanges: [],
        relationChanges: [],
      };
    }
    // Список допустимых значений прямо в ошибке: агент выбирает, а не гадает.
    const available = [
      ...listProducts().map((p) => p.name),
      ...listGarments()
        .filter((g) => g.price > 0)
        .map((g) => g.name),
    ];
    return {
      ok: false,
      result: `Товара «${String(args.item ?? "")}» в магазине нет. Выбери из: ${
        available.join(", ") || "(витрина пуста)"
      }. Полное описание — ${SHOP_BROWSE_TOOL}.`,
      observation: "",
      audience: "none",
      stateChanges: [],
      relationChanges: [],
    };
  }

  const balance = moneyOf(actor);
  if (balance < product.price) {
    return {
      ok: false,
      result: `Недостаточно денег: «${product.name}» стоит $${product.price}, а у тебя $${balance}. Заработай или выбери другое.`,
      observation: "",
      audience: "none",
      stateChanges: [],
      relationChanges: [],
    };
  }

  // Получатель подарка (необязательный)
  const forName = args["for"];
  let recipient: Character | null = null;
  if (typeof forName === "string" && forName.trim() !== "") {
    recipient = resolveTargetByName(participants, forName);
    if (!recipient) {
      const names = participants.map((c) => c.name).join(", ");
      return {
        ok: false,
        result: `Получатель «${forName}» не найден среди участников. Доступны: ${names}`,
        observation: "",
        audience: "none",
        stateChanges: [],
        relationChanges: [],
      };
    }
  }

  // Пресыщение подарками: нельзя задарить отношение деньгами. Первый подарок
  // за сцену — полный эффект, каждый следующий — вдвое слабее, четвёртый —
  // вежливый отказ (деньги целы). Курсам и покупкам себе лимит не мешает.
  let giftFactor = 1;
  let giftNote = "";
  if (recipient && sceneId != null) {
    const given = giftCountInScene(sceneId, actor.id, recipient.name);
    if (given >= GIFT_LIMIT_PER_SCENE) {
      return {
        ok: false,
        result: `${recipient.name} растроган(а), но ${GIFT_LIMIT_PER_SCENE} подарков за одну сцену — это уже слишком: искренность не измеряется количеством. Подари в другой сцене или удиви чем-то другим. Деньги не потрачены.`,
        observation: "",
        audience: "none",
        stateChanges: [],
        relationChanges: [],
      };
    }
    if (given > 0) {
      giftFactor = Math.pow(0.5, given);
      giftNote = ` (подарков в этой сцене уже ${given} — эффект слабее)`;
    }
  }

  // Эффекты + списание: аккумулируем state по целям, пишем один раз на цель.
  const stateMap = new Map<number, Record<string, unknown>>();
  const stateOf = (c: Character) => {
    let s = stateMap.get(c.id);
    if (!s) {
      s = { ...(getCharacter(c.id)?.state ?? c.state) }; // свежий state: тулы одной итерации не затирают записи друг друга
      stateMap.set(c.id, s);
    }
    return s;
  };
  const applyEffects = (
    buyer: Character,
    target: Character | null,
    effects: ToolEffect[],
    factor = 1
  ): {
    stateChanges: { characterId: number; key: string; value: unknown }[];
    relationChanges: { fromId: number; toId: number; value: number }[];
    notes: string[];
  } => {
    const changes: { characterId: number; key: string; value: unknown }[] = [];
    const relationChanges: { fromId: number; toId: number; value: number }[] = [];
    const notes: string[] = [];
    for (const eff of effects) {
      // Затухание подарков: множитель бьёт только по эффектам на получателя
      const f = eff.target === "self" ? 1 : factor;
      if (eff.target === "relation") {
        if (!target || target.id === buyer.id) continue;
        const raw = typeof eff.value === "number" ? eff.value : Number(eff.value) || 0;
        const delta = eff.op === "set" ? raw : raw > 0 ? Math.floor(raw * f) : Math.ceil(raw * f);
        const next = applyRelationDelta(buyer.id, target.id, eff.op, delta);
        relationChanges.push({ fromId: target.id, toId: buyer.id, value: next });
        notes.push(`отношение ${target.name} к тебе теперь ${next}`);
        continue;
      }
      const who = eff.target === "self" ? buyer : target;
      if (!who) continue;
      const cur = stateOf(who);
      if (eff.op === "set") {
        cur[eff.key] = eff.value;
      } else {
        const curVal = typeof cur[eff.key] === "number" ? (cur[eff.key] as number) : 0;
        const raw = typeof eff.value === "number" ? eff.value : Number(eff.value) || 0;
        const delta = raw > 0 ? Math.floor(raw * f) : Math.ceil(raw * f);
        cur[eff.key] = curVal + delta;
      }
      changes.push({ characterId: who.id, key: eff.key, value: cur[eff.key] });
    }
    return { stateChanges: changes, relationChanges, notes };
  };

  const self = stateOf(actor);
  self[MONEY_KEY] = moneyOf(actor) - product.price;
  const stateChanges: ShopBuyResult["stateChanges"] = [
    { characterId: actor.id, key: MONEY_KEY, value: self[MONEY_KEY] },
  ];

  // Одежда: товар со слотом сразу надевается на владельца (получателя
  // подарка, иначе покупателя) — сверх пользовательских эффектов.
  if (product.slot.trim() !== "") {
    const wearer = recipient ?? actor;
    const wState = stateOf(wearer);
    wState[WORN_PREFIX + product.slot.trim()] = product.name;
    wState[CARRIED_PREFIX + product.slot.trim()] = "";
    stateChanges.push({
      characterId: wearer.id,
      key: WORN_PREFIX + product.slot.trim(),
      value: product.name,
    });
  }

  const observation = recipient
    ? `${actor.name} дарит ${recipient.name}: ${product.emoji} ${product.name}`
    : `${actor.name} покупает ${product.emoji} ${product.name}`;

  // Отложенный товар: деньги списываются сразу, эффект наступит через N сцен.
  if (product.delayScenes > 0) {
    const defs = listAttributes();
    stateMap.forEach((state, id) =>
      updateCharacter(id, { state: clampStateValues(state, defs) })
    );
    createPendingEffect({
      characterId: actor.id,
      recipientId: recipient?.id ?? null,
      productId: product.id,
      productName: product.name,
      effects: product.effects,
      remainingScenes: product.delayScenes,
    });
    const effectText = effectSummary(product.effects) || "эффект товара";
    return {
      ok: true,
      result: `Оплачено: ${product.name} за $${product.price} (остаток: $${self[MONEY_KEY]}). Эффект подействует не сразу, а через ${product.delayScenes} ${
        product.delayScenes === 1 ? "сцену" : "сцен"
      } — когда перейдёшь в неё в сценарии: ${effectText}. Деньги потрачены уже сейчас, эффект потеряется, если выбудешь из сценария.`,
      observation,
      audience: "all",
      stateChanges,
      relationChanges: [],
    };
  }

  const applied = applyEffects(actor, recipient, product.effects, giftFactor);
  stateChanges.push(...applied.stateChanges);
  const defs = listAttributes();
  stateMap.forEach((state, id) =>
    updateCharacter(id, { state: clampStateValues(state, defs) })
  );
  let result = `Куплено: ${product.name} за $${product.price}. Остаток: $${self[MONEY_KEY]}.${giftNote}`;
  if (product.slot.trim() !== "") {
    result += ` ${recipient ? recipient.name : "Ты"} надел(а) это (слот ${product.slot.trim()}).`;
  }
  if (applied.notes.length > 0) {
    result += ` | ${applied.notes.join("; ")}`;
  }
  if (applied.stateChanges.length > 0) {
    result += ` | Изменения: ${applied.stateChanges
      .filter((c) => !(c.key === MONEY_KEY && c.characterId === actor.id))
      .map((c) => `${c.key}=${JSON.stringify(c.value)}`)
      .join(", ")}`;
  }
  return {
    ok: true,
    result,
    observation,
    audience: "all",
    stateChanges,
    relationChanges: applied.relationChanges,
  };
}

/**
 * Ход времени для отложенных эффектов: вызывается при рассадке персонажа
 * в новую сцену сценария. Счётчик оставшихся сцен уменьшается; дошёл до нуля —
 * эффект применяется. Возвращает строки-уведомления для персонажа.
 */
export function processPendingEffects(characterId: number): string[] {
  const notices: string[] = [];
  for (const p of listPendingEffects(characterId)) {
    if (p.remainingScenes > 1) {
      decrementPendingEffect(p.id, p.remainingScenes);
      notices.push(
        `Напоминание: «${p.productName}» ещё не подействовал(а) — эффект наступит через ${
          p.remainingScenes - 1
        } ${p.remainingScenes - 1 === 1 ? "сцену" : "сцен"}.`
      );
      continue;
    }
    // remainingScenes <= 1: эффект наступает сейчас
    const buyer = getCharacter(characterId);
    const recipient = p.recipientId != null ? getCharacter(p.recipientId) : null;
    if (!buyer) {
      markPendingApplied(p.id);
      continue;
    }
    const stateMap = new Map<number, Record<string, unknown>>();
    const stateOf = (c: Character) => {
      let s = stateMap.get(c.id);
      if (!s) {
        s = { ...(getCharacter(c.id)?.state ?? c.state) }; // свежий state: тулы одной итерации не затирают записи друг друга
        stateMap.set(c.id, s);
      }
      return s;
    };
    const applied: string[] = [];
    for (const eff of p.effects) {
      const who = eff.target === "self" ? buyer : recipient;
      if (!who) continue;
      const cur = stateOf(who);
      if (eff.op === "set") {
        cur[eff.key] = eff.value;
      } else {
        const curVal = typeof cur[eff.key] === "number" ? (cur[eff.key] as number) : 0;
        const delta = typeof eff.value === "number" ? eff.value : Number(eff.value) || 0;
        cur[eff.key] = curVal + delta;
      }
      applied.push(`${who.name}: ${eff.key} → ${JSON.stringify(cur[eff.key])}`);
    }
    const defs = listAttributes();
    stateMap.forEach((state, id) =>
      updateCharacter(id, { state: clampStateValues(state, defs) })
    );
    markPendingApplied(p.id);
    notices.push(
      `Время пришло: «${p.productName}» подействовал(а)${
        applied.length > 0 ? ` — ${applied.join(", ")}` : ""
      }.`
    );
  }
  return notices;
}
