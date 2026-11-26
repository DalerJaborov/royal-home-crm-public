#!/usr/bin/env node
/**
 * СТЕНД АГЕНТА ЗА ОДНУ КОМАНДУ (12.09.2026).
 *
 * ЗАЧЕМ. Замер ночной смены 11→12.09: из часа работы агента в изолированной
 * копии репозитория 10–20 минут уходило не на код, а на одно и то же —
 * junction-ссылки на общий `node_modules`, свой клиент Prisma, контейнер
 * Postgres, `migrate deploy`, `seed`. Каждый агент выводил этот рецепт заново
 * из задания и половину подводных камней находил заново же (память
 * `royalhome-env-traps-10-09`, `royalhome-worktree-isolated-prisma-client-10-09`).
 * Здесь рецепт один, проверенный, и запускается одной строкой.
 *
 * ЧТО ДЕЛАЕТ
 *   node scripts/agent-stand.mjs up   --api 4730 --web 5230
 *   node scripts/agent-stand.mjs down --api 4730 --web 5230   # те же флаги, что в up
 *
 * `up` печатает готовые строки запуска API и Vite с переменными окружения —
 * агенту остаётся их скопировать. `.env` не читается вообще: секреты для
 * стенда выдуманные и живут только в этой команде (правило владельца).
 *
 * БЫСТРЫЙ СТАРТ БАЗЫ. После первого `up` сделай `snapshot` — он кладёт
 * выгрузку базы с уже применёнными миграциями и сидом в `D:\CRM\.rh-stand`.
 * Дальше каждый `up` восстанавливает её вместо миграций и сида: замер 12.09 —
 * 33 секунды на весь стенд против 3-4 минут, и это на каждого агента.
 */
import { execFileSync, execSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MAIN_TREE = "D:\\CRM";
/**
 * ОДИН КОНТЕЙНЕР НА ВСЕХ, БАЗА ИЗ ШАБЛОНА (12.09.2026, второй заход).
 *
 * Первый вариант поднимал агенту свой контейнер Postgres. На машине владельца
 * 6 ядер и 16 ГБ, и при семи агентах свободной памяти оставалось 1,1 ГБ:
 * dev-серверы начинали падать, прогоны e2e сыпались таймаутами. Каждый лишний
 * контейнер это ещё 40-90 МБ и 20-30 секунд старта.
 *
 * Теперь контейнер один (`rh-stand-pg`, порт 15500), внутри эталонная база
 * `seeded` с применёнными миграциями и сидом, а агенту достаётся своя база
 * командой `CREATE DATABASE ... TEMPLATE seeded` — это копия на уровне файлов,
 * секунда вместо трёх минут, и памяти на неё почти не тратится.
 *
 * Про `docker commit` для снимка: не работает. Официальный образ postgres
 * объявляет каталог данных томом, снимок поднимается пустым. Эталон живёт
 * базой внутри общего контейнера.
 */
const PG_NAME = "rh-stand-pg";
const PG_PORT = "15500";
const TEMPLATE_DB = "seeded";

/**
 * РЕЖИМ БЕЗ DOCKER (26.11.2026). На ПК владельца Docker Desktop иногда мёртв
 * (зависшая виртуальная машина WSL, лечится только перезагрузкой), и тогда
 * нельзя ни снять кадры экранов, ни проверить их в браузере. Тот же стенд
 * умеет работать на ВНЕШНЕМ Postgres (portable-сборка, 127.0.0.1:15502):
 * все обращения к базе идут через помощники `pgRun`/`pgOut`/`pgDbExists`, а
 * какой из двух режимов включён, решает чистая `choosePgMode`.
 *   STAND_PG=external|docker   принудительно; без него: Docker отвечает — Docker,
 *                              не отвечает, а внешний Postgres доступен — внешний
 *   STAND_PG_HOST (127.0.0.1)  STAND_PG_PORT (15502)  STAND_PG_USER/PASSWORD (postgres)
 *   STAND_PG_BIN (D:\PgPortable\pgsql\bin)  STAND_PG_DATA (D:\PgPortable\data)
 */
const EXT_DEFAULTS = {
  host: "127.0.0.1",
  port: "15502",
  user: "postgres",
  password: "postgres",
  bin: "D:\\PgPortable\\pgsql\\bin",
  data: "D:\\PgPortable\\data",
};

/**
 * ВЫБОР РЕЖИМА — чистая функция (проверяется тестом без Docker и без Postgres).
 * `dockerOk` — ответил ли `docker version`; `externalUp` — доступен ли внешний
 * Postgres (слушает порт или его можно поднять).
 */
function choosePgMode({ env = {}, dockerOk, externalUp }) {
  const forced = String(env.STAND_PG ?? "").trim().toLowerCase();
  if (forced === "external") return { mode: "external", reason: "STAND_PG=external" };
  if (forced === "docker") return { mode: "docker", reason: "STAND_PG=docker" };
  if (forced !== "") return { mode: "docker", reason: `STAND_PG=${forced} не понят, беру Docker` };
  if (dockerOk) return { mode: "docker", reason: "Docker отвечает" };
  if (externalUp) return { mode: "external", reason: "Docker недоступен, внешний Postgres доступен" };
  return { mode: "docker", reason: "Docker недоступен и внешнего Postgres нет — дальше упадёт сам Docker" };
}

/** Параметры базы активного режима; `initPg()` заполняет их в начале команды. */
let PG = { mode: "docker", host: "localhost", port: PG_PORT, user: "postgres", password: "postgres", bin: "", data: "" };

function externalConfig(env = process.env) {
  return {
    mode: "external",
    host: env.STAND_PG_HOST || EXT_DEFAULTS.host,
    port: String(env.STAND_PG_PORT || EXT_DEFAULTS.port),
    user: env.STAND_PG_USER || EXT_DEFAULTS.user,
    password: env.STAND_PG_PASSWORD || EXT_DEFAULTS.password,
    bin: env.STAND_PG_BIN || EXT_DEFAULTS.bin,
    data: env.STAND_PG_DATA || EXT_DEFAULTS.data,
  };
}

const args = process.argv.slice(2);
const cmd = args[0] ?? "up";
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
/**
 * ПОРТ API — ЕДИНСТВЕННЫЙ КЛЮЧ СТЕНДА (24.09.2026). Раньше был ещё `--port`
 * (порт своего контейнера Postgres из первого варианта), и `--api` по
 * умолчанию считался из него (`--port 15470` → 4730). Контейнер давно один на
 * всех (PG_PORT), а `--port` остался и в подсказке `up`: «погасить: down --port
 * 15470». Агент, поднявший стенд с `--api 4760`, гасил его этой подсказкой и
 * сносил `agent_4730` — базу по умолчанию, то есть ЧУЖУЮ (18.09 и 23.09). Флаг
 * убран совсем: передали `--port` — отказ с объяснением, а не тихий пересчёт.
 */
if (args.includes("--port")) {
  console.error(
    "флаг --port больше не используется: контейнер Postgres один на всех (rh-stand-pg:" +
      PG_PORT +
      "). Стенд задаётся портом API: --api <порт> [--web <порт>]"
  );
  process.exit(2);
}
const apiPortGiven = args.includes("--api");
const apiPort = opt("api", "4730");
const webPort = opt("web", String(Number(apiPort) + 500));
if (!/^\d{2,5}$/.test(apiPort) || !/^\d{2,5}$/.test(webPort)) {
  console.error(`порты должны быть числами: --api ${apiPort} --web ${webPort}`);
  process.exit(2);
}

const sh = (c, o = {}) => execSync(c, { stdio: "pipe", encoding: "utf8", cwd: ROOT, ...o }).trim();
const shLoud = (c, o = {}) => execSync(c, { stdio: "inherit", cwd: ROOT, ...o });
const has = (c) => {
  try {
    sh(c);
    return true;
  } catch {
    return false;
  }
};

/** Junction вместо копии: общий `node_modules` весит гигабайты, копировать его
 *  в каждую копию репозитория нельзя, а `npm install` в общем дереве ломает
 *  соседние сессии (память `feedback_no_npm_install_in_main_tree_by_agents`). */
function link(from, to) {
  if (existsSync(from)) return "уже есть";
  mkdirSync(path.dirname(from), { recursive: true });
  execFileSync("cmd", ["/c", "mklink", "/J", from, to], { stdio: "pipe" });
  return "создана";
}

/**
 * ПОАПНЫЙ `node_modules` — НЕ ТОЛЬКО @royal-home/shared (14.09.2026).
 *
 * Прежний рецепт связывал корневой `node_modules` и создавал внутри
 * `apps/<app>/node_modules` ровно одну ссылку — на свой `packages/shared`.
 * Побочный эффект: `apps/<app>/node_modules` появлялся НАСТОЯЩЕЙ папкой и
 * ЗАСЛОНЯЛ собой одноимённую папку главного дерева, до которой поиск модулей
 * дальше уже не доходил (Node идёт вверх по дереву и берёт первую найденную).
 *
 * А там лежит не пустота: npm не поднимает наверх пакеты, версии которых
 * конфликтуют между workspace, и держит их копии по месту — в главном дереве
 * это `apps/api/node_modules` с express 5 и его зависимостями (18 пакетов) и
 * `apps/web/node_modules` с `@typescript-eslint/*`, `@vitejs/plugin-react`,
 * `@types/react-dom`, `ignore`. В корневом `node_modules` их НЕТ вовсе.
 *
 * Итог для агента в свежей копии: eslint, tsc и vite падали с «Cannot find
 * package '@typescript-eslint/parser'» и «Could not find a declaration file for
 * module 'react-dom'» — текст ровно такой же, как у по-настоящему битой
 * установки в общем дереве. Исполнитель 14.09 потратил на это время, проверяя
 * здоровое главное дерево (наблюдение 0351), и то же самое поймал сборщик.
 *
 * Почему не связать всю папку `apps/<app>/node_modules` целиком: вместе с
 * пакетами приедет и её `@royal-home/shared`, указывающий на сборку ГЛАВНОГО
 * дерева, — и задача, правящая `packages/shared`, молча проверялась бы на
 * чужом коде. Поэтому связываем каждую запись по отдельности, а `@royal-home`
 * остаётся своим.
 *
 * ЗАЩИТА НАПРАВЛЕНИЯ ССЫЛОК (17.09.2026, ловушка 15.09 из docs/TASKS.md).
 *
 * `apps/{api,web}/node_modules/@royal-home/shared` в ГЛАВНОМ дереве оказалась
 * ссылкой на `packages/shared` ЧУЖОГО worktree — главное дерево молча собирало
 * чужой код. Причина: `link()` видит `existsSync(from)` и останавливается на
 * «уже есть», не проверяя, КУДА ссылка на самом деле указывает. Для обычных
 * пакетов (react, express — read-only переиспользование общего дерева) это не
 * страшно: они везде одинаковые. Для `@royal-home/shared` это фатально: это
 * ЕДИНСТВЕННАЯ ссылка, которую каждое дерево обязано направить на СВОИ
 * собственные исходники, и перепутанное направление даёт зелёную сборку над
 * чужим кодом без единой ошибки.
 */
function linkTargetRealpath(p) {
  try {
    if (!lstatSync(p).isSymbolicLink()) return null; // обычный каталог — не наша ссылка
  } catch {
    return null; // пути нет вовсе
  }
  try {
    return realpathSync(p);
  } catch {
    return "<битая ссылка, цели не существует>";
  }
}

/** Куда ОБЯЗАНА указывать `apps/*\/node_modules/@royal-home/shared` для дерева `root`. */
function expectedSharedTarget(root) {
  const target = path.join(root, "packages", "shared");
  try {
    return realpathSync(target);
  } catch {
    return path.resolve(target); // ещё не существует — сравниваем по нормализованному пути
  }
}

/**
 * Единственное место, которое пишет в `apps/<app>/node_modules/@royal-home/shared`.
 * Отказывается молча переписывать существующую ссылку, если она указывает не
 * на СВОЁ дерево: чужая ссылка на этом месте означает либо чужую сессию, уже
 * пользующуюся ею (см. память `royalhome-worktree-shared-node-modules-prisma-lock`),
 * либо ровно ту путаницу, что дошла до главного дерева 15.09.
 */
function linkSharedOverride(from, root) {
  const expected = expectedSharedTarget(root);
  const current = linkTargetRealpath(from);
  if (current === null) {
    // Не ссылка: либо каталога нет вовсе (создаём), либо это настоящий каталог
    // (главное дерево после `npm install` — трогать нельзя ни при каких условиях).
    if (existsSync(from)) return "уже есть (настоящий каталог, не ссылка — не трогаю)";
    return link(from, path.join(root, "packages", "shared"));
  }
  if (path.resolve(current) === path.resolve(expected)) return "уже есть, указывает верно";
  throw new Error(
    `${from} уже указывает на ${current}, а ожидалось ${expected} (дерево ${root}). ` +
      "Не переписываю автоматически — возможно, ссылкой сейчас пользуется другая сессия; " +
      "проверь руками (node scripts/agent-stand.mjs check) и почини направление, если это чужая ошибка."
  );
}

/**
 * Отчёт о направлении ссылок `@royal-home/shared` — только чтение, без правок.
 * Смотрит ДВА дерева: это (`ROOT`, где сейчас запущен скрипт) и главное
 * (`D:\CRM`), потому что ловушка 15.09 ударила именно по главному дереву, а
 * агент почти никогда не запускает `up`/`check` из него самого — значит некому
 * было бы это заметить, не смотри мы туда явно.
 */
function checkLinkDirections() {
  const problems = [];
  const inspect = (root, label) => {
    const expected = expectedSharedTarget(root);
    for (const app of ["web", "api"]) {
      const from = path.join(root, "apps", app, "node_modules", "@royal-home", "shared");
      const current = linkTargetRealpath(from);
      if (current === null) continue; // не ссылка — либо каталог, либо просто нет, не наша забота
      if (path.resolve(current) !== path.resolve(expected)) {
        problems.push(`${label} apps/${app}/node_modules/@royal-home/shared -> ${current} (ожидалось ${expected})`);
      }
    }
  };
  inspect(ROOT, "это дерево");
  if (path.resolve(ROOT) !== path.resolve(MAIN_TREE)) inspect(MAIN_TREE, "главное дерево D:\\CRM");
  return problems;
}

/** `check` — read-only подкоманда: для ручного вызова и для `precheck`. */
function check() {
  const problems = checkLinkDirections();
  if (problems.length === 0) {
    console.log("ссылки @royal-home/shared в порядке (это дерево и главное D:\\CRM)");
    return;
  }
  console.log("⚠ ссылки @royal-home/shared указывают не туда:");
  for (const p of problems) console.log("  " + p);
  process.exitCode = 1;
}

function setupTree() {
  const steps = [];
  steps.push(`node_modules: ${link(path.join(ROOT, "node_modules"), path.join(MAIN_TREE, "node_modules"))}`);
  for (const app of ["web", "api"]) {
    // ЧАСТЬ ЗАВИСИМОСТЕЙ ЖИВЁТ НЕ В КОРНЕ (15.09.2026). npm кладёт пакет в
    // `apps/<app>/node_modules`, когда версия расходится с корневой — так у
    // apps/web оказались `@vitejs/plugin-react`, `@typescript-eslint/*` и
    // `@types/*`. Ссылки на них не было, и в рабочей копии агента не
    // поднимался Vite и падал eslint: три агента подряд доложили «сборка не
    // проходит», каждый потратил на выяснение по десять минут и НИ ОДИН не
    // смог снять кадр — то есть проверка глазами не делалась вовсе.
    //
    // Связываем ПОЭЛЕМЕНТНО, а не папку целиком: общий джанкшен на
    // `apps/web/node_modules` подменил бы и `@royal-home/shared`, и главное
    // дерево собирало бы чужой код (память
    // `royalhome-shared-tree-git-add-and-junction-traps-14-09`). Своё
    // `@royal-home` поэтому пропускаем и делаем ссылку на исходники ниже.
    const mainAppModules = path.join(MAIN_TREE, "apps", app, "node_modules");
    if (existsSync(mainAppModules)) {
      for (const entry of readdirSync(mainAppModules)) {
        if (entry === "@royal-home" || entry === ".bin") continue;
        link(path.join(ROOT, "apps", app, "node_modules", entry), path.join(mainAppModules, entry));
      }
      steps.push(`apps/${app}/node_modules: связаны пакеты главного дерева`);
    }
    steps.push(
      `apps/${app}/node_modules/@royal-home/shared: ${linkSharedOverride(
        path.join(ROOT, "apps", app, "node_modules", "@royal-home", "shared"),
        ROOT
      )}`
    );
  }
  return steps;
}

/**
 * Клиент Prisma. С версии 7 генератор пишет его в дерево ИСХОДНИКОВ
 * (`apps/api/src/generated/prisma`, см. `output` в схеме), а не в общий
 * `node_modules`, — то есть у каждой копии репозитория он свой сам по себе.
 * Прежний обходной рецепт (временная схема с подменённым `output` и копия
 * пакета `@prisma/client` в свой `node_modules`) существовал ровно затем,
 * чтобы соседняя сессия не получила клиент под чужую схему; теперь этой беды
 * нет, и от рецепта остался обычный вызов.
 */
function setupPrisma() {
  shLoud("npm run prisma:generate --workspace=apps/api");
  return "сгенерирован в apps/api/src/generated/prisma";
}

/** Имя базы агента выводится из порта API: у каждого агента он свой. */
const dbName = `agent_${apiPort}`;

/**
 * ОКРУЖЕНИЕ СТЕНДА — ОДНО МЕСТО НА `up` И `serve` (20.11.2026).
 *
 * Раньше список переменных жил дважды: строкой в подсказке `up` и списком
 * `$env:` в `serve`. Они разошлись — разные ключи JWT, а главное, ни в одном не
 * было `LOGIN_CODE_DEV_ECHO=1`. Вход в CRM с 19.10.2026 только по коду из СМС;
 * без этой переменной сервер стенда кода в ответе не отдаёт, СМС не уходит
 * (провайдера нет), и войти через форму нельзя вовсе: `auth.setup` e2e падал по
 * таймауту на пустом поле кода при исправном приложении (18.11, Чат 3).
 *
 * Код в ответе сервер отдаёт только вне production (lib/loginSmsCode.ts), а
 * env-check.ts не даёт серверу стартовать с этой переменной в production, —
 * поэтому NODE_ENV здесь обязан оставаться development.
 */
function standEnv(api = apiPort, web = webPort) {
  return {
    DATABASE_URL: dbUrl(`agent_${api}`),
    JWT_ACCESS_SECRET: `stand-${api}-access-secret-0123456789`,
    JWT_REFRESH_SECRET: `stand-${api}-refresh-secret-0123456789`,
    SETTINGS_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", // gitleaks:allow -- reviewed synthetic test value or non-secret identifier
    PORT: String(api),
    API_RATE_LIMIT: "1000000",
    NODE_ENV: "development",
    LOGIN_CODE_DEV_ECHO: "1",
    CORS_ORIGIN: `http://localhost:${web}`,
    // Без этого Vite проксирует /api на свой умолчательный :4000 — чужой сервер
    // с другой базой и другими ключами, и вход в интерфейсе отвечает 500 при
    // полностью здоровом своём API (поймано на проверке 12.09).
    VITE_API_PROXY: `http://localhost:${api}`,
  };
}

/** Строка для e2e против своего стенда: тот же адрес, что поднял `serve`. */
function e2eHint(api = apiPort, web = webPort) {
  return `cd apps/web && E2E_BASE_URL=http://localhost:${web} E2E_API_URL=http://localhost:${api} npx playwright test --grep @smoke`;
}
/** Адрес базы активного режима (в Docker-режиме — прежний `localhost:15500`). */
function dbUrl(db) {
  return `postgresql://${PG.user}:${PG.password}@${PG.host}:${PG.port}/${db}`;
}

/** psql.exe напрямую (внешний режим): пароль через PGPASSWORD, не через командную строку. */
const extPsqlFile = () => path.join(PG.bin, "psql.exe");
const extEnv = () => ({ ...process.env, PGPASSWORD: PG.password });
const extArgs = (db, more) => ["-h", PG.host, "-p", PG.port, "-U", PG.user, "-d", db, "-v", "ON_ERROR_STOP=1", ...more];

/** Выполнить SQL с выводом в консоль (CREATE/DROP/ALTER/COMMENT). */
function pgRun(sql, db = "postgres") {
  if (PG.mode === "docker") {
    return shLoud(`docker exec ${PG_NAME} psql -U postgres -d ${db} -v ON_ERROR_STOP=1 -c ${JSON.stringify(sql)}`);
  }
  return execFileSync(extPsqlFile(), extArgs(db, ["-c", sql]), { stdio: "inherit", cwd: ROOT, env: extEnv() });
}

/** DROP DATABASE: во внешнем режиме с FORCE (Postgres 13+) — база может держать чужое соединение от умершего стенда. */
const dropSql = (db, ifExists) => `DROP DATABASE ${ifExists ? "IF EXISTS " : ""}${db}${PG.mode === "external" ? " WITH (FORCE)" : ""}`;

/** Общий контейнер поднимается один раз и живёт между агентами. */
function ensureServer() {
  if (PG.mode === "external") return ensureExternalServer();
  if (!has(`docker container inspect ${PG_NAME}`)) {
    shLoud(
      `docker run -d --name ${PG_NAME} -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=postgres -p ${PG_PORT}:5432 postgres:16-alpine`
    );
  } else if (sh(`docker inspect -f "{{.State.Running}}" ${PG_NAME}`) !== "true") {
    shLoud(`docker start ${PG_NAME}`);
  }
  for (let i = 0; i < 60; i++) {
    if (has(`docker exec ${PG_NAME} pg_isready -U postgres`)) return;
    execSync('node -e "setTimeout(()=>{},1000)"');
  }
  throw new Error("Postgres не поднялся");
}

/** Внешний Postgres принимает соединения? (pg_isready.exe из его же bin; код 0 = да) */
function externalReady(cfg = PG) {
  try {
    execFileSync(path.join(cfg.bin, "pg_isready.exe"), ["-h", cfg.host, "-p", cfg.port, "-U", cfg.user], { stdio: "ignore", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/** Можно ли поднять внешний Postgres сами: есть pg_ctl.exe и каталог данных (и это локальный хост). */
function externalStartable(cfg) {
  return ["127.0.0.1", "localhost"].includes(cfg.host) && existsSync(path.join(cfg.bin, "pg_ctl.exe")) && existsSync(cfg.data);
}

/** Внешний Postgres: если не слушает — запускаем `pg_ctl start` (portable-сборка), ждём готовности. */
function ensureExternalServer() {
  if (externalReady()) return;
  if (!externalStartable(PG)) {
    throw new Error(`внешний Postgres ${PG.host}:${PG.port} не отвечает, а запустить его нечем (нужны ${path.join(PG.bin, "pg_ctl.exe")} и каталог данных ${PG.data})`);
  }
  console.log(`  внешний Postgres ${PG.host}:${PG.port} не отвечает, запускаю pg_ctl start`);
  const log = path.join(path.dirname(PG.data), "pg.log");
  execFileSync(path.join(PG.bin, "pg_ctl.exe"), ["-D", PG.data, "-l", log, "-w", "-t", "60", "start"], { stdio: "inherit" });
  for (let i = 0; i < 30; i++) {
    if (externalReady()) return;
    execSync('node -e "setTimeout(()=>{},1000)"');
  }
  throw new Error(`Postgres ${PG.host}:${PG.port} не поднялся после pg_ctl start`);
}

/**
 * ВЫБОР И ВКЛЮЧЕНИЕ РЕЖИМА. Вызывается один раз в начале up/serve/refresh/down.
 * Docker проверяем коротко (`docker version` с таймаутом ~5 с): живой Docker
 * отвечает за доли секунды, а мёртвая виртуальная машина WSL молча виснет.
 */
function initPg() {
  const ext = externalConfig();
  const forced = String(process.env.STAND_PG ?? "").trim() !== "";
  let dockerOk = true;
  let externalUp = false;
  if (!forced) {
    try {
      execFileSync("docker", ["version", "--format", "{{.Server.Version}}"], { stdio: "pipe", timeout: 5000, windowsHide: true });
    } catch {
      dockerOk = false;
    }
    if (!dockerOk) externalUp = externalReady(ext) || externalStartable(ext);
  }
  const choice = choosePgMode({ env: process.env, dockerOk, externalUp });
  if (choice.mode === "external") {
    PG = ext;
    console.log(`${forced ? "Режим внешней базы" : "Docker недоступен"} — стенд на внешнем Postgres ${PG.host}:${PG.port}  (${choice.reason})`);
  } else {
    PG = { ...PG, mode: "docker" };
  }
  return choice;
}

/**
 * ЭТАЛОН СОБИРАЕТСЯ ПОД ВРЕМЕННЫМ ИМЕНЕМ И ПЕРЕИМЕНОВЫВАЕТСЯ ТОЛЬКО ПОСЛЕ УСПЕХА
 * (аудит Codex 04.10, OPS09). Раньше `CREATE DATABASE seeded` шёл первым, а
 * миграции и сид после него: упали они — пустая или недонакатанная `seeded`
 * оставалась, следующий `up` видел запись в pg_database, считал эталон готовым и
 * клонировал его в базу агента; так же `refresh` дропал рабочий эталон ДО сборки
 * нового, а параллельный `up` соседа клонировал недособранную базу посреди сборки.
 * Теперь: своя база `seeded_building_<порт API>` → миграции → сид → метка в
 * комментарии базы → DROP старого → RENAME. Упало на любом шаге — временная
 * база сносится, а прежний эталон остаётся нетронутым.
 */
const READY_MARK = "rh-stand-ready";

/** Один psql-запрос с ответом: SQL идёт через stdin, чтобы кавычки таблиц ("Agent") не ломались о оболочку. */
const psqlOut = (sql, db = "postgres") =>
  PG.mode === "docker"
    ? execSync(`docker exec -i ${PG_NAME} psql -U postgres -d ${db} -tA`, { input: sql, stdio: "pipe", encoding: "utf8", cwd: ROOT }).trim()
    : execFileSync(extPsqlFile(), extArgs(db, ["-tA"]), { input: sql, stdio: ["pipe", "pipe", "pipe"], encoding: "utf8", cwd: ROOT, env: extEnv() }).trim();

const tplUrl = (db) => dbUrl(db);
const apiDir = () => path.join(ROOT, "apps", "api");

/** Действия над общим контейнером; в тесте подменяются заглушкой. */
const realTemplateIo = {
  dbExists: (db) => dbExists(db),
  createDb: (db) => pgRun(`CREATE DATABASE ${db}`),
  dropDb: (db) => pgRun(dropSql(db, true)),
  renameDb: (from, to) => pgRun(`ALTER DATABASE ${from} RENAME TO ${to}`),
  setMark: (db) => pgRun(`COMMENT ON DATABASE ${db} IS '${READY_MARK}'`),
  hasMark: (db) => psqlOut(`SELECT shobj_description(oid, 'pg_database') FROM pg_database WHERE datname='${db}'`) === READY_MARK,
  // Эталон, собранный ДО появления метки: принимаем, только если миграции доехали
  // (нет незавершённых) и сид что-то записал (есть агенты).
  looksComplete: (db) => {
    try {
      return psqlOut(`SELECT (SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NULL) = 0 AND (SELECT count(*) FROM "Agent") > 0`, db) === "t";
    } catch {
      return false;
    }
  },
  // CLI Prisma 7 читает `apps/api/prisma.config.ts` (там и путь к схеме, и адрес
  // базы), а конфиг ищется от текущего каталога — отсюда `cwd`. Раз рабочий
  // каталог УЖЕ apps/api, флага `--workspace` быть не должно: изнутри воркспейса
  // npm его не разрешает («No workspaces found»).
  migrate: (db) => shLoud("npm run prisma:migrate:deploy", { cwd: apiDir(), env: { ...process.env, DATABASE_URL: tplUrl(db) } }),
  seed: (db) => shLoud("npx tsx prisma/seed.ts", { cwd: apiDir(), env: { ...process.env, DATABASE_URL: tplUrl(db) } }),
};

/** Эталон готов, только если он ЕСТЬ и помечен как собранный до конца. */
function templateIsReady(io) {
  if (!io.dbExists(TEMPLATE_DB)) return false;
  if (io.hasMark(TEMPLATE_DB)) return true;
  if (io.looksComplete(TEMPLATE_DB)) {
    io.setMark(TEMPLATE_DB);
    return true;
  }
  return false;
}

/**
 * Гарантирует готовый эталон. Возвращает "готов" | "собран" | "собрал сосед".
 * `force` (для refresh) пересобирает даже готовый, но старый заменяется только
 * после успешной сборки нового.
 */
function ensureTemplate(io = realTemplateIo, { force = false, building = `${TEMPLATE_DB}_building_${apiPort}`, log = () => {} } = {}) {
  if (!force && templateIsReady(io)) return "готов";
  log("  эталона нет или он недособран, собираю его (миграции и сид)");
  io.dropDb(building); // хвост нашего же прежнего упавшего запуска
  io.createDb(building);
  try {
    io.migrate(building);
    io.seed(building);
    io.setMark(building);
    // Пока строили, соседний up мог собрать свой эталон: берём его, свой выбрасываем.
    if (!force && templateIsReady(io)) {
      io.dropDb(building);
      return "собрал сосед";
    }
    io.dropDb(TEMPLATE_DB); // неполный или устаревший
    io.renameDb(building, TEMPLATE_DB);
  } catch (err) {
    try {
      io.dropDb(building);
    } catch {
      /* не удалось убрать временную базу: следующий запуск сам её пересоздаст */
    }
    throw err;
  }
  return "собран";
}

async function up() {
  initPg();
  guardForeignStand();
  await ensurePortsUsable();
  console.log("== дерево");
  try {
    for (const s of setupTree()) console.log("  " + s);
  } catch (err) {
    console.error("  ОТКАЗ: " + (err instanceof Error ? err.message : String(err)));
    process.exit(1);
  }
  // Своя ссылка в порядке (иначе setupTree() уже упал выше) — но ловушка 15.09
  // ударила по ГЛАВНОМУ дереву, а не по worktree, поэтому проверяем и его: у
  // агента почти никогда нет повода зайти в D:\CRM и заметить неладное самому.
  const foreignProblems = checkLinkDirections().filter((p) => p.startsWith("главное дерево"));
  if (foreignProblems.length) {
    console.log("⚠ главное дерево D:\\CRM: ссылки @royal-home/shared указывают не туда (не трогаю, разбирайся руками):");
    for (const p of foreignProblems) console.log("  " + p);
  }

  console.log("== клиент Prisma");
  console.log("  " + setupPrisma());

  console.log("== база");
  ensureServer();
  ensureTemplate(realTemplateIo, { log: (m) => console.log(m) });
  // Своя база агента копией эталона: копирование на уровне файлов, ~1 секунда.
  try {
    pgRun(dropSql(dbName, true));
  } catch {
    /* базы могло не быть */
  }
  pgRun(`CREATE DATABASE ${dbName} TEMPLATE ${TEMPLATE_DB}`);
  writeStandState();
  console.log(`  своя база ${dbName} готова копией эталона (${PG.mode === "docker" ? "Docker " + PG_NAME : "внешний Postgres"} ${PG.host}:${PG.port})`);
  // ДОКАТИТЬ МИГРАЦИИ ПОВЕРХ ЭТАЛОНА (20.11.2026). Эталон пересобирается только
  // руками (`refresh`), и 18.11 он отстал от main на 28 миграций, к 20.11 — на 36:
  // стенд поднимался «зелёным», а API падал на первом же запросе к новой колонке,
  // вход и e2e краснели при исправном коде. `migrate deploy` докатывает ровно
  // недостающее из ЭТОГО дерева в СВОЮ базу (эталон и чужие базы не трогает) и
  // при свежем эталоне ничего не делает.
  realTemplateIo.migrate(dbName);
  console.log(`  миграции этого дерева сверены с ${dbName}, недостающие докачены (если их было много — пересобери эталон: node scripts/agent-stand.mjs refresh)`);

  const env = Object.entries(standEnv())
    .filter(([k]) => k !== "VITE_API_PROXY")
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");

  console.log("\n== запусти сервер API (в отдельной команде):");
  console.log(`cd apps/api && ${env} npx tsx src/index.ts`);
  console.log("\n== запусти Vite:");
  console.log(`cd apps/web && VITE_API_PROXY=http://localhost:${apiPort} npx vite --port ${webPort} --strictPort`);
  console.log("\n== e2e против этого стенда (после serve):");
  console.log(e2eHint());
  console.log("\n== для тестов API:");
  console.log(`cd apps/api && ${env} NODE_ENV=test npx vitest run <файлы>`);
  console.log("\n== учётки сида: +99290000000N (0 директор, 2 агент, 4 руководитель, 5 маркетинг); вход только формой, код стенд подставит сам");
  // Подсказка повторяет РОВНО те флаги, что были в `up`: `down` без `--api`
  // отказывается работать, чтобы не снести базу по умолчанию (см. разбор
  // флагов вверху файла).
  console.log(`== погасить: node scripts/agent-stand.mjs down --api ${apiPort} --web ${webPort}`);
}


/**
 * ВЛАДЕЛЕЦ БАЗЫ СТЕНДА (26.11.2026). Память проекта: «другой чат взял тот же
 * порт, его `down` удалил мою базу». Имя базы выводится из порта API, и два чата
 * с одним `--api` делили одну `agent_<порт>`. Теперь `up` пишет запись
 * `.rh-stand/state-<порт>.json` (какое дерево, какая база, какой режим), а
 * `down` сносит базу только по записи СВОЕГО дерева; `up` не затирает чужую
 * (оба отказа обходятся только явным `--force`).
 */
const stateFile = () => path.join(MAIN_TREE, ".rh-stand", `state-${apiPort}.json`);
const sameTree = (a, b) => path.resolve(String(a)).toLowerCase() === path.resolve(String(b)).toLowerCase();

function readStandState() {
  try {
    return JSON.parse(readFileSync(stateFile(), "utf8"));
  } catch {
    return null;
  }
}

function writeStandState() {
  mkdirSync(path.dirname(stateFile()), { recursive: true });
  writeFileSync(
    stateFile(),
    JSON.stringify({ dbName, apiPort, webPort, root: ROOT, mode: PG.mode, host: PG.host, pgPort: PG.port, createdAt: new Date().toISOString() }, null, 2)
  );
}

/** serve и down работают с тем режимом базы, в котором стенд поднял `up` (запись состояния), если режим не задан явно. */
function adoptStateMode() {
  const st = readStandState();
  if (!st || process.env.STAND_PG) return;
  process.env.STAND_PG = st.mode;
  if (st.mode === "external") {
    if (st.host) process.env.STAND_PG_HOST ??= st.host;
    if (st.pgPort) process.env.STAND_PG_PORT ??= String(st.pgPort);
  }
}

/** `up` на порту, где уже стоит стенд ДРУГОГО дерева, отказывает. */
function guardForeignStand() {
  const st = readStandState();
  if (st && st.root && !sameTree(st.root, ROOT) && !args.includes("--force")) {
    console.error(
      `порт API ${apiPort} уже занят стендом другого дерева (${st.root}, база ${st.dbName}). ` +
        `Возьми другой --api (например ${Number(apiPort) + 10}) или, если тот стенд мёртв, повтори с --force`
    );
    process.exit(1);
  }
}

/**
 * ПОРТЫ API И VITE: свободны ли и можно ли их вообще занять. На Windows часть
 * портов лежит в «исключённом диапазоне» (Hyper-V/WSL/Docker резервируют их, привязка
 * даёт EACCES; память `royalhome-windows-excluded-ports-stand-24-09`) — сервер на
 * таком порту умирает без внятной причины. Проверяем привязкой и предлагаем
 * ближайшую пару свободных портов.
 */
function portProblem(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", (e) => resolve(e.code === "EACCES" ? "в исключённом диапазоне Windows" : e.code === "EADDRINUSE" ? "занят" : String(e.code)));
    srv.listen(Number(port), "127.0.0.1", () => srv.close(() => resolve(null)));
  });
}

async function ensurePortsUsable() {
  if (existsSync(path.join(MAIN_TREE, ".rh-stand", `pids-${apiPort}.json`))) return; // свой стенд уже запущен — порты заняты им
  const bad = [];
  for (const [label, port] of [["API", apiPort], ["Vite", webPort]]) {
    const why = await portProblem(port);
    if (why) bad.push(`${label} ${port}: ${why}`);
  }
  if (!bad.length) return;
  let a = Number(apiPort) + 10;
  for (let i = 0; i < 50; i++, a += 10) {
    if (!(await portProblem(a)) && !(await portProblem(a + 500))) {
      console.error(`порты недоступны (${bad.join("; ")}). Предлагаю: --api ${a} --web ${a + 500}`);
      process.exit(1);
    }
  }
  console.error(`порты недоступны (${bad.join("; ")}), подходящей пары рядом не нашёл — укажи другие вручную`);
  process.exit(1);
}

/**
 * ОТВЯЗАННЫЕ СЕРВЕРЫ (12.09.2026). Dev-серверы, запущенные фоновой командой
 * чата, умирают вместе с ней: за ночь Vite падал с кодом 127 трижды посреди
 * прогонов e2e, и каждый раз это 5-15 минут на разбор и перезапуск. Причина в
 * том, что процесс остаётся ребёнком фоновой задачи. `Start-Process` отвязывает
 * его от родителя: сервер живёт, пока его не погасят явно.
 *
 * Идентификаторы процессов пишутся рядом с логами, чтобы `down` гасил ровно
 * свои, а не всё подряд по строке «tsx src/index.ts» — так одна сессия уже
 * уронила стенд соседней.
 */
async function serve() {
  adoptStateMode();
  initPg();
  await ensurePortsUsable();
  const dir = path.join(MAIN_TREE, ".rh-stand");
  mkdirSync(dir, { recursive: true });
  const apiLog = path.join(dir, `api-${apiPort}.log`);
  const webLog = path.join(dir, `web-${webPort}.log`);
  const pidFile = path.join(dir, `pids-${apiPort}.json`);

  // Одно место с `up` (standEnv выше): тот самый список, в котором 18.11 не
  // оказалось LOGIN_CODE_DEV_ECHO.
  const env = Object.entries(standEnv())
    .map(([k, v]) => `$env:${k}='${v}'`)
    .join("; ");

  const start = (cwd, cmdline, log) =>
    execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        `${env}; $p = Start-Process -PassThru -WindowStyle Hidden -WorkingDirectory '${cwd}' ` +
          `-FilePath 'cmd.exe' -ArgumentList '/c ${cmdline} > "${log}" 2>&1'; $p.Id`,
      ],
      { encoding: "utf8" }
    ).trim();

  const apiPid = start(path.join(ROOT, "apps", "api"), "npx tsx src/index.ts", apiLog);
  const webPid = start(
    path.join(ROOT, "apps", "web"),
    `npx vite --port ${webPort} --strictPort`,
    webLog
  );
  writeFileSync(pidFile, JSON.stringify({ apiPid, webPid, apiPort, webPort, dbName }, null, 2));

  console.log(`API  pid ${apiPid}  http://localhost:${apiPort}/api/v1/health   лог ${apiLog}`);
  console.log(`Vite pid ${webPid}  http://localhost:${webPort}                 лог ${webLog}`);
  console.log(`e2e:      ${e2eHint()}`);
  console.log(`погасить: node scripts/agent-stand.mjs down --api ${apiPort}`);
}

/** Гасим ровно свои процессы по записанным идентификаторам. */
/**
 * ГАСИМ ТОЛЬКО ЕСЛИ ЭТО ВСЁ ЕЩЁ НАШ ПРОЦЕСС (20.11.2026).
 *
 * Файл с PID переживает сами процессы: стенд погас (перезагрузка, закрытое
 * окно), файл остался. Windows быстро выдаёт освободившиеся номера заново, и
 * `taskkill /PID <старый> /T` по такому файлу убивал ЧУЖОЕ дерево процессов —
 * вместе с API соседнего стенда. 20.11 у Чата 3 сервер API четыре раза исчезал
 * посреди прогона e2e без единой строки ошибки, каждый раз рядом с чужим
 * `down`/`serve` (04:01:41 смерть, 04:01:51 соседний serve на 4796).
 *
 * Свой процесс узнаём по командной строке: `serve` запускает `cmd.exe /c ... >
 * "<.rh-stand>\api-<порт>.log"` — путь к логу с портом есть только у нашего.
 */
function pidBelongsToStand(commandLine, marker) {
  return typeof commandLine === "string" && commandLine.includes(marker);
}

function commandLineOf(pid) {
  try {
    return execFileSync(
      "powershell",
      ["-NoProfile", "-Command", `(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}").CommandLine`],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    ).trim();
  } catch {
    return "";
  }
}

function killServers() {
  const pidFile = path.join(MAIN_TREE, ".rh-stand", `pids-${apiPort}.json`);
  if (!existsSync(pidFile)) return "серверов не запускали";
  const saved = JSON.parse(readFileSync(pidFile, "utf8"));
  const report = [];
  for (const [pid, marker] of [
    [saved.apiPid, `api-${saved.apiPort ?? apiPort}.log`],
    [saved.webPid, `web-${saved.webPort ?? webPort}.log`],
  ]) {
    if (!/^\d+$/.test(String(pid))) continue;
    if (!pidBelongsToStand(commandLineOf(pid), marker)) {
      report.push(`${pid} уже не наш (процесс завершён или номер занят другим) — не трогаю`);
      continue;
    }
    try {
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "pipe" });
      report.push(`${pid} остановлен`);
    } catch {
      report.push(`${pid} завершился сам`);
    }
  }
  rmSync(pidFile, { force: true });
  return `процессы: ${report.join("; ")}`;
}

/** Пересобрать эталон после новых миграций: один раз на всех. */
function refresh() {
  initPg();
  ensureServer();
  ensureTemplate(realTemplateIo, { force: true, log: (m) => console.log(m) });
  console.log("эталон пересобран, следующие стенды получат свежую схему");
}

/** Есть ли база агента: спрашиваем каталог, а не полагаемся на `IF EXISTS`,
 *  чтобы «удалена» в выводе значило именно удаление, а не пустой ход. */
function dbExists(db) {
  try {
    if (PG.mode === "docker") return sh(`docker exec ${PG_NAME} psql -U postgres -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='${db}'"`) === "1";
    return psqlOut(`SELECT 1 FROM pg_database WHERE datname='${db}'`) === "1";
  } catch {
    return false;
  }
}

function down() {
  // `--api` обязателен: без него dbName это база по умолчанию (agent_4730), и
  // именно так две сессии снесли чужой стенд. Нет флага — нет и догадок.
  if (!apiPortGiven) {
    console.error("укажи --api <порт> — тот же, что был в up (например: down --api 4760). Без флага down ничего не трогает");
    process.exit(2);
  }
  adoptStateMode();
  initPg();
  // ЧУЖОЙ СТЕНД НЕ ГАСИМ (26.11.2026): ни процессы, ни базу — только по записи
  // `up` ЭТОГО же дерева.
  const st = readStandState();
  if (!args.includes("--force")) {
    if (!st) {
      console.error(`записи стенда для порта ${apiPort} нет: его поднимал не этот up (или другая версия скрипта). Ничего не трогаю; если уверен — повтори с --force`);
      process.exit(1);
    }
    if (!sameTree(st.root, ROOT)) {
      console.error(`стенд на порту ${apiPort} поднят из другого дерева (${st.root}) — не трогаю. Гасить его надо оттуда (или --force)`);
      process.exit(1);
    }
  }
  const dbToDrop = st?.dbName ?? dbName;
  console.log(killServers());
  if (PG.mode === "docker" && !has(`docker container inspect ${PG_NAME}`)) {
    console.log(`контейнера ${PG_NAME} нет, базу удалять негде`);
    return;
  }
  ensureServer();
  if (!dbExists(dbToDrop)) {
    console.error(`база ${dbToDrop} не найдена: либо стенд поднимали с другим --api, либо он уже погашен`);
    rmSync(stateFile(), { force: true });
    process.exit(1);
  }
  pgRun(dropSql(dbToDrop, false));
  rmSync(stateFile(), { force: true });
  console.log(PG.mode === "docker" ? `база ${dbToDrop} удалена, общий контейнер ${PG_NAME} оставлен другим агентам` : `база ${dbToDrop} удалена, внешний Postgres ${PG.host}:${PG.port} оставлен другим агентам`);
  console.log("порты API и Vite гаси по своим PID: netstat -ano | grep \":<порт> \" и taskkill //PID <pid> //F");
}

// Запускать команду только когда файл выполняется напрямую (`node
// scripts/agent-stand.mjs ...`), а не когда его импортируют — тест
// (`scripts/agent-stand-links.test.mjs`) импортирует чистые функции проверки
// направления ссылок и не должен по пути поднимать базу или трогать диск.
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  if (cmd === "up") await up();
  else if (cmd === "serve") await serve();
  else if (cmd === "down") down();
  else if (cmd === "refresh") refresh();
  else if (cmd === "check") check();
  else {
    console.log("команды: up | serve | refresh | down | check   (опции: --api --web --force)");
    process.exit(1);
  }
}

export { choosePgMode, externalConfig, linkTargetRealpath, expectedSharedTarget, checkLinkDirections, linkSharedOverride, ensureTemplate, templateIsReady, READY_MARK, standEnv, e2eHint, pidBelongsToStand };
