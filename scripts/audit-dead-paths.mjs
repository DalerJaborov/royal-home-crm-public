#!/usr/bin/env node
/**
 * ДЕТЕКТОР МЁРТВЫХ ПУТЕЙ — код написан, но до человека не доходит.
 *
 * ЗАЧЕМ. 27.08.2026 выяснилось, что кнопка «Закрыть напоминание» существовала с
 * 18 августа: серверный маршрут `/me/summaries/:id/dismiss` написан, хук
 * `useDismissSummary` написан — а кнопки на экране нет, хук не вызывался ниоткуда.
 * Девять дней агенты гасили навязчивое окно единственным доступным способом:
 * «Отложить на 10 минут», четыре раза, потом оно висело безвыходно.
 *
 * Ни один аудит по коду этого не находит, и находить не может: код есть, он
 * корректен, типы сходятся, тесты (которых нет) не падают. Дефект не в коде, а в
 * том, что до кода нельзя добраться из интерфейса.
 *
 * ЧТО ПРОВЕРЯЕТСЯ:
 *   1. Хуки и компоненты фронта, экспортированные и ни разу не использованные.
 *   2. Маршруты API, к которым фронт не обращается ни одной строкой.
 *
 * ЧЕГО ЭТОТ СКРИПТ НЕ УМЕЕТ (и не должен): понимать динамические пути,
 * собранные из переменных. Поэтому вывод — не приговор, а список на глазами
 * посмотреть. Ложное срабатывание здесь дешевле пропуска: пропуск стоил девяти
 * дней навязчивого окна.
 *
 * Запуск: npm run audit:dead
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const WEB_SRC = join(ROOT, "apps/web/src");
const API_SRC = join(ROOT, "apps/api/src");

/** Пути, которые сознательно живут без вызова из интерфейса. */
const ALLOWED_UNUSED_API = [
  // Служебные, их зовут не из браузера.
  "/webhooks",
  "/morning-report",
  "/public",
  "/health",
  "/telephony",
  "/site",
];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "node_modules" || name === "dist") continue;
      walk(full, out);
    } else if (/\.(ts|tsx)$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

const webFiles = walk(WEB_SRC);
const apiFiles = walk(API_SRC);
const webText = webFiles.map((f) => ({ file: f, text: readFileSync(f, "utf8") }));
const allWebText = webText.map((f) => f.text).join("\n");

// ── 1. Экспортированные хуки и компоненты, которые никто не использует ────────
const deadFront = [];
for (const { file, text } of webText) {
  const rel = relative(ROOT, file).replace(/\\/g, "/");
  // Тесты и точки входа проверять незачем: они и есть вызывающие.
  if (/\.(test|spec)\.tsx?$/.test(rel) || rel.endsWith("main.tsx")) continue;

  for (const m of text.matchAll(/export function (use[A-Z]\w+|[A-Z]\w+)\s*\(/g)) {
    const name = m[1];
    // Считаем употребления имени во ВСЕХ файлах фронта, кроме объявления.
    const uses = allWebText.split(new RegExp(`\\b${name}\\b`)).length - 1;
    // Одно вхождение — само объявление. Второе — обычно строка импорта в этом же
    // файле или реэкспорт; порог в два оставляет запас против ложных срабатываний.
    if (uses <= 1) deadFront.push({ file: rel, name });
  }
}

// ── 2. Маршруты API, к которым фронт не обращается ───────────────────────────
const routeRe = /(\w+Router)\.(get|post|put|patch|delete)\(\s*["'`]([^"'`]+)["'`]/g;
const deadApi = [];
for (const file of apiFiles) {
  const rel = relative(ROOT, file).replace(/\\/g, "/");
  if (!rel.includes("/routes/")) continue;
  const text = readFileSync(file, "utf8");

  for (const m of text.matchAll(routeRe)) {
    const [, , method, path] = m;
    if (path === "/" || ALLOWED_UNUSED_API.some((p) => rel.includes(p) || path.includes(p))) continue;
    // Ищем во фронте самый узнаваемый кусок пути: последний статический сегмент.
    // Параметры (:id) во фронте подставляются шаблоном, сравнивать их бесполезно.
    const segments = path.split("/").filter((s) => s && !s.startsWith(":"));
    const needle = segments[segments.length - 1];
    if (!needle || needle.length < 4) continue;
    if (!allWebText.includes(needle)) {
      deadApi.push({ file: rel, method: method.toUpperCase(), path });
    }
  }
}

// ── Вывод ────────────────────────────────────────────────────────────────────
console.log("\n=== МЁРТВЫЕ ПУТИ: код есть, а дойти до него нельзя ===\n");

console.log(`Экспортировано во фронте и нигде не используется: ${deadFront.length}`);
for (const d of deadFront.slice(0, 40)) console.log(`  ${d.file}: ${d.name}`);
if (deadFront.length > 40) console.log(`  … и ещё ${deadFront.length - 40}`);

console.log(`\nМаршруты API без единого обращения из интерфейса: ${deadApi.length}`);
for (const d of deadApi.slice(0, 40)) console.log(`  ${d.method} ${d.path}   (${d.file})`);
if (deadApi.length > 40) console.log(`  … и ещё ${deadApi.length - 40}`);

console.log(
  "\nЭто список НА ПОСМОТРЕТЬ, а не приговор: динамические пути скрипт не понимает.\n" +
    "Но каждая строка здесь — кандидат в «написали и забыли вывести на экран».\n"
);
