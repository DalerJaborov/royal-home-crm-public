#!/usr/bin/env node
/**
 * ЧТО ЭТА ПРАВКА УБРАЛА ИЗ ПРОДУКТА — сторож пропаж на карте.
 *
 * ЗАЧЕМ. `npm run map:check` отвечает ровно на один вопрос: «файл карты собран
 * из текущего кода или отстал». Он НЕ отвечает на вопрос «а не пропало ли
 * что-нибудь». Пересобрал карту после рефакторинга — и `map:check` зелёный,
 * даже если в продукте стало на три экрана и сорок путей меньше.
 *
 * Такое здесь уже было, и не по злому умыслу: вынос куска экспортируемой
 * функции в НЕэкспортируемый помощник выкидывает её из `docs/product-flows.md`
 * целиком (ловушка 21.09.2026, раздел «Ловушки этого репозитория» в CLAUDE.md).
 * Видно это было только в `git diff` на сгенерированном файле в мегабайт —
 * то есть не видно никому.
 *
 * Сторож сравнивает карту ветки с картой `origin/main` и НЕ пропускает правку,
 * которая молча убирает экран, путь сервера, задачу по расписанию или фоновое
 * задание. Прибавление не трогает никогда: продукт растёт каждый день.
 *
 * Это и есть ответ на «правлю здесь — ломается там» в самом дешёвом виде:
 * поломка ещё не случилась, а поверхность продукта уже изменилась.
 *
 * Запуск:
 *   node scripts/map-gate.mjs                 # сравнить с origin/main
 *   node scripts/map-gate.mjs --base=<ref>
 *
 * КОГДА УБРАЛИ НАМЕРЕННО. Это бывает: экран удаляют, роут переименовывают.
 * Тогда пропажу надо ПРОИЗНЕСТИ вслух, а не проскочить молча:
 *   • локально:  MAP_GATE_ALLOW_REMOVALS=1 npm run precheck
 *   • в CI:      повесить на правку метку «карта-убрано-намеренно»
 * Смысл не в разрешении, а в том, что пропажа попадает в описание правки и
 * её видит тот, кто вливает.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MAP = "docs/product-map-simple.json";

const argv = process.argv.slice(2);
const baseArg = argv.find((a) => a.startsWith("--base="));
const BASE = baseArg ? baseArg.slice("--base=".length) : "origin/main";
const ALLOWED = process.env.MAP_GATE_ALLOW_REMOVALS === "1";

function capture(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : null;
}

/**
 * Карта базы читается из git, а не с диска: сравнивать надо с тем, что лежит в
 * `main`, а не с тем, что оказалось в рабочем дереве.
 */
const baseRaw = capture("git", ["show", `${BASE}:${MAP}`]);
if (baseRaw === null) {
  console.log(`Сторож карты: базы «${BASE}» нет в этой копии — сравнивать не с чем, пропускаю.`);
  process.exit(0);
}
if (!existsSync(join(ROOT, MAP))) {
  console.error(`Сторож карты: нет ${MAP}. Выполните: npm run map`);
  process.exit(1);
}

let before;
let after;
try {
  before = JSON.parse(baseRaw);
  after = JSON.parse(readFileSync(join(ROOT, MAP), "utf8"));
} catch (e) {
  console.error(`Сторож карты: карта не читается (${e.message}). Выполните: npm run map`);
  process.exit(1);
}

/** Разделы карты и как назвать каждую строку по-человечески. */
const PARTS = [
  {
    title: "Экраны",
    list: (m) => m.screens || [],
    key: (s) => s.path,
    label: (s) => `${s.path} — ${s.title} (${s.file})`,
  },
  {
    title: "Пути сервера",
    list: (m) => m.paths || [],
    key: (p) => `${p.method} ${p.full}`,
    label: (p) => `${p.method} ${p.full}${p.title ? ` — ${p.title}` : ""} (${p.where})`,
  },
  {
    title: "Задачи по расписанию",
    list: (m) => m.cron || [],
    key: (c) => c.id,
    label: (c) => `${c.id} — ${c.label}`,
  },
  {
    title: "Фоновые задания",
    list: (m) => m.jobs || [],
    key: (j) => j.kind,
    label: (j) => j.kind,
  },
];

const gone = [];
const added = [];
for (const part of PARTS) {
  const beforeKeys = new Map(part.list(before).map((x) => [part.key(x), x]));
  const afterKeys = new Map(part.list(after).map((x) => [part.key(x), x]));
  const lost = [...beforeKeys.keys()].filter((k) => !afterKeys.has(k));
  const gain = [...afterKeys.keys()].filter((k) => !beforeKeys.has(k));
  if (lost.length) gone.push({ title: part.title, items: lost.map((k) => part.label(beforeKeys.get(k))) });
  if (gain.length) added.push({ title: part.title, count: gain.length });
}

/**
 * Развилки считаем отдельно: их тысячи, поимённо не сравнишь, но заметное
 * падение числа — тот же сигнал. Порог 2% от текущего: мелкие колебания при
 * обычном рефакторинге в норме, обвал — нет.
 */
const condBefore = before.totals?.conditions ?? 0;
const condAfter = after.totals?.conditions ?? 0;
const condDrop = condBefore - condAfter;
const condLimit = Math.max(20, Math.round(condBefore * 0.02));

const summary =
  `Сторож карты (сравнение с ${BASE}): ` +
  `экранов ${before.totals?.screens} → ${after.totals?.screens}, ` +
  `путей ${before.totals?.paths} → ${after.totals?.paths}, ` +
  `по расписанию ${before.totals?.cron} → ${after.totals?.cron}, ` +
  `фоновых ${before.totals?.jobs} → ${after.totals?.jobs}, ` +
  `развилок ${condBefore} → ${condAfter}.`;

if (!gone.length && condDrop <= condLimit) {
  console.log(summary);
  if (added.length) console.log(`  прибавилось: ${added.map((a) => `${a.title.toLowerCase()} +${a.count}`).join(", ")}`);
  process.exit(0);
}

console.log(summary);
console.error("\nИз продукта пропало:");
for (const part of gone) {
  console.error(`\n  ${part.title} (${part.items.length}):`);
  for (const item of part.items.slice(0, 25)) console.error(`    − ${item}`);
  if (part.items.length > 25) console.error(`    … ещё ${part.items.length - 25}`);
}
if (condDrop > condLimit) {
  console.error(`\n  Развилок стало меньше на ${condDrop} (порог ${condLimit}).`);
  console.error("    Обычная причина — кусок экспортируемой функции уехал в неэкспортируемый помощник:");
  console.error("    для карты это значит, что путь исчез целиком. Посмотрите git diff по docs/product-flows.md.");
}

if (ALLOWED) {
  console.error("\nMAP_GATE_ALLOW_REMOVALS=1 — пропажа объявлена намеренной, пропускаю.");
  console.error("Перечислите её в описании правки: тому, кто вливает, это единственный способ узнать.");
  process.exit(0);
}

console.error(
  "\nЕсли убрали намеренно — скажите это вслух, а не молчанием:" +
    "\n  локально:  MAP_GATE_ALLOW_REMOVALS=1 npm run precheck" +
    "\n  в CI:      метка «карта-убрано-намеренно» на правке" +
    "\nЕсли не убирали — это и есть поломка: рефакторинг унёс кусок продукта.",
);
process.exit(1);
