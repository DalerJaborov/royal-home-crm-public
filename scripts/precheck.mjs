#!/usr/bin/env node
/**
 * ПРОВЕРКА ПЕРЕД ПУШЕМ — то же, что сделает CI, но локально и с замером.
 *
 * ЗАЧЕМ. Раннер один, полный прогон CI занимает около 10,5 минут, и очередь из
 * трёх веток держит выкат час. Каждая правка, которую CI заворачивает на первом
 * же шаге, стоит этот час всем остальным. Дешевле узнать про поломку за минуту
 * на своей машине.
 *
 * Что гоняется и в каком порядке — ровно порядок CI (ci.yml), от самого дешёвого
 * к самому дорогому, чтобы падение приходило раньше:
 *
 *   0. agent-stand check         ~0 с    направление ссылок @royal-home/shared
 *                                        (только здесь: CI всегда клонирует чисто,
 *                                        ловушка 15.09 — только для worktree/главного
 *                                        дерева, см. scripts/agent-stand.mjs)
 *   1. build:shared              ~5 с    (без него api и web видят старый dist)
 *   2. build:api                 ~20 с   типы сервера
 *   3. build:web                 ~50 с   типы клиента + eslint внутри build:web
 *   4. тесты фронта             ~9 с    apps/web целиком; базы не требуют
 *   5. audit:deps:gate           ~5 с    НОВЫЕ циклы импортов и утечка сервера в бандл
 *                                        (известные три — .dependency-cruiser-baseline.json)
 *   6. audit:theme               ~1 с    мобильные правила без исключения тем 2026
 *   7. audit:nginx               ~0 с    `types{}` в nginx.conf не глушит карту MIME (простой 14.09)
 *   7б. audit:typeset            ~0 с    размеры и гарнитура не отстали от темы
 *   8. audit:rules               ~0 с    одно правило не написано дважды (сервер и сайт)
 *   8б. audit:mocks              ~1 с    нет новых узких подмен vi.mock без importOriginal (№204)
 *   9. audit:журнал              ~0 с    у каждого действия журнала есть подпись по-русски
 *   9б. audit:secrets            ~1 с    нет ключей, .env и настоящих номеров клиентов в документах
 *  10. map:check                 ~0 с    карта продукта не отстала от кода (docs/product-map.md)
 *  11. сторож карты              ~0 с    правка не убрала экран/путь молча (scripts/map-gate.mjs)
 *  11а. журнал                   ~0 с    правка с кодом добавила запись в docs/journal/
 *  11б. тесты команды выката     ~2 с    scripts/ship.test.mjs (npm run ship)
 *  12. тесты API, задетые правкой  зависит от того, что изменено
 *
 * Двенадцатый шаг — не весь прогон на 5400 тестов (это работа CI и того, кто
 * вливает), а те тесты, которые ПО ИМПОРТАМ дотягиваются до изменённых
 * исходников (`scripts/impact-tests.mjs`). Правило владельца из CLAUDE.md:
 * «Исполнителю одной задачи достаточно сборки и точечного прогона своих и
 * смежных тестов» — «смежных» здесь считает граф импортов, а не человек по
 * памяти. Задето слишком много — шаг сам переключается на весь набор.
 *
 *   npm run precheck                # всё вышеперечисленное
 *   npm run precheck -- --no-tests  # без шага 12 (нет базы; фронт всё равно гоняется)
 *   npm run precheck -- --base=<ref># сравнивать не с origin/main, а с <ref>
 *
 * ЧЕСТНЫЙ КОД ВОЗВРАТА. Скрипт выходит с 1, если упал ЛЮБОЙ шаг, и печатает
 * сводку с временем каждого. Вывод команд не перехватывается и не проходит через
 * `tee` (пайп отдаёт код возврата последнего звена, а не команды) — потомок
 * пишет прямо в тот же терминал, а его код читается напрямую.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const IS_WIN = process.platform === "win32";

const argv = process.argv.slice(2);
const noTests = argv.includes("--no-tests");
const baseArg = argv.find((a) => a.startsWith("--base="));
const BASE = baseArg ? baseArg.slice("--base=".length) : "origin/main";

/**
 * shell нужен ТОЛЬКО для npm/npx и только на Windows: там это `.cmd`-обёртки, и
 * без shell их не найти. Для git shell — активный вред: cmd.exe считает `^`
 * своим знаком экранирования и съедает его, из-за чего `origin/main^{commit}`
 * приезжает в git как `origin/main{commit}`, ревизия «не находится», и шаг
 * тестов молча пропускается с бодрым объяснением. Поймано на первом же прогоне
 * этого скрипта.
 */
const needsShell = (cmd) => IS_WIN && (cmd === "npm" || cmd === "npx");

/** Запустить команду, вернуть {code, ms}. stdio наследуется — вывод виден целиком. */
function run(cmd, args, opts = {}) {
  const started = Date.now();
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd || ROOT,
    stdio: "inherit",
    shell: needsShell(cmd),
    env: { ...process.env, ...(opts.env || {}) },
  });
  return { code: r.status === null ? 1 : r.status, ms: Date.now() - started };
}

/** Тихий запуск ради вывода (git). Пустая строка, если команда не удалась. */
function capture(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: "utf8", shell: needsShell(cmd) });
  return r.status === 0 ? (r.stdout || "").trim() : "";
}

function fmt(ms) {
  const s = ms / 1000;
  return s < 60 ? `${s.toFixed(1)} с` : `${Math.floor(s / 60)} м ${Math.round(s % 60)} с`;
}

/**
 * Тесты, которые задевает эта правка — ПО ИМПОРТАМ, а не по именам файлов.
 *
 * Было (до 22.09.2026): брались только изменённые файлы из `apps/api/tests`.
 * Это ловило «я поправил тест» и пропускало ровно тот случай, ради которого
 * проверка существует: правишь `src/lib/…`, в `tests/` не заходишь — и шаг
 * честно печатал «файлы тестов не менялись, нечего гонять». Ноль прогнанных
 * тестов при зелёной проверке; поломка всплывала в чужом модуле через день.
 *
 * Теперь список считает `scripts/impact-tests.mjs`: он строит граф импортов и
 * возвращает тесты, которые дотягиваются до изменённых исходников. Там же
 * описано, чего этот граф НЕ видит (динамический `import()`, реестры по
 * строковому ключу) — поэтому шаг остаётся проверкой ПЕРЕД пушем, а полный
 * прогон перед мержем в main он не отменяет.
 *
 * Слово `ALL` в ответе значит «задето слишком много, дешевле прогнать весь
 * набор» — тогда гоняем весь.
 */
function impactedApiTests() {
  const haveBase = capture("git", ["rev-parse", "--verify", "--quiet", `${BASE}^{commit}`]);
  if (!haveBase) return { files: [], haveBase: false, all: false };
  const r = spawnSync(process.execPath, [join(ROOT, "scripts", "impact-tests.mjs"), `--base=${BASE}`], {
    cwd: ROOT,
    encoding: "utf8",
  });
  const lines = (r.stdout || "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  if (lines.includes("ALL")) return { files: [], haveBase: true, all: true };
  const files = lines.filter((f) => /\.test\.ts$/.test(f) && existsSync(join(ROOT, "apps", "api", f)));
  return { files, haveBase: true, all: false };
}

const steps = [
  // Первым и самым дешёвым — направление ссылок @royal-home/shared (п.3
  // tooling-reliability-17-09.md). Смысл ставить его ПЕРЕД сборкой: ловушка
  // 15.09 (docs/TASKS.md) — перепутанная ссылка на packages/shared чужого
  // worktree — даёт зелёную сборку над чужим кодом, а не ошибку. Проверка
  // здесь ловит это раньше, чем оно спрячется за непонятной ошибкой типов.
  { name: "agent-stand: направление ссылок", cmd: "node", args: ["scripts/agent-stand.mjs", "check"] },
  { name: "build:shared", cmd: "npm", args: ["run", "build:shared"] },
  { name: "build:api", cmd: "npm", args: ["run", "build", "--workspace=apps/api"] },
  { name: "build:web (внутри eslint)", cmd: "npm", args: ["run", "build", "--workspace=apps/web"] },
  // Тесты фронта. До 22.09.2026 они не гонялись НИГДЕ: `npm run build:web` их не
  // видит (это eslint + tsc + vite build), в ci.yml их не было, а шаг тестов ниже
  // берёт только apps/api. Самая дешёвая проверка во всём списке (на 02.10.2026
  // это 80 файлов, 476 тестов, девять секунд), и закрывает ровно то, на что
  // жалуется владелец: одно и то же правило на сервере и на сайте расходится
  // (разбор в #752). Базы не требуют, поэтому шаг живёт здесь, а не под
  // `--no-tests`.
  //
  // Числа в ПОДПИСИ шага намеренно нет: она вписывается руками, ничем не
  // сверяется и потому тихо устаревает — «169 шт.» прожили так с 22.09 по
  // 02.10, пока тестов не стало 476, то есть подпись врала почти втрое. Это
  // тот же класс, что жёсткая дата в тесте: не краснеет, просто врёт. Честное
  // число печатает сам vitest строкой ниже.
  { name: "тесты фронта", cmd: "npm", args: ["run", "test", "--workspace=apps/web"] },
  { name: "audit:deps", cmd: "npm", args: ["run", "audit:deps:gate"] },
  { name: "audit:theme", cmd: "npm", args: ["run", "audit:theme"] },
  { name: "audit:nginx", cmd: "npm", args: ["run", "audit:nginx"] },
  // Шкала размеров текста собирается генератором из самой темы; если тему
  // пересинхронизировали, а шкалу не пересобрали, часть экранов молча вернётся
  // к мелкому шрифту. Проверка сравнивает собранное с текущими исходниками.
  { name: "audit:typeset (шрифт приложения)", cmd: "npm", args: ["run", "audit:typeset"] },
  // «Одно правило — одно место»: имя, экспортируемое и сервером, и сайтом, без
  // общего источника в packages/shared. Ровно так разошёлся `toTjs` (#752) —
  // и ни сборка, ни тесты, ни карта этого не видели: каждая сторона была
  // согласна сама с собой. Исключения — .shared-rules-baseline.json, с причиной.
  { name: "одно правило — одно место", cmd: "npm", args: ["run", "audit:rules"] },
  // Подмена `vi.mock(путь, () => ({ … }))` без `importOriginal` отдаёт меньше
  // имён, чем у модуля есть, и первый же новый вывоз валит чужие тесты (#584,
  // находка №204). Известные подмены — .vi-mock-baseline.json, валят только новые.
  { name: "audit:mocks (подмены vi.mock)", cmd: "npm", args: ["run", "audit:mocks"] },
  { name: "audit:журнал", cmd: "npm", args: ["run", "audit:audit-labels"] },
  // Ни ключ, ни токен, ни файл .env, ни настоящий номер клиента в документе не
  // уходят в main (владелец 20.10.2026: «ни от тебя, ни от Codex»). Хук перед
  // коммитом ловит то же раньше, но его можно не подключить или обойти —
  // ship через precheck обойти нельзя.
  { name: "audit:secrets (ключи и номера клиентов)", cmd: "npm", args: ["run", "audit:secrets"] },
  // Карта продукта не должна отставать от кода: docs/product-map.md собирается
  // программой, и если экран, модуль или задача по расписанию добавлены без
  // пересборки карты, правка не проходит. Без этого шага живой карты не бывает —
  // разовый документ врёт уже через неделю. Перестроить: npm run map.
  { name: "map:check (карта продукта)", cmd: "npm", args: ["run", "map:check"] },
  // `map:check` отвечает только на вопрос «карта собрана из текущего кода».
  // Сторож отвечает на другой: «а не убрала ли эта правка экран или путь
  // молча» — рефакторинг, унёсший кусок продукта, проходит map:check зелёным
  // (разбор в scripts/map-gate.mjs). Пропажу можно объявить намеренной:
  // MAP_GATE_ALLOW_REMOVALS=1.
  { name: "сторож карты (что пропало)", cmd: "node", args: ["scripts/map-gate.mjs", `--base=${BASE}`] },
  // Правка, меняющая код, добавляет запись в docs/journal/ (разбор в
  // scripts/journal-gate.mjs). Запись правда не нужна: JOURNAL_GATE_SKIP=1.
  { name: "журнал (запись о правке)", cmd: "node", args: ["scripts/journal-gate.mjs", `--base=${BASE}`] },
  // Команда выката `npm run ship` (docs/ship.md): правило «пачки», ловушки
  // 120000/160000, остановка на красном — сухим прогоном, без сети и базы.
  { name: "тесты команды выката", cmd: "npm", args: ["run", "test:scripts"] },
];

const results = [];
let failed = null;

for (const step of steps) {
  console.log(`\n[1m── ${step.name}[0m`);
  const { code, ms } = run(step.cmd, step.args);
  results.push({ name: step.name, code, ms });
  if (code !== 0) {
    failed = step.name;
    break; // дальше бессмысленно: следующие шаги читают результат предыдущих
  }
}

// ── Шаг 11: точечные тесты изменённых файлов ────────────────────────────────
if (!failed) {
  if (noTests) {
    results.push({ name: "тесты API (пропущено: --no-tests)", code: 0, ms: 0, skipped: true });
  } else {
    const { files, haveBase, all } = impactedApiTests();
    if (!haveBase) {
      console.log(
        `\n[33m── тесты API: базы «${BASE}» нет в этой копии — сначала \`git fetch origin main\`.` +
          " Шаг пропущен.[0m",
      );
      results.push({ name: `тесты API (нет базы ${BASE})`, code: 0, ms: 0, skipped: true });
    } else if (all) {
      console.log(
        `\n[1m── тесты API (правка задевает слишком многое — гоню весь набор)[0m` +
          `\n  это дольше точечного прогона, но честнее: список путей был бы почти полным.`,
      );
      const { code, ms } = run("npx", ["tsx", "tests/runParallel.ts"], { cwd: join(ROOT, "apps", "api") });
      results.push({ name: "тесты API (весь набор)", code, ms });
      if (code !== 0) failed = "тесты API";
    } else if (files.length === 0) {
      console.log(
        `\n[1m── тесты API[0m\n  изменённое не достаёт ни до одного теста сервера относительно ${BASE}.`,
      );
      results.push({ name: "тесты API (правка их не задевает)", code: 0, ms: 0, skipped: true });
    } else {
      console.log(`\n[1m── тесты API (${files.length} задетых правкой файлов)[0m`);
      for (const f of files) console.log(`  ${f}`);
      // Именно из apps/api: с `--root` из корня dotenv в tests/setup.ts не найдёт
      // .env и прогон упадёт на DATABASE_URL (CLAUDE.md).
      const { code, ms } = run("npx", ["vitest", "run", ...files], { cwd: join(ROOT, "apps", "api") });
      results.push({ name: `тесты API (${files.length} файлов)`, code, ms });
      if (code !== 0) failed = "тесты API";
    }
  }
}

// ── Сводка ─────────────────────────────────────────────────────────────────
const total = results.reduce((a, r) => a + r.ms, 0);
console.log("\n[1m── Итог проверки перед пушем[0m");
for (const r of results) {
  const mark = r.skipped ? "–" : r.code === 0 ? "[32m✔[0m" : "[31m✘[0m";
  console.log(`  ${mark} ${r.name.padEnd(34)} ${r.skipped ? "" : fmt(r.ms)}`);
}
console.log(`  всего: ${fmt(total)}`);

// Зелёная проверка рабочего дерева ничего не говорит о том, что уедет в ветку.
const dirty = capture("git", ["status", "--porcelain"]);
if (dirty) {
  console.log(
    "\n[33mВ рабочем дереве есть незакоммиченные изменения — проверено ОНО, а уедет коммит.\n" +
      "Закоммить их или убедись, что они не нужны, прежде чем пушить:[0m",
  );
  console.log(dirty.split("\n").slice(0, 20).map((l) => `  ${l}`).join("\n"));
}

if (failed) {
  console.error(`\n[31mПроверка не пройдена: ${failed}. В CI будет то же самое.[0m`);
  process.exit(1);
}
console.log("\n[32mЧисто. CI на этих шагах не завернёт.[0m");
