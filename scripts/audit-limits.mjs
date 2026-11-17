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
 *  2. У каждого `guardedUpload({...})`:
 *     - есть `maxRequestBytes`, и он не выше потолка — либо рядом
 *       `overProxyCeilingReason: "..."` (кто зовёт мимо прокси и почему);
 *     - `limits.fileSize` не больше `maxRequestBytes` (такой файл дверь не пропустит);
 *     - `limits.fileSize × limits.files` не больше `maxRequestBytes` — либо
 *       `batchFitsReason: "..."` (почему экран всё равно укладывает запрос в предел).
 *     Числа — арифметикой или общими константами (packages/shared/src, тот же файл).
 *     Исключения печатаются при каждом прогоне, чтобы их видели.
 *  3. `express.raw/json/text/urlencoded({ limit })`, в том числе `import { raw } from "express"`
 *     и `bodyParser.*` — предел строкой и не выше потолка.
 *  4. Экран: каждая ОТПРАВКА FormData мимо `api()` (`xhr.send(form)`, `fetch(…, { body: form })`,
 *     свой помощник вида `xhrSend…(…, form, …)`) обязана пройти `assertFitsSingleRequest(form`
 *     раньше отправки. `api()` и `sendToClient()` проверяют вес сами (lib/api.ts).
 *
 * Каждое правило проверено внесением поломки — scripts/audit-limits.test.mjs.
 *
 *   node scripts/audit-limits.mjs
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { maskComments } from "./audit-fetch-timeout.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MB = 1024 * 1024;
const MIN_REASON = 20;

// ── числа ──────────────────────────────────────────────────────────────────────

/** Таблица `const ИМЯ = выражение;` из текста (только ИМЕНА_ЗАГЛАВНЫМИ — константы). */
export function collectConstants(text, into = new Map()) {
  for (const m of maskComments(text).matchAll(/\bconst\s+([A-Z][A-Z0-9_]*)\s*(?::[^=;\n]+)?=\s*/g)) {
    const start = m.index + m[0].length;
    const end = text.indexOf(";", start);
    if (end < 0) continue;
    const expr = text.slice(start, end).trim();
    if (!into.has(m[1]) && expr.length < 200) into.set(m[1], expr);
  }
  return into;
}

/** Число из выражения: арифметика, MB/GB, PROXY_SINGLE_REQUEST_MAX_BYTES и константы таблицы. null — не разобрать. */
export function evalBytes(expr, ceiling, constants = new Map(), depth = 0) {
  if (depth > 8) return null;
  let failed = false;
  const cleaned = expr
    .trim()
    .replace(/\bPROXY_SINGLE_REQUEST_MAX_BYTES\b/g, String(ceiling))
    .replace(/\b[A-Z][A-Z0-9_]*\b/g, (name) => {
      if (name === "MB") return String(MB);
      if (name === "GB") return String(1024 * MB);
      const inner = constants.get(name);
      const value = inner === undefined ? null : evalBytes(inner, ceiling, constants, depth + 1);
      if (value === null) failed = true;
      return String(value);
    })
    .replace(/_/g, "");
  if (failed || !/^[\d\s*+()-]+$/.test(cleaned)) return null;
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

// ── разбор текста ──────────────────────────────────────────────────────────────

function lineOf(text, index) {
  return text.slice(0, index).split("\n").length;
}

/** Закрывающая скобка для открывающей на `open` (по маске — скобки в строках не мешают). */
function matching(masked, open) {
  const pair = { "(": ")", "{": "}", "[": "]" }[masked[open]];
  let depth = 0;
  for (let i = open; i < masked.length; i++) {
    if (masked[i] === masked[open]) depth++;
    else if (masked[i] === pair && --depth === 0) return i;
  }
  return -1;
}

/** Значение верхнего уровня `key:` в объекте [from, to]: { text, start, end } или null. */
function topLevelEntry(source, masked, from, to, key) {
  const re = new RegExp(`\\b${key}\\s*:`, "g");
  re.lastIndex = from;
  for (let m = re.exec(masked); m && m.index < to; m = re.exec(masked)) {
    let depth = 0;
    for (let i = from; i < m.index; i++) {
      if ("{([".includes(masked[i])) depth++;
      else if ("})]".includes(masked[i])) depth--;
    }
    if (depth !== 1) continue;
    const start = m.index + m[0].length;
    let end = start;
    let d = 0;
    for (; end < to; end++) {
      const c = masked[end];
      if ("({[".includes(c)) d++;
      else if (")}]".includes(c)) d--;
      if (d < 0 || (d === 0 && (c === "," || c === "\n"))) break;
    }
    const raw = source.slice(start, end);
    const lead = raw.length - raw.trimStart().length;
    return { text: raw.trim(), start: start + lead, end };
  }
  return null;
}

function stringLiteral(raw) {
  const m = /^(["'`])([\s\S]*)\1$/.exec(raw ?? "");
  return m ? m[2] : null;
}

function reasonOf(source, masked, open, close, key) {
  const r = stringLiteral(topLevelEntry(source, masked, open, close, key)?.text);
  return r && r.trim().length >= MIN_REASON ? r.trim() : null;
}

// ── сервер ─────────────────────────────────────────────────────────────────────

/** Проверка одного серверного файла: { problems: [{ line, problem }], exceptions }. */
export function checkServerSource(source, { file, ceiling, isDoorFile, sharedConstants = new Map() }) {
  const masked = maskComments(source);
  const problems = [];
  const exceptions = [];
  const constants = collectConstants(source, new Map(sharedConstants));
  const mb = (n) => `${Math.round((n / MB) * 10) / 10} МБ`;

  const multerCalls = [...masked.matchAll(/\bmulter\s*\(/g)];
  for (const m of isDoorFile ? multerCalls.slice(1) : multerCalls) {
    problems.push({
      line: lineOf(source, m.index),
      problem: isDoorFile
        ? "второй `multer(` в upload.ts: загрузчик создаётся только через guardedUpload"
        : "`multer(` вне двери: загрузчик создаётся только через guardedUpload (apps/api/src/upload.ts)",
    });
  }

  for (const m of masked.matchAll(/\bguardedUpload\s*\(\s*\{/g)) {
    const open = m.index + m[0].length - 1;
    const close = matching(masked, open);
    const line = lineOf(source, m.index);
    if (close < 0) {
      problems.push({ line, problem: "не разобрать guardedUpload({...})" });
      continue;
    }
    const name = stringLiteral(topLevelEntry(source, masked, open, close, "name")?.text) ?? `строка ${line}`;
    const value = (key, from = open, to = close) => {
      const entry = topLevelEntry(source, masked, from, to, key);
      return entry ? { ...entry, bytes: evalBytes(entry.text, ceiling, constants) } : null;
    };
    const req = value("maxRequestBytes");
    if (!req) {
      problems.push({ line, problem: `${name}: нет maxRequestBytes — назовите вес всего запроса` });
      continue;
    }
    if (req.bytes === null) {
      problems.push({ line, problem: `${name}: maxRequestBytes = ${req.text} — не разобрать: числом, PROXY_SINGLE_REQUEST_MAX_BYTES или константой из packages/shared` });
      continue;
    }
    if (req.bytes > ceiling) {
      const reason = reasonOf(source, masked, open, close, "overProxyCeilingReason");
      if (reason) exceptions.push({ file, line, name, bytes: req.bytes, reason });
      else {
        problems.push({
          line,
          problem:
            `${name}: запрос до ${mb(req.bytes)} одним разом — выше потолка прокси ${mb(ceiling)}. ` +
            "Такой файл не дойдёт до API (Cloudflare вернёт 413): переведите приём на загрузку частями " +
            "(lib/chunkedUploadSessions.ts) или, если вызывающий ходит мимо прокси, укажите overProxyCeilingReason.",
        });
      }
    }

    const limits = topLevelEntry(source, masked, open, close, "limits");
    const limitsOpen = limits && masked[limits.start] === "{" ? limits.start : -1;
    const limitsClose = limitsOpen >= 0 ? matching(masked, limitsOpen) : -1;
    const fileSize = limitsClose > 0 ? value("fileSize", limitsOpen, limitsClose) : null;
    const files = limitsClose > 0 ? value("files", limitsOpen, limitsClose) : null;
    if (!fileSize || fileSize.bytes === null) {
      problems.push({ line, problem: `${name}: limits.fileSize не задан или не разобрать — без него один файл не ограничен` });
      continue;
    }
    if (fileSize.bytes > req.bytes) {
      problems.push({ line, problem: `${name}: limits.fileSize ${mb(fileSize.bytes)} больше maxRequestBytes ${mb(req.bytes)} — такой файл дверь не пропустит` });
      continue;
    }
    const count = files ? files.bytes : Number.POSITIVE_INFINITY;
    if (files && count === null) {
      problems.push({ line, problem: `${name}: limits.files = ${files.text} — не разобрать` });
      continue;
    }
    if (fileSize.bytes * count > req.bytes) {
      const reason = reasonOf(source, masked, open, close, "batchFitsReason");
      if (reason) exceptions.push({ file, line, name, bytes: fileSize.bytes * count, reason: `пачка: ${reason}` });
      else {
        const total = Number.isFinite(count) ? `${count} × ${mb(fileSize.bytes)} = ${mb(fileSize.bytes * count)}` : "без предела числа файлов";
        problems.push({
          line,
          problem:
            `${name}: дверь обещает ${total} за запрос, а пропустит ${mb(req.bytes)}. ` +
            "Уменьшите files/fileSize или укажите batchFitsReason — почему экран укладывает запрос в предел.",
        });
      }
    }
  }

  // Парсеры тела: express.raw(...), bodyParser.raw(...) и голые raw(...) из `import { raw } from "express"`.
  const parsers = ["(?:express|bodyParser)\\s*\\.\\s*(?:raw|json|text|urlencoded)"];
  // Имя модуля в маске стёрто (это строка) — его читаем из исходника по тем же позициям.
  for (const imp of masked.matchAll(/\bimport\s*(?:\w+\s*,\s*)?\{([^}]*)\}\s*from\s*["'][^"'\n]*["']/g)) {
    const text = source.slice(imp.index, imp.index + imp[0].length);
    if (!/from\s*["'](?:express|body-parser)["']$/.test(text)) continue;
    for (const part of imp[1].split(",")) {
      const mm = /^\s*(raw|json|text|urlencoded)(?:\s+as\s+(\w+))?\s*$/.exec(part);
      if (mm) parsers.push(`(?<![.\\w])${mm[2] ?? mm[1]}`);
    }
  }
  const parserRe = new RegExp(`(?:${parsers.join("|")})\\s*\\(\\s*\\{`, "g");
  for (const m of masked.matchAll(parserRe)) {
    const open = m.index + m[0].length - 1;
    const close = matching(masked, open);
    if (close < 0) continue;
    const line = lineOf(source, m.index);
    const raw = topLevelEntry(source, masked, open, close, "limit")?.text;
    if (raw === undefined) continue; // умолчание express — 100 КБ
    const literal = stringLiteral(raw);
    const bytes = literal !== null ? parseLimit(literal) : evalBytes(raw, ceiling, constants);
    if (bytes === null) {
      problems.push({ line, problem: `парсер тела с limit: ${raw} — пишите строкой вида "32mb", чтобы его видел сторож` });
    } else if (bytes > ceiling) {
      problems.push({ line, problem: `парсер тела с limit: ${raw} выше потолка прокси ${mb(ceiling)} — такое тело не дойдёт до API` });
    }
  }
  return { problems, exceptions };
}

// ── экран ──────────────────────────────────────────────────────────────────────

/** Вызовы, которые сами проверяют вес FormData (lib/api.ts) или не отправляют её. */
const SAFE_CALLEES = new Set(["api", "sendToClient", "assertFitsSingleRequest", "formDataFileBytes", "sendFingerprint"]);

/** Экран: каждая отправка FormData мимо api() — после assertFitsSingleRequest(той же формы). */
export function checkWebSource(source) {
  const masked = maskComments(source);
  const problems = [];
  // Форма, созданная прямо в вызове отправки, без переменной, — проверить её нечем.
  for (const m of masked.matchAll(/\b(?:send|fetch)\s*\([^)]*\bnew\s+FormData\b/g)) {
    problems.push({ line: lineOf(source, m.index), problem: "FormData создаётся прямо в отправке — сложите её в переменную и проверьте assertFitsSingleRequest(form)" });
  }
  for (const decl of masked.matchAll(/\b(?:const|let)\s+(\w+)\s*=\s*new\s+FormData\s*\(/g)) {
    const form = decl[1];
    const callRe = /([\w$]+)\s*\(/g;
    callRe.lastIndex = decl.index + decl[0].length;
    for (let c = callRe.exec(masked); c; c = callRe.exec(masked)) {
      const open = c.index + c[0].length - 1;
      const close = matching(masked, open);
      if (close < 0) break;
      const args = masked.slice(open + 1, close);
      if (!new RegExp(`(^|[^.\\w$])${form}\\b`).test(args)) continue;
      const callee = c[1];
      if (SAFE_CALLEES.has(callee) || !/send|fetch|upload|xhr/i.test(callee)) continue;
      const before = masked.slice(decl.index, c.index);
      if (!new RegExp(`\\bassertFitsSingleRequest\\s*\\(\\s*${form}\\b`).test(before)) {
        problems.push({
          line: lineOf(source, c.index),
          problem:
            `${callee}(…${form}…) шлёт FormData без assertFitsSingleRequest(${form}) перед отправкой — тяжёлый файл получит 413 от прокси. ` +
            "Проверьте вес до отправки (lib/singleRequestLimit.ts), шлите через api() или файл частями (lib/chunkedUpload.ts).",
        });
      }
    }
  }
  return problems;
}

// ── обход ──────────────────────────────────────────────────────────────────────

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "generated" || name === "dist" || name === "__tests__") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (/\.(ts|tsx)$/.test(name) && !/\.(test|spec)\.tsx?$/.test(name) && !/\.d\.ts$/.test(name)) yield full;
  }
}

/** Потолок из общего реестра — сторож не держит своей копии числа. */
export function readCeiling(root = ROOT) {
  const text = readFileSync(join(root, "packages", "shared", "src", "uploadLimits.ts"), "utf8");
  const m = /export const PROXY_SINGLE_REQUEST_MAX_BYTES = ([^;]+);/.exec(text);
  if (!m) throw new Error("В packages/shared/src/uploadLimits.ts нет PROXY_SINGLE_REQUEST_MAX_BYTES");
  const value = evalBytes(m[1], 0);
  if (value === null) throw new Error(`Не разобрать PROXY_SINGLE_REQUEST_MAX_BYTES = ${m[1]}`);
  return value;
}

export function scan(root = ROOT) {
  const ceiling = readCeiling(root);
  const sharedConstants = new Map();
  for (const file of walk(join(root, "packages", "shared", "src"))) collectConstants(readFileSync(file, "utf8"), sharedConstants);
  const doorFile = join(root, "apps", "api", "src", "upload.ts");
  const problems = [];
  const exceptions = [];
  for (const file of walk(join(root, "apps", "api", "src"))) {
    const rel = relative(root, file).replace(/\\/g, "/");
    const result = checkServerSource(readFileSync(file, "utf8"), { file: rel, ceiling, isDoorFile: file === doorFile, sharedConstants });
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
