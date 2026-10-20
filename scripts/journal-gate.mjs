#!/usr/bin/env node
/**
 * ЖУРНАЛ НЕ ОТСТАЛ ОТ КОДА — сторож записи в журнале (23.09.2026).
 *
 * ЗАЧЕМ. Владелец (Dan) дважды попросил, 21.09 09:14 и 11:03: «сохрани всё, что
 * сделано, чтобы я зашёл с любой другой учётной записи и продолжил, и так на
 * каждом шаге». Память Claude живёт внутри одного проекта claude.ai и с другой
 * учётной записи не видна. Переживает смену учётки только сам репозиторий, поэтому
 * история работы ведётся здесь: обзор — docs/JOURNAL.md, записи — docs/journal/.
 *
 * Правило без сторожа не держится: запись «потом» не делает никто. Сторож не
 * пропускает правку, которая меняет код, но не добавляет и не меняет ни одной
 * записи журнала.
 *
 * ПОЧЕМУ ОТДЕЛЬНЫЕ ФАЙЛЫ, А НЕ СТРОКА В КОНЕЦ ОДНОГО. Параллельно идут десятки
 * веток; каждая, дописывающая строку в конец одного файла, конфликтовала бы при
 * слиянии с каждой другой. Файл на правку не конфликтует никогда.
 *
 * ЧТО СЧИТАЕТСЯ КОДОМ — см. CODE ниже: исходники приложений и общего пакета,
 * схема и миграции базы, скрипты, серверные ops/, рабочие потоки GitHub.
 * Тесты, docs/ и сгенерированная карта продукта кодом не считаются.
 *
 * Запуск:
 *   node scripts/journal-gate.mjs                 # сравнить с origin/main
 *   node scripts/journal-gate.mjs --base=<ref>
 *
 * КОГДА ЗАПИСЬ ПРАВДА НЕ НУЖНА (опечатка в комментарии, чистое переименование):
 *   • локально:  JOURNAL_GATE_SKIP=1 npm run precheck
 *   • в CI:      метка «журнал-не-нужен» на правке
 *
 * ПЕРЕХОДНЫЙ ПЕРИОД. Правки, открытые до появления сторожа (номер ≤ GRACE_PR),
 * получают предупреждение, а не отказ: их ветки родились без правила, и красить
 * всю очередь разом значит остановить её на день ради записей задним числом.
 */
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Последняя правка, открытая до сторожа. Всё новее — уже по правилу. */
const GRACE_PR = 806;

const CODE = [
  /^apps\/[^/]+\/src\//,
  /^packages\/[^/]+\/src\//,
  /^apps\/api\/prisma\//,
  /^scripts\//,
  /^ops\//,
  /^\.github\/workflows\//,
];
const JOURNAL = [/^docs\/JOURNAL\.md$/, /^docs\/journal\/(?!README\.md$).+\.md$/];

const argv = process.argv.slice(2);
const baseArg = argv.find((a) => a.startsWith("--base="));
const BASE = baseArg ? baseArg.slice("--base=".length) : "origin/main";

function git(args) {
  const r = spawnSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : null;
}

if (process.env.JOURNAL_GATE_SKIP === "1") {
  console.log("Сторож журнала: запись объявлена ненужной (метка «журнал-не-нужен» / JOURNAL_GATE_SKIP=1).");
  process.exit(0);
}

const mergeBase = git(["merge-base", BASE, "HEAD"])?.trim();
if (!mergeBase) {
  console.log(`Сторож журнала: базы «${BASE}» нет в этой копии — сравнивать не с чем, пропускаю.`);
  process.exit(0);
}

// Сравнение с рабочим деревом, а не с HEAD: локально запись журнала обычно ещё
// не закоммичена, когда запускают precheck. В CI дерево чистое — разницы нет.
const changed = new Set(
  [
    ...(git(["diff", "--name-only", mergeBase]) ?? "").split("\n"),
    ...(git(["ls-files", "--others", "--exclude-standard"]) ?? "").split("\n"),
  ]
    .map((s) => s.trim().replace(/\\/g, "/"))
    .filter(Boolean),
);

const code = [...changed].filter((f) => CODE.some((re) => re.test(f)) && !/\.test\.[cm]?[jt]sx?$/.test(f));
const journal = [...changed].filter((f) => JOURNAL.some((re) => re.test(f)));

if (!code.length) {
  console.log("Сторож журнала: код не тронут — запись не требуется.");
  process.exit(0);
}
if (journal.length) {
  console.log(`Сторож журнала: код тронут (${code.length} файл.), запись есть: ${journal.join(", ")}.`);
  process.exit(0);
}

const prNumber = Number(process.env.PR_NUMBER || 0);
const graced = prNumber > 0 && prNumber <= GRACE_PR;

const out = graced ? console.log : console.error;
out(
  [
    `Сторож журнала: правка меняет код (${code.length} файл.), но в журнал ничего не записано.`,
    "",
    "Тронуто, например:",
    ...code.slice(0, 8).map((f) => `  ${f}`),
    ...(code.length > 8 ? [`  … и ещё ${code.length - 8}`] : []),
    "",
    "Что сделать: добавить файл docs/journal/ГГГГ-ММ-ДД-коротко-о-чём.md —",
    "три-пять строк простыми словами: что изменилось для людей, почему, чем проверено,",
    "что осталось. Образец и правила — docs/journal/README.md.",
    "Если запись правда не нужна — метка «журнал-не-нужен» на правке",
    "(локально JOURNAL_GATE_SKIP=1).",
  ].join("\n"),
);
if (graced) {
  console.log(`\nПравка №${prNumber} открыта до сторожа (≤ ${GRACE_PR}) — только предупреждение.`);
  process.exit(0);
}
process.exit(1);
