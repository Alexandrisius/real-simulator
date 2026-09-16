// Начальные инструменты создаются один раз (флаг в app_meta), поэтому
// пользователь может спокойно удалить или переопределить все сиды.

import type { DB } from "./index";

export function seedDefaultTools(db: DB): void {
  db.exec(`CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  // Сид — под эксклюзивной транзакцией: один БД могут одновременно открыть
  // несколько процессов (воркеры next build), и проверка флагов «уже сеяно»
  // должна быть атомарной, иначе гонка даёт UNIQUE-ошибки и двойные сиды.
  // Второй процесс просто дождётся COMMIT (busy_timeout) и выйдет по флагам.
  db.exec("BEGIN IMMEDIATE");
  try {
    runSeeds(db);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

function runSeeds(db: DB): void {
  // Товары магазина и атрибуты сеются под своими флагами — чтобы добавиться
  // и в уже существующие базы (ранний return ниже старые базы не пропускает).
  seedProducts(db);
  seedAttributes(db);
  seedClothingSlots(db);
  seedPlaces(db);
  const done = db.prepare("SELECT value FROM app_meta WHERE key = 'seeded_tools'").get() as
    | { value: string }
    | undefined;
  if (done) return;

  const now = new Date().toISOString();
  const insert = db.prepare(`
    INSERT INTO tools (name, title, description, parameters_schema, audience, target_param, observation_template, effects, cost, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  db.prepare("INSERT OR REPLACE INTO app_meta (key, value) VALUES ('seeded_tools', '1')").run();

  const insertTool = (
    name: string,
    title: string,
    description: string,
    parametersSchema: object,
    audience: string,
    targetParam: string | null,
    observationTemplate: string,
    effects: unknown[] = [],
    cost = 0
  ) => {
    insert.run(
      name,
      title,
      description,
      JSON.stringify(parametersSchema),
      audience,
      targetParam,
      observationTemplate,
      JSON.stringify(effects),
      cost,
      now
    );
  };


  insertTool(
    "send_photo",
    "Отправить фото",
    "Отправить персонажу фотографию (опиши словами, что на ней). Видит только получатель.",
    {
      type: "object",
      properties: {
        to: { type: "string", description: "Имя получателя" },
        description: { type: "string", description: "Что изображено на фото" },
        caption: { type: "string", description: "Подпись к фото" },
      },
      required: ["to", "description"],
    },
    "target",
    "to",
    "{name} отправил(а) тебе фото: {description}"
  );

  insertTool(
    "do_activity",
    "Заняться делом",
    "Совершить бытовое действие, видимое всем: сходить в душ, приготовить еду, прогуляться и т.п.",
    {
      type: "object",
      properties: {
        activity: { type: "string", description: "Описание действия" },
      },
      required: ["activity"],
    },
    "all",
    null,
    "{name}: {activity}"
  );

  // Пример схемы валидации (один раз, флаг в app_meta)
  const schemaSeeded = db
    .prepare("SELECT value FROM app_meta WHERE key = 'seeded_schemas'")
    .get() as { value: string } | undefined;
  if (!schemaSeeded) {
    db.prepare(
      "INSERT INTO validation_schemas (name, description, steps, forbidden, penalty, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(
      "Флирт по шагам (пример)",
      "Демонстрация скоринга: сначала дело (do_activity), потом фото — бонус. Раннее фото — нарушение.",
      JSON.stringify([
        { toolName: "do_activity", required: true, points: 10, minCount: 1, argContains: null },
        { toolName: "send_photo", required: false, points: 5, minCount: 1, argContains: null },
      ]),
      JSON.stringify([]),
      3,
      new Date().toISOString()
    );
    db.prepare("INSERT OR REPLACE INTO app_meta (key, value) VALUES ('seeded_schemas', '1')").run();
  }
}


/**
 * Магазин: товары — простые карточки (название/цена/описание), а не инструменты.
 * Агенты смотрят ассортимент через shop_browse и покупают через shop_buy.
 * Отдельный флаг: добавляется и в существующие базы. Старые магазинные тулы
 * (buy_flowers и т.п., засеянные раньше как инструменты) переезжают в товары.
 */
function seedProducts(db: DB): void {
  const done = db.prepare("SELECT value FROM app_meta WHERE key = 'seeded_products'").get() as
    | { value: string }
    | undefined;
  if (done) return;
  db.prepare("INSERT OR REPLACE INTO app_meta (key, value) VALUES ('seeded_products', '1')").run();

  const insert = db.prepare(`
    INSERT INTO products (name, emoji, description, category, price, effects, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const add = (
    name: string,
    emoji: string,
    description: string,
    category: string,
    price: number,
    effects: unknown[]
  ) => {
    insert.run(name, emoji, description, category, price, JSON.stringify(effects), new Date().toISOString());
  };

  // Миграция: магазинные тулы прошлой версии -> товары
  const legacy: Record<string, { emoji: string; category: string }> = {
    buy_flowers: { emoji: "🌹", category: "подарки" },
    buy_gift: { emoji: "🎁", category: "подарки" },
    go_gym: { emoji: "💪", category: "спорт" },
    beauty_salon: { emoji: "✨", category: "внешность" },
  };
  let migrated = 0;
  for (const [name, meta] of Object.entries(legacy)) {
    const row = db.prepare("SELECT * FROM tools WHERE name = ?").get(name) as
      | { id: number; title: string; description: string; cost: number; effects: string }
      | undefined;
    if (!row) continue;
    insert.run(
      row.title || name,
      meta.emoji,
      row.description,
      meta.category,
      row.cost ?? 0,
      row.effects || "[]",
      new Date().toISOString()
    );
    db.prepare("DELETE FROM tools WHERE id = ?").run(row.id);
    migrated += 1;
  }
  if (migrated > 0) return;

  add(
    "Букет цветов",
    "🌹",
    "Цветы: пионы, розы или те, что любит получатель. Подарок поднимает настроение тому, кому вручён.",
    "подарки",
    20,
    [{ target: "tool_target", key: "mood", op: "add", value: 1 }]
  );
  add(
    "Подарок-сюрприз",
    "🎁",
    "Значимый подарок по вкусу получателя. Заметно укрепляет отношения.",
    "подарки",
    50,
    [{ target: "tool_target", key: "mood", op: "add", value: 1 }]
  );
  add(
    "Месяц в спортзале",
    "💪",
    "Абонемент на месяц тренировок: тело становится подтянутым, физподготовка растёт.",
    "спорт",
    40,
    [{ target: "self", key: "fitness", op: "add", value: 1 }]
  );
  add(
    "Салон красоты",
    "✨",
    "Комплекс процедур у косметолога и стилиста: внешность заметно улучшается.",
    "внешность",
    200,
    [{ target: "self", key: "looks", op: "add", value: 1 }]
  );
}

/**
 * Реестр характеристик персонажей: рост, вес, физподготовка, красота…
 * Значения живут в state персонажа по ключу атрибута; определения — чисто
 * метаданные для форм редактора и подсказок эффектов.
 */
function seedAttributes(db: DB): void {
  const done = db.prepare("SELECT value FROM app_meta WHERE key = 'seeded_attributes'").get() as
    | { value: string }
    | undefined;
  if (done) return;
  db.prepare("INSERT OR REPLACE INTO app_meta (key, value) VALUES ('seeded_attributes', '1')").run();

  const insert = db.prepare(`
    INSERT INTO attributes (key, label, emoji, type, unit, min, max, options, position, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, '[]', ?, ?)
  `);
  const now = new Date().toISOString();
  const add = (
    key: string,
    label: string,
    emoji: string,
    unit: string,
    min: number | null,
    max: number | null,
    position: number
  ) => insert.run(key, label, emoji, "number", unit, min, max, position, now);

  add("height", "Рост", "📏", "см", 140, 220, 1);
  add("weight", "Вес", "⚖️", "кг", 35, 200, 2);
  add("fitness", "Физподготовка", "💪", "ур. 0–10", 0, 10, 3);
  add("looks", "Красота", "✨", "ур. 0–10", 0, 10, 4);
  add("mood", "Настроение", "😊", "ур. 0–10", 0, 10, 5);
  add("energy", "Энергия", "⚡", "ур. 0–10", 0, 10, 6);
  add("money", "Деньги", "💵", "$", 0, null, 7);
}

/**
 * Реестр слотов одежды. layer задаёт порядок снятия (2 = бельё нельзя снять
 * поверх 1 = верхнего), undressPlaces — где слот можно обнажить (пусто =
 * где угодно). Сид под своим флагом добавляется и в существующие базы.
 */
function seedClothingSlots(db: DB): void {
  const done = db
    .prepare("SELECT value FROM app_meta WHERE key = 'seeded_clothing_slots'")
    .get() as { value: string } | undefined;
  if (done) return;
  db.prepare("INSERT OR REPLACE INTO app_meta (key, value) VALUES ('seeded_clothing_slots', '1')").run();

  const insert = db.prepare(`
    INSERT INTO clothing_slots (slot, layer, undress_places, position, created_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  const now = new Date().toISOString();
  const add = (slot: string, layer: number, places: string[], position: number) =>
    insert.run(slot, layer, JSON.stringify(places), position, now);

  add("top", 1, ["дом", "кафе", "отель", "пляж"], 1);
  add("bottom", 1, ["дом", "кафе", "отель", "пляж"], 2);
  add("underwear", 2, ["дом", "отель", "пляж"], 3);
}

/**
 * Реестр мест: доступен агентам через go_to («отправиться») и invite
 * («пригласить»). Сид под своим флагом добавляется и в существующие базы.
 */
function seedPlaces(db: DB): void {
  const done = db.prepare("SELECT value FROM app_meta WHERE key = 'seeded_places'").get() as
    | { value: string }
    | undefined;
  if (done) return;
  db.prepare("INSERT OR REPLACE INTO app_meta (key, value) VALUES ('seeded_places', '1')").run();

  const insert = db.prepare(
    "INSERT OR IGNORE INTO places (name, description, position, created_at) VALUES (?, ?, ?, ?)"
  );
  const now = new Date().toISOString();
  const add = (name: string, description: string, position: number) =>
    insert.run(name, description, position, now);

  add("дом", "Жилое помещение: уют, приватность и полное уединение.", 1);
  add("кафе", "Уютное кафе: приглушённый свет, кофе и разговоры за столиком.", 2);
  add("отель", "Номер отеля: романтика, вино и полная приватность.", 3);
  add("улица", "Городская улица: прохожие, воздух и людские глаза.", 4);
  add("пляж", "Пляж: море, песок, минимум одежды и максимум солнца.", 5);
  add("сауна", "Элитная сауна: пар, вино, массажный стол и расслабленность.", 6);
}
