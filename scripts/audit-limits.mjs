#!/usr/bin/env node
/**
 * СТОРОЖ «БОЛЬШОЙ ФАЙЛ ОДНИМ ЗАПРОСОМ» (17.11.2026, шаг `npm run precheck` и CI).
 *
 * Живой случай: ролик 87 МБ в «Роликах в соцсети» получал 413 «Файл слишком большой» ещё до
 * API. Между браузером и сервером стоят Cloudflare (тело больше 100 МБ режет) и прокси, а
 * приложение обещало принять 2 ГБ одним запросом — обещание, которое цепочка не выполняет.
 * Поломка не видна ни сборке, ни тестам: на стенде прокси нет, и всё проходит.
 *
 * Правило: всё, что может быть тяжелее PROXY_SINGLE_REQUEST_MAX_BYTES
 * (packages/shared/src/uploadLimits.ts, 90 МБ), едет частями (сессии загрузки), а одиночный
 * приём обещает не больше этого числа на запрос. Сторож проверяет:
 *
 *  1. `multer(` вызывается только в двери `guardedUpload` (apps/api/src/upload.ts) — один раз.
 *  2. У каждого `guardedUpload({...})` есть `maxRequestBytes`, и он не выше потолка — либо
 *     рядом `overProxyCeilingReason: "..."` (кто зовёт мимо прокси и почему). Исключения
 *     печатаются при каждом прогоне, чтобы их видели.
 *  3. `express.raw/json/text/urlencoded({ limit })` — предел строкой и не выше потолка.
 *  4. Экран: файл в apps/web/src, который шлёт FormData через XMLHttpRequest, обязан звать
 *     `assertFitsSingleRequest(` — проверку веса до отправки (запросы через `api()` её уже
 *     проходят внутри api.ts).
 *
 *   node scripts/audit-limits.mjs
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { maskComments } from "./audit-fetch-timeout.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MB = 1024 * 1024;

/** Потолок из общего реестра — сторож не держит своей копии числа. */
export function readCeiling(root = ROOT) {
  const text = readFileSync(join(root, "packages", "shared", "src", "uploadLimits.ts"), "utf8");
  const m = /export const PROXY_SINGLE_REQUEST_MAX_BYTES = ([^;]+);/.exec(text);
  if (!m) throw new Error("В packages/shared/src/uploadLimits.ts нет PROXY_SINGLE_REQUEST_MAX_BYTES");
  const value = evalBytes(m[1], 0);
  if (value === null) throw new Error(`Не разобрать PROXY_SINGLE_REQUEST_MAX_BYTES = ${m[1]}`);
  return value;
}

/** Число из выражения вроде `90 * MB`, `300 * 1024 * 1024`, `PROXY_SINGLE_REQUEST_MAX_BYTES`. null — не разобрать. */
export function evalBytes(expr, ceiling) {
  const cleaned = expr
    .trim()
    .replace(/\bPROXY_SINGLE_REQUEST_MAX_BYTES\b/g, String(ceiling))
    .replace(/\bMB\b/g, String(MB))
    .replace(/\bGB\b/g, String(1024 * MB))
    .replace(/_/g, "");
  if (!/^[\d\s*+()-]+$/.test(cleaned)) return null;
  // Только цифры и арифметика — Function здесь безопасен.
  const value = Function(`"use strict"; return (${cleaned});`)();
  return Number.isFinite(value) ? value : null;
}

/** «32mb», "1gb", "500kb", 1024 → байты; null — не разобрать. */
export function parseLimit(raw) {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?\s*$/i.exec(raw);
  if (!m) return null;
  const unit = (m[2] ?? "b").toLowerCase();
  const k = { b: 1, kb: 1024, mb: MB, gb: 1024 * MB }[unit];
  return Math.round(Number(m[1]) * k);
}

function lineOf(text, index) {
  return text.slice(0, index).split("\n").length;
}

/** Конец объекта `{...}`, начинающегося на `open` (по маске — скобки в строках не мешают). */
function matchingBrace(masked, open) {
  let depth = 0;
  for (let i = open; i < masked.length; i++) {
    if (masked[i] === "{") depth++;
    else if (masked[i] === "}" && --depth === 0) return i;
  }
  return -1;
}

/** Значение верхнего уровня `key:` внутри объекта (до запятой/переноса на нулевой глубине). */
function topLevelValue(source, masked, from, to, key) {
  const re = new RegExp(`\\b${key}\\s*:`, "g");
  re.lastIndex = from;
  for (let m = re.exec(masked); m && m.index < to; m = re.exec(masked)) {
    // Глубина в объекте: ключ вложенного объекта (limits: { fileSize }) нас не интересует.
    let depth = 0;
    for (let i = from; i < m.index; i++) {
      if (masked[i] === "{" || masked[i] === "(" || masked[i] === "[") depth++;
      else if (masked[i] === "}" || masked[i] === ")" || masked[i] === "]") depth--;
    }
    if (depth !== 1) continue;
    let end = m.index + m[0].length;
    let d = 0;
    for (; end < to; end++) {
      const c = masked[end];
      if (c === "(" || c === "[" || c === "{") d++;
      else if (c === ")" || c === "]" || c === "}") d--;
      if (d < 0 || (d === 0 && (c === "," || c === "\n"))) break;
    }
    return source.slice(m.index + m[0].length, end).trim();
  }
  return null;
}

function stringLiteral(raw) {
  const m = /^(["'`])([\s\S]*)\1$/.exec(raw ?? "");
  return m ? m[2] : null;
}

/** Проверка одного серверного файла: [{ line, problem }] и найденные исключения. */
export function checkServerSource(source, { file, ceiling, isDoorFile }) {
  const masked = maskComments(source);
  const problems = [];
  const exceptions = [];

  const multerCalls = [...masked.matchAll(/\bmulter\s*\(/g)];
  if (!isDoorFile) {
    for (const m of multerCalls) {
      problems.push({
        line: lineOf(source, m.index),
        problem: "`multer(` вне двери: загрузчик создаётся только через guardedUpload (apps/api/src/upload.ts)",
      });
    }
  } else if (multerCalls.length > 1) {
    for (const m of multerCalls.slice(1)) {
      problems.push({ line: lineOf(source, m.index), problem: "второй `multer(` в upload.ts: загрузчик создаётся только через guardedUpload" });
    }
  }

  for (const m of masked.matchAll(/\bguardedUpload\s*\(\s*\{/g)) {
    const open = m.index + m[0].length - 1;
    const close = matchingBrace(masked, open);
    const line = lineOf(source, m.index);
    if (close < 0) {
      problems.push({ line, problem: "не разобрать guardedUpload({...})" });
      continue;
    }
    const name = stringLiteral(topLevelValue(source, masked, open, close, "name")) ?? `строка ${line}`;
    const expr = topLevelValue(source, masked, open, close, "maxRequestBytes");
    if (!expr) {
      problems.push({ line, problem: `${name}: нет maxRequestBytes — назовите вес всего запроса` });
      continue;
    }
    const bytes = evalBytes(expr, ceiling);
    if (bytes === null) {
      problems.push({
        line,
        problem: `${name}: maxRequestBytes = ${expr} — пишите числом (N * 1024 * 1024) или PROXY_SINGLE_REQUEST_MAX_BYTES`,
      });
      continue;
    }
    if (bytes <= ceiling) continue;
    const reason = stringLiteral(topLevelValue(source, masked, open, close, "overProxyCeilingReason"));
    if (reason && reason.trim().length >= 20) {
      exceptions.push({ file, line, name, bytes, reason: reason.trim() });
      continue;
    }
    problems.push({
      line,
      problem:
        `${name}: запрос до ${Math.round(bytes / MB)} МБ одним разом — выше потолка прокси ${Math.round(ceiling / MB)} МБ. ` +
        "Такой файл не дойдёт до API (Cloudflare вернёт 413): переведите приём на загрузку частями " +
        "(lib/chunkedUploadSessions.ts) или, если вызывающий ходит мимо прокси, укажите overProxyCeilingReason.",
    });
  }

  for (const m of masked.matchAll(/\b(?:express|bodyParser)\s*\.\s*(raw|json|text|urlencoded)\s*\(\s*\{/g)) {
    const open = m.index + m[0].length - 1;
    const close = matchingBrace(masked, open);
    if (close < 0) continue;
    const line = lineOf(source, m.index);
    const raw = topLevelValue(source, masked, open, close, "limit");
    if (raw === null) continue; // умолчание express — 100 КБ
    const literal = stringLiteral(raw) ?? raw;
    const bytes = parseLimit(literal);
    if (bytes === null) {
      problems.push({ line, problem: `express.${m[1]}({ limit: ${raw} }) — предел строкой вида "32mb", чтобы его видел сторож` });
    } else if (bytes > ceiling) {
      problems.push({
        line,
        problem: `express.${m[1]}({ limit: ${raw} }) выше потолка прокси ${Math.round(ceiling / MB)} МБ — такое тело не дойдёт до API`,
      });
    }
  }
  return { problems, exceptions };
}

/** Экран: XMLHttpRequest + FormData без проверки веса до отправки. */
export function checkWebSource(source) {
  const masked = maskComments(source);
  if (!/\bnew\s+XMLHttpRequest\b/.test(masked) || !/\bnew\s+FormData\b/.test(masked)) return [];
  if (/\bassertFitsSingleRequest\s*\(/.test(masked)) return [];
  const at = masked.search(/\bnew\s+FormData\b/);
  return [
    {
      line: lineOf(source, at),
      problem:
        "FormData уходит через XMLHttpRequest без assertFitsSingleRequest(...) — тяжёлый файл получит 413 от прокси. " +
        "Проверьте вес до отправки (lib/singleRequestLimit.ts) или шлите файл частями (lib/chunkedUpload.ts).",
    },
  ];
}

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "generated" || name === "dist") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (/\.(ts|tsx)$/.test(name) && !/\.(test|spec)\.tsx?$/.test(name) && !/\.d\.ts$/.test(name)) yield full;
  }
}

export function scan(root = ROOT) {
  const ceiling = readCeiling(root);
  const doorFile = join(root, "apps", "api", "src", "upload.ts");
  const problems = [];
  const exceptions = [];
  for (const file of walk(join(root, "apps", "api", "src"))) {
    const rel = relative(root, file).replace(/\\/g, "/");
    const result = checkServerSource(readFileSync(file, "utf8"), { file: rel, ceiling, isDoorFile: file === doorFile });
    for (const p of result.problems) problems.push({ file: rel, ...p });
    exceptions.push(...result.exceptions);
  }
  for (const file of walk(join(root, "apps", "web", "src"))) {
    const rel = relative(root, file).replace(/\\/g, "/");
    for (const p of checkWebSource(readFileSync(file, "utf8"))) problems.push({ file: rel, ...p });
  }
  return { ceiling, problems, exceptions };
}

function main() {
  const { ceiling, problems, exceptions } = scan();
  for (const e of exceptions) {
    console.log(`исключение: ${e.file}:${e.line} ${e.name} до ${Math.round(e.bytes / MB)} МБ — ${e.reason}`);
  }
  if (problems.length) {
    console.error(`audit:limits — ${problems.length} нарушени(й) потолка одного запроса (${Math.round(ceiling / MB)} МБ):\n`);
    for (const p of problems) console.error(`  ${p.file}:${p.line}  ${p.problem}`);
    console.error("\nРазбор и образец — шапка scripts/audit-limits.mjs.");
    process.exit(1);
  }
  console.log(`audit:limits — чисто: одиночные приёмы не тяжелее ${Math.round(ceiling / MB)} МБ, исключений ${exceptions.length}.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
