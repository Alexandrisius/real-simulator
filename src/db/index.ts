// Подключение к SQLite (node:sqlite, без нативных зависимостей) + схема БД.
// Singleton через globalThis переживает HMR в next dev.

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { seedDefaultTools } from "./seed";

export type DB = DatabaseSync;

export function resolveDbPath(): string {
  if (process.env.SIM_DB_PATH) return process.env.SIM_DB_PATH;
  return path.join(process.cwd(), "data", "app.db");
}

function createDb(): DB {
  const dbPath = resolveDbPath();
  // standalone-сборка меняет рабочий каталог: БД молча создаётся в копии
  // data/ внутри .next и «съедает» правки (данные «пропадают» после пересборки).
  // Прод запускается только start.bat из корня — здесь это всегда ошибка окружения.
  if (dbPath.includes(`${path.sep}.next${path.sep}`)) {
    console.warn(
      "\n⚠️  БД открывается внутри сборки (.next) — это копия, а не живая база!\n" +
        "   Прод запускается только `start.bat` из корня репозитория; никогда\n" +
        "   `node .next/standalone/server.js` (данные уйдут в копию и потеряются).\n"
    );
  }
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  // Ждём чужую блокировку, а не падаем сразу: несколько процессов законно
  // открывают одну БД (воркеры next build, сервер + ручные скрипты).
  db.exec("PRAGMA busy_timeout = 15000;");
  db.exec("PRAGMA foreign_keys = ON;");
  ensureSchema(db);
  seedDefaultTools(db);
  return db;
}

export function ensureSchema(db: DB): void {
  // Эксклюзивная транзакция: воркеры next build открывают одну БД параллельно,
  // и без сериализации два воркера успевают увидеть «колонки нет» и оба
  // выполнить ALTER TABLE ADD COLUMN → «duplicate column name». BEGIN IMMEDIATE
  // + busy_timeout выстраивают их в очередь: второй увидит уже готовую схему.
  db.exec("BEGIN IMMEDIATE");
  try {
    ensureSchemaLocked(db);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

function ensureSchemaLocked(db: DB): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS providers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'openai-compatible',
      base_url TEXT NOT NULL,
      api_key TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tools (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      parameters_schema TEXT NOT NULL DEFAULT '{}',
      audience TEXT NOT NULL DEFAULT 'all',
      target_param TEXT,
      observation_template TEXT NOT NULL DEFAULT '{name} использует {tool}',
      effects TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS characters (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      emoji TEXT NOT NULL DEFAULT '🙂',
      persona TEXT NOT NULL DEFAULT '',
      provider_id INTEGER REFERENCES providers(id),
      model TEXT NOT NULL DEFAULT '',
      temperature REAL NOT NULL DEFAULT 0.8,
      max_tokens INTEGER NOT NULL DEFAULT 1024,
      tool_ids TEXT NOT NULL DEFAULT '[]',
      state TEXT NOT NULL DEFAULT '{}',
      is_human INTEGER NOT NULL DEFAULT 0,
      boundaries TEXT NOT NULL DEFAULT '[]',
      fallback_provider_id INTEGER REFERENCES providers(id),
      fallback_model TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS scenes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      setting TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'idle',
      config TEXT NOT NULL DEFAULT '{}',
      cursor INTEGER NOT NULL DEFAULT 0,
      spent_api_calls INTEGER NOT NULL DEFAULT 0,
      spent_tokens INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS validation_schemas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      steps TEXT NOT NULL DEFAULT '[]',
      forbidden TEXT NOT NULL DEFAULT '[]',
      penalty REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS scene_characters (
      scene_id INTEGER NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
      character_id INTEGER NOT NULL REFERENCES characters(id),
      position INTEGER NOT NULL DEFAULT 0,
      validation_schema_id INTEGER REFERENCES validation_schemas(id),
      goal TEXT,
      PRIMARY KEY (scene_id, character_id)
    );

    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scene_id INTEGER NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
      turn INTEGER NOT NULL,
      type TEXT NOT NULL,
      actor_id INTEGER,
      audience TEXT NOT NULL DEFAULT '"all"',
      payload TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_events_scene ON events(scene_id, id);

    CREATE TABLE IF NOT EXISTS api_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scene_id INTEGER NOT NULL,
      character_id INTEGER,
      turn INTEGER NOT NULL,
      iteration INTEGER NOT NULL DEFAULT 0,
      model TEXT,
      request_json TEXT NOT NULL,
      response_json TEXT,
      error TEXT,
      latency_ms INTEGER,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_apilogs_scene ON api_logs(scene_id, id);

    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      emoji TEXT NOT NULL DEFAULT '🛍️',
      description TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL DEFAULT '',
      price REAL NOT NULL DEFAULT 0,
      effects TEXT NOT NULL DEFAULT '[]',
      delay_scenes INTEGER NOT NULL DEFAULT 0,
      slot TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS pending_effects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      character_id INTEGER NOT NULL,
      recipient_id INTEGER,
      product_id INTEGER NOT NULL,
      product_name TEXT NOT NULL,
      effects TEXT NOT NULL DEFAULT '[]',
      remaining_scenes INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      applied_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_pending_char ON pending_effects(character_id, id);

    CREATE TABLE IF NOT EXISTS attributes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT NOT NULL UNIQUE,
      label TEXT NOT NULL,
      emoji TEXT NOT NULL DEFAULT '',
      type TEXT NOT NULL DEFAULT 'number',
      unit TEXT NOT NULL DEFAULT '',
      min REAL,
      max REAL,
      options TEXT NOT NULL DEFAULT '[]',
      position INTEGER NOT NULL DEFAULT 0,
      visibility TEXT NOT NULL DEFAULT 'public',
      lie_penalty REAL NOT NULL DEFAULT 2,
      covered_by TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS relations (
      from_id INTEGER NOT NULL,
      to_id INTEGER NOT NULL,
      value REAL NOT NULL DEFAULT 0,
      PRIMARY KEY (from_id, to_id)
    );

    CREATE TABLE IF NOT EXISTS knowledge (
      observer_id INTEGER NOT NULL,
      subject_id INTEGER NOT NULL,
      key TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'claimed',
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (observer_id, subject_id, key)
    );

    CREATE TABLE IF NOT EXISTS clothing_slots (
      slot TEXT PRIMARY KEY,
      layer INTEGER NOT NULL DEFAULT 1,
      undress_places TEXT NOT NULL DEFAULT '[]',
      position INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS skills (
      key TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      emoji TEXT NOT NULL DEFAULT '',
      max_level INTEGER NOT NULL DEFAULT 5,
      practice_per_level INTEGER NOT NULL DEFAULT 10,
      grows INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS skill_practice (
      character_id INTEGER NOT NULL,
      skill_key TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (character_id, skill_key)
    );

    CREATE TABLE IF NOT EXISTS chemistry (
      a_id INTEGER NOT NULL,
      b_id INTEGER NOT NULL,
      value REAL NOT NULL DEFAULT 0,
      PRIMARY KEY (a_id, b_id)
    );

    CREATE TABLE IF NOT EXISTS places (
      name TEXT PRIMARY KEY,
      description TEXT NOT NULL DEFAULT '',
      position INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tool_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scene_id INTEGER NOT NULL,
      character_id INTEGER NOT NULL,
      tool_name TEXT NOT NULL,
      draft_json TEXT NOT NULL DEFAULT '{}',
      reason TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      decision_reason TEXT,
      created_at TEXT NOT NULL,
      decided_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_toolreq_scene ON tool_requests(scene_id, id);

    CREATE TABLE IF NOT EXISTS flows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      graph TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS flow_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      flow_id INTEGER NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'running',
      cast TEXT NOT NULL DEFAULT '[]',
      started_at TEXT NOT NULL,
      finished_at TEXT
    );

    CREATE TABLE IF NOT EXISTS flow_run_progress (
      run_id INTEGER NOT NULL REFERENCES flow_runs(id) ON DELETE CASCADE,
      character_id INTEGER NOT NULL,
      node_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      PRIMARY KEY (run_id, character_id)
    );

    CREATE TABLE IF NOT EXISTS flow_run_visits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL REFERENCES flow_runs(id) ON DELETE CASCADE,
      character_id INTEGER NOT NULL,
      node_id TEXT NOT NULL,
      scene_id INTEGER,
      score REAL,
      completion_pct INTEGER,
      seated INTEGER NOT NULL DEFAULT 0,
      entered_at TEXT NOT NULL,
      left_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_flowvisits_run ON flow_run_visits(run_id, id);

    CREATE TABLE IF NOT EXISTS offers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scene_id INTEGER NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
      from_id INTEGER NOT NULL,
      to_id INTEGER NOT NULL,
      tool_name TEXT NOT NULL,
      args TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'pending',
      comment TEXT NULL,
      turn INTEGER NOT NULL DEFAULT 0,
      expires_turn INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      decided_at TEXT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_offers_scene ON offers(scene_id, id);

    CREATE TABLE IF NOT EXISTS scene_blocks (
      scene_id INTEGER NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
      blocker_id INTEGER NOT NULL,
      blocked_id INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (scene_id, blocker_id, blocked_id)
    );

    CREATE TABLE IF NOT EXISTS garments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      emoji TEXT NOT NULL DEFAULT '👕',
      description TEXT NOT NULL DEFAULT '',
      slot TEXT NOT NULL DEFAULT '',
      effects TEXT NOT NULL DEFAULT '[]',
      price REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS character_garments (
      character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
      garment_id INTEGER NOT NULL REFERENCES garments(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      PRIMARY KEY (character_id, garment_id)
    );

    CREATE TABLE IF NOT EXISTS combos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      steps TEXT NOT NULL DEFAULT '[]',
      window_turns INTEGER NOT NULL DEFAULT 10,
      effects TEXT NOT NULL DEFAULT '[]',
      knowers TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL
    );
  `);
  migrateCharacters(db);
  migrateScenes(db);
  migrateSceneCharacters(db);
  migrateTools(db);
  migrateProducts(db);
  migrateAttributes(db);
  migrateClothingSlots(db);
  migrateCombos(db);
}

/** Миграция старых баз: анонс срабатывания комбо («достижение» всем участникам). */
function migrateCombos(db: DB): void {
  const cols = db.prepare("PRAGMA table_info(combos)").all() as unknown as {
    name: string;
  }[];
  if (!cols.some((c) => c.name === "announce")) {
    db.exec("ALTER TABLE combos ADD COLUMN announce INTEGER NOT NULL DEFAULT 1");
  }
}

/** Миграция старых баз: публичность/штраф лжи/прикрытие одеждой у характеристик. */
function migrateAttributes(db: DB): void {
  const cols = db.prepare("PRAGMA table_info(attributes)").all() as unknown as {
    name: string;
  }[];
  if (!cols.some((c) => c.name === "visibility")) {
    db.exec("ALTER TABLE attributes ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public'");
  }
  if (!cols.some((c) => c.name === "lie_penalty")) {
    db.exec("ALTER TABLE attributes ADD COLUMN lie_penalty REAL NOT NULL DEFAULT 2");
  }
  if (!cols.some((c) => c.name === "covered_by")) {
    db.exec("ALTER TABLE attributes ADD COLUMN covered_by TEXT NOT NULL DEFAULT '[]'");
  }
}

/** Миграция старых баз: задержка применения товара в сценах + слот одежды. */
function migrateProducts(db: DB): void {
  const cols = db.prepare("PRAGMA table_info(products)").all() as unknown as {
    name: string;
  }[];
  if (!cols.some((c) => c.name === "delay_scenes")) {
    db.exec("ALTER TABLE products ADD COLUMN delay_scenes INTEGER NOT NULL DEFAULT 0");
  }
  if (!cols.some((c) => c.name === "slot")) {
    db.exec("ALTER TABLE products ADD COLUMN slot TEXT NOT NULL DEFAULT ''");
  }
}

/** Миграция старых баз: цена/происхождение инструмента (экономика + заявки агентов). */
function migrateTools(db: DB): void {
  const cols = db.prepare("PRAGMA table_info(tools)").all() as unknown as {
    name: string;
  }[];
  if (!cols.some((c) => c.name === "cost")) {
    db.exec("ALTER TABLE tools ADD COLUMN cost REAL NOT NULL DEFAULT 0");
  }
  if (!cols.some((c) => c.name === "origin")) {
    db.exec("ALTER TABLE tools ADD COLUMN origin TEXT NOT NULL DEFAULT 'manual'");
  }
  if (!cols.some((c) => c.name === "created_by")) {
    db.exec("ALTER TABLE tools ADD COLUMN created_by INTEGER");
  }
  if (!cols.some((c) => c.name === "trains_skill")) {
    db.exec("ALTER TABLE tools ADD COLUMN trains_skill TEXT NOT NULL DEFAULT ''");
  }
  if (!cols.some((c) => c.name === "outcomes")) {
    db.exec("ALTER TABLE tools ADD COLUMN outcomes TEXT NOT NULL DEFAULT '[]'");
  }
  // Согласие на адресный тул + эффекты при отказе (механика предложений)
  if (!cols.some((c) => c.name === "requires_consent")) {
    db.exec("ALTER TABLE tools ADD COLUMN requires_consent INTEGER NOT NULL DEFAULT 0");
  }
  if (!cols.some((c) => c.name === "decline_effects")) {
    db.exec("ALTER TABLE tools ADD COLUMN decline_effects TEXT NOT NULL DEFAULT '[]'");
  }
}

/** Миграция старых баз: эффекты пустого слота одежды (bareEffects). */
function migrateClothingSlots(db: DB): void {
  const cols = db.prepare("PRAGMA table_info(clothing_slots)").all() as unknown as {
    name: string;
  }[];
  if (!cols.some((c) => c.name === "bare_effects")) {
    db.exec("ALTER TABLE clothing_slots ADD COLUMN bare_effects TEXT NOT NULL DEFAULT '[]'");
  }
}

/** Миграция старых баз: привязка схемы валидации + цель участника сцены. */
function migrateSceneCharacters(db: DB): void {
  const cols = db.prepare("PRAGMA table_info(scene_characters)").all() as unknown as {
    name: string;
  }[];
  if (!cols.some((c) => c.name === "validation_schema_id")) {
    db.exec(
      "ALTER TABLE scene_characters ADD COLUMN validation_schema_id INTEGER REFERENCES validation_schemas(id)"
    );
  }
  if (!cols.some((c) => c.name === "goal")) {
    db.exec("ALTER TABLE scene_characters ADD COLUMN goal TEXT");
  }
  if (!cols.some((c) => c.name === "initial_state")) {
    db.exec("ALTER TABLE scene_characters ADD COLUMN initial_state TEXT");
  }
  if (!cols.some((c) => c.name === "left_scene")) {
    // Ушёл из сцены (leave_scene): из ротации исчезает навсегда, до пересбора состава
    db.exec("ALTER TABLE scene_characters ADD COLUMN left_scene INTEGER NOT NULL DEFAULT 0");
  }
  if (!cols.some((c) => c.name === "editor_overlay")) {
    // Оверлей правок редактора поверх снимка: «Заново» = снимок на момент
    // рассадки + то, что Архитектор явно правил у персонажа после неё.
    db.exec("ALTER TABLE scene_characters ADD COLUMN editor_overlay TEXT");
  }
}

/** Миграция старых баз: счётчики расходов сцены (вызовы API и токены). */
function migrateScenes(db: DB): void {
  const cols = db.prepare("PRAGMA table_info(scenes)").all() as unknown as {
    name: string;
  }[];
  if (!cols.some((c) => c.name === "spent_api_calls")) {
    db.exec("ALTER TABLE scenes ADD COLUMN spent_api_calls INTEGER NOT NULL DEFAULT 0");
  }
  if (!cols.some((c) => c.name === "spent_tokens")) {
    db.exec("ALTER TABLE scenes ADD COLUMN spent_tokens INTEGER NOT NULL DEFAULT 0");
  }
}

/** Миграция старых баз: колонка is_human + необязательный provider_id + доход + границы. */
function migrateCharacters(db: DB): void {
  const cols = db.prepare("PRAGMA table_info(characters)").all() as unknown as {
    name: string;
  }[];
  if (!cols.some((c) => c.name === "income")) {
    db.exec("ALTER TABLE characters ADD COLUMN income REAL NOT NULL DEFAULT 0");
  }
  if (!cols.some((c) => c.name === "boundaries")) {
    db.exec("ALTER TABLE characters ADD COLUMN boundaries TEXT NOT NULL DEFAULT '[]'");
  }
  // Страховочная модель: провайдер+модель, подхватывающая ход при отказе/обрыве основной
  if (!cols.some((c) => c.name === "fallback_provider_id")) {
    db.exec(
      "ALTER TABLE characters ADD COLUMN fallback_provider_id INTEGER REFERENCES providers(id)"
    );
  }
  if (!cols.some((c) => c.name === "fallback_model")) {
    db.exec("ALTER TABLE characters ADD COLUMN fallback_model TEXT NOT NULL DEFAULT ''");
  }
  if (cols.some((c) => c.name === "is_human")) return;
  // FK приходится гасить: DROP TABLE characters не пройдёт,
  // пока на него ссылаются строки scene_characters.
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    db.exec("DROP TABLE IF EXISTS characters_new");
    db.exec(`
      CREATE TABLE characters_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        emoji TEXT NOT NULL DEFAULT '🙂',
        persona TEXT NOT NULL DEFAULT '',
        provider_id INTEGER REFERENCES providers(id),
        model TEXT NOT NULL DEFAULT '',
        temperature REAL NOT NULL DEFAULT 0.8,
        max_tokens INTEGER NOT NULL DEFAULT 1024,
        tool_ids TEXT NOT NULL DEFAULT '[]',
        state TEXT NOT NULL DEFAULT '{}',
        is_human INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      INSERT INTO characters_new (id, name, emoji, persona, provider_id, model, temperature, max_tokens, tool_ids, state, is_human, created_at)
        SELECT id, name, emoji, persona, provider_id, model, temperature, max_tokens, tool_ids, state, 0, created_at FROM characters;
      DROP TABLE characters;
      ALTER TABLE characters_new RENAME TO characters;
    `);
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

const g = globalThis as unknown as { __simDb?: DB };

export function getDb(): DB {
  if (!g.__simDb) g.__simDb = createDb();
  return g.__simDb;
}
