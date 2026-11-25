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
 *  5. Прокси: `read_body` в ops/Caddyfile.example не короче времени, за которое доходит
 *     (а) часть UPLOAD_PART_BYTES на канале 300 Кбит/с с запасом ×2 и (б) самое тяжёлое
 *     одиночное тело (max_size) на канале 1 Мбит/с (25.11.2026: при 10s ролики мастера
 *     получали 502 — см. checkCaddyBodyTimeout).
 *  6. nginx (apps/web/nginx.conf): PUT частей (три семейства адресов) идёт отдельным location
 *     без буферизации тела, с client_max_body_size не меньше части и не больше лимита
 *     express.raw сервера (32 МБ), с таймаутами — checkNginxPartLocation.
 *  7. Caddy `max_size` не ниже PROXY_SINGLE_REQUEST_MAX_BYTES (иначе файлы 25–90 МБ получают
 *     HTML-413 от Caddy) и не выше `client_max_body_size` общего /api/ у nginx.
 *  8. Ответы-заглушки в JSON: у nginx — @proxy_408/413/502/503/504 и error_page в каждом
 *     прокси-location; у Caddy — handle_errors с PROXY_ и application/json.
 *  9. МЯГКОЕ: `requestTimeout`/`headersTimeout` Node в apps/api/src/index.ts проверяются, только
 *     если заданы явно (ставит волна B); не заданы — пропуск без падения.
 *
 * Каждое правило проверено внесением поломки — scripts/audit-limits.test.mjs.
 *
 *   node scripts/audit-limits.mjs
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
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

// ── прокси: потолок времени на тело ───────────────────────────────────────────

/**
 * Самый медленный канал агента, на котором загрузка обязана проходить: 1 Мбит/с.
 * Замер 24.11.2026 (журнал nginx прода): Android-агент отдавал 1,4–3,5 МБ за 10 с,
 * то есть 1,1–2,8 Мбит/с; iPhone 23.11 — 2,1–6 Мбит/с в провалах.
 */
export const MIN_UPLINK_BITS_PER_SEC = 1_000_000;

/**
 * Худший канал для ЧАСТИ загрузки: 300 Кбит/с (разбор 25.11.2026: часть 8 МБ там принимается
 * ≈ 224 с). Запас ×2 — на повтор и на провалы связи внутри одной части.
 */
export const MIN_PART_UPLINK_BITS_PER_SEC = 300_000;
export const PART_TIMEOUT_MARGIN = 2;

/** Лимит `express.raw` на маршрутах частей (apps/api/src/routes): nginx не должен обещать больше. */
export const SERVER_RAW_PART_LIMIT_BYTES = 32 * MB;

/** Длительность Caddy/Go («10s», «5m», «1m30s», «500ms») → секунды; null — не разобрать. */
export function parseDurationSeconds(raw) {
  const text = String(raw).trim();
  if (!/^(\d+(?:\.\d+)?(ms|s|m|h))+$/.test(text)) return null;
  const k = { ms: 0.001, s: 1, m: 60, h: 3600 };
  let total = 0;
  for (const m of text.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h)/g)) total += Number(m[1]) * k[m[2]];
  return total;
}

/** Размер Caddy («25MB» — десятичные мегабайты, «25MiB» — двоичные) → байты; null — не разобрать. */
export function parseCaddySize(raw) {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(b|kb|mb|gb|kib|mib|gib)?\s*$/i.exec(String(raw));
  if (!m) return null;
  const unit = (m[2] ?? "b").toLowerCase();
  const k = { b: 1, kb: 1e3, mb: 1e6, gb: 1e9, kib: 1024, mib: MB, gib: 1024 * MB }[unit];
  return Math.round(Number(m[1]) * k);
}

/**
 * ПРАВИЛО 5 (25.11.2026, разбор 502 при загрузке ролика в мастере): `read_body` у Caddy — потолок
 * на ВСЁ тело запроса, а не на паузу между байтами. При 10s часть ролика 8 МБ на канале
 * 2–6 Мбит/с обрывалась ровно на десятой секунде (nginx: `400 time=10.000 upstream=-`), а телефон
 * получал 502. Сторож: самое тяжёлое тело, которое пропускает прокси (`request_body.max_size`, и
 * не меньше части загрузки `UPLOAD_PART_BYTES`), должно успеть дойти за `read_body` на канале
 * MIN_UPLINK_BITS_PER_SEC. Не задан `read_body` — потолка нет, нарушать нечего.
 */
export function checkCaddyBodyTimeout(
  text,
  {
    partBytes,
    minUplinkBitsPerSec = MIN_UPLINK_BITS_PER_SEC,
    partUplinkBitsPerSec = MIN_PART_UPLINK_BITS_PER_SEC,
    partMargin = PART_TIMEOUT_MARGIN,
  }
) {
  const lines = text.split("\n").map((l) => l.replace(/#.*$/, ""));
  const problems = [];
  let biggest = 0;
  lines.forEach((line, i) => {
    const m = /^\s*max_size\s+(\S+)/.exec(line);
    if (!m) return;
    const bytes = parseCaddySize(m[1]);
    if (bytes === null) problems.push({ line: i + 1, problem: `max_size ${m[1]} — не разобрать` });
    else biggest = Math.max(biggest, bytes);
  });
  // (а) часть на худшем канале с запасом; (б) самое тяжёлое одиночное тело на 1 Мбит/с.
  const partSec = Math.ceil(((partBytes * 8) / partUplinkBitsPerSec) * partMargin);
  const singleSec = Math.ceil((biggest * 8) / minUplinkBitsPerSec);
  const requiredSec = Math.max(partSec, singleSec);
  biggest = Math.max(biggest, partBytes);
  lines.forEach((line, i) => {
    const m = /^\s*read_body\s+(\S+)/.exec(line);
    if (!m) return;
    const sec = parseDurationSeconds(m[1]);
    if (sec === null) {
      problems.push({ line: i + 1, problem: `read_body ${m[1]} — не разобрать (пишите «15m», «900s»)` });
    } else if (sec < requiredSec) {
      problems.push({
        line: i + 1,
        problem:
          `read_body ${m[1]} короче ${requiredSec} с — часть ${Math.round(partBytes / 1e6)} МБ на канале ` +
          `${partUplinkBitsPerSec / 1e3} Кбит/с (запас ×${partMargin}) или тело ${Math.round(biggest / 1e6)} МБ на ` +
          `${minUplinkBitsPerSec / 1e6} Мбит/с не успеет дойти: прокси оборвёт загрузку и телефон получит 502 ` +
          "(read_body — потолок на всё тело, а не на паузу между байтами).",
      });
    }
  });
  return problems;
}

// ── nginx и ответы-заглушки ───────────────────────────────────────────────────

/** Размер nginx («10m», «150m», «2100m», «512k») → байты; null — не разобрать. */
export function parseNginxSize(raw) {
  const m = /^\s*(\d+)\s*([kmg]?)\s*$/i.exec(String(raw));
  if (!m) return null;
  return Number(m[1]) * { "": 1, k: 1024, m: MB, g: 1024 * MB }[m[2].toLowerCase()];
}

/** Список `location …{ тело }` из текста nginx (без комментариев). */
export function nginxLocations(text) {
  const clean = text.split("\n").map((l) => l.replace(/#.*/, "")).join("\n");
  const out = [];
  const re = /\blocation\b([^{]*)\{/g;
  let m;
  while ((m = re.exec(clean))) {
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < clean.length && depth > 0; i++) {
      if (clean[i] === "{") depth++;
      else if (clean[i] === "}") depth--;
    }
    out.push({ name: m[1].trim(), line: clean.slice(0, m.index).split("\n").length, body: clean.slice(m.index + m[0].length, i - 1) });
  }
  return out;
}

const PART_FAMILIES = ["upload-sessions/", "videos/upload-sessions/", "drafts/current/videos/"];
const STUB_CODES = [408, 413, 502, 503, 504];

/**
 * ПРАВИЛА 6 и 8 (nginx). 25.11.2026: части шли под общим /api/ с буферизацией тела — часть
 * 8 МБ на канале 300 Кбит/с лежала в tmpfs 128 МБ (mem_limit контейнера) ≈ 224 с, дюжина таких
 * частей разом роняла nginx, и вся CRM отвечала 502.
 */
export function checkNginxPartLocation(text, { partBytes, rawLimitBytes = SERVER_RAW_PART_LIMIT_BYTES }) {
  const problems = [];
  const locs = nginxLocations(text);
  const parts = locs.filter((l) => l.name.includes("/parts/"));
  if (parts.length === 0) {
    problems.push({ line: 1, problem: "нет location для PUT частей загрузки (…/parts/N): части пойдут под общий /api/ с буферизацией тела в tmpfs" });
  }
  for (const family of PART_FAMILIES) {
    if (parts.length && !parts.some((l) => l.name.includes(family))) {
      problems.push({ line: parts[0].line, problem: `location частей не покрывает семейство адресов «${family}…/parts/N»` });
    }
  }
  for (const l of parts) {
    const at = (problem) => problems.push({ line: l.line, problem: `location ${l.name.slice(0, 40)}…: ${problem}` });
    if (!/\bproxy_request_buffering\s+off\s*;/.test(l.body)) at("нет `proxy_request_buffering off;` — часть копится в tmpfs 128 МБ целиком");
    if (!/\bproxy_http_version\s+1\.1\s*;/.test(l.body)) at("нет `proxy_http_version 1.1;` — без него потоковая отправка тела не работает");
    const cmb = /\bclient_max_body_size\s+(\S+?)\s*;/.exec(l.body);
    const cmbBytes = cmb ? parseNginxSize(cmb[1]) : null;
    if (!cmb || cmbBytes === null) at("нет разборчивого `client_max_body_size`");
    else if (cmbBytes < partBytes) at(`client_max_body_size ${cmb[1]} меньше части ${Math.round(partBytes / MB)} МБ — каждая часть получит 413`);
    else if (cmbBytes >= rawLimitBytes) at(`client_max_body_size ${cmb[1]} не меньше лимита express.raw сервера (${rawLimitBytes / MB} МБ) — обещание шире сервера`);
    if (!/\bclient_body_timeout\s+\d+\s*[sm]\s*;/.test(l.body)) at("нет `client_body_timeout` (пауза между байтами тела)");
    if (!/\bproxy_read_timeout\s+\d+\s*[sm]\s*;/.test(l.body) || !/\bproxy_send_timeout\s+\d+\s*[sm]\s*;/.test(l.body)) at("нет proxy_read_timeout/proxy_send_timeout");
  }
  // Правило 8: заглушки в JSON.
  for (const code of STUB_CODES) {
    const stub = locs.find((l) => l.name === `@proxy_${code}`);
    if (!stub) {
      problems.push({ line: 1, problem: `нет named-location @proxy_${code}: ошибка nginx ${code} придёт HTML-страницей` });
      continue;
    }
    const ok =
      /application\/json/.test(stub.body) &&
      new RegExp(`\\breturn\\s+${code}\\b`).test(stub.body) &&
      stub.body.includes(`"code":"PROXY_${code}"`) &&
      /"message":"[^"]+"/.test(stub.body) &&
      /"retryable":(true|false)/.test(stub.body);
    if (!ok) problems.push({ line: stub.line, problem: `@proxy_${code}: тело должно быть JSON с code PROXY_${code}, message, retryable и Content-Type application/json` });
    const wantRetry = code === 413 ? "false" : "true";
    if (ok && !stub.body.includes(`"retryable":${wantRetry}`)) problems.push({ line: stub.line, problem: `@proxy_${code}: retryable должен быть ${wantRetry}` });
  }
  for (const l of locs) {
    // Только /api/: /uploads/ отдаёт файлы браузеру и Meta, JSON-ответ там не нужен.
    if (!/\bproxy_pass\b/.test(l.body) || !l.name.includes("/api/")) continue;
    for (const code of STUB_CODES) {
      if (!new RegExp(`\\berror_page\\s+${code}\\s+@proxy_${code}\\s*;`).test(l.body)) {
        problems.push({ line: l.line, problem: `location ${l.name.slice(0, 40)}: нет \`error_page ${code} @proxy_${code};\` — ошибка ${code} придёт HTML` });
      }
    }
  }
  return problems;
}

/** `client_max_body_size` общего `location /api/` (байты) или null. */
export function nginxApiBodyLimit(text) {
  const api = nginxLocations(text).find((l) => l.name === "/api/");
  const m = api && /\bclient_max_body_size\s+(\S+?)\s*;/.exec(api.body);
  return m ? parseNginxSize(m[1]) : null;
}

/**
 * ПРАВИЛО 7: Caddy `request_body max_size` не ниже потолка одиночного запроса (иначе файл
 * 25–90 МБ получает HTML-413 без кода) и не выше `client_max_body_size` общего /api/ у nginx.
 * ПРАВИЛО 8 (Caddy): блок handle_errors с JSON.
 */
export function checkCaddyMaxSize(text, { ceiling, nginxApiLimit = null }) {
  const problems = [];
  const lines = text.split("\n").map((l) => l.replace(/#.*$/, ""));
  let inCrm = false;
  lines.forEach((line, i) => {
    if (/^\S.*\{\s*$/.test(line)) inCrm = /crm\./.test(line);
    const m = /^\s*max_size\s+(\S+)/.exec(line);
    if (!m || !inCrm) return;
    const bytes = parseCaddySize(m[1]);
    if (bytes === null) problems.push({ line: i + 1, problem: `max_size ${m[1]} — не разобрать` });
    else if (bytes < ceiling) {
      problems.push({
        line: i + 1,
        problem: `max_size ${m[1]} ниже потолка одиночного запроса ${Math.round(ceiling / MB)} МБ — файлы между ними получат HTML-413 от Caddy без кода`,
      });
    } else if (nginxApiLimit !== null && bytes > nginxApiLimit) {
      problems.push({ line: i + 1, problem: `max_size ${m[1]} выше client_max_body_size у nginx (${Math.round(nginxApiLimit / MB)} МБ)` });
    }
  });
  const joined = lines.join("\n");
  if (!/\bhandle_errors\b/.test(joined) || !/application\/json/.test(joined) || !/PROXY_/.test(joined)) {
    problems.push({ line: 1, problem: "нет `handle_errors` с JSON-ответом (code PROXY_…, application/json): ошибки Caddy придут HTML-страницей" });
  }
  return problems;
}

/**
 * ПРАВИЛО 9 (мягкое): `requestTimeout`/`headersTimeout` Node в apps/api/src/index.ts.
 * Умолчание Node requestTimeout — 300 с на ВСЁ тело: часть 8 МБ на 300 Кбит/с с запасом ×2
 * (≈ 448 с) в него не влезает. Проверяем, только если значение задано явно; 0 — без предела.
 */
export function checkNodeTimeouts(text, { partBytes }) {
  const problems = [];
  const masked = maskComments(text);
  const get = (name) => {
    const m = new RegExp(`\\b${name}\\s*[=:]\\s*([^;,\\n}]+)`).exec(masked);
    return m ? m[1].trim() : null;
  };
  const val = (expr) => evalBytes(expr.replace(/_/g, ""), 0);
  const rt = get("requestTimeout");
  const ht = get("headersTimeout");
  const need = Math.ceil(((partBytes * 8) / MIN_PART_UPLINK_BITS_PER_SEC) * PART_TIMEOUT_MARGIN) * 1000;
  const a = rt === null ? null : val(rt);
  const b = ht === null ? null : val(ht);
  if (rt !== null && a === null) problems.push({ line: 1, problem: `requestTimeout = ${rt} — не разобрать (число миллисекунд или арифметика)` });
  else if (a !== null && a !== 0 && a < need) problems.push({ line: 1, problem: `requestTimeout ${a} мс короче ${need} мс — часть ${Math.round(partBytes / MB)} МБ на 300 Кбит/с с запасом ×2 не успеет` });
  if (a !== null && b !== null && a !== 0 && b > a) problems.push({ line: 1, problem: `headersTimeout ${b} мс больше requestTimeout ${a} мс` });
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
  // Правило 5: шаблон Caddy (по нему ops/bootstrap.sh пишет /etc/caddy/Caddyfile нового сервера,
  // с ним же ops/deploy.sh сверяет живой файл после каждого выката).
  const caddy = join(root, "ops", "Caddyfile.example");
  if (existsSync(caddy)) {
    const partBytes = evalBytes("UPLOAD_PART_BYTES", ceiling, sharedConstants);
    const nginxPath = join(root, "apps", "web", "nginx.conf");
    const nginxText = existsSync(nginxPath) ? readFileSync(nginxPath, "utf8") : null;
    if (partBytes === null) problems.push({ file: "packages/shared/src/uploadLimits.ts", line: 1, problem: "нет UPLOAD_PART_BYTES — сторож read_body не знает размер части" });
    else {
      const caddyText = readFileSync(caddy, "utf8");
      for (const p of checkCaddyBodyTimeout(caddyText, { partBytes })) problems.push({ file: "ops/Caddyfile.example", ...p });
      const nginxLimit = nginxText ? nginxApiBodyLimit(nginxText) : null;
      for (const p of checkCaddyMaxSize(caddyText, { ceiling, nginxApiLimit: nginxLimit })) problems.push({ file: "ops/Caddyfile.example", ...p });
      if (nginxText) for (const p of checkNginxPartLocation(nginxText, { partBytes })) problems.push({ file: "apps/web/nginx.conf", ...p });
      const indexPath = join(root, "apps", "api", "src", "index.ts");
      if (existsSync(indexPath)) for (const p of checkNodeTimeouts(readFileSync(indexPath, "utf8"), { partBytes })) problems.push({ file: "apps/api/src/index.ts", ...p });
    }
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
