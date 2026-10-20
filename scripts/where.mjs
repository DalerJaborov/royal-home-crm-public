#!/usr/bin/env node
/**
 * ГДЕ ЭТО ЛЕЖИТ — один вопрос, один ответ, без догадок.
 *
 * ЗАЧЕМ. Карта продукта (`docs/product-map-simple.json`, `docs/product-flows.json`)
 * знает про 49 экранов, 456 путей сервера, 86 задач по расписанию и 15 фоновых
 * заданий — но это файлы на мегабайт, их не читают, и каждая новая сессия снова
 * ищет «а где у нас перенос клиента другому агенту» перебором `grep` по
 * наугад придуманным словам. Отсюда две беды: правку кладут не в тот слой, и
 * «второе место» никто не находит, пока оно не сломается.
 *
 * Этот скрипт отвечает на вопрос за секунду и показывает ВСЕ места сразу:
 * экран, путь сервера, задачу по расписанию, фоновое задание, модель базы и
 * файлы, где это встречается.
 *
 *   npm run where клиент агент          # слова ищутся вместе (И, а не ИЛИ)
 *   npm run where -- --model Client     # кто трогает модель базы Client
 *   npm run where -- --file apps/api/src/lib/leads/assign.ts
 *                                       # что этот файл импортирует и кто зависит от него
 *   npm run where -- --limit=30 звонок  # по умолчанию показывается по 12 в разделе
 *
 * ЧЕГО ЭТОТ ОТВЕТ НЕ ЗНАЕТ (список ведёт сама карта, шапка docs/product-flows.md):
 * прав как системы (видно `requirePermission("x")`, не видно, у кого это право
 * есть), схемы базы и миграций, полей Zod-схем, порядка регистрации маршрутов,
 * обращений фронтенда мимо `api()`. Раздел «файлы» ищет по тексту и этим дыры
 * частично закрывает — но он именно текстовый, а не смысловой.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);

const flagValue = (name) => {
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : null;
};
const LIMIT = Number(flagValue("limit") || 12);
const MODEL = flagValue("model");
const FILE = flagValue("file");
const words = argv
  .filter((a) => !a.startsWith("--"))
  .filter((a) => a !== MODEL && a !== FILE && String(a) !== String(LIMIT))
  .map((w) => w.toLowerCase());

const B = (s) => `\u001b[1m${s}\u001b[0m`;
const DIM = (s) => `\u001b[2m${s}\u001b[0m`;

function loadJson(rel) {
  const full = join(ROOT, rel);
  if (!existsSync(full)) return null;
  try {
    return JSON.parse(readFileSync(full, "utf8"));
  } catch {
    return null;
  }
}

const simple = loadJson("docs/product-map-simple.json");
const flows = loadJson("docs/product-flows.json");
if (!simple || !flows) {
  console.error("Карта не собрана или испорчена. Выполните: npm run map");
  process.exit(1);
}

/** Все слова запроса должны встретиться в тексте — иначе «клиент» выдаёт полкарты. */
const matches = (text) => {
  const t = String(text || "").toLowerCase();
  return words.every((w) => t.includes(w));
};

function section(title, rows) {
  if (!rows.length) return;
  console.log(`\n${B(title)}  ${DIM(`(${rows.length})`)}`);
  for (const row of rows.slice(0, LIMIT)) console.log(`  ${row}`);
  if (rows.length > LIMIT) console.log(DIM(`  … ещё ${rows.length - LIMIT}, полностью: --limit=${rows.length}`));
}

// ── режим «кто трогает модель базы» ────────────────────────────────────────

/** Все файлы исходников — один обход, дальше по ним ищут и текстом, и по импортам. */
function walkSources() {
  const out = [];
  const roots = ["apps/api/src", "apps/web/src", "packages/shared/src"];
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === "dist") continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry)) out.push(relative(ROOT, full).replace(/\\/g, "/"));
    }
  };
  for (const r of roots) walk(join(ROOT, r));
  return out;
}

if (MODEL) {
  const model = MODEL[0].toLowerCase() + MODEL.slice(1);
  const pretty = MODEL[0].toUpperCase() + MODEL.slice(1);

  // Пути сервера берём из карты: у неё уже разобран каждый обработчик.
  const routes = [];
  const walkTree = (node, sink) => {
    if (!node) return;
    const re = new RegExp(`prisma\\.${model}\\.(\\w+)`, "g");
    let m;
    while ((m = re.exec(String(node.t || "")))) sink.add(m[1]);
    for (const c of node.c || []) walkTree(c, sink);
  };
  for (const ep of flows.endpoints || []) {
    const ops = new Set();
    for (const n of ep.tree || []) walkTree(n, ops);
    if (ops.size) routes.push(`${ep.method} ${ep.full}  ${DIM(`${ep.file} · ${[...ops].join(", ")}`)}`);
  }

  // Библиотеки карта внутрь не разбирает — там ищем текстом.
  const inFiles = [];
  for (const f of walkSources()) {
    const text = readFileSync(join(ROOT, f), "utf8");
    const hits = (text.match(new RegExp(`prisma\\.${model}\\.`, "g")) || []).length;
    if (hits) inFiles.push(`${f}  ${DIM(`${hits}×`)}`);
  }

  const inSchema = existsSync(join(ROOT, "apps/api/prisma/schema.prisma"))
    ? readFileSync(join(ROOT, "apps/api/prisma/schema.prisma"), "utf8").includes(`model ${pretty} `)
    : false;

  console.log(`${B(`Модель базы ${pretty}`)}${inSchema ? "" : DIM("  (в schema.prisma такой модели нет — проверьте написание)")}`);
  section("Пути сервера (из карты)", routes);
  section("Файлы, где к ней обращаются", inFiles);
  if (!routes.length && !inFiles.length) console.log(DIM("  ничего не найдено"));
  process.exit(0);
}

// ── режим «что связано с этим файлом» ──────────────────────────────────────

if (FILE) {
  const target = FILE.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!existsSync(join(ROOT, target))) {
    console.error(`Файла ${target} нет.`);
    process.exit(1);
  }
  const text = readFileSync(join(ROOT, target), "utf8");
  const imports = [...text.matchAll(/from\s*["'](\.[^"']+)["']/g)].map((m) => m[1]);

  // Кто зависит от него — ищем по имени файла в импортах остальных.
  const base = target.split("/").pop().replace(/\.tsx?$/, "");
  const dependents = [];
  for (const f of walkSources()) {
    if (f === target) continue;
    const t = readFileSync(join(ROOT, f), "utf8");
    if (new RegExp(`from\\s*["'][^"']*\\/${base}\\.js["']|from\\s*["']\\.\\/${base}\\.js["']`).test(t)) dependents.push(f);
  }

  // Экраны и пути карты, живущие в этом файле.
  const screens = (simple.screens || []).filter((s) => s.file === target).map((s) => `${s.path}  ${DIM(s.title)}`);
  const routes = (flows.endpoints || []).filter((e) => e.file === target).map((e) => `${e.method} ${e.full}`);

  console.log(B(target));
  section("Экраны в этом файле", screens);
  section("Пути сервера в этом файле", routes);
  section("Импортирует", [...new Set(imports)]);
  section("Кто зависит от него (правка здесь задевает их)", dependents);
  process.exit(0);
}

// ── обычный поиск по словам ────────────────────────────────────────────────

if (!words.length) {
  console.log(`${B("Карта продукта")}: ${simple.totals.screens} экранов, ${simple.totals.paths} путей сервера, ${simple.totals.cron} задач по расписанию, ${simple.totals.jobs} фоновых заданий.

Спросить: ${B("npm run where <слова>")}  — например \`npm run where перенос клиента\`
Ещё:      npm run where -- --model Client        кто трогает модель базы
          npm run where -- --file <путь>          что импортирует и кто зависит`);
  process.exit(0);
}

const screens = (simple.screens || [])
  .filter((s) => matches(`${s.title} ${s.path} ${s.file} ${simple.groups?.[s.group] || ""}`))
  .map((s) => `${s.path.padEnd(28)} ${s.title}  ${DIM(s.file)}`);

const routes = (simple.paths || [])
  .filter((p) => matches(`${p.title} ${p.full} ${p.module} ${p.where}`))
  .map((p) => `${(p.method + " " + p.full).padEnd(48)} ${p.title || ""}  ${DIM(p.where)}`);

const cron = (simple.cron || [])
  .filter((c) => matches(`${c.id} ${c.label}`))
  .map((c) => `${c.id.padEnd(28)} ${DIM(c.when)}  ${c.label}`);

const jobs = (simple.jobs || []).filter((j) => matches(j.kind)).map((j) => j.kind);

/**
 * Файлы ищем текстом — это и есть та часть, которой в карте нет: `lib/*`,
 * схемы, миграции, ops. Через git grep, чтобы не читать node_modules и dist.
 */
let files = [];
try {
  const out = execFileSync(
    "git",
    ["grep", "-l", "-i", "--", words[0], "apps", "packages", "ops", "scripts"],
    { cwd: ROOT, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  files = out
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((f) => words.slice(1).every((w) => {
      try {
        return readFileSync(join(ROOT, f), "utf8").toLowerCase().includes(w);
      } catch {
        return false;
      }
    }));
} catch {
  // git grep выходит с 1, когда ничего не нашёл — это не ошибка.
}

console.log(B(`Где: ${words.join(" ")}`));
section("Экраны", screens);
section("Пути сервера", routes);
section("По расписанию", cron);
section("Фоновые задания", jobs);
section("Файлы (поиск по тексту)", files);

if (!screens.length && !routes.length && !cron.length && !jobs.length && !files.length) {
  console.log(DIM("\n  Ничего. Попробуйте одно слово вместо нескольких или синоним из карты:"));
  console.log(DIM("  npm run where -- --limit=60 " + words[0]));
}
