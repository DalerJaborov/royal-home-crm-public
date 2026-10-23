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
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** Worktrees share a Git directory with the primary checkout. Never reuse an
 * archived repository's dependencies after the public-source migration. */
export function resolveMainTree(root) {
  const commonDir = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
    cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  return path.dirname(path.resolve(root, commonDir));
}
const MAIN_TREE = resolveMainTree(ROOT);
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
  if (path.resolve(ROOT) !== path.resolve(MAIN_TREE)) inspect(MAIN_TREE, `главное дерево ${MAIN_TREE}`);
  return problems;
}

/** `check` — read-only подкоманда: для ручного вызова и для `precheck`. */
function check() {
  const problems = checkLinkDirections();
  if (problems.length === 0) {
    console.log(`ссылки @royal-home/shared в порядке (это дерево и главное ${MAIN_TREE})`);
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
const DB_URL = `postgresql://postgres:postgres@localhost:${PG_PORT}/${dbName}`;
const psql = (sql, db = "postgres") =>
  `docker exec ${PG_NAME} psql -U postgres -d ${db} -v ON_ERROR_STOP=1 -c ${JSON.stringify(sql)}`;

/** Общий контейнер поднимается один раз и живёт между агентами. */
function ensureServer() {
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
  execSync(`docker exec -i ${PG_NAME} psql -U postgres -d ${db} -tA`, { input: sql, stdio: "pipe", encoding: "utf8", cwd: ROOT }).trim();

const tplUrl = (db) => `postgresql://postgres:postgres@localhost:${PG_PORT}/${db}`;
const apiDir = () => path.join(ROOT, "apps", "api");

/** Действия над общим контейнером; в тесте подменяются заглушкой. */
const realTemplateIo = {
  dbExists: (db) => dbExists(db),
  createDb: (db) => shLoud(psql(`CREATE DATABASE ${db}`)),
  dropDb: (db) => shLoud(psql(`DROP DATABASE IF EXISTS ${db}`)),
  renameDb: (from, to) => shLoud(psql(`ALTER DATABASE ${from} RENAME TO ${to}`)),
  setMark: (db) => shLoud(psql(`COMMENT ON DATABASE ${db} IS '${READY_MARK}'`)),
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

function up() {
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
    console.log(`⚠ главное дерево ${MAIN_TREE}: ссылки @royal-home/shared указывают не туда (не трогаю, разбирайся руками):`);
    for (const p of foreignProblems) console.log("  " + p);
  }

  console.log("== клиент Prisma");
  console.log("  " + setupPrisma());

  console.log("== база");
  ensureServer();
  ensureTemplate(realTemplateIo, { log: (m) => console.log(m) });
  // Своя база агента копией эталона: копирование на уровне файлов, ~1 секунда.
  try {
    shLoud(psql(`DROP DATABASE IF EXISTS ${dbName}`));
  } catch {
    /* базы могло не быть */
  }
  shLoud(psql(`CREATE DATABASE ${dbName} TEMPLATE ${TEMPLATE_DB}`));
  console.log(`  своя база ${dbName} готова копией эталона`);

  const env =
    `DATABASE_URL=${DB_URL} ` +
    `JWT_ACCESS_SECRET=stand-${apiPort}-access-secret-0123456789 ` +
    `JWT_REFRESH_SECRET=stand-${apiPort}-refresh-secret-0123456789 ` +
    `SETTINGS_ENCRYPTION_KEY=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef ` + // gitleaks:allow -- reviewed synthetic test value or non-secret identifier
    `PORT=${apiPort} API_RATE_LIMIT=1000000 NODE_ENV=development CORS_ORIGIN=http://localhost:${webPort}`;

  console.log("\n== запусти сервер API (в отдельной команде):");
  console.log(`cd apps/api && ${env} npx tsx src/index.ts`);
  console.log("\n== запусти Vite:");
  console.log(`cd apps/web && VITE_API_PROXY=http://localhost:${apiPort} npx vite --port ${webPort} --strictPort`);
  console.log("\n== для тестов API:");
  console.log(`cd apps/api && ${env} NODE_ENV=test npx vitest run <файлы>`);
  console.log("\n== учётки сида: +99290000000N / password123 (0 директор, 2 агент, 4 руководитель, 5 маркетинг)");
  // Подсказка повторяет РОВНО те флаги, что были в `up`: `down` без `--api`
  // отказывается работать, чтобы не снести базу по умолчанию (см. разбор
  // флагов вверху файла).
  console.log(`== погасить: node scripts/agent-stand.mjs down --api ${apiPort} --web ${webPort}`);
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
function serve() {
  const dir = path.join(MAIN_TREE, ".rh-stand");
  mkdirSync(dir, { recursive: true });
  const apiLog = path.join(dir, `api-${apiPort}.log`);
  const webLog = path.join(dir, `web-${webPort}.log`);
  const pidFile = path.join(dir, `pids-${apiPort}.json`);

  const env = [
    `$env:DATABASE_URL='${DB_URL}'`,
    `$env:JWT_ACCESS_SECRET='stand-access-secret-0123456789'`,
    `$env:JWT_REFRESH_SECRET='stand-refresh-secret-0123456789'`,
    `$env:SETTINGS_ENCRYPTION_KEY='0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'`, // gitleaks:allow -- reviewed synthetic test value or non-secret identifier
    `$env:PORT='${apiPort}'`,
    `$env:API_RATE_LIMIT='1000000'`,
    `$env:NODE_ENV='development'`,
    `$env:CORS_ORIGIN='http://localhost:${webPort}'`,
    // Без этого Vite проксирует /api на свой умолчательный :4000 — чужой сервер
    // с другой базой и другими ключами, и вход в интерфейсе отвечает 500 при
    // полностью здоровом своём API (поймано на проверке 12.09).
    `$env:VITE_API_PROXY='http://localhost:${apiPort}'`,
  ].join("; ");

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
  console.log(`погасить: node scripts/agent-stand.mjs down --api ${apiPort}`);
}

/** Гасим ровно свои процессы по записанным идентификаторам. */
function killServers() {
  const pidFile = path.join(MAIN_TREE, ".rh-stand", `pids-${apiPort}.json`);
  if (!existsSync(pidFile)) return "серверов не запускали";
  const { apiPid, webPid } = JSON.parse(readFileSync(pidFile, "utf8"));
  for (const pid of [apiPid, webPid]) {
    try {
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "pipe" });
    } catch {
      /* процесс мог уже завершиться */
    }
  }
  rmSync(pidFile, { force: true });
  return `процессы ${apiPid} и ${webPid} остановлены`;
}

/** Пересобрать эталон после новых миграций: один раз на всех. */
function refresh() {
  ensureServer();
  ensureTemplate(realTemplateIo, { force: true, log: (m) => console.log(m) });
  console.log("эталон пересобран, следующие стенды получат свежую схему");
}

/** Есть ли база агента: спрашиваем каталог, а не полагаемся на `IF EXISTS`,
 *  чтобы «удалена» в выводе значило именно удаление, а не пустой ход. */
function dbExists(db) {
  try {
    return sh(`docker exec ${PG_NAME} psql -U postgres -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='${db}'"`) === "1";
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
  console.log(killServers());
  if (!has(`docker container inspect ${PG_NAME}`)) {
    console.log(`контейнера ${PG_NAME} нет, базу удалять негде`);
    return;
  }
  ensureServer();
  if (!dbExists(dbName)) {
    console.error(`база ${dbName} не найдена: либо стенд поднимали с другим --api, либо он уже погашен`);
    process.exit(1);
  }
  shLoud(psql(`DROP DATABASE ${dbName}`));
  console.log(`база ${dbName} удалена, общий контейнер ${PG_NAME} оставлен другим агентам`);
  console.log("порты API и Vite гаси по своим PID: netstat -ano | grep \":<порт> \" и taskkill //PID <pid> //F");
}

// Запускать команду только когда файл выполняется напрямую (`node
// scripts/agent-stand.mjs ...`), а не когда его импортируют — тест
// (`scripts/agent-stand-links.test.mjs`) импортирует чистые функции проверки
// направления ссылок и не должен по пути поднимать базу или трогать диск.
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  if (cmd === "up") up();
  else if (cmd === "serve") serve();
  else if (cmd === "down") down();
  else if (cmd === "refresh") refresh();
  else if (cmd === "check") check();
  else {
    console.log("команды: up | serve | refresh | down | check   (опции: --api --web)");
    process.exit(1);
  }
}

export { linkTargetRealpath, expectedSharedTarget, checkLinkDirections, linkSharedOverride, ensureTemplate, templateIsReady, READY_MARK };
