#!/usr/bin/env node
/**
 * СТОРОЖ РЕЕСТРА ФУНКЦИЙ (14.11.2026, аудит скрытых механизмов, раздел D).
 *
 * Функция, которую молча держит выключенной переменная окружения (`*_LIVE`, `*_MODE`,
 * `*_EXECUTION_MODE`, `*_EXECUTION`, `*_ENABLED`), должна быть видна директору на экране
 * «Состояние функций» (Настройки → Данные и система). Экран строится из реестра
 * packages/shared/src/functionStatus.ts. Этот сторож сверяет два списка:
 *   1. какие такие переменные сервер РЕАЛЬНО читает (apps/api/src: `process.env.X`,
 *      `env.X`, `process.env["X"]`, а также `mediaExecutionMode("KIND")` → CRM_KIND_EXECUTION_MODE);
 *   2. какие названы в `env: [...]` записей реестра.
 * Новая переменная без записи — ошибка сборки. Запись про переменную, которой в коде уже нет, — тоже:
 * иначе реестр начнёт врать «выключено из-за X», когда X давно ничего не значит.
 *
 *   node scripts/audit-function-registry.mjs
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const API_SRC = join(ROOT, "apps", "api", "src");
const REGISTRY = join(ROOT, "packages", "shared", "src", "functionStatus.ts");

/** Имена, которые считаем рубильниками. */
const SWITCH_NAME = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*_(?:LIVE|MODE|EXECUTION_MODE|EXECUTION|ENABLED)$/;

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name === "generated" || name === "node_modules") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (full.endsWith(".ts") && !full.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

/** Убирает комментарии, чтобы пояснение «см. process.env.X_LIVE» не считалось чтением. */
export function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
}

/** Рубильники, которые читает исходник (имя → true). */
export function findSwitchReads(text) {
  const code = stripComments(text);
  const names = new Set();
  const direct = /\b(?:process\.env|env)\.([A-Z][A-Z0-9_]*)\b/g;
  const bracket = /\bprocess\.env\[\s*["'`]([A-Z][A-Z0-9_]*)["'`]\s*\]/g;
  for (const re of [direct, bracket]) {
    for (const m of code.matchAll(re)) if (SWITCH_NAME.test(m[1])) names.add(m[1]);
  }
  // Имя собирается шаблоном: process.env[`CRM_${kind}_EXECUTION_MODE`] — значения kind берём из вызовов.
  for (const m of code.matchAll(/\bmediaExecutionMode\(\s*["']([A-Z_]+)["']\s*\)/g)) names.add(`CRM_${m[1]}_EXECUTION_MODE`);
  return names;
}

/** Имена из `env: [ ... ]` записей реестра. */
export function registryEnvNames(registrySource) {
  const names = new Set();
  for (const block of stripComments(registrySource).matchAll(/\benv:\s*\[([^\]]*)\]/g)) {
    for (const m of block[1].matchAll(/["']([A-Z][A-Z0-9_]*)["']/g)) names.add(m[1]);
  }
  return names;
}

/** Чистая проверка: files — { путь: текст }, registrySource — текст реестра. */
export function findProblems(files, registrySource) {
  const registered = registryEnvNames(registrySource);
  const readers = new Map(); // имя → первый файл
  const anywhere = new Set();
  for (const [path, text] of Object.entries(files)) {
    for (const name of findSwitchReads(text)) if (!readers.has(name)) readers.set(name, path);
    for (const name of registered) if (text.includes(name)) anywhere.add(name);
  }
  const missing = [...readers].filter(([name]) => !registered.has(name)).map(([name, file]) => ({ name, file }));
  const stale = [...registered].filter((name) => !readers.has(name) && !anywhere.has(name));
  return { missing, stale };
}

function main() {
  const files = {};
  for (const full of walk(API_SRC)) files[relative(ROOT, full)] = readFileSync(full, "utf8");
  const { missing, stale } = findProblems(files, readFileSync(REGISTRY, "utf8"));
  if (!missing.length && !stale.length) {
    console.log(`Реестр функций: все переменные-рубильники учтены (${registryEnvNames(readFileSync(REGISTRY, "utf8")).size} в реестре).`);
    return;
  }
  if (missing.length) {
    console.error(`\nПЕРЕМЕННАЯ-РУБИЛЬНИК БЕЗ ЗАПИСИ В РЕЕСТРЕ ФУНКЦИЙ — ${missing.length} шт.`);
    for (const m of missing) console.error(`  ${m.name}   (читается в ${m.file})`);
    console.error(
      `\nЧто делать: добавить запись в FUNCTION_REGISTRY (packages/shared/src/functionStatus.ts) с этой переменной в env,\n` +
        `и расчёт состояния в apps/api/src/lib/functionStatus.ts. Тогда директор увидит функцию на экране\n` +
        `«Состояние функций», а не узнает о выключенной функции от клиента.`,
    );
  }
  if (stale.length) {
    console.error(`\nВ РЕЕСТРЕ ЕСТЬ ПЕРЕМЕННАЯ, КОТОРОЙ В КОДЕ БОЛЬШЕ НЕТ — ${stale.length} шт.: ${stale.join(", ")}`);
    console.error(`Убрать из env записи реестра (или вернуть чтение переменной).`);
  }
  process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
