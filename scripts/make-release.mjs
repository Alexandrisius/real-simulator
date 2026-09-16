// Сборка портативного релиза: release/ можно скопировать на любой ПК
// с Node 22.13+ и запустить START.bat — без npm install и без репозитория.
// Использование: node scripts/make-release.mjs   (сначала сам делает build)
//
// Что попадает в release/:
//   app/            — standalone-сервер + минимум node_modules + .next/static
//   START.bat       — запуск сервера (порт 3999) и браузера
//   УСТАНОВКА.txt   — инструкция (нужен Node 22.13+, БД создаётся сама)

import { execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const rel = path.join(root, "release");
const app = path.join(rel, "app");

// next build при сборке импортирует роуты, а те на старте открывают БД
// (схема + сид). Живой сервер держит data/app.db — получается
// «database is locked». Поэтому build идёт на временной БД, в релиз она
// не попадает: на целевом ПК БД создаётся с нуля при первом запуске.
const buildDb = path.join(os.tmpdir(), `real-sim-release-build-${process.pid}.db`);
try {
  console.log("1/4  Продакшен-сборка (next build)…");
  execSync("npm run build", {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, SIM_DB_PATH: buildDb },
  });
} finally {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(buildDb + suffix, { force: true });
}

const standalone = path.join(root, ".next", "standalone");
if (!existsSync(standalone)) {
  console.error("FAIL: .next/standalone не собрался — проверь output:'standalone' в next.config.ts");
  process.exit(1);
}

console.log("2/4  Копирую standalone + static…");
rmSync(rel, { recursive: true, force: true });
mkdirSync(rel, { recursive: true });
cpSync(standalone, app, { recursive: true });
cpSync(path.join(root, ".next", "static"), path.join(app, ".next", "static"), { recursive: true });
if (existsSync(path.join(root, "public"))) {
  cpSync(path.join(root, "public"), path.join(app, "public"), { recursive: true });
}

console.log("3/4  Запускатель и инструкция…");
writeFileSync(
  path.join(rel, "START.bat"),
  [
    "@echo off",
    "setlocal",
    "title Real Simulator",
    'cd /d "%~dp0app"',
    "",
    "REM Требуется Node.js 22.13 или новее (node:sqlite).",
    "where node >nul 2>&1",
    "if errorlevel 1 (",
    "  echo Node.js не найден! Установите с https://nodejs.org (версия 22 LTS или новее)",
    "  pause",
    "  exit /b 1",
    ")",
    "",
    "set \"PORT=3999\"",
    "set \"NODE_USE_SYSTEM_CA=1\"",
    "if not exist data mkdir data",
    "",
    "echo ============================================================",
    "echo  Real Simulator: http://localhost:3999",
    "echo  База данных создастся сама при первом запуске (data\\app.db).",
    "echo  Это окно и есть сервер — сверните, но не закрывайте.",
    "echo ============================================================",
    "echo.",
    "start \"\" http://localhost:3999",
    "node server.js",
    "pause",
    "",
  ].join("\r\n"),
  "utf8"
);

writeFileSync(
  path.join(rel, "УСТАНОВКА.txt"),
  [
    "Real Simulator — локальный симулятор социальных ИИ-агентов.",
    "",
    "УСТАНОВКА (один раз):",
    "  1. Установите Node.js 22.13 или новее: https://nodejs.org (22 LTS).",
    "  2. Скопируйте папку release целиком на любой ПК (Windows).",
    "",
    "ЗАПУСК:",
    "  Двойной клик по START.bat → откроется браузер на http://localhost:3999.",
    "  Всё локально: ни интернет-серверов, ни установки зависимостей.",
    "  База (SQLite) создаётся сама: app\\data\\app.db.",
    "",
    "ПЕРВЫЕ ШАГИ В UI:",
    "  1. «Провайдеры» — добавьте LM Studio / OpenRouter / любой",
    "     OpenAI-совместимый endpoint (нужен API-ключ).",
    "  2. «Персонажи» — создайте агентов, выберите им модель.",
    "  3. «Сцены» — участники, цели, место; кнопка «Старт».",
    "     Прогон сценариев — раздел «Сценарии».",
    "",
    "ПОРТ ЗАНЯТ? Закройте старое окно сервера или поменяйте PORT",
    "в START.bat (например, на 4000).",
    "",
    "Обновление сборки: пересоберите на машине разработчика",
    "  node scripts/make-release.mjs  — и скопируйте release заново.",
  ].join("\r\n"),
  "utf8"
);

console.log("4/4  Готово: " + rel);
console.log("Проверка запуска: cd release/app && PORT=4060 node server.js");
