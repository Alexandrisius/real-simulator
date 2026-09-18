// Сборка портативного релиза «для людей»: в комплекте собственный node.exe,
// поэтому на целевом ПК НЕ нужен установленный Node.js.
// Использование: node scripts/make-release.mjs [--skip-build] [--no-zip]
//
// Что попадает в release/:
//   app/            — standalone-сервер + минимум node_modules + .next/static
//   app/runtime/    — node.exe (скачивается с nodejs.org, кэш в .release-cache)
//   START.bat       — запуск сервера + окно-приложение (Edge --app)
//   APP-WINDOW.bat  — открыть окно-приложение повторно (если закрыли)
//   УСТАНОВКА.txt   — инструкция для конечного пользователя
// dist/real-simulator-<version>-win64-portable.zip — артефакт для GitHub Releases.
//
// Важно: батники — ASCII-only намеренно (любая кодовая страница консоли),
// русский — только в УСТАНОВКА.txt (UTF-8 c BOM, читается Блокнотом).

import { execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const args = new Set(process.argv.slice(2));
const skipBuild = args.has("--skip-build");
const noZip = args.has("--no-zip");

const root = path.resolve(import.meta.dirname, "..");
const rel = path.join(root, "release");
const app = path.join(rel, "app");
const cache = path.join(root, ".release-cache");
const dist = path.join(root, "dist");

const PORT = 3999;

const die = (msg) => {
  console.error("FAIL: " + msg);
  process.exit(1);
};

// Версия приложения — из package.json (идёт в имя zip-артефакта).
const version = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version;

// next build при сборке импортирует роуты, а те на старте открывают БД
// (схема + сид). Живой сервер держит data/app.db — получается
// «database is locked». Поэтому build идёт на временной БД, в релиз она
// не попадает: на целевом ПК БД создаётся с нуля при первом запуске.
if (!skipBuild) {
  const buildDb = path.join(os.tmpdir(), `real-sim-release-build-${process.pid}.db`);
  try {
    console.log("1/6  Продакшен-сборка (next build)…");
    execSync("npm run build", {
      cwd: root,
      stdio: "inherit",
      env: { ...process.env, SIM_DB_PATH: buildDb },
    });
  } finally {
    for (const suffix of ["", "-wal", "-shm"]) rmSync(buildDb + suffix, { force: true });
  }
} else {
  console.log("1/6  Сборка пропущена (--skip-build)");
}

const standalone = path.join(root, ".next", "standalone");
if (!existsSync(standalone)) {
  die(".next/standalone не собрался — проверь output:'standalone' в next.config.ts");
}

console.log("2/6  Копирую standalone + static…");
rmSync(rel, { recursive: true, force: true });
mkdirSync(rel, { recursive: true });
cpSync(standalone, app, { recursive: true });
cpSync(path.join(root, ".next", "static"), path.join(app, ".next", "static"), { recursive: true });
if (existsSync(path.join(root, "public"))) {
  cpSync(path.join(root, "public"), path.join(app, "public"), { recursive: true });
}

console.log("3/6  Загружаю Node.js runtime (кэш: .release-cache)…");
const nodeMajor = Number(process.versions.node.split(".")[0]);
if (!(nodeMajor >= 22)) die(`локальный Node ${process.versions.node} — нужен 22.13+ для сборки`);
const runtimeExe = await ensureNodeRuntime(nodeMajor);
mkdirSync(path.join(app, "runtime"), { recursive: true });
cpSync(runtimeExe, path.join(app, "runtime", "node.exe"));
console.log(`      runtime: ${path.basename(runtimeExe)}`);

console.log("4/6  Запускатели (START.bat, APP-WINDOW.bat)…");
writeFileSync(path.join(rel, "START.bat"), startBat(), "ascii");
writeFileSync(path.join(rel, "APP-WINDOW.bat"), windowBat(), "ascii");

console.log("5/6  Инструкция (УСТАНОВКА.txt)…");
writeFileSync(
  path.join(rel, "УСТАНОВКА.txt"),
  "\uFEFF" + installTxt().join("\r\n"),
  "utf8"
);

let zipInfo = "";
if (!noZip) {
  console.log("6/6  Упаковка zip…");
  mkdirSync(dist, { recursive: true });
  const zipPath = path.join(dist, `real-simulator-${version}-win64-portable.zip`);
  rmSync(zipPath, { force: true });
  execSync(
    `powershell -NoProfile -Command "Compress-Archive -Path '${rel.replace(/'/g, "''")}\\*' -DestinationPath '${zipPath.replace(/'/g, "''")}' -Force"`,
    { stdio: "inherit" }
  );
  zipInfo = `\nАртефакт для GitHub Releases: ${zipPath}`;
}

console.log(`\nГотово: ${rel}${zipInfo}`);
console.log("Проверка: cd release && START.bat (окно приложения откроется само)");

// -------------------------------------------------------------------------

/** Скачать node.exe нужной мажорной версии (последний патч LTS-ветки). */
async function ensureNodeRuntime(major) {
  mkdirSync(cache, { recursive: true });
  const listUrl = `https://nodejs.org/dist/latest-v${major}.x/`;
  const list = await fetch(listUrl).catch(() => null);
  if (!list || !list.ok) die(`не удалось получить список ${listUrl}`);
  const match = (await list.text()).match(new RegExp(`node-v(\\d+\\.\\d+\\.\\d+)-win-x64\\.zip`));
  if (!match) die(`в ${listUrl} нет win-x64 архива`);
  const ver = match[1];
  const exe = path.join(cache, `node-v${ver}-win-x64-node.exe`);
  if (existsSync(exe)) return exe;

  const zip = path.join(cache, `node-v${ver}-win-x64.zip`);
  if (!existsSync(zip)) {
    console.log(`      скачиваю https://nodejs.org/dist/v${ver}/node-v${ver}-win-x64.zip …`);
    const res = await fetch(`https://nodejs.org/dist/v${ver}/node-v${ver}-win-x64.zip`);
    if (!res.ok) die(`HTTP ${res.status} при скачивании Node ${ver}`);
    writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
  }
  // В архиве папка node-vX.Y.Z-win-x64/ — забираем только node.exe
  // (стандартная библиотека Node вшита в exe, остальное не нужно).
  const tmp = path.join(cache, `extract-${ver}`);
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  execSync(`tar -xf "${zip}" -C "${tmp}"`, { stdio: "inherit" });
  const inner = path.join(tmp, `node-v${ver}-win-x64`, "node.exe");
  if (!existsSync(inner)) die(`в архиве Node ${ver} нет node.exe`);
  cpSync(inner, exe);
  rmSync(tmp, { recursive: true, force: true });
  rmSync(zip, { force: true });
  return exe;
}

/** Сервер + автозапуск окна-приложения. ASCII-only! */
function startBat() {
  return [
    "@echo off",
    "setlocal",
    "title Real Simulator - server",
    'cd /d "%~dp0app"',
    "",
    "REM Portable build: bundled node.exe, no Node.js install needed.",
    `set "PORT=${PORT}"`,
    "REM Loopback only: no Windows firewall prompt, nothing exposed to LAN.",
    'set "HOSTNAME=127.0.0.1"',
    'set "NODE_USE_SYSTEM_CA=1"',
    "if not exist data mkdir data",
    "",
    'set "NODE_EXE=runtime\\node.exe"',
    'if not exist "%NODE_EXE%" (',
    "  echo [!] Bundled runtime missing - trying system Node.js...",
    '  set "NODE_EXE=node"',
    ")",
    "",
    "REM App window opens by itself as soon as the server is ready.",
    'start "" "%~dp0APP-WINDOW.bat"',
    "",
    "echo ============================================================",
    `echo  Real Simulator: http://localhost:${PORT}`,
    "echo  First run creates the database (data\\app.db) automatically.",
    "echo  This window IS the server: you can minimize it.",
    "echo  Close this window to stop the app completely.",
    "echo ============================================================",
    "echo.",
    '"%NODE_EXE%" server.js',
    "echo.",
    "echo Server stopped.",
    "pause",
    "",
  ].join("\r\n");
}

/** Открыть окно-приложение (дожидается сервера). ASCII-only! */
function windowBat() {
  return [
    "@echo off",
    "setlocal EnableDelayedExpansion",
    `set "PORT=${PORT}"`,
    `set "URL=http://localhost:%PORT%/"`,
    "",
    "REM Wait until the server answers (max ~60s, first run builds the DB).",
    "set /a tries=0",
    ":wait",
    "powershell -NoProfile -Command \"try{Invoke-WebRequest -UseBasicParsing -Uri 'http://localhost:%PORT%' -TimeoutSec 2 | Out-Null; exit 0}catch{exit 1}\" >nul 2>&1",
    "if not errorlevel 1 goto ready",
    "set /a tries+=1",
    "if !tries! GEQ 60 goto ready",
    "timeout /t 1 /nobreak >nul",
    "goto wait",
    "",
    ":ready",
    "REM Chromeless app window via Edge (preinstalled on Windows 10/11);",
    "REM fallback: default browser.",
    'set "EDGE=%ProgramFiles(x86)%\\Microsoft\\Edge\\Application\\msedge.exe"',
    'if not exist "%EDGE%" set "EDGE=%ProgramFiles%\\Microsoft\\Edge\\Application\\msedge.exe"',
    'if exist "%EDGE%" (',
    '  start "" "%EDGE%" --app=%URL%',
    ") else (",
    "  start \"\" %URL%",
    ")",
    "exit /b 0",
    "",
  ].join("\r\n");
}

function installTxt() {
  return [
    "Real Simulator — локальный симулятор социальных ИИ-агентов.",
    "",
    "НИЧЕГО УСТАНАВЛИВАТЬ НЕ НУЖНО: Node.js уже в комплекте (app\\runtime).",
    "",
    "ЗАПУСК:",
    "  Двойной клик по START.bat:",
    "    - появится консоль сервера (её можно свернуть; закрыли — приложение",
    "      остановилось);",
    "    - через пару секунд само откроется окно приложения.",
    "  Если окно случайно закрыли — двойной клик по APP-WINDOW.bat.",
    "",
    "ГДЕ ДАННЫЕ:",
    "  База (SQLite) и все настройки — в папке app\\data. Не теряйте её:",
    "  там же лежат ключи провайдеров. Перенос на другой ПК = скопировать",
    "  всю папку целиком.",
    "",
    "ПЕРВЫЕ ШАГИ В ПРИЛОЖЕНИИ:",
    "  1. «Провайдеры» — добавьте LM Studio (локально, бесплатно), OpenRouter",
    "     или OpenCode Go (нужен API-ключ) — инструкции в самом приложении.",
    "  2. «Персонажи» — создайте агентов и выберите им модель.",
    "  3. «Сцены» — участники, цели, место; кнопка «Старт».",
    "",
    "ПОРТ ЗАНЯТ?",
    "  Если на этом ПК уже что-то слушает порт 3999, поменяйте PORT",
    "  в START.bat и APP-WINDOW.bat (например, на 4000) — в обоих файлах.",
    "",
    "АНТИВИРУС МОЖЕТ СПРОСИТЬ про app\\runtime\\node.exe — это обычный Node.js",
    "с официального сайта nodejs.org, разрешите его запуск.",
    "",
    "ОБНОВЛЕНИЕ: скачайте новую сборку и скопируйте папку app\\data из",
    "старой — вся ваша база переедет с ней.",
  ];
}
