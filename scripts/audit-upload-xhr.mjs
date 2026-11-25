#!/usr/bin/env node
/**
 * СТОРОЖ «ШЕСТАЯ ЗАГРУЗКА» (25.11.2026, шаг `npm run precheck` и CI).
 *
 * На клиенте было ПЯТЬ своих реализаций отправки файла через XMLHttpRequest (очередь
 * карточки, мастер, общий помощник частями, фото-пост в соцсети, ролик монтажёра через
 * очередь), и каждая заново решала одни и те же вопросы: сторож тишины (объявлен трижды),
 * «ни одного байта» (дважды), проверка чтения файла (трижды), повторы, журнал. Любая починка
 * доезжала до одной-двух из пяти — так находки аудита 25.11 и появились: у мастера сборка
 * обрывалась на 30 с, хотя у карточки это починили ещё в сентябре.
 *
 * Правило: `new XMLHttpRequest` и `upload.onprogress` в apps/web/src — только в общих
 * кирпичах `apps/web/src/lib/upload/` и в реализациях из `.upload-xhr-baseline.json`.
 * Список только убывает: реализацию перевели на общие кирпичи — уберите её из списка
 * (сторож напомнит, если в файле совпадений стало меньше, чем записано).
 *
 *   node scripts/audit-upload-xhr.mjs            проверить
 *   node scripts/audit-upload-xhr.mjs --update   переписать числа в базе (только вниз)
 *
 * Тесты сторожа (каждое правило проверено внесением поломки) — scripts/audit-upload-xhr.test.mjs.
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = "apps/web/src";
const ALLOWED_DIR = "apps/web/src/lib/upload/";
const BASELINE = ".upload-xhr-baseline.json";

/** Комментарии не считаются: рассказ о XHR в докстринге — не отправка. */
export function maskComments(text) {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const n = text[i + 1];
    if (c === "/" && n === "/") {
      const end = text.indexOf("\n", i);
      const stop = end < 0 ? text.length : end;
      out += " ".repeat(stop - i);
      i = stop - 1;
      continue;
    }
    if (c === "/" && n === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end < 0 ? text.length : end + 2;
      out += text.slice(i, stop).replace(/[^\n]/g, " ");
      i = stop - 1;
      continue;
    }
    out += c;
  }
  return out;
}

const PATTERNS = [/\bnew\s+XMLHttpRequest\s*\(/g, /\.upload\s*\.\s*onprogress\b/g, /\.upload\.addEventListener\s*\(\s*["']progress["']/g];

/** Сколько отправок с прогрессом в тексте файла (без комментариев). */
export function countUploads(text) {
  const masked = maskComments(text);
  return PATTERNS.reduce((sum, re) => sum + (masked.match(re)?.length ?? 0), 0);
}

function isTest(rel) {
  return /(^|\/)__tests__\//.test(rel) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(rel);
}

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.[cm]?[jt]sx?$/.test(name)) out.push(full);
  }
  return out;
}

/** Совпадения по файлам: { "apps/web/src/…": число }. */
export function scan(root = ROOT) {
  const found = {};
  for (const full of walk(join(root, SRC))) {
    const rel = relative(root, full).replace(/\\/g, "/");
    if (isTest(rel) || rel.startsWith(ALLOWED_DIR)) continue;
    const n = countUploads(readFileSync(full, "utf8"));
    if (n > 0) found[rel] = n;
  }
  return found;
}

/**
 * Сверка с базой. База: { files: { путь: { count, reason } } }.
 * Ошибка — новый файл с отправкой; рост числа в известном файле; запись без причины.
 * Предупреждение-ошибка — число упало или файла больше нет: базу надо уменьшить.
 */
export function check(found, baseline) {
  const problems = [];
  const files = baseline.files ?? {};
  for (const [file, count] of Object.entries(found)) {
    const known = files[file];
    if (!known) {
      problems.push(
        `${file}: своя отправка через XMLHttpRequest (${count}). Новых реализаций не заводим — берите общий помощник ` +
          `(lib/chunkedUpload.ts) или кирпичи из ${ALLOWED_DIR}.`
      );
      continue;
    }
    if (!known.reason || String(known.reason).trim().length < 20) problems.push(`${file}: в ${BASELINE} нет причины (не короче 20 знаков).`);
    if (count > known.count) problems.push(`${file}: отправок стало ${count}, в базе ${known.count}. Список только убывает.`);
  }
  for (const [file, known] of Object.entries(files)) {
    const now = found[file] ?? 0;
    if (now < known.count) {
      problems.push(`${file}: отправок ${now}, в базе ${known.count} — уменьшите базу (node scripts/audit-upload-xhr.mjs --update).`);
    }
  }
  return problems;
}

function main() {
  const found = scan();
  const path = join(ROOT, BASELINE);
  const baseline = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { files: {} };
  if (process.argv.includes("--update")) {
    // Только вниз: новые файлы сюда не попадают — для них нужна причина руками.
    for (const [file, known] of Object.entries(baseline.files ?? {})) {
      const now = found[file] ?? 0;
      if (now === 0) delete baseline.files[file];
      else if (now < known.count) known.count = now;
    }
    writeFileSync(path, `${JSON.stringify(baseline, null, 2)}\n`);
    console.log(`${BASELINE} обновлён`);
    return;
  }
  const problems = check(found, baseline);
  const total = Object.values(found).reduce((a, b) => a + b, 0);
  if (problems.length) {
    console.error("✖ audit:upload-xhr — загрузка файла мимо общих кирпичей:");
    for (const p of problems) console.error("  " + p);
    process.exit(1);
  }
  console.log(`✔ audit:upload-xhr — ${total} отправок в ${Object.keys(found).length} известных реализациях, новых нет`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
