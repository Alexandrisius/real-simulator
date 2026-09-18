// Типизированный слой доступа к данным. Все JSON-колонки парсятся здесь,
// остальной код работает только с объектами из lib/types.

import type {
  ApiLog,
  AttributeDef,
  Audience,
  Boundary,
  BoundaryCondition,
  Character,
  ClothingSlot,
  Combo,
  ComboStep,
  EventPayload,
  EventType,
  Flow,
  FlowGraph,
  FlowProgress,
  FlowRun,
  FlowRunStatus,
  FlowVisit,
  Garment,
  KnowledgeEntry,
  Offer,
  OfferStatus,
  PendingEffect,
  Place,
  Provider,
  ProviderKind,
  Scene,
  SceneBlock,
  SceneConfig,
  SceneStatus,
  ShopProduct,
  SimEvent,
  Skill,
  SkillUp,
  Tool,
  ToolAudience,
  ToolDraft,
  ToolEffect,
  ToolOutcome,
  ToolRequest,
  ToolRequestStatus,
  ValidationSchema,
  ValidationStep,
} from "@/lib/types";
import { DEFAULT_SCENE_CONFIG, SKILL_PREFIX } from "@/lib/types";
import type { DB } from "./index";
import { getDb } from "./index";

const now = () => new Date().toISOString();

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (raw == null || raw === "") return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

// ---------- Providers ----------

interface ProviderRow {
  id: number | bigint;
  name: string;
  kind: string;
  base_url: string;
  api_key: string;
  created_at: string;
}

function mapProvider(r: ProviderRow): Provider {
  return {
    id: Number(r.id),
    name: r.name,
    kind: r.kind as ProviderKind,
    baseUrl: r.base_url,
    apiKey: r.api_key,
    createdAt: r.created_at,
  };
}

export function listProviders(): Provider[] {
  const rows = getDb()
    .prepare("SELECT * FROM providers ORDER BY id")
    .all() as unknown as ProviderRow[];
  return rows.map(mapProvider);
}

export function getProvider(id: number): Provider | null {
  const row = getDb()
    .prepare("SELECT * FROM providers WHERE id = ?")
    .get(id) as unknown as ProviderRow | undefined;
  return row ? mapProvider(row) : null;
}

export function createProvider(data: {
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  apiKey: string;
}): Provider {
  const res = getDb()
    .prepare(
      "INSERT INTO providers (name, kind, base_url, api_key, created_at) VALUES (?, ?, ?, ?, ?)"
    )
    .run(data.name, data.kind, data.baseUrl, data.apiKey, now());
  return getProvider(Number(res.lastInsertRowid))!;
}

export function updateProvider(
  id: number,
  data: Partial<{ name: string; kind: ProviderKind; baseUrl: string; apiKey: string }>
): Provider | null {
  const cur = getProvider(id);
  if (!cur) return null;
  getDb()
    .prepare(
      "UPDATE providers SET name = ?, kind = ?, base_url = ?, api_key = ? WHERE id = ?"
    )
    .run(
      data.name ?? cur.name,
      data.kind ?? cur.kind,
      data.baseUrl ?? cur.baseUrl,
      data.apiKey ?? cur.apiKey,
      id
    );
  return getProvider(id);
}

export function deleteProvider(id: number): boolean {
  const res = getDb().prepare("DELETE FROM providers WHERE id = ?").run(id);
  return Number(res.changes) > 0;
}

export function providerInUse(id: number): boolean {
  const row = getDb()
    .prepare("SELECT COUNT(*) AS n FROM characters WHERE provider_id = ?")
    .get(id) as unknown as { n: number | bigint };
  return Number(row.n) > 0;
}

// ---------- Tools ----------

interface ToolRow {
  id: number | bigint;
  name: string;
  title: string;
  description: string;
  parameters_schema: string;
  audience: string;
  target_param: string | null;
  observation_template: string;
  effects: string;
  cost: number;
  origin: string;
  created_by: number | bigint | null;
  trains_skill: string;
  outcomes: string;
  requires_consent: number | bigint;
  decline_effects: string;
  created_at: string;
}

function mapTool(r: ToolRow): Tool {
  return {
    id: Number(r.id),
    name: r.name,
    title: r.title,
    description: r.description,
    parametersSchema: parseJson<Record<string, unknown>>(r.parameters_schema, {}),
    audience: r.audience as ToolAudience,
    targetParam: r.target_param,
    observationTemplate: r.observation_template,
    effects: parseJson<ToolEffect[]>(r.effects, []),
    cost: Number(r.cost ?? 0),
    origin: r.origin === "agent" ? "agent" : "manual",
    createdBy: r.created_by == null ? null : Number(r.created_by),
    trainsSkill: r.trains_skill ?? "",
    outcomes: parseJson<ToolOutcome[]>(r.outcomes, []),
    requiresConsent: Number(r.requires_consent ?? 0) === 1,
    declineEffects: parseJson<ToolEffect[]>(r.decline_effects ?? "[]", []),
    createdAt: r.created_at,
  };
}

export function listTools(): Tool[] {
  const rows = getDb()
    .prepare("SELECT * FROM tools ORDER BY id")
    .all() as unknown as ToolRow[];
  return rows.map(mapTool);
}

export function getTool(id: number): Tool | null {
  const row = getDb()
    .prepare("SELECT * FROM tools WHERE id = ?")
    .get(id) as unknown as ToolRow | undefined;
  return row ? mapTool(row) : null;
}

export function getToolsByIds(ids: number[]): Tool[] {
  return ids
    .map((id) => getTool(id))
    .filter((t): t is Tool => t !== null);
}

export interface ToolInput {
  name: string;
  title: string;
  description: string;
  parametersSchema: Record<string, unknown>;
  audience: ToolAudience;
  targetParam: string | null;
  observationTemplate: string;
  effects: ToolEffect[];
  cost?: number;
  origin?: "manual" | "agent";
  createdBy?: number | null;
  trainsSkill?: string;
  outcomes?: ToolOutcome[];
  /** Адресный тул требует согласия получателя (сначала предложение, потом действие) */
  requiresConsent?: boolean;
  /** Эффекты при отклонении предложения получателем */
  declineEffects?: ToolEffect[];
}

export function createTool(data: ToolInput): Tool {
  const res = getDb()
    .prepare(
      `INSERT INTO tools (name, title, description, parameters_schema, audience, target_param, observation_template, effects, cost, origin, created_by, trains_skill, outcomes, requires_consent, decline_effects, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      data.name,
      data.title,
      data.description,
      JSON.stringify(data.parametersSchema),
      data.audience,
      data.targetParam,
      data.observationTemplate,
      JSON.stringify(data.effects),
      data.cost ?? 0,
      data.origin ?? "manual",
      data.createdBy ?? null,
      data.trainsSkill ?? "",
      JSON.stringify(data.outcomes ?? []),
      data.requiresConsent ? 1 : 0,
      JSON.stringify(data.declineEffects ?? []),
      now()
    );
  return getTool(Number(res.lastInsertRowid))!;
}

export function updateTool(id: number, data: ToolInput): Tool | null {
  const res = getDb()
    .prepare(
      `UPDATE tools SET name = ?, title = ?, description = ?, parameters_schema = ?, audience = ?, target_param = ?, observation_template = ?, effects = ?, cost = ?, trains_skill = ?, outcomes = ?, requires_consent = ?, decline_effects = ? WHERE id = ?`
    )
    .run(
      data.name,
      data.title,
      data.description,
      JSON.stringify(data.parametersSchema),
      data.audience,
      data.targetParam,
      data.observationTemplate,
      JSON.stringify(data.effects),
      data.cost ?? 0,
      data.trainsSkill ?? "",
      JSON.stringify(data.outcomes ?? []),
      data.requiresConsent ? 1 : 0,
      JSON.stringify(data.declineEffects ?? []),
      id
    );
  return Number(res.changes) > 0 ? getTool(id) : null;
}

export function getToolByName(name: string): Tool | null {
  const row = getDb()
    .prepare("SELECT * FROM tools WHERE name = ?")
    .get(name) as unknown as ToolRow | undefined;
  return row ? mapTool(row) : null;
}

export function deleteTool(id: number): boolean {
  const res = getDb().prepare("DELETE FROM tools WHERE id = ?").run(id);
  return Number(res.changes) > 0;
}

export function toolInUse(id: number): boolean {
  const rows = getDb()
    .prepare("SELECT tool_ids FROM characters")
    .all() as { tool_ids: string }[];
  return rows.some((r) =>
    parseJson<number[]>(r.tool_ids, []).includes(id)
  );
}

// ---------- Товары магазина ----------

interface ProductRow {
  id: number | bigint;
  name: string;
  emoji: string;
  description: string;
  category: string;
  price: number;
  effects: string;
  delay_scenes: number | bigint;
  slot: string;
  created_at: string;
}

function mapProduct(r: ProductRow): ShopProduct {
  return {
    id: Number(r.id),
    name: r.name,
    emoji: r.emoji,
    description: r.description,
    category: r.category,
    price: Number(r.price ?? 0),
    effects: parseJson<ToolEffect[]>(r.effects, []),
    delayScenes: Number(r.delay_scenes ?? 0),
    slot: r.slot ?? "",
    createdAt: r.created_at,
  };
}

export function listProducts(): ShopProduct[] {
  const rows = getDb()
    .prepare("SELECT * FROM products ORDER BY category, price, id")
    .all() as unknown as ProductRow[];
  return rows.map(mapProduct);
}

export function getProduct(id: number): ShopProduct | null {
  const row = getDb()
    .prepare("SELECT * FROM products WHERE id = ?")
    .get(id) as unknown as ProductRow | undefined;
  return row ? mapProduct(row) : null;
}

/** Поиск товара по названию: точное совпадение, потом вхождение. */
export function findProductByName(name: unknown): ShopProduct | null {
  if (typeof name !== "string" || !name.trim()) return null;
  const needle = name.trim().toLowerCase();
  const all = listProducts();
  return (
    all.find((p) => p.name.toLowerCase() === needle) ??
    all.find((p) => p.name.toLowerCase().includes(needle)) ??
    all.find((p) => needle.includes(p.name.toLowerCase())) ??
    null
  );
}

export function createProduct(data: {
  name: string;
  emoji: string;
  description: string;
  category: string;
  price: number;
  effects: ToolEffect[];
  delayScenes?: number;
  slot?: string;
}): ShopProduct {
  const res = getDb()
    .prepare(
      `INSERT INTO products (name, emoji, description, category, price, effects, delay_scenes, slot, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      data.name,
      data.emoji,
      data.description,
      data.category,
      data.price,
      JSON.stringify(data.effects),
      data.delayScenes ?? 0,
      data.slot ?? "",
      now()
    );
  return getProduct(Number(res.lastInsertRowid))!;
}

export function updateProduct(
  id: number,
  data: {
    name: string;
    emoji: string;
    description: string;
    category: string;
    price: number;
    effects: ToolEffect[];
    delayScenes?: number;
    slot?: string;
  }
): ShopProduct | null {
  const res = getDb()
    .prepare(
      `UPDATE products SET name = ?, emoji = ?, description = ?, category = ?, price = ?, effects = ?, delay_scenes = ?, slot = ? WHERE id = ?`
    )
    .run(
      data.name,
      data.emoji,
      data.description,
      data.category,
      data.price,
      JSON.stringify(data.effects),
      data.delayScenes ?? 0,
      data.slot ?? "",
      id
    );
  return Number(res.changes) > 0 ? getProduct(id) : null;
}

export function deleteProduct(id: number): boolean {
  const res = getDb().prepare("DELETE FROM products WHERE id = ?").run(id);
  return Number(res.changes) > 0;
}

// ---------- Отложенные эффекты товаров ----------

interface PendingRow {
  id: number | bigint;
  character_id: number | bigint;
  recipient_id: number | bigint | null;
  product_id: number | bigint;
  product_name: string;
  effects: string;
  remaining_scenes: number | bigint;
  created_at: string;
  applied_at: string | null;
}

function mapPending(r: PendingRow): PendingEffect {
  return {
    id: Number(r.id),
    characterId: Number(r.character_id),
    recipientId: r.recipient_id == null ? null : Number(r.recipient_id),
    productId: Number(r.product_id),
    productName: r.product_name,
    effects: parseJson<ToolEffect[]>(r.effects, []),
    remainingScenes: Number(r.remaining_scenes),
    createdAt: r.created_at,
    appliedAt: r.applied_at,
  };
}

/** Ещё не наступившие отложенные эффекты персонажа. */
export function listPendingEffects(characterId: number): PendingEffect[] {
  const rows = getDb()
    .prepare(
      "SELECT * FROM pending_effects WHERE character_id = ? AND applied_at IS NULL ORDER BY id"
    )
    .all(characterId) as unknown as PendingRow[];
  return rows.map(mapPending);
}

export function createPendingEffect(data: {
  characterId: number;
  recipientId: number | null;
  productId: number;
  productName: string;
  effects: ToolEffect[];
  remainingScenes: number;
}): void {
  getDb()
    .prepare(
      `INSERT INTO pending_effects (character_id, recipient_id, product_id, product_name, effects, remaining_scenes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      data.characterId,
      data.recipientId,
      data.productId,
      data.productName,
      JSON.stringify(data.effects),
      data.remainingScenes,
      now()
    );
}

/** Уменьшить счётчик оставшихся сцен; возвращает строку с новым значением или null. */
export function decrementPendingEffect(id: number, remaining: number): void {
  getDb()
    .prepare("UPDATE pending_effects SET remaining_scenes = ? WHERE id = ?")
    .run(Math.max(0, remaining - 1), id);
}

export function markPendingApplied(id: number): void {
  getDb()
    .prepare("UPDATE pending_effects SET applied_at = ? WHERE id = ?")
    .run(now(), id);
}

// ---------- Реестр характеристик ----------

interface AttributeRow {
  id: number | bigint;
  key: string;
  label: string;
  emoji: string;
  type: string;
  unit: string;
  min: number | null;
  max: number | null;
  options: string;
  position: number | bigint;
  visibility: string;
  lie_penalty: number;
  covered_by: string;
  created_at: string;
}

function mapAttribute(r: AttributeRow): AttributeDef {
  return {
    id: Number(r.id),
    key: r.key,
    label: r.label,
    emoji: r.emoji,
    type: r.type === "select" ? "select" : r.type === "text" ? "text" : "number",
    unit: r.unit,
    min: r.min == null ? null : Number(r.min),
    max: r.max == null ? null : Number(r.max),
    options: parseJson<string[]>(r.options, []),
    position: Number(r.position),
    visibility: r.visibility === "hidden" ? "hidden" : "public",
    liePenalty: Number(r.lie_penalty ?? 2),
    coveredBy: parseJson<string[]>(r.covered_by, []),
    createdAt: r.created_at,
  };
}

export function listAttributes(): AttributeDef[] {
  const rows = getDb()
    .prepare("SELECT * FROM attributes ORDER BY position, id")
    .all() as unknown as AttributeRow[];
  return rows.map(mapAttribute);
}

export function getAttribute(id: number): AttributeDef | null {
  const row = getDb()
    .prepare("SELECT * FROM attributes WHERE id = ?")
    .get(id) as unknown as AttributeRow | undefined;
  return row ? mapAttribute(row) : null;
}

export interface AttributeInput {
  key: string;
  label: string;
  emoji: string;
  type: "number" | "select" | "text";
  unit: string;
  min: number | null;
  max: number | null;
  options: string[];
  position: number;
  visibility: "public" | "hidden";
  liePenalty: number;
  coveredBy: string[];
}

export function createAttribute(data: AttributeInput): AttributeDef {
  const res = getDb()
    .prepare(
      `INSERT INTO attributes (key, label, emoji, type, unit, min, max, options, position, visibility, lie_penalty, covered_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      data.key,
      data.label,
      data.emoji,
      data.type,
      data.unit,
      data.min,
      data.max,
      JSON.stringify(data.options),
      data.position,
      data.visibility,
      data.liePenalty,
      JSON.stringify(data.coveredBy),
      now()
    );
  return getAttribute(Number(res.lastInsertRowid))!;
}

export function updateAttribute(id: number, data: AttributeInput): AttributeDef | null {
  const res = getDb()
    .prepare(
      `UPDATE attributes SET key = ?, label = ?, emoji = ?, type = ?, unit = ?, min = ?, max = ?, options = ?, position = ?, visibility = ?, lie_penalty = ?, covered_by = ? WHERE id = ?`
    )
    .run(
      data.key,
      data.label,
      data.emoji,
      data.type,
      data.unit,
      data.min,
      data.max,
      JSON.stringify(data.options),
      data.position,
      data.visibility,
      data.liePenalty,
      JSON.stringify(data.coveredBy),
      id
    );
  return Number(res.changes) > 0 ? getAttribute(id) : null;
}

export function deleteAttribute(id: number): boolean {
  const res = getDb().prepare("DELETE FROM attributes WHERE id = ?").run(id);
  return Number(res.changes) > 0;
}

// ---------- Отношения (матрица «X расположен к Y») ----------

export function getRelation(fromId: number, toId: number): number {
  const row = getDb()
    .prepare("SELECT value FROM relations WHERE from_id = ? AND to_id = ?")
    .get(fromId, toId) as unknown as { value: number } | undefined;
  return row ? Number(row.value) : 0;
}

export function setRelation(fromId: number, toId: number, value: number): void {
  getDb()
    .prepare(
      `INSERT INTO relations (from_id, to_id, value) VALUES (?, ?, ?)
       ON CONFLICT(from_id, to_id) DO UPDATE SET value = excluded.value`
    )
    .run(fromId, toId, value);
}

export function addRelation(fromId: number, toId: number, delta: number): number {
  const next = getRelation(fromId, toId) + delta;
  setRelation(fromId, toId, next);
  return next;
}

/** Отношения персонажа к другим (только ненулевые записи). */
export function listRelationsOf(characterId: number): { toId: number; value: number }[] {
  const rows = getDb()
    .prepare("SELECT to_id, value FROM relations WHERE from_id = ? ORDER BY to_id")
    .all(characterId) as unknown as { to_id: number | bigint; value: number }[];
  return rows.map((r) => ({ toId: Number(r.to_id), value: Number(r.value) }));
}

/** Вся матрица отношений (для отчётов). */
export function relationsMatrix(): { fromId: number; toId: number; value: number }[] {
  const rows = getDb()
    .prepare("SELECT from_id, to_id, value FROM relations ORDER BY from_id, to_id")
    .all() as unknown as { from_id: number | bigint; to_id: number | bigint; value: number }[];
  return rows.map((r) => ({
    fromId: Number(r.from_id),
    toId: Number(r.to_id),
    value: Number(r.value),
  }));
}

// ---------- Химия пары (симметричная матрица −3..+3) ----------

const pairKey = (x: number, y: number): [number, number] => (x < y ? [x, y] : [y, x]);

/** Химия пары: скрытый множитель «насколько им легко вместе». Дефолт 0. */
export function getChemistry(xId: number, yId: number): number {
  const [a, b] = pairKey(xId, yId);
  if (a === b) return 0;
  const row = getDb()
    .prepare("SELECT value FROM chemistry WHERE a_id = ? AND b_id = ?")
    .get(a, b) as unknown as { value: number } | undefined;
  return row ? Number(row.value) : 0;
}

export function setChemistry(xId: number, yId: number, value: number): void {
  const [a, b] = pairKey(xId, yId);
  if (a === b) return;
  const v = Math.max(-3, Math.min(3, value));
  getDb()
    .prepare(
      `INSERT INTO chemistry (a_id, b_id, value) VALUES (?, ?, ?)
       ON CONFLICT(a_id, b_id) DO UPDATE SET value = excluded.value`
    )
    .run(a, b, v);
}

/** Химия ±дельта (кламп −3..+3); возвращает новое значение. */
export function addChemistry(xId: number, yId: number, delta: number): number {
  const next = Math.max(-3, Math.min(3, getChemistry(xId, yId) + delta));
  setChemistry(xId, yId, next);
  return next;
}

/** Вся матрица химии (для UI и отчётов). */
export function chemistryMatrix(): { aId: number; bId: number; value: number }[] {
  const rows = getDb()
    .prepare("SELECT a_id, b_id, value FROM chemistry ORDER BY a_id, b_id")
    .all() as unknown as { a_id: number | bigint; b_id: number | bigint; value: number }[];
  return rows.map((r) => ({
    aId: Number(r.a_id),
    bId: Number(r.b_id),
    value: Number(r.value),
  }));
}

// ---------- Знания: картина мира наблюдателя ----------

interface KnowledgeRow {
  observer_id: number | bigint;
  subject_id: number | bigint;
  key: string;
  status: string;
  value: string;
  updated_at: string;
}

function mapKnowledge(r: KnowledgeRow): KnowledgeEntry {
  return {
    observerId: Number(r.observer_id),
    subjectId: Number(r.subject_id),
    key: r.key,
    status: r.status === "verified" ? "verified" : "claimed",
    value: r.value,
    updatedAt: r.updated_at,
  };
}

/** Заявление субъекта, записанное в картину мира наблюдателя (может быть ложью). */
export function upsertClaim(data: {
  observerId: number;
  subjectId: number;
  key: string;
  value: string | number;
}): void {
  getDb()
    .prepare(
      `INSERT INTO knowledge (observer_id, subject_id, key, status, value, updated_at)
       VALUES (?, ?, ?, 'claimed', ?, ?)
       ON CONFLICT(observer_id, subject_id, key) DO UPDATE SET
         status = 'claimed', value = excluded.value, updated_at = excluded.updated_at`
    )
    .run(data.observerId, data.subjectId, data.key, String(data.value), now());
}

/**
 * Личная проверка наблюдателем характеристики субъекта: запись становится
 * verified с истинным значением. Возвращает прошлое заявление, если оно
 * расходилось с истиной (основание для разоблачения лжи).
 */
export function verifyKnowledge(data: {
  observerId: number;
  subjectId: number;
  key: string;
  trueValue: string | number;
}): { exposed: boolean; claimedValue: string | null } {
  const db = getDb();
  const prev = db
    .prepare("SELECT * FROM knowledge WHERE observer_id = ? AND subject_id = ? AND key = ?")
    .get(data.observerId, data.subjectId, data.key) as unknown as KnowledgeRow | undefined;
  const exposed =
    prev != null && prev.status === "claimed" && prev.value !== String(data.trueValue);
  db.prepare(
    `INSERT INTO knowledge (observer_id, subject_id, key, status, value, updated_at)
     VALUES (?, ?, ?, 'verified', ?, ?)
     ON CONFLICT(observer_id, subject_id, key) DO UPDATE SET
       status = 'verified', value = excluded.value, updated_at = excluded.updated_at`
  ).run(data.observerId, data.subjectId, data.key, String(data.trueValue), now());
  return { exposed, claimedValue: prev ? prev.value : null };
}

/** Вся картина мира наблюдателя (о всех субъектах). */
export function knowledgeOf(observerId: number): KnowledgeEntry[] {
  const rows = getDb()
    .prepare("SELECT * FROM knowledge WHERE observer_id = ? ORDER BY subject_id, key")
    .all(observerId) as unknown as KnowledgeRow[];
  return rows.map(mapKnowledge);
}

/** Что наблюдатель знает о конкретном субъекте. */
export function knowledgeAbout(observerId: number, subjectId: number): KnowledgeEntry[] {
  const rows = getDb()
    .prepare("SELECT * FROM knowledge WHERE observer_id = ? AND subject_id = ? ORDER BY key")
    .all(observerId, subjectId) as unknown as KnowledgeRow[];
  return rows.map(mapKnowledge);
}

// ---------- Реестр слотов одежды ----------

interface ClothingSlotRow {
  slot: string;
  layer: number | bigint;
  undress_places: string;
  bare_effects: string;
  position: number | bigint;
  created_at: string;
}

function mapClothingSlot(r: ClothingSlotRow): ClothingSlot {
  return {
    slot: r.slot,
    layer: Number(r.layer),
    undressPlaces: parseJson<string[]>(r.undress_places, []),
    bareEffects: parseJson<ToolEffect[]>(r.bare_effects ?? "[]", []),
    position: Number(r.position),
    createdAt: r.created_at,
  };
}

export function listClothingSlots(): ClothingSlot[] {
  const rows = getDb()
    .prepare("SELECT * FROM clothing_slots ORDER BY position, slot")
    .all() as unknown as ClothingSlotRow[];
  return rows.map(mapClothingSlot);
}

export function getClothingSlot(slot: string): ClothingSlot | null {
  const row = getDb()
    .prepare("SELECT * FROM clothing_slots WHERE slot = ?")
    .get(slot) as unknown as ClothingSlotRow | undefined;
  return row ? mapClothingSlot(row) : null;
}

export interface ClothingSlotInput {
  slot: string;
  layer: number;
  undressPlaces: string[];
  /** Эффекты пустого слота: пока слот не надет — действуют на владельца */
  bareEffects?: ToolEffect[];
  position: number;
}

export function createClothingSlot(data: ClothingSlotInput): ClothingSlot {
  getDb()
    .prepare(
      `INSERT INTO clothing_slots (slot, layer, undress_places, bare_effects, position, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      data.slot,
      data.layer,
      JSON.stringify(data.undressPlaces),
      JSON.stringify(data.bareEffects ?? []),
      data.position,
      now()
    );
  return getClothingSlot(data.slot)!;
}

export function updateClothingSlot(slot: string, data: ClothingSlotInput): ClothingSlot | null {
  const res = getDb()
    .prepare(
      `UPDATE clothing_slots SET layer = ?, undress_places = ?, bare_effects = ?, position = ? WHERE slot = ?`
    )
    .run(data.layer, JSON.stringify(data.undressPlaces), JSON.stringify(data.bareEffects ?? []), data.position, slot);
  return Number(res.changes) > 0 ? getClothingSlot(slot) : null;
}

export function deleteClothingSlot(slot: string): boolean {
  const res = getDb().prepare("DELETE FROM clothing_slots WHERE slot = ?").run(slot);
  return Number(res.changes) > 0;
}

// ---------- Реестр навыков ----------

interface SkillRow {
  key: string;
  label: string;
  emoji: string;
  max_level: number | bigint;
  practice_per_level: number | bigint;
  grows: number | bigint;
  created_at: string;
}

function mapSkill(r: SkillRow): Skill {
  return {
    key: r.key,
    label: r.label,
    emoji: r.emoji,
    maxLevel: Number(r.max_level),
    practicePerLevel: Number(r.practice_per_level),
    grows: Number(r.grows) === 1,
    attributeKey: SKILL_PREFIX + r.key,
    createdAt: r.created_at,
  };
}

export function listSkills(): Skill[] {
  const rows = getDb()
    .prepare("SELECT * FROM skills ORDER BY key")
    .all() as unknown as SkillRow[];
  return rows.map(mapSkill);
}

export function getSkillByKey(key: string): Skill | null {
  const row = getDb()
    .prepare("SELECT * FROM skills WHERE key = ?")
    .get(key) as unknown as SkillRow | undefined;
  return row ? mapSkill(row) : null;
}

export interface SkillInput {
  key: string;
  label: string;
  emoji: string;
  maxLevel: number;
  practicePerLevel: number;
  grows: boolean;
}

export function createSkill(data: SkillInput): Skill {
  getDb()
    .prepare(
      `INSERT INTO skills (key, label, emoji, max_level, practice_per_level, grows, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      data.key,
      data.label,
      data.emoji,
      data.maxLevel,
      data.practicePerLevel,
      data.grows ? 1 : 0,
      now()
    );
  return getSkillByKey(data.key)!;
}

/** Ключ навыка неизменен — обновляем только настройки. */
export function updateSkill(
  key: string,
  data: Omit<SkillInput, "key">
): Skill | null {
  const res = getDb()
    .prepare(
      `UPDATE skills SET label = ?, emoji = ?, max_level = ?, practice_per_level = ?, grows = ? WHERE key = ?`
    )
    .run(data.label, data.emoji, data.maxLevel, data.practicePerLevel, data.grows ? 1 : 0, key);
  return Number(res.changes) > 0 ? getSkillByKey(key) : null;
}

/**
 * Удаление навыка целиком: счётчики практики, ссылки тулов и связанная
 * скрытая характеристика (skill_<key>) исчезают вместе с ним.
 */
export function deleteSkill(key: string): boolean {
  const db = getDb();
  const res = db.prepare("DELETE FROM skills WHERE key = ?").run(key);
  if (Number(res.changes) === 0) return false;
  db.prepare("DELETE FROM skill_practice WHERE skill_key = ?").run(key);
  db.prepare("UPDATE tools SET trains_skill = '' WHERE trains_skill = ?").run(key);
  db.prepare("DELETE FROM attributes WHERE key = ?").run(SKILL_PREFIX + key);
  return true;
}

/**
 * Синхронизация связанной характеристики навыка: создаётся автоматически
 * как скрытая (0..maxLevel), при изменении настроек обновляются ярлык и max.
 * Скрытность — инвариант: партнёры видят последствия, но не число.
 */
export function syncSkillAttribute(skill: Skill): void {
  const attrKey = skill.attributeKey;
  const existing = listAttributes().find((a) => a.key === attrKey);
  if (!existing) {
    const position = listAttributes().reduce((m, a) => Math.max(m, a.position), 0) + 10;
    createAttribute({
      key: attrKey,
      label: skill.label,
      emoji: skill.emoji,
      type: "number",
      unit: "ур.",
      min: 0,
      max: skill.maxLevel,
      options: [],
      position,
      visibility: "hidden",
      liePenalty: 1,
      coveredBy: [],
    });
    return;
  }
  updateAttribute(existing.id, {
    ...existing,
    label: skill.label,
    emoji: skill.emoji,
    max: skill.maxLevel,
    visibility: "hidden",
  });
}

// ---------- Счётчики практики навыков ----------
// Отдельная таблица, а не state: счётчик «до следующего уровня» — служебное
// знание системы, оно не должно шуметь в промптах персонажа.

export function getPracticeCount(characterId: number, skillKey: string): number {
  const row = getDb()
    .prepare("SELECT count FROM skill_practice WHERE character_id = ? AND skill_key = ?")
    .get(characterId, skillKey) as unknown as { count: number | bigint } | undefined;
  return row ? Number(row.count) : 0;
}

export function setPracticeCount(characterId: number, skillKey: string, count: number): void {
  getDb()
    .prepare(
      `INSERT INTO skill_practice (character_id, skill_key, count) VALUES (?, ?, ?)
       ON CONFLICT(character_id, skill_key) DO UPDATE SET count = excluded.count`
    )
    .run(characterId, skillKey, count);
}

// ---------- Настройки (key-value, системные промпты и прочее) ----------

export function getSetting(key: string): string | null {
  const row = getDb()
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(key) as unknown as { value: string } | undefined;
  return row ? row.value : null;
}

/** Пустая строка/undefined = сброс к дефолту (ключ удаляется). */
export function setSetting(key: string, value: string | null | undefined): void {
  if (value == null || value.trim() === "") {
    getDb().prepare("DELETE FROM settings WHERE key = ?").run(key);
    return;
  }
  getDb()
    .prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    )
    .run(key, value);
}

export function listSettings(): Record<string, string> {
  const rows = getDb()
    .prepare("SELECT key, value FROM settings ORDER BY key")
    .all() as unknown as { key: string; value: string }[];
  const out: Record<string, string> = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

// ---------- Реестр мест ----------

interface PlaceRow {
  name: string;
  description: string;
  position: number | bigint;
  created_at: string;
}

function mapPlace(r: PlaceRow): Place {
  return {
    name: r.name,
    description: r.description,
    position: Number(r.position),
    createdAt: r.created_at,
  };
}

export function listPlaces(): Place[] {
  const rows = getDb()
    .prepare("SELECT * FROM places ORDER BY position, name")
    .all() as unknown as PlaceRow[];
  return rows.map(mapPlace);
}

export function createPlace(data: { name: string; description: string; position: number }): Place {
  getDb()
    .prepare("INSERT INTO places (name, description, position, created_at) VALUES (?, ?, ?, ?)")
    .run(data.name, data.description, data.position, now());
  return listPlaces().find((p) => p.name === data.name)!;
}

/**
 * Конфликт уникальности (переименование места в уже существующее и т.п.).
 * REST-слой переводит его в 409 с русским текстом.
 */
export class UniqueConflictError extends Error {}

/**
 * Обновление места. При переименовании — каскад в ОДНОЙ транзакции по всем
 * ссылкам на старое имя (регистронезависимо): config.place у сцен,
 * undress_places у слотов, условия kind:"place" в границах персонажей,
 * условия kind:"place" в исходах тулов. Коллизия с существующим именем —
 * UniqueConflictError, ничего не меняется.
 */
export function updatePlace(
  name: string,
  data: Partial<{ name: string; description: string; position: number }>
): Place | null {
  const db = getDb();
  const cur = listPlaces().find((p) => p.name === name) ?? null;
  if (!cur) return null;
  const oldName = cur.name;
  const newName = (data.name ?? cur.name).trim();
  const description = data.description ?? cur.description;
  const position = data.position ?? cur.position;
  const renaming = newName.toLowerCase() !== oldName.toLowerCase();

  if (renaming && listPlaces().some((p) => p.name.toLowerCase() === newName.toLowerCase())) {
    throw new UniqueConflictError(`Место «${newName}» уже существует`);
  }

  const norm = (s: string) => s.trim().toLowerCase();

  db.exec("BEGIN");
  try {
    if (renaming) {
      // Сцены: config.place → newName (переписываем JSON целиком)
      const sceneRows = db
        .prepare("SELECT id, config FROM scenes")
        .all() as unknown as { id: number | bigint; config: string }[];
      const updScene = db.prepare("UPDATE scenes SET config = ? WHERE id = ?");
      for (const row of sceneRows) {
        const cfg = parseJson<Record<string, unknown>>(row.config, {});
        const place = cfg.place;
        if (typeof place !== "string" || norm(place) !== norm(oldName)) continue;
        cfg.place = newName;
        updScene.run(JSON.stringify(cfg), row.id);
      }
      // Слоты одежды: undress_places содержат старое имя
      const slotRows = db
        .prepare("SELECT slot, undress_places FROM clothing_slots")
        .all() as unknown as { slot: string; undress_places: string }[];
      const updSlot = db.prepare("UPDATE clothing_slots SET undress_places = ? WHERE slot = ?");
      for (const row of slotRows) {
        const places = parseJson<string[]>(row.undress_places, []);
        if (!places.some((p) => norm(p) === norm(oldName))) continue;
        updSlot.run(
          JSON.stringify(places.map((p) => (norm(p) === norm(oldName) ? newName : p))),
          row.slot
        );
      }
      // Границы персонажей: условия kind:"place" со значением старого имени
      const charRows = db
        .prepare("SELECT id, boundaries FROM characters WHERE boundaries != '[]'")
        .all() as unknown as { id: number | bigint; boundaries: string }[];
      const updChar = db.prepare("UPDATE characters SET boundaries = ? WHERE id = ?");
      for (const row of charRows) {
        const rules = parseJson<Boundary[]>(row.boundaries, []).map(mapBoundary);
        let dirty = false;
        for (const rule of rules) {
          for (const cond of rule.conditions ?? []) {
            if (cond.kind === "place" && norm(cond.place) === norm(oldName)) {
              cond.place = newName;
              dirty = true;
            }
          }
        }
        if (dirty) updChar.run(JSON.stringify(rules), row.id);
      }
      // Исходы тулов: условия kind:"place" со значением старого имени
      const toolRows = db
        .prepare("SELECT id, outcomes FROM tools WHERE outcomes != '[]'")
        .all() as unknown as { id: number | bigint; outcomes: string }[];
      const updTool = db.prepare("UPDATE tools SET outcomes = ? WHERE id = ?");
      for (const row of toolRows) {
        const outcomes = parseJson<ToolOutcome[]>(row.outcomes, []);
        let dirty = false;
        for (const oc of outcomes) {
          for (const cond of oc.conditions) {
            if (
              cond.kind === "place" &&
              typeof cond.value === "string" &&
              norm(cond.value) === norm(oldName)
            ) {
              cond.value = newName;
              dirty = true;
            }
          }
        }
        if (dirty) updTool.run(JSON.stringify(outcomes), row.id);
      }
    }
    db.prepare("UPDATE places SET name = ?, description = ?, position = ? WHERE name = ?").run(
      newName,
      description,
      position,
      oldName
    );
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return listPlaces().find((p) => p.name === newName) ?? null;
}

export function deletePlace(name: string): boolean {
  const res = getDb().prepare("DELETE FROM places WHERE name = ?").run(name);
  return Number(res.changes) > 0;
}

/** Поиск места по названию: точное, потом вхождение в обе стороны (нечётко). */
export function findPlaceByName(name: unknown): Place | null {
  if (typeof name !== "string" || !name.trim()) return null;
  const needle = name.trim().toLowerCase();
  const all = listPlaces();
  return (
    all.find((p) => p.name.toLowerCase() === needle) ??
    all.find((p) => p.name.toLowerCase().includes(needle) || needle.includes(p.name.toLowerCase())) ??
    null
  );
}

// ---------- Characters ----------

interface CharacterRow {
  id: number | bigint;
  name: string;
  emoji: string;
  persona: string;
  provider_id: number | bigint | null;
  model: string;
  temperature: number;
  max_tokens: number | bigint;
  tool_ids: string;
  state: string;
  is_human: number | bigint;
  income: number;
  boundaries: string;
  fallback_provider_id: number | bigint | null;
  fallback_model: string;
  created_at: string;
}

/**
 * Нормализация границы при чтении персонажа. В JSON-колонке boundaries правила
 * могут быть записаны и в новом виде (conditions), и в легаси-полях
 * (minRelation/minAttr/minMood/requirePlace/requireAttr). Всегда отдаём
 * правило с заполненным conditions: легаси-поля переписываются в условия
 * (в том же порядке: minRelation → minAttr/minMood → requirePlace → requireAttr)
 * и из результата исчезают — conditions единственный источник правды.
 * Правило с уже заданным conditions читается как есть.
 */
function mapBoundary(b: Boundary): Boundary {
  if (Array.isArray(b.conditions)) return b;  const conditions: BoundaryCondition[] = [];
  if (typeof b.minRelation === "number") {
    conditions.push({ kind: "relation", op: ">=", value: b.minRelation });
  }
  if (b.minAttr) {
    conditions.push({
      kind: "attr",
      owner: "target",
      key: b.minAttr.key,
      op: ">=",
      value: b.minAttr.value,
    });
  } else if (typeof b.minMood === "number") {
    conditions.push({ kind: "attr", owner: "target", key: "mood", op: ">=", value: b.minMood });
  }
  if (b.requirePlace) {
    conditions.push({ kind: "place", place: b.requirePlace });
  }
  if (b.requireAttr) {
    conditions.push({
      kind: "attr",
      owner: b.requireAttr.owner,
      key: b.requireAttr.key,
      op: b.requireAttr.op,
      value: b.requireAttr.value,
    });
  }
  return {
    toolName: b.toolName,
    conditions,
    refusalText: b.refusalText ?? "",
    effects: Array.isArray(b.effects) ? b.effects : [],
  };
}

function mapCharacter(r: CharacterRow): Character {
  return {
    id: Number(r.id),
    name: r.name,
    emoji: r.emoji,
    persona: r.persona,
    providerId: r.provider_id == null ? null : Number(r.provider_id),
    model: r.model,
    fallbackProviderId: r.fallback_provider_id == null ? null : Number(r.fallback_provider_id),
    fallbackModel: r.fallback_model ?? "",
    temperature: r.temperature,
    maxTokens: Number(r.max_tokens),
    toolIds: parseJson<number[]>(r.tool_ids, []),
    state: parseJson<Record<string, unknown>>(r.state, {}),
    isHuman: Number(r.is_human) === 1,
    income: Number(r.income ?? 0),
    boundaries: parseJson<Boundary[]>(r.boundaries, []).map(mapBoundary),
    createdAt: r.created_at,
  };
}

export function listCharacters(): Character[] {
  const rows = getDb()
    .prepare("SELECT * FROM characters ORDER BY id")
    .all() as unknown as CharacterRow[];
  return rows.map(mapCharacter);
}

export function getCharacter(id: number): Character | null {
  const row = getDb()
    .prepare("SELECT * FROM characters WHERE id = ?")
    .get(id) as unknown as CharacterRow | undefined;
  return row ? mapCharacter(row) : null;
}

export function createCharacter(data: {
  name: string;
  emoji: string;
  persona: string;
  providerId: number | null;
  model: string;
  temperature: number;
  maxTokens: number;
  toolIds: number[];
  state: Record<string, unknown>;
  isHuman: boolean;
  income?: number;
  boundaries?: Boundary[];
  fallbackProviderId?: number | null;
  fallbackModel?: string;
}): Character {
  const res = getDb()
    .prepare(
      `INSERT INTO characters (name, emoji, persona, provider_id, model, temperature, max_tokens, tool_ids, state, is_human, income, boundaries, fallback_provider_id, fallback_model, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      data.name,
      data.emoji,
      data.persona,
      data.providerId,
      data.model,
      data.temperature,
      data.maxTokens,
      JSON.stringify(data.toolIds),
      JSON.stringify(data.state),
      data.isHuman ? 1 : 0,
      data.income ?? 0,
      JSON.stringify(data.boundaries ?? []),
      data.fallbackProviderId ?? null,
      data.fallbackModel ?? "",
      now()
    );
  return getCharacter(Number(res.lastInsertRowid))!;
}

export function updateCharacter(
  id: number,
  data: Partial<{
    name: string;
    emoji: string;
    persona: string;
    providerId: number | null;
    model: string;
    temperature: number;
    maxTokens: number;
    toolIds: number[];
    state: Record<string, unknown>;
    isHuman: boolean;
    income: number;
    boundaries: Boundary[];
    fallbackProviderId: number | null;
    fallbackModel: string;
  }>
): Character | null {
  const cur = getCharacter(id);
  if (!cur) return null;
  getDb()
    .prepare(
      `UPDATE characters SET name = ?, emoji = ?, persona = ?, provider_id = ?, model = ?, temperature = ?, max_tokens = ?, tool_ids = ?, state = ?, is_human = ?, income = ?, boundaries = ?, fallback_provider_id = ?, fallback_model = ? WHERE id = ?`
    )
    .run(
      data.name ?? cur.name,
      data.emoji ?? cur.emoji,
      data.persona ?? cur.persona,
      "providerId" in data ? data.providerId ?? null : cur.providerId,
      data.model ?? cur.model,
      data.temperature ?? cur.temperature,
      data.maxTokens ?? cur.maxTokens,
      JSON.stringify(data.toolIds ?? cur.toolIds),
      JSON.stringify(data.state ?? cur.state),
      (data.isHuman ?? cur.isHuman) ? 1 : 0,
      data.income ?? cur.income,
      JSON.stringify(data.boundaries ?? cur.boundaries),
      "fallbackProviderId" in data ? data.fallbackProviderId ?? null : cur.fallbackProviderId,
      data.fallbackModel ?? cur.fallbackModel,
      id
    );
  return getCharacter(id);
}

export function deleteCharacter(id: number): boolean {
  const res = getDb().prepare("DELETE FROM characters WHERE id = ?").run(id);
  return Number(res.changes) > 0;
}

/**
 * Зеркало редакторских правок state в снимки участий персонажа в сценах
 * (scene_characters.initial_state — точка отката для «Заново»). Правило
 * щадящее: в снимок добавляются ТОЛЬКО ключи, которых в нём ещё нет, и
 * удаляются ключи, явно стёртые редактором (null). Значения существующих
 * ключей не трогаем — «Заново» обязано откатывать прогресс сцены.
 */
export function mirrorStateKeysToSceneSnapshots(
  characterId: number,
  keys: Map<string, unknown | null>
): void {
  if (keys.size === 0) return;
  const db = getDb();
  const rows = db
    .prepare("SELECT scene_id, initial_state FROM scene_characters WHERE character_id = ?")
    .all(characterId) as unknown as { scene_id: number; initial_state: string | null }[];
  const upd = db.prepare(
    "UPDATE scene_characters SET initial_state = ? WHERE scene_id = ? AND character_id = ?"
  );
  for (const r of rows) {
    let snapshot = r.initial_state ? (JSON.parse(r.initial_state) as Record<string, unknown>) : null;
    if (!snapshot || typeof snapshot !== "object") snapshot = {};
    let dirty = false;
    for (const [k, v] of keys) {
      if (v === null) {
        if (k in snapshot) {
          delete snapshot[k];
          dirty = true;
        }
        continue;
      }
      if (!(k in snapshot)) {
        snapshot[k] = v;
        dirty = true;
      }
    }
    if (dirty) upd.run(JSON.stringify(snapshot), r.scene_id, characterId);
  }
}

export function characterInScenes(id: number): number {
  const row = getDb()
    .prepare("SELECT COUNT(*) AS n FROM scene_characters WHERE character_id = ?")
    .get(id) as unknown as { n: number | bigint };
  return Number(row.n);
}

/**
 * Оверлей правок редактора: помнит, какие ключи state и в какие значения
 * Архитектор явно выставил у персонажа ПОСЛЕ рассадки по сценам. «Заново»
 * (resetSceneFull) восстанавливает снимок сцены, а затем накатывает оверлей —
 * так правки редактора (деньги, статичные черты) переживают откат прогресса,
 * а прогресс сцены (траты, эффекты) честно откатывается. null в оверлее —
 * ключ удалён редактором.
 */
export function overlayEditorState(
  characterId: number,
  keys: Map<string, unknown | null>
): void {
  if (keys.size === 0) return;
  const db = getDb();
  const rows = db
    .prepare("SELECT scene_id, editor_overlay FROM scene_characters WHERE character_id = ?")
    .all(characterId) as unknown as { scene_id: number; editor_overlay: string | null }[];
  const upd = db.prepare(
    "UPDATE scene_characters SET editor_overlay = ? WHERE scene_id = ? AND character_id = ?"
  );
  for (const r of rows) {
    const overlay = parseJson<Record<string, unknown | null>>(r.editor_overlay, {});
    for (const [k, v] of keys) {
      // null — редактор УДАЛИЛ ключ: помним это как null в оверлее,
      // чтобы «Заново» вычистил ключ и из снимка (а не воскресил его).
      overlay[k] = v;
    }
    upd.run(JSON.stringify(overlay), r.scene_id, characterId);
  }
}

/**
 * Дельта-правки из карточки гардероба редактора: всё, что изменилось в state
 * надеванием/снятием (ключи слотов и эффекты предметов), запоминается как
 * правки Архитектора (зеркало + оверлей). Тогда «Заново» откатывает прогресс
 * сцены, но конфигурация одежды, выставленная в редакторе, сохраняется.
 */
export function recordWardrobeEdit(
  characterId: number,
  before: Record<string, unknown>,
  after: Record<string, unknown>
): void {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const edited = new Map<string, unknown | null>();
  for (const k of keys) {
    const removed = k in before && !(k in after);
    const added = !(k in before) && k in after;
    if (removed) edited.set(k, null);
    else if (added || JSON.stringify(before[k]) !== JSON.stringify(after[k])) edited.set(k, after[k]);
  }
  if (edited.size === 0) return;
  mirrorStateKeysToSceneSnapshots(characterId, edited);
  overlayEditorState(characterId, edited);
}

// ---------- Scenes ----------

interface SceneRow {
  id: number | bigint;
  name: string;
  setting: string;
  status: string;
  config: string;
  cursor: number | bigint;
  spent_api_calls: number | bigint;
  spent_tokens: number | bigint;
  created_at: string;
}

function mapScene(r: SceneRow): Scene {
  return {
    id: Number(r.id),
    name: r.name,
    setting: r.setting,
    status: r.status as SceneStatus,
    config: { ...DEFAULT_SCENE_CONFIG, ...parseJson<Partial<SceneConfig>>(r.config, {}) },
    cursor: Number(r.cursor),
    spentApiCalls: Number(r.spent_api_calls ?? 0),
    spentTokens: Number(r.spent_tokens ?? 0),
    createdAt: r.created_at,
  };
}

export function listScenes(): Scene[] {
  const rows = getDb()
    .prepare("SELECT * FROM scenes ORDER BY id DESC")
    .all() as unknown as SceneRow[];
  return rows.map(mapScene);
}

export function getScene(id: number): Scene | null {
  const row = getDb()
    .prepare("SELECT * FROM scenes WHERE id = ?")
    .get(id) as unknown as SceneRow | undefined;
  return row ? mapScene(row) : null;
}

/** Личные цели участников сцены (по characterId). */
export function getSceneGoals(sceneId: number): Record<number, string> {
  const rows = getDb()
    .prepare("SELECT character_id, goal FROM scene_characters WHERE scene_id = ? AND goal IS NOT NULL")
    .all(sceneId) as unknown as { character_id: number | bigint; goal: string }[];
  const out: Record<number, string> = {};
  for (const r of rows) out[Number(r.character_id)] = r.goal;
  return out;
}

/** id участников, покинувших сцену через leave_scene (из ротации — навсегда). */
export function getSceneLeftIds(sceneId: number): number[] {
  const rows = getDb()
    .prepare("SELECT character_id FROM scene_characters WHERE scene_id = ? AND left_scene = 1")
    .all(sceneId) as unknown as { character_id: number | bigint }[];
  return rows.map((r) => Number(r.character_id));
}

/** Пометить участника ушедшим (leave_scene). Снимается пересбором состава/сбросом. */
export function setSceneLeftFlag(sceneId: number, characterId: number): void {
  getDb()
    .prepare("UPDATE scene_characters SET left_scene = 1 WHERE scene_id = ? AND character_id = ?")
    .run(sceneId, characterId);
}

export function createScene(data: {
  name: string;
  setting: string;
  config: Partial<SceneConfig>;
  characterIds: number[];
  schemas?: Record<string, number | null>;
  goals?: Record<string, string | null>;
}): Scene {
  const db = getDb();
  const res = db
    .prepare(
      "INSERT INTO scenes (name, setting, status, config, cursor, created_at) VALUES (?, ?, 'idle', ?, 0, ?)"
    )
    .run(
      data.name,
      data.setting,
      JSON.stringify({ ...DEFAULT_SCENE_CONFIG, ...data.config }),
      now()
    );
  const id = Number(res.lastInsertRowid);
  setSceneParticipants(id, data.characterIds, { schemas: data.schemas, goals: data.goals });
  return getScene(id)!;
}

export function updateScene(
  id: number,
  data: Partial<{
    name: string;
    setting: string;
    config: Partial<SceneConfig>;
    characterIds: number[];
    schemas: Record<string, number | null>;
    goals: Record<string, string | null>;
  }>
): Scene | null {
  const cur = getScene(id);
  if (!cur) return null;
  const db = getDb();
  db.prepare("UPDATE scenes SET name = ?, setting = ?, config = ? WHERE id = ?").run(
    data.name ?? cur.name,
    data.setting ?? cur.setting,
    JSON.stringify({ ...cur.config, ...(data.config ?? {}) }),
    id
  );
  if ((data.schemas || data.goals) && !data.characterIds) {
    // точечное обновление атрибутов участников без смены состава
    setSceneParticipants(id, [], { schemas: data.schemas, goals: data.goals });
  } else if (data.characterIds) {
    // состав меняется: сохраняем текущие атрибуты, если новые не переданы
    const existingSchemas = getSceneSchemas(id);
    const existingGoals = getSceneGoals(id);
    const opts: ParticipantPatch = {
      schemas:
        data.schemas ??
        Object.fromEntries(
          data.characterIds
            .filter((cid) => existingSchemas[cid] != null)
            .map((cid) => [String(cid), existingSchemas[cid]])
        ),
      goals:
        data.goals ??
        Object.fromEntries(
          data.characterIds
            .filter((cid) => existingGoals[cid] != null)
            .map((cid) => [String(cid), existingGoals[cid]])
        ),
    };
    setSceneParticipants(id, data.characterIds, opts);
  }
  return getScene(id);
}

export function deleteScene(id: number): boolean {
  const res = getDb().prepare("DELETE FROM scenes WHERE id = ?").run(id);
  return Number(res.changes) > 0;
}

export function setSceneStatus(id: number, status: SceneStatus): void {
  getDb().prepare("UPDATE scenes SET status = ? WHERE id = ?").run(status, id);
}

export function setSceneCursor(id: number, cursor: number): void {
  getDb().prepare("UPDATE scenes SET cursor = ? WHERE id = ?").run(cursor, id);
}

/** Накопить расход сцены: +N вызовов API, +K токенов. */
export function incrementSceneSpend(id: number, apiCalls: number, tokens: number): void {
  getDb()
    .prepare("UPDATE scenes SET spent_api_calls = spent_api_calls + ?, spent_tokens = spent_tokens + ? WHERE id = ?")
    .run(apiCalls, tokens, id);
}

/**
 * Сброс сцены к чистому листу: события удаляются, курсор/расход/статус — в ноль.
 * Состав участников, цели и схемы остаются. Живой цикл движка гасится.
 * Предложения (offers) и блокировки (scene_blocks) — часть диалога сцены,
 * стираются тоже (полный сброс resetSceneFull проходит через эту функцию).
 */
export function resetScene(id: number): void {
  getDb()
    .prepare("DELETE FROM events WHERE scene_id = ?")
    .run(id);
  deleteOffersForScene(id);
  deleteSceneBlocks(id);
  getDb()
    .prepare("UPDATE scene_characters SET left_scene = 0 WHERE scene_id = ?")
    .run(id);
  getDb()
    .prepare("UPDATE scenes SET cursor = 0, spent_api_calls = 0, spent_tokens = 0, status = 'idle' WHERE id = ?")
    .run(id);
}

/** Удалить directed-отношение (запись исчезает вовсе, а не становится нулём). */
export function deleteRelation(fromId: number, toId: number): void {
  getDb()
    .prepare("DELETE FROM relations WHERE from_id = ? AND to_id = ?")
    .run(fromId, toId);
}

/**
 * «Заново»: полный откат диалога в сцене. События стираются; отношения между
 * участниками и взаимная память (заявления, проверки) обнуляются; состояния
 * участников возвращаются к снимку на момент рассадки, поверх которого
 * накатывается оверлей правок редактора (деньги/черты, заданные после
 * рассадки, переживают откат прогресса). Если снимка ещё нет (старая сцена) —
 * текущее состояние запоминается как исходное.
 */
export function resetSceneFull(id: number): void {
  const db = getDb();
  const participants = getSceneParticipants(id);
  const rows = db
    .prepare(
      "SELECT character_id, initial_state, editor_overlay FROM scene_characters WHERE scene_id = ?"
    )
    .all(id) as unknown as {
    character_id: number | bigint;
    initial_state: string | null;
    editor_overlay: string | null;
  }[];

  const updSnapshot = db.prepare(
    "UPDATE scene_characters SET initial_state = ? WHERE scene_id = ? AND character_id = ?"
  );
  for (const r of rows) {
    const cid = Number(r.character_id);
    let snapshot = r.initial_state;
    if (!snapshot) {
      // старая сцена без снимка: текущее состояние и есть исходное
      const cur = getCharacter(cid);
      snapshot = cur ? JSON.stringify(cur.state) : null;
      updSnapshot.run(snapshot, id, cid);
    }
    const state = parseJson<Record<string, unknown>>(snapshot, {});
    // Оверлей правок редактора поверх снимка: то, что Архитектор явно
    // выставил после рассадки, «Заново» не откатывает.
    const overlay = parseJson<Record<string, unknown | null>>(r.editor_overlay, {});
    const merged = { ...state, ...overlay };
    for (const [k, v] of Object.entries(overlay)) if (v === null) delete merged[k];
    if (Object.keys(merged).length > 0) updateCharacter(cid, { state: merged });
  }

  // Отношения внутри сцены — в ноль (записи удаляются)
  const delRel = db.prepare("DELETE FROM relations WHERE from_id = ? AND to_id = ?");
  for (const a of participants) {
    for (const b of participants) {
      if (a !== b) delRel.run(a, b);
    }
  }
  // Взаимная память участников друг о друге — забыть всё
  const delKnown = db.prepare(
    "DELETE FROM knowledge WHERE observer_id = ? AND subject_id = ?"
  );
  for (const a of participants) {
    for (const b of participants) {
      if (a !== b) delKnown.run(a, b);
    }
  }

  resetScene(id);
}

export function getSceneParticipants(sceneId: number): number[] {
  const rows = getDb()
    .prepare(
      "SELECT character_id FROM scene_characters WHERE scene_id = ? ORDER BY position"
    )
    .all(sceneId) as { character_id: number | bigint }[];
  return rows.map((r) => Number(r.character_id));
}

/** Точечные атрибуты участника сцены: схема валидации и личная цель. */
export interface ParticipantPatch {
  schemas?: Record<string, number | null>;
  goals?: Record<string, string | null>;
}

export function setSceneParticipants(
  sceneId: number,
  characterIds: number[],
  opts?: ParticipantPatch
): void {
  const db = getDb();
  const del = db.prepare("DELETE FROM scene_characters WHERE scene_id = ?");
  const ins = db.prepare(
    "INSERT INTO scene_characters (scene_id, character_id, position, validation_schema_id, goal, initial_state) VALUES (?, ?, ?, ?, ?, ?)"
  );
  const updSchema = db.prepare(
    "UPDATE scene_characters SET validation_schema_id = ? WHERE scene_id = ? AND character_id = ?"
  );
  const updGoal = db.prepare(
    "UPDATE scene_characters SET goal = ? WHERE scene_id = ? AND character_id = ?"
  );
  const schemaFor = (cid: number) =>
    opts?.schemas && String(cid) in opts.schemas ? (opts.schemas[String(cid)] ?? null) : null;
  const goalFor = (cid: number) =>
    opts?.goals && String(cid) in opts.goals ? (opts.goals[String(cid)] ?? null) : null;
  // Снимок состояния на момент рассадки — исходная точка для «Заново».
  const snapshotFor = (cid: number) => {
    const c = getCharacter(cid);
    return c ? JSON.stringify(c.state) : null;
  };

  db.exec("BEGIN");
  try {
    if (characterIds.length === 0 && (opts?.schemas || opts?.goals)) {
      // точечное обновление атрибутов: состав не трогаем
      if (opts?.schemas) {
        for (const [cid, sid] of Object.entries(opts.schemas)) {
          updSchema.run(sid ?? null, sceneId, Number(cid));
        }
      }
      if (opts?.goals) {
        for (const [cid, g] of Object.entries(opts.goals)) {
          updGoal.run(g && g.trim() ? g.trim() : null, sceneId, Number(cid));
        }
      }
    } else {
      del.run(sceneId);
      characterIds.forEach((cid, i) => {
        const goal = goalFor(cid);
        ins.run(sceneId, cid, i, schemaFor(cid), goal && goal.trim() ? goal.trim() : null, snapshotFor(cid));
      });
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/** Схемы валидации не удаляются каскадом — отвязываем вручную перед удалением. */
export function detachSchemaEverywhere(schemaId: number): void {
  getDb()
    .prepare("UPDATE scene_characters SET validation_schema_id = NULL WHERE validation_schema_id = ?")
    .run(schemaId);
}

// ---------- Схемы валидации ----------

interface SchemaRow {
  id: number | bigint;
  name: string;
  description: string;
  steps: string;
  forbidden: string;
  penalty: number;
  created_at: string;
}

function mapSchema(r: SchemaRow): ValidationSchema {
  return {
    id: Number(r.id),
    name: r.name,
    description: r.description,
    steps: parseJson<ValidationStep[]>(r.steps, []),
    forbidden: parseJson<string[]>(r.forbidden, []),
    penalty: r.penalty,
    createdAt: r.created_at,
  };
}

export function listValidationSchemas(): ValidationSchema[] {
  const rows = getDb()
    .prepare("SELECT * FROM validation_schemas ORDER BY id")
    .all() as unknown as SchemaRow[];
  return rows.map(mapSchema);
}

export function getValidationSchema(id: number): ValidationSchema | null {
  const row = getDb()
    .prepare("SELECT * FROM validation_schemas WHERE id = ?")
    .get(id) as unknown as SchemaRow | undefined;
  return row ? mapSchema(row) : null;
}

export function createValidationSchema(data: {
  name: string;
  description: string;
  steps: ValidationStep[];
  forbidden: string[];
  penalty: number;
}): ValidationSchema {
  const res = getDb()
    .prepare(
      "INSERT INTO validation_schemas (name, description, steps, forbidden, penalty, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    )
    .run(
      data.name,
      data.description,
      JSON.stringify(data.steps),
      JSON.stringify(data.forbidden),
      data.penalty,
      now()
    );
  return getValidationSchema(Number(res.lastInsertRowid))!;
}

export function updateValidationSchema(
  id: number,
  data: {
    name: string;
    description: string;
    steps: ValidationStep[];
    forbidden: string[];
    penalty: number;
  }
): ValidationSchema | null {
  const res = getDb()
    .prepare(
      "UPDATE validation_schemas SET name = ?, description = ?, steps = ?, forbidden = ?, penalty = ? WHERE id = ?"
    )
    .run(
      data.name,
      data.description,
      JSON.stringify(data.steps),
      JSON.stringify(data.forbidden),
      data.penalty,
      id
    );
  return Number(res.changes) > 0 ? getValidationSchema(id) : null;
}

export function deleteValidationSchema(id: number): boolean {
  const res = getDb().prepare("DELETE FROM validation_schemas WHERE id = ?").run(id);
  return Number(res.changes) > 0;
}

/** id схем, привязанных к участникам сцены (по characterId). */
export function getSceneSchemas(sceneId: number): Record<number, number> {
  const rows = getDb()
    .prepare("SELECT character_id, validation_schema_id FROM scene_characters WHERE scene_id = ?")
    .all(sceneId) as unknown as {
    character_id: number | bigint;
    validation_schema_id: number | bigint | null;
  }[];
  const out: Record<number, number> = {};
  for (const r of rows) {
    if (r.validation_schema_id != null) out[Number(r.character_id)] = Number(r.validation_schema_id);
  }
  return out;
}

// ---------- Events ----------

interface EventRow {
  id: number | bigint;
  scene_id: number | bigint;
  turn: number | bigint;
  type: string;
  actor_id: number | bigint | null;
  audience: string;
  payload: string;
  created_at: string;
}

function mapEvent(r: EventRow): SimEvent {
  return {
    id: Number(r.id),
    sceneId: Number(r.scene_id),
    turn: Number(r.turn),
    type: r.type as EventType,
    actorId: r.actor_id == null ? null : Number(r.actor_id),
    // fail-closed: битая строка аудитории не должна рассекречивать личные события
    audience: parseJson<Audience>(r.audience, "none"),
    payload: parseJson<EventPayload>(r.payload, {}),
    createdAt: r.created_at,
  };
}

export function appendEvent(
  db: DB,
  sceneId: number,
  turn: number,
  type: EventType,
  actorId: number | null,
  audience: Audience,
  payload: EventPayload
): SimEvent {
  const ts = now();
  const res = db
    .prepare(
      "INSERT INTO events (scene_id, turn, type, actor_id, audience, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    )
    .run(sceneId, turn, type, actorId, JSON.stringify(audience), JSON.stringify(payload), ts);
  return {
    id: Number(res.lastInsertRowid),
    sceneId,
    turn,
    type,
    actorId,
    audience,
    payload,
    createdAt: ts,
  };
}

export function listSceneEvents(sceneId: number, afterId = 0): SimEvent[] {
  const rows = getDb()
    .prepare("SELECT * FROM events WHERE scene_id = ? AND id > ? ORDER BY id")
    .all(sceneId, afterId) as unknown as EventRow[];
  return rows.map(mapEvent);
}

/**
 * События, которые персонаж "видит": публичные, адресованные ему
 * или совершённые им самим (свои действия нужны для реконструкции истории).
 * Берём окно с запасом (в сцене бывает много невидимых личных событий)
 * и фильтруем ДО обрезания до лимита.
 */
export function getVisibleEvents(
  sceneId: number,
  characterId: number,
  limit: number
): SimEvent[] {
  const fetchLimit = limit * 4 + 50;
  const rows = getDb()
    .prepare("SELECT * FROM events WHERE scene_id = ? ORDER BY id DESC LIMIT ?")
    .all(sceneId, fetchLimit) as unknown as EventRow[];
  const events = rows.map(mapEvent).reverse();
  const visible = events.filter((e) => {
    if (e.actorId === characterId) return true;
    if (e.audience === "all") return true;
    if (Array.isArray(e.audience)) return e.audience.includes(characterId);
    return false;
  });
  return visible.slice(Math.max(0, visible.length - limit));
}

export function countSceneEvents(sceneId: number): number {
  const row = getDb()
    .prepare("SELECT COUNT(*) AS n FROM events WHERE scene_id = ?")
    .get(sceneId) as unknown as { n: number | bigint };
  return Number(row.n);
}

// ---------- API logs ----------

interface ApiLogRow {
  id: number | bigint;
  scene_id: number | bigint;
  character_id: number | bigint | null;
  turn: number | bigint;
  iteration: number | bigint;
  model: string | null;
  request_json: string;
  response_json: string | null;
  error: string | null;
  latency_ms: number | bigint | null;
  created_at: string;
}

function mapApiLog(r: ApiLogRow): ApiLog {
  return {
    id: Number(r.id),
    sceneId: Number(r.scene_id),
    characterId: r.character_id == null ? null : Number(r.character_id),
    turn: Number(r.turn),
    iteration: Number(r.iteration),
    model: r.model,
    requestJson: r.request_json,
    responseJson: r.response_json,
    error: r.error,
    latencyMs: r.latency_ms == null ? null : Number(r.latency_ms),
    createdAt: r.created_at,
  };
}

export function appendApiLog(
  db: DB,
  data: {
    sceneId: number;
    characterId: number;
    turn: number;
    iteration: number;
    model: string;
    requestJson: string;
    responseJson: string | null;
    error: string | null;
    latencyMs: number;
  }
): ApiLog {
  const ts = now();
  const res = db
    .prepare(
      `INSERT INTO api_logs (scene_id, character_id, turn, iteration, model, request_json, response_json, error, latency_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      data.sceneId,
      data.characterId,
      data.turn,
      data.iteration,
      data.model,
      data.requestJson,
      data.responseJson,
      data.error,
      data.latencyMs,
      ts
    );
  return {
    id: Number(res.lastInsertRowid),
    createdAt: ts,
    sceneId: data.sceneId,
    characterId: data.characterId,
    turn: data.turn,
    iteration: data.iteration,
    model: data.model,
    requestJson: data.requestJson,
    responseJson: data.responseJson,
    error: data.error,
    latencyMs: data.latencyMs,
  };
}

export function listSceneApiLogs(
  sceneId: number,
  characterId?: number,
  turn?: number
): ApiLog[] {
  let sql = "SELECT * FROM api_logs WHERE scene_id = ?";
  const params: (number | string)[] = [sceneId];
  if (characterId != null) {
    sql += " AND character_id = ?";
    params.push(characterId);
  }
  if (turn != null) {
    sql += " AND turn = ?";
    params.push(turn);
  }
  sql += " ORDER BY id";
  const rows = getDb().prepare(sql).all(...params) as unknown as ApiLogRow[];
  return rows.map(mapApiLog);
}

export function getApiLog(id: number): ApiLog | null {
  const row = getDb()
    .prepare("SELECT * FROM api_logs WHERE id = ?")
    .get(id) as unknown as ApiLogRow | undefined;
  return row ? mapApiLog(row) : null;
}

// ---------- Заявки на инструменты (агенты просят новые тулы) ----------

interface ToolRequestRow {
  id: number | bigint;
  scene_id: number | bigint;
  character_id: number | bigint;
  tool_name: string;
  draft_json: string;
  reason: string;
  status: string;
  decision_reason: string | null;
  created_at: string;
  decided_at: string | null;
}

function mapToolRequest(r: ToolRequestRow): ToolRequest {
  return {
    id: Number(r.id),
    sceneId: Number(r.scene_id),
    characterId: Number(r.character_id),
    toolName: r.tool_name,
    draft: parseJson<ToolDraft>(r.draft_json, {
      name: r.tool_name,
      title: "",
      description: "",
      parametersSchema: {},
      audience: "all",
      targetParam: null,
      observationTemplate: "",
      effects: [],
      cost: 0,
    }),
    reason: r.reason,
    status: r.status === "approved" ? "approved" : r.status === "rejected" ? "rejected" : "pending",
    decisionReason: r.decision_reason,
    createdAt: r.created_at,
    decidedAt: r.decided_at,
  };
}

export function listToolRequests(sceneId?: number, status?: ToolRequestStatus): ToolRequest[] {
  let sql = "SELECT * FROM tool_requests";
  const cond: string[] = [];
  const params: (number | string)[] = [];
  if (sceneId != null) {
    cond.push("scene_id = ?");
    params.push(sceneId);
  }
  if (status) {
    cond.push("status = ?");
    params.push(status);
  }
  if (cond.length > 0) sql += " WHERE " + cond.join(" AND ");
  sql += " ORDER BY id DESC";
  const rows = getDb().prepare(sql).all(...params) as unknown as ToolRequestRow[];
  return rows.map(mapToolRequest);
}

export function getToolRequest(id: number): ToolRequest | null {
  const row = getDb()
    .prepare("SELECT * FROM tool_requests WHERE id = ?")
    .get(id) as unknown as ToolRequestRow | undefined;
  return row ? mapToolRequest(row) : null;
}

export function hasPendingToolRequest(sceneId: number, characterId: number): boolean {
  const row = getDb()
    .prepare(
      "SELECT 1 AS x FROM tool_requests WHERE scene_id = ? AND character_id = ? AND status = 'pending' LIMIT 1"
    )
    .get(sceneId, characterId);
  return row != null;
}

export function createToolRequest(data: {
  sceneId: number;
  characterId: number;
  toolName: string;
  draft: ToolDraft;
  reason: string;
}): ToolRequest {
  const res = getDb()
    .prepare(
      `INSERT INTO tool_requests (scene_id, character_id, tool_name, draft_json, reason, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?)`
    )
    .run(
      data.sceneId,
      data.characterId,
      data.toolName,
      JSON.stringify(data.draft),
      data.reason,
      now()
    );
  return getToolRequest(Number(res.lastInsertRowid))!;
}

export function decideToolRequest(
  id: number,
  status: "approved" | "rejected",
  decisionReason: string | null
): ToolRequest | null {
  getDb()
    .prepare("UPDATE tool_requests SET status = ?, decision_reason = ?, decided_at = ? WHERE id = ?")
    .run(status, decisionReason, now(), id);
  return getToolRequest(id);
}

// ---------- Предложения (offers): агент предлагает другому вызов тула ----------

interface OfferRow {
  id: number | bigint;
  scene_id: number | bigint;
  from_id: number | bigint;
  to_id: number | bigint;
  tool_name: string;
  args: string;
  status: string;
  comment: string | null;
  turn: number | bigint;
  expires_turn: number | bigint;
  created_at: string;
  decided_at: string | null;
}

function mapOffer(r: OfferRow): Offer {
  return {
    id: Number(r.id),
    sceneId: Number(r.scene_id),
    fromId: Number(r.from_id),
    toId: Number(r.to_id),
    toolName: r.tool_name,
    args: parseJson<Record<string, unknown>>(r.args, {}),
    status: r.status === "accepted" || r.status === "declined" || r.status === "expired" ? r.status : "pending",
    comment: r.comment,
    turn: Number(r.turn),
    expiresTurn: Number(r.expires_turn),
    createdAt: r.created_at,
    decidedAt: r.decided_at,
  };
}

export function createOffer(
  sceneId: number,
  fromId: number,
  toId: number,
  toolName: string,
  args: Record<string, unknown>,
  turn: number,
  expiresTurn: number
): Offer {
  const res = getDb()
    .prepare(
      `INSERT INTO offers (scene_id, from_id, to_id, tool_name, args, status, turn, expires_turn, created_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`
    )
    .run(sceneId, fromId, toId, toolName, JSON.stringify(args ?? {}), turn, expiresTurn, now());
  return getOfferById(Number(res.lastInsertRowid))!;
}

export function getOfferById(id: number): Offer | null {
  const row = getDb()
    .prepare("SELECT * FROM offers WHERE id = ?")
    .get(id) as unknown as OfferRow | undefined;
  return row ? mapOffer(row) : null;
}

/** Активные предложения, адресованные персонажу (его очередь решать). */
export function listPendingOffersForCharacter(sceneId: number, charId: number): Offer[] {
  const rows = getDb()
    .prepare(
      "SELECT * FROM offers WHERE scene_id = ? AND to_id = ? AND status = 'pending' ORDER BY id"
    )
    .all(sceneId, charId) as unknown as OfferRow[];
  return rows.map(mapOffer);
}

/** Все активные предложения сцены (для шапки/инспектора). */
export function listPendingOffersForScene(sceneId: number): Offer[] {
  const rows = getDb()
    .prepare("SELECT * FROM offers WHERE scene_id = ? AND status = 'pending' ORDER BY id")
    .all(sceneId) as unknown as OfferRow[];
  return rows.map(mapOffer);
}

export function setOfferStatus(
  id: number,
  status: "accepted" | "declined" | "expired",
  comment?: string | null
): Offer | null {
  getDb()
    .prepare("UPDATE offers SET status = ?, comment = ?, decided_at = ? WHERE id = ?")
    .run(status, comment ?? null, now(), id);
  return getOfferById(id);
}

/** Протухшие предложения сцены: pending с expires_turn < currentTurn → expired. */
export function expireOffersForScene(sceneId: number, currentTurn: number): number {
  const res = getDb()
    .prepare(
      "UPDATE offers SET status = 'expired', decided_at = ? WHERE scene_id = ? AND status = 'pending' AND expires_turn < ?"
    )
    .run(now(), sceneId, currentTurn);
  return Number(res.changes);
}

export function deleteOffersForScene(sceneId: number): void {
  getDb().prepare("DELETE FROM offers WHERE scene_id = ?").run(sceneId);
}

/** Есть ли уже висящее предложение той же пары про тот же тул (без учёта аргументов). */
export function hasPendingOffer(sceneId: number, fromId: number, toId: number, toolName: string): boolean {
  const row = getDb()
    .prepare(
      "SELECT 1 AS x FROM offers WHERE scene_id = ? AND from_id = ? AND to_id = ? AND tool_name = ? AND status = 'pending' LIMIT 1"
    )
    .get(sceneId, fromId, toId, toolName);
  return row != null;
}

/** Последний отклонённый оффер той же пары про тот же тул (для антидавления). */
export function findRecentlyDeclinedOffer(
  sceneId: number,
  fromId: number,
  toId: number,
  toolName: string
): Offer | null {
  const row = getDb()
    .prepare(
      "SELECT * FROM offers WHERE scene_id = ? AND from_id = ? AND to_id = ? AND tool_name = ? AND status = 'declined' ORDER BY id DESC LIMIT 1"
    )
    .get(sceneId, fromId, toId, toolName) as unknown as OfferRow | undefined;
  return row ? mapOffer(row) : null;
}

// ---------- Блокировки в сцене (молчание в обе стороны) ----------

interface SceneBlockRow {
  scene_id: number | bigint;
  blocker_id: number | bigint;
  blocked_id: number | bigint;
  created_at: string;
}

function mapSceneBlock(r: SceneBlockRow): SceneBlock {
  return {
    sceneId: Number(r.scene_id),
    blockerId: Number(r.blocker_id),
    blockedId: Number(r.blocked_id),
    createdAt: r.created_at,
  };
}

export function addSceneBlock(sceneId: number, blockerId: number, blockedId: number): void {
  getDb()
    .prepare(
      "INSERT OR IGNORE INTO scene_blocks (scene_id, blocker_id, blocked_id, created_at) VALUES (?, ?, ?, ?)"
    )
    .run(sceneId, blockerId, blockedId, now());
}

export function listSceneBlocks(sceneId: number): SceneBlock[] {
  const rows = getDb()
    .prepare("SELECT * FROM scene_blocks WHERE scene_id = ? ORDER BY created_at")
    .all(sceneId) as unknown as SceneBlockRow[];
  return rows.map(mapSceneBlock);
}

/** Заблокирована ли пара: блокировка действует в обе стороны. */
export function isPairBlocked(sceneId: number, aId: number, bId: number): boolean {
  const row = getDb()
    .prepare(
      "SELECT 1 AS x FROM scene_blocks WHERE scene_id = ? AND ((blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)) LIMIT 1"
    )
    .get(sceneId, aId, bId, bId, aId);
  return row != null;
}

/** Все заглушённые для персонажа: кого он заблокировал И кто заблокировал его. */
export function blockedIdsFor(sceneId: number, charId: number): number[] {
  const rows = getDb()
    .prepare(
      "SELECT blocker_id, blocked_id FROM scene_blocks WHERE scene_id = ? AND (blocker_id = ? OR blocked_id = ?)"
    )
    .all(sceneId, charId, charId) as unknown as { blocker_id: number | bigint; blocked_id: number | bigint }[];
  const out: number[] = [];
  for (const r of rows) {
    const other = Number(r.blocker_id) === charId ? Number(r.blocked_id) : Number(r.blocker_id);
    if (!out.includes(other)) out.push(other);
  }
  return out;
}

export function deleteSceneBlocks(sceneId: number): void {
  getDb().prepare("DELETE FROM scene_blocks WHERE scene_id = ?").run(sceneId);
}

// ---------- Гардероб: предметы одежды ----------

export interface GarmentInput {
  name: string;
  emoji: string;
  description: string;
  /** Слот из реестра clothing_slots ('' = предмет без слота) */
  slot: string;
  effects: ToolEffect[];
  price: number;
}

interface GarmentRow {
  id: number | bigint;
  name: string;
  emoji: string;
  description: string;
  slot: string;
  effects: string;
  price: number;
  created_at: string;
}

function mapGarment(r: GarmentRow): Garment {
  return {
    id: Number(r.id),
    name: r.name,
    emoji: r.emoji,
    description: r.description,
    slot: r.slot ?? "",
    effects: parseJson<ToolEffect[]>(r.effects, []),
    price: Number(r.price ?? 0),
    createdAt: r.created_at,
  };
}

export function listGarments(): Garment[] {
  const rows = getDb()
    .prepare("SELECT * FROM garments ORDER BY id")
    .all() as unknown as GarmentRow[];
  return rows.map(mapGarment);
}

export function getGarmentById(id: number): Garment | null {
  const row = getDb()
    .prepare("SELECT * FROM garments WHERE id = ?")
    .get(id) as unknown as GarmentRow | undefined;
  return row ? mapGarment(row) : null;
}

export function createGarment(data: GarmentInput): Garment {
  const res = getDb()
    .prepare(
      `INSERT INTO garments (name, emoji, description, slot, effects, price, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      data.name,
      data.emoji,
      data.description,
      data.slot,
      JSON.stringify(data.effects),
      data.price,
      now()
    );
  return getGarmentById(Number(res.lastInsertRowid))!;
}

export function updateGarment(id: number, data: GarmentInput): Garment | null {
  const res = getDb()
    .prepare(
      `UPDATE garments SET name = ?, emoji = ?, description = ?, slot = ?, effects = ?, price = ? WHERE id = ?`
    )
    .run(
      data.name,
      data.emoji,
      data.description,
      data.slot,
      JSON.stringify(data.effects),
      data.price,
      id
    );
  return Number(res.changes) > 0 ? getGarmentById(id) : null;
}

export function deleteGarment(id: number): boolean {
  const res = getDb().prepare("DELETE FROM garments WHERE id = ?").run(id);
  return Number(res.changes) > 0;
}

/** Поиск одежды по названию: точное совпадение, потом вхождение в обе стороны. */
export function findGarmentByName(name: unknown): Garment | null {
  if (typeof name !== "string" || !name.trim()) return null;
  const needle = name.trim().toLowerCase();
  const all = listGarments();
  return (
    all.find((g) => g.name.toLowerCase() === needle) ??
    all.find((g) => g.name.toLowerCase().includes(needle)) ??
    all.find((g) => needle.includes(g.name.toLowerCase())) ??
    null
  );
}

/** Гардероб персонажа: предметы из character_garments (join). */
export function listCharacterGarments(charId: number): Garment[] {
  const rows = getDb()
    .prepare(
      `SELECT g.* FROM garments g
       JOIN character_garments cg ON cg.garment_id = g.id
       WHERE cg.character_id = ? ORDER BY g.id`
    )
    .all(charId) as unknown as GarmentRow[];
  return rows.map(mapGarment);
}

export function addGarmentToCharacter(charId: number, garmentId: number): void {
  getDb()
    .prepare(
      "INSERT OR IGNORE INTO character_garments (character_id, garment_id, created_at) VALUES (?, ?, ?)"
    )
    .run(charId, garmentId, now());
}

export function removeGarmentFromCharacter(charId: number, garmentId: number): void {
  getDb()
    .prepare("DELETE FROM character_garments WHERE character_id = ? AND garment_id = ?")
    .run(charId, garmentId);
}

/** Предмет в гардеробе персонажа по названию (точное, потом вхождение). */
export function findOwnedGarmentByName(charId: number, name: unknown): Garment | null {
  if (typeof name !== "string" || !name.trim()) return null;
  const needle = name.trim().toLowerCase();
  const owned = listCharacterGarments(charId);
  return (
    owned.find((g) => g.name.toLowerCase() === needle) ??
    owned.find((g) => g.name.toLowerCase().includes(needle)) ??
    null
  );
}

// ---------- Комбо: цепочка вызовов с наградой ----------

export interface ComboInput {
  name: string;
  title: string;
  description: string;
  steps: ComboStep[];
  windowTurns: number;
  effects: ToolEffect[];
  knowers: number[];
  announce: boolean;
}

interface ComboRow {
  id: number | bigint;
  name: string;
  title: string;
  description: string;
  steps: string;
  window_turns: number | bigint;
  effects: string;
  knowers: string;
  announce?: number | bigint;
  created_at: string;
}

function mapCombo(r: ComboRow): Combo {
  return {
    id: Number(r.id),
    name: r.name,
    title: r.title,
    description: r.description,
    steps: parseJson<ComboStep[]>(r.steps, []),
    windowTurns: Number(r.window_turns ?? 10),
    effects: parseJson<ToolEffect[]>(r.effects, []),
    knowers: parseJson<number[]>(r.knowers, []).map(Number),
    announce: Number(r.announce ?? 1) === 1,
    createdAt: r.created_at,
  };
}

export function listCombos(): Combo[] {
  const rows = getDb()
    .prepare("SELECT * FROM combos ORDER BY id")
    .all() as unknown as ComboRow[];
  return rows.map(mapCombo);
}

export function getComboById(id: number): Combo | null {
  const row = getDb()
    .prepare("SELECT * FROM combos WHERE id = ?")
    .get(id) as unknown as ComboRow | undefined;
  return row ? mapCombo(row) : null;
}

export function createCombo(data: ComboInput): Combo {
  const res = getDb()
    .prepare(
      `INSERT INTO combos (name, title, description, steps, window_turns, effects, knowers, announce, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      data.name,
      data.title,
      data.description,
      JSON.stringify(data.steps),
      data.windowTurns,
      JSON.stringify(data.effects),
      JSON.stringify(data.knowers),
      data.announce ? 1 : 0,
      now()
    );
  return getComboById(Number(res.lastInsertRowid))!;
}

export function updateCombo(id: number, data: ComboInput): Combo | null {
  const res = getDb()
    .prepare(
      `UPDATE combos SET name = ?, title = ?, description = ?, steps = ?, window_turns = ?, effects = ?, knowers = ?, announce = ? WHERE id = ?`
    )
    .run(
      data.name,
      data.title,
      data.description,
      JSON.stringify(data.steps),
      data.windowTurns,
      JSON.stringify(data.effects),
      JSON.stringify(data.knowers),
      data.announce ? 1 : 0,
      id
    );
  return Number(res.changes) > 0 ? getComboById(id) : null;
}

export function deleteCombo(id: number): boolean {
  const res = getDb().prepare("DELETE FROM combos WHERE id = ?").run(id);
  return Number(res.changes) > 0;
}

// ---------- Флоу (канвас сценариев) ----------

interface FlowRow {
  id: number | bigint;
  name: string;
  description: string;
  graph: string;
  created_at: string;
}

function mapFlow(r: FlowRow): Flow {
  return {
    id: Number(r.id),
    name: r.name,
    description: r.description,
    graph: parseJson<FlowGraph>(r.graph, { nodes: [], edges: [] }),
    createdAt: r.created_at,
  };
}

export function listFlows(): Flow[] {
  const rows = getDb().prepare("SELECT * FROM flows ORDER BY id DESC").all() as unknown as FlowRow[];
  return rows.map(mapFlow);
}

export function getFlow(id: number): Flow | null {
  const row = getDb().prepare("SELECT * FROM flows WHERE id = ?").get(id) as unknown as FlowRow | undefined;
  return row ? mapFlow(row) : null;
}

export function createFlow(data: { name: string; description: string; graph: FlowGraph }): Flow {
  const res = getDb()
    .prepare("INSERT INTO flows (name, description, graph, created_at) VALUES (?, ?, ?, ?)")
    .run(data.name, data.description, JSON.stringify(data.graph), now());
  return getFlow(Number(res.lastInsertRowid))!;
}

export function updateFlow(
  id: number,
  data: Partial<{ name: string; description: string; graph: FlowGraph }>
): Flow | null {
  const cur = getFlow(id);
  if (!cur) return null;
  getDb()
    .prepare("UPDATE flows SET name = ?, description = ?, graph = ? WHERE id = ?")
    .run(
      data.name ?? cur.name,
      data.description ?? cur.description,
      JSON.stringify(data.graph ?? cur.graph),
      id
    );
  return getFlow(id);
}

export function deleteFlow(id: number): boolean {
  const res = getDb().prepare("DELETE FROM flows WHERE id = ?").run(id);
  return Number(res.changes) > 0;
}

interface FlowRunRow {
  id: number | bigint;
  flow_id: number | bigint;
  status: string;
  cast: string;
  started_at: string;
  finished_at: string | null;
}

function mapFlowRun(r: FlowRunRow): FlowRun {
  return {
    id: Number(r.id),
    flowId: Number(r.flow_id),
    status: r.status === "finished" ? "finished" : r.status === "aborted" ? "aborted" : "running",
    cast: parseJson<number[]>(r.cast, []),
    startedAt: r.started_at,
    finishedAt: r.finished_at,
  };
}

export function listFlowRuns(flowId?: number): FlowRun[] {
  const rows = (
    flowId != null
      ? getDb().prepare("SELECT * FROM flow_runs WHERE flow_id = ? ORDER BY id DESC").all(flowId)
      : getDb().prepare("SELECT * FROM flow_runs ORDER BY id DESC").all()
  ) as unknown as FlowRunRow[];
  return rows.map(mapFlowRun);
}

export function getFlowRun(id: number): FlowRun | null {
  const row = getDb().prepare("SELECT * FROM flow_runs WHERE id = ?").get(id) as unknown as FlowRunRow | undefined;
  return row ? mapFlowRun(row) : null;
}

export function createFlowRun(flowId: number, cast: number[]): FlowRun {
  const res = getDb()
    .prepare(
      "INSERT INTO flow_runs (flow_id, status, cast, started_at) VALUES (?, 'running', ?, ?)"
    )
    .run(flowId, JSON.stringify(cast), now());
  return getFlowRun(Number(res.lastInsertRowid))!;
}

export function setFlowRunStatus(id: number, status: FlowRunStatus): void {
  getDb()
    .prepare("UPDATE flow_runs SET status = ?, finished_at = ? WHERE id = ?")
    .run(status, status === "running" ? null : now(), id);
}

/** Есть ли у флоу незавершённые прогоны. */
export function flowHasRunningRun(flowId: number): boolean {
  const row = getDb()
    .prepare("SELECT 1 AS x FROM flow_runs WHERE flow_id = ? AND status = 'running' LIMIT 1")
    .get(flowId);
  return row != null;
}

export function listFlowProgress(runId: number): FlowProgress[] {
  const rows = getDb()
    .prepare("SELECT * FROM flow_run_progress WHERE run_id = ?")
    .all(runId) as unknown as {
    run_id: number | bigint;
    character_id: number | bigint;
    node_id: string;
    status: string;
  }[];
  return rows.map((r) => ({
    runId: Number(r.run_id),
    characterId: Number(r.character_id),
    nodeId: r.node_id,
    status: r.status === "final" ? "final" : r.status === "eliminated" ? "eliminated" : "active",
  }));
}

export function setFlowProgress(
  runId: number,
  characterId: number,
  nodeId: string,
  status: FlowProgress["status"]
): void {
  getDb()
    .prepare(
      "INSERT INTO flow_run_progress (run_id, character_id, node_id, status) VALUES (?, ?, ?, ?) ON CONFLICT(run_id, character_id) DO UPDATE SET node_id = excluded.node_id, status = excluded.status"
    )
    .run(runId, characterId, nodeId, status);
}

export function listFlowVisits(runId: number): FlowVisit[] {
  const rows = getDb()
    .prepare("SELECT * FROM flow_run_visits WHERE run_id = ? ORDER BY id")
    .all(runId) as unknown as {
    id: number | bigint;
    run_id: number | bigint;
    character_id: number | bigint;
    node_id: string;
    scene_id: number | bigint | null;
    score: number | null;
    completion_pct: number | bigint | null;
    seated: number | bigint;
    entered_at: string;
    left_at: string | null;
  }[];
  return rows.map((r) => ({
    id: Number(r.id),
    runId: Number(r.run_id),
    characterId: Number(r.character_id),
    nodeId: r.node_id,
    sceneId: r.scene_id == null ? null : Number(r.scene_id),
    score: r.score,
    completionPct: r.completion_pct == null ? null : Number(r.completion_pct),
    seated: Number(r.seated),
    enteredAt: r.entered_at,
    leftAt: r.left_at,
  }));
}

export function openFlowVisit(data: {
  runId: number;
  characterId: number;
  nodeId: string;
  sceneId: number | null;
}): void {
  getDb()
    .prepare(
      "INSERT INTO flow_run_visits (run_id, character_id, node_id, scene_id, entered_at) VALUES (?, ?, ?, ?, ?)"
    )
    .run(data.runId, data.characterId, data.nodeId, data.sceneId, now());
}

/** Закрыть последнее незакрытое посещение персонажем узла (с оценкой сцены). */
export function closeFlowVisit(
  runId: number,
  characterId: number,
  nodeId: string,
  score: number | null,
  completionPct: number | null
): void {
  getDb()
    .prepare(
      `UPDATE flow_run_visits SET left_at = ?, score = ?, completion_pct = ?
       WHERE id = (
         SELECT id FROM flow_run_visits
         WHERE run_id = ? AND character_id = ? AND node_id = ? AND left_at IS NULL
         ORDER BY id DESC LIMIT 1
       )`
    )
    .run(now(), score, completionPct, runId, characterId, nodeId);
}

/** Была ли рассадка персонажей по сцене узла в этом прогоне (первая волна). */
export function hasSeatedVisit(runId: number, nodeId: string): boolean {
  const row = getDb()
    .prepare("SELECT 1 AS x FROM flow_run_visits WHERE run_id = ? AND node_id = ? AND seated = 1 LIMIT 1")
    .get(runId, nodeId);
  return row != null;
}

export function markVisitSeated(runId: number, characterId: number, nodeId: string): void {
  getDb()
    .prepare(
      `UPDATE flow_run_visits SET seated = 1
       WHERE id = (
         SELECT id FROM flow_run_visits
         WHERE run_id = ? AND character_id = ? AND node_id = ?
         ORDER BY id DESC LIMIT 1
       )`
    )
    .run(runId, characterId, nodeId);
}

// ---------- Утилиты (e2e/тесты) ----------

export function wipeAll(): void {
  const db = getDb();
  db.exec("BEGIN");
  try {
    db.exec(
      "DELETE FROM api_logs; DELETE FROM events; DELETE FROM scene_characters; DELETE FROM offers; DELETE FROM scene_blocks; DELETE FROM scenes; DELETE FROM character_garments; DELETE FROM characters; DELETE FROM tools; DELETE FROM providers; DELETE FROM tool_requests; DELETE FROM flow_run_visits; DELETE FROM flow_run_progress; DELETE FROM flow_runs; DELETE FROM flows; DELETE FROM products; DELETE FROM garments; DELETE FROM combos; DELETE FROM attributes; DELETE FROM pending_effects; DELETE FROM relations; DELETE FROM knowledge; DELETE FROM clothing_slots; DELETE FROM skill_practice; DELETE FROM skills; DELETE FROM chemistry; DELETE FROM settings; DELETE FROM places;"
    );
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
