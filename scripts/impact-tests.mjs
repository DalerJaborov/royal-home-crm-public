#!/usr/bin/env node
/**
 * КАКИЕ ТЕСТЫ ЗАДЕВАЕТ ЭТА ПРАВКА — по импортам, а не по именам файлов.
 *
 * ЗАЧЕМ. Шаг тестов в `npm run precheck` гоняет ТОЛЬКО изменённые файлы тестов
 * (scripts/precheck.mjs, `changedApiTests`). Это ловит «я поправил тест» и не
 * ловит ровно тот случай, ради которого проверка и существует: правишь
 * `src/lib/ownershipSatellites.ts`, ни одного файла в `tests/` не трогаешь —
 * и precheck честно печатает «файлы тестов не менялись, нечего гонять».
 * Зелёная проверка, ноль прогнанных тестов, поломка уезжает в ветку и всплывает
 * в чужом модуле через день.
 *
 * ЧТО ДЕЛАЕТ. Строит граф импортов по `apps/api/src`, `apps/api/tests` и
 * `packages/shared/src`, для каждого файла тестов считает, до каких исходников
 * он дотягивается (транзитивно), и печатает те тесты, чей охват пересекается с
 * изменёнными файлами. То есть отвечает на вопрос «кого ещё может уронить эта
 * правка», а не «что я редактировал».
 *
 * Учитываются и `vi.mock("../src/…")`: подмена модуля — такая же зависимость,
 * как импорт, и по ней тест ломается ничуть не реже.
 *
 * ГРАНИЦЫ ЧЕСТНОСТИ (важно, иначе на скрипт понадеются зря):
 *  • Видны только статические импорты и `vi.mock`. Динамический `await import()`
 *    с вычисляемым путём, реестры обработчиков по строковому ключу и крючки
 *    регистрации (`liveIncomingLookupHook` и подобные) графом НЕ видны.
 *  • Любая правка в `packages/shared/src` считается задевающей всех, кто
 *    импортирует `@royal-home/shared`: пакет — бочка (`index.ts` реэкспортирует
 *    всё), разобрать точнее нельзя, и ошибаться здесь безопаснее в бóльшую
 *    сторону.
 *  • Поэтому это проверка ПЕРЕД пушем, а не замена полному прогону перед
 *    мержем в main. Полный прогон отменяет только полный прогон.
 *
 * Запуск:
 *   node scripts/impact-tests.mjs             # список путей для vitest, по одному в строке
 *   node scripts/impact-tests.mjs --base=<ref>   # сравнивать не с origin/main
 *   node scripts/impact-tests.mjs --explain      # ещё и почему каждый тест попал в список
 *   node scripts/impact-tests.mjs --max=80       # порог «проще прогнать всё» (по умолчанию 80)
 *
 * Код возврата 0 всегда, кроме внутренней ошибки: это подсказка, а не ворота.
 * Если задето больше `--max` файлов, печатает `ALL` — дешевле один полный
 * прогон, чем vitest с восемью сотнями путей в командной строке.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const BASE = arg("base", "origin/main");
const MAX = Number(arg("max", "80"));
const EXPLAIN = argv.includes("--explain");
/**
 * `--for=<путь>[,<путь>]` — спросить про КОНКРЕТНЫЕ файлы вместо «что изменено
 * относительно базы». Нужно хуку после правки (.claude/hooks/post-edit-impact.mjs)
 * и любому, кто спрашивает «а кого заденет, если я трону вот это» ДО правки.
 * git при этом не опрашивается вовсе: база может быть не загружена, а ответ
 * от неё не зависит.
 */
const FOR = (arg("for", "") || "")
  .split(",")
  .map((s) => s.trim().replace(/\\/g, "/"))
  .filter(Boolean);

/** Корни, внутри которых мы вообще что-то понимаем. Всё остальное — внешние пакеты. */
const ROOTS = ["apps/api/src", "apps/api/tests", "packages/shared/src"];
const SHARED_ENTRY = "packages/shared/src/index.ts";

// ── git ────────────────────────────────────────────────────────────────────

function capture(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: "utf8" });
  return r.status === 0 ? (r.stdout || "").trim() : "";
}

/**
 * Изменённые файлы: и зафиксированные относительно базы, и незакоммиченные, и
 * новые. Ровно тот же набор источников, что у precheck.mjs, — иначе два шага
 * одной проверки отвечали бы на вопрос о разных правках.
 */
function changedFiles() {
  const haveBase = Boolean(capture("git", ["rev-parse", "--verify", "--quiet", `${BASE}^{commit}`]));
  const sets = [];
  if (haveBase) sets.push(capture("git", ["diff", "--name-only", `${BASE}...HEAD`]));
  sets.push(capture("git", ["diff", "--name-only", "HEAD"]));
  sets.push(capture("git", ["ls-files", "--others", "--exclude-standard"]));
  const files = new Set(
    sets
      .join("\n")
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => s.replace(/\\/g, "/")),
  );
  return { files, haveBase };
}

// ── граф импортов ──────────────────────────────────────────────────────────

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(relative(ROOT, full).replace(/\\/g, "/"));
  }
  return out;
}

/**
 * Пути в импортах пишутся с расширением `.js` (module: NodeNext), а на диске
 * лежит `.ts`. Плюс привычные случаи: каталог с `index.ts`, импорт без
 * расширения вовсе.
 */
function resolveLocal(fromFile, spec) {
  const base = join(ROOT, dirname(fromFile), spec);
  const candidates = [
    base.replace(/\.js$/, ".ts"),
    base.replace(/\.js$/, ".tsx"),
    `${base}.ts`,
    `${base}.tsx`,
    join(base, "index.ts"),
    join(base, "index.tsx"),
    base,
  ];
  for (const c of candidates) {
    if (existsSync(c) && statSync(c).isFile()) return relative(ROOT, c).replace(/\\/g, "/");
  }
  return null;
}

const IMPORT_RE = /(?:^|\n)\s*(?:import|export)\s[^;]*?from\s*["']([^"']+)["']/g;
const BARE_IMPORT_RE = /(?:^|\n)\s*import\s*["']([^"']+)["']/g;
const DYNAMIC_RE = /\bimport\(\s*["']([^"']+)["']\s*\)/g;
const MOCK_RE = /\bvi\.mock\(\s*["']([^"']+)["']/g;

/** Соседи файла в графе: локальные файлы, до которых он дотягивается напрямую. */
function depsOf(file) {
  let text;
  try {
    text = readFileSync(join(ROOT, file), "utf8");
  } catch {
    return [];
  }
  const specs = new Set();
  for (const re of [IMPORT_RE, BARE_IMPORT_RE, DYNAMIC_RE, MOCK_RE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) specs.add(m[1]);
  }
  const out = [];
  for (const spec of specs) {
    if (spec.startsWith(".")) {
      const hit = resolveLocal(file, spec);
      if (hit) out.push(hit);
    } else if (spec === "@royal-home/shared" || spec.startsWith("@royal-home/shared/")) {
      // Бочка: пакет реэкспортирует всё из index.ts, разбирать точнее нечем.
      out.push(SHARED_ENTRY);
    }
  }
  return out;
}

const allFiles = ROOTS.flatMap((r) => walk(join(ROOT, r)));
const graph = new Map();
for (const f of allFiles) graph.set(f, depsOf(f));

/**
 * Весь пакет shared считается одним узлом: правка любого его файла обязана
 * доставать до каждого, кто импортирует бочку.
 */
const sharedFiles = allFiles.filter((f) => f.startsWith("packages/shared/src/"));
graph.set(SHARED_ENTRY, [...(graph.get(SHARED_ENTRY) || []), ...sharedFiles]);

/**
 * До каких файлов дотягивается `start`, включая себя. Обход с защитой от циклов.
 *
 * `barrier` — файлы, ЧЕРЕЗ которые обход не идёт дальше (сам файл в ответ
 * попадает, его зависимости — нет). Зачем это нужно, см. ниже про узлы-сборки.
 */
function reach(start, barrier = new Set()) {
  const seen = new Set([start]);
  const stack = [start];
  while (stack.length) {
    const node = stack.pop();
    if (node !== start && barrier.has(node)) continue;
    for (const next of graph.get(node) || []) {
      if (!seen.has(next)) {
        seen.add(next);
        stack.push(next);
      }
    }
  }
  return seen;
}

/**
 * УЗЛЫ-СБОРКИ, ЧЕРЕЗ КОТОРЫЕ ДОСТУПНО ВСЁ.
 *
 * `apps/api/src/app.ts` собирает приложение и импортирует 82 модуля, а через
 * них достаёт до 510 файлов из 1225. Его импортируют 169 файлов тестов — то
 * есть каждый такой тест формально дотягивается почти до всего сервера, и
 * «задетые тесты» вырождаются в «весь набор» при любой правке.
 *
 * Формально это правда: тест, поднимающий всё приложение, действительно может
 * упасть от правки в глубине. Но как ОТБОР это бесполезно, а как обещание —
 * обманчиво: вместе такие тесты ловят не больше, чем один полный прогон, для
 * которого и отведено место перед вливанием в main.
 *
 * Поэтому узлы-сборки (те, из которых достижимо больше 40% файлов) находятся
 * сами и ставятся барьером. Тест считается БЛИЗКИМ, если дотягивается до
 * правки не только через сборку, а своим путём зависимостей. Остальные
 * считаются и называются числом — бежать их здесь смысла нет.
 */
const hubs = new Set();
for (const f of allFiles) {
  if (!f.startsWith("apps/api/src/") && !f.startsWith("packages/shared/src/")) continue;
  if (reach(f).size > allFiles.length * 0.4) hubs.add(f);
}

// ── собственно ответ ───────────────────────────────────────────────────────

const { files: changed, haveBase } = FOR.length ? { files: new Set(FOR), haveBase: true } : changedFiles();
if (!haveBase) {
  console.error(`# базы «${BASE}» нет в этой копии — сначала \`git fetch origin main\``);
  process.exit(0);
}

/** Изменённое, что вообще может влиять на тесты сервера. */
const changedRelevant = new Set(
  [...changed].filter((f) => ROOTS.some((r) => f.startsWith(`${r}/`)) && /\.(ts|tsx)$/.test(f)),
);

const testFiles = allFiles.filter((f) => f.startsWith("apps/api/tests/") && /\.test\.ts$/.test(f));
const hits = [];
let throughHub = 0;
for (const test of testFiles) {
  // Изменённый файл теста гоняется всегда, даже если импортов у него нет.
  if (changedRelevant.has(test)) {
    hits.push({ test, because: [test] });
    continue;
  }
  const near = [...reach(test, hubs)].filter((f) => changedRelevant.has(f));
  if (near.length) {
    hits.push({ test, because: near });
  } else if ([...reach(test)].some((f) => changedRelevant.has(f))) {
    // Дотягивается только через узел-сборку: поднимает всё приложение целиком.
    // Это работа полного прогона перед вливанием, не проверки перед пушем.
    throughHub += 1;
  }
}

/**
 * ФАЙЛЫ, ДО КОТОРЫХ НИКТО НЕ ДОТЯГИВАЕТСЯ НАПРЯМУЮ — ЭТО РОУТЫ.
 *
 * `routes/dealPayout.ts` не импортирует ни один тест: к роутам ходят запросом
 * через поднятое приложение, а приложение — узел-сборка, через который мы
 * намеренно не идём. Граф импортов на такой правке честно отвечает «ноль», и
 * это худший из возможных ответов: правка роута — ровно то, что надо проверить.
 *
 * Достраиваем текстом, единственным, что тут работает: берём адреса, которые
 * роут объявляет (`router.get("/…")`), и ищем тесты, которые по этим адресам
 * ходят. Способ грубый, зато ловит именно ту связь, которой нет в импортах.
 */
if (!hits.length && changedRelevant.size) {
  // Полные адреса берём из карты, а не регуляркой по файлу: в самом файле
  // написано `router.post("/:id/payout")`, а живой адрес — `/api/v1/deals/:id/payout`,
  // и приставку знает только место монтирования. Карта её уже разобрала.
  let flows = null;
  try {
    flows = JSON.parse(readFileSync(join(ROOT, "docs/product-flows.json"), "utf8"));
  } catch {
    flows = null;
  }

  const byUrl = new Set();
  if (flows?.endpoints) {
    const needles = new Set();
    for (const ep of flows.endpoints) {
      if (!changedRelevant.has(ep.file)) continue;
      // До первого параметра: в тесте адрес пишется с настоящим id, а не с `:id`.
      const stem = String(ep.full || "").split("/:")[0];
      if (stem.length > "/api/v1/".length) needles.add(stem);
    }
    if (needles.size) {
      for (const test of testFiles) {
        let t;
        try {
          t = readFileSync(join(ROOT, test), "utf8");
        } catch {
          continue;
        }
        if ([...needles].some((n) => t.includes(n))) byUrl.add(test);
      }
    }
  }
  for (const test of byUrl) hits.push({ test, because: ["адрес роута встречается в тексте теста"] });
  if (byUrl.size) console.error(`# ${byUrl.size} тестов найдено по адресам роута из карты (импортов к роутам не бывает)`);
}

if (!hits.length) {
  if (!changedRelevant.size) {
    console.error("# сервер и общие схемы не менялись");
  } else if (throughHub) {
    // Ноль своих тестов при живых приложенческих — это не «проверять нечего»,
    // а «проверить может только полный набор». Молчать здесь нельзя: ровно от
    // такого молчания и заводился этот скрипт.
    console.error(
      `# своих тестов у правки нет, но ${throughHub} поднимают всё приложение — гоню весь набор`,
    );
    console.log("ALL");
  } else {
    console.error("# изменённые файлы не достают ни до одного теста сервера");
  }
  process.exit(0);
}

if (hits.length > MAX) {
  console.error(`# задето ${hits.length} файлов тестов (порог ${MAX}) — дешевле прогнать весь набор`);
  console.log("ALL");
  process.exit(0);
}

for (const { test, because } of hits) {
  // Пути отдаём относительно apps/api: vitest запускается оттуда (иначе dotenv
  // в tests/setup.ts не найдёт .env — ловушка из CLAUDE.md).
  const forVitest = test.replace(/^apps\/api\//, "");
  if (EXPLAIN) {
    console.log(`${forVitest}\n    из-за: ${because.slice(0, 4).join(", ")}${because.length > 4 ? " …" : ""}`);
  } else {
    console.log(forVitest);
  }
}
console.error(
  `# ${hits.length} файлов тестов задето правкой напрямую (изменённых исходников: ${changedRelevant.size})` +
    (throughHub
      ? `\n# ещё ${throughHub} поднимают всё приложение и потому дотягиваются до чего угодно —` +
        " их место в полном прогоне перед вливанием в main, а не здесь"
      : ""),
);
