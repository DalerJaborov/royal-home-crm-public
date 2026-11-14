#!/usr/bin/env node
/**
 * СТОРОЖ «FETCH БЕЗ ТАЙМАУТА» (находка №12, охота на тихие поломки 14.11.2026).
 *
 * ЗАЧЕМ. Внешний вызов без `signal` (AbortSignal.timeout) при зависшем сервисе висит вечно:
 * тик крона упирается в потолок, очередь стоит, а в журнале ничего нет. Сейчас таймаут есть у
 * всех вызовов `fetch` в `apps/api/src`, но новый вызов без него пройдёт молча: ни сборка, ни
 * тесты этого не видят.
 *
 * ЧТО ДЕЛАЕТ. Обходит `apps/api/src` (без тестов и `generated/`), находит вызовы `fetch(`,
 * `fetcher(`, `aws.fetch(` и `fetchFacebookPublish(` (обёртка, которая таймаут сама не ставит)
 * и требует, чтобы в аргументах того же вызова встречалось слово `signal`
 * (`signal: AbortSignal.timeout(...)`, `signal: controller.signal`, `{ ...init, signal }`).
 * Намеренное исключение: комментарий `fetch-timeout: allow <причина>` на той же строке или строкой выше
 * (например, таймаут задан в переменной `init` выше).
 *
 * ЧЕГО НЕ ЛОВИТ. Обёртки с таймаутом внутри (`fetchWithRetry`, `payomFetch`...): это смотрит ревью;
 * вызовы через `globalThis.fetch(...)`; слово `signal` как имя чужой переменной в аргументах.
 *
 *   node scripts/audit-fetch-timeout.mjs
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";
import { matchParen } from "./audit-vi-mock.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const ALLOW_MARK = "fetch-timeout: allow";

/** Текст с комментариями и содержимым строк, заменёнными пробелами (позиции и переводы строк целы): `fetch()` в комментарии или строке не вызов. */
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
    if (c === "'" || c === '"' || c === "`") {
      let j = i + 1;
      for (; j < text.length && text[j] !== c; j++) {
        if (text[j] === "\\") j++;
        else if (c !== "`" && text[j] === "\n") break;
      }
      // Содержимое строки гасим: `"fetch(url)"` в тексте не вызов. Кавычки и переводы строк остаются.
      out += c + text.slice(i + 1, j).replace(/[^\n]/g, " ") + (j < text.length ? c : "");
      i = j;
      continue;
    }
    out += c;
  }
  return out;
}

/** Вызов, у которого нет `signal` в аргументах и нет пометки-исключения: [{ line, call }]. */
export function findUnguardedFetches(source) {
  const out = [];
  const lines = source.split("\n");
  const text = maskComments(source);
  const re = /(?<![\w$.])(?:fetch|fetcher|fetchFacebookPublish)\s*\(|\baws\.fetch\s*\(/g;
  let m;
  while ((m = re.exec(text))) {
    const before = text.slice(Math.max(0, m.index - 20), m.index);
    // Объявление функции или метода с таким именем: не вызов.
    if (/(?:function\*?|async)\s+$/.test(before)) continue;
    const open = m.index + m[0].length - 1;
    const close = matchParen(text, open);
    if (close < 0) continue;
    const args = text.slice(open + 1, close);
    if (/\bsignal\b/.test(args)) continue;
    const line = text.slice(0, m.index).split("\n").length;
    const near = `${lines[line - 2] ?? ""}\n${lines[line - 1] ?? ""}`;
    if (near.includes(ALLOW_MARK)) continue;
    out.push({ line, call: m[0].replace(/\s*\($/, "") });
  }
  return out;
}

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name === "generated" || name === "node_modules") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) yield full;
  }
}

export function scan(srcDir) {
  const found = [];
  for (const file of walk(srcDir)) {
    for (const hit of findUnguardedFetches(readFileSync(file, "utf8"))) found.push({ file, ...hit });
  }
  return found;
}

function main() {
  const src = join(ROOT, "apps", "api", "src");
  const found = scan(src);
  if (!found.length) {
    console.log("fetch без таймаута: новых нет, ok");
    return;
  }
  console.error(`\nFETCH БЕЗ ТАЙМАУТА: ${found.length} шт.\n`);
  for (const f of found) console.error(`  ${relative(ROOT, f.file).replaceAll("\\", "/")}:${f.line}  ${f.call}(...)`);
  console.error(
    `\nЧто делать: добавить в вызов \`signal: AbortSignal.timeout(мс)\`: зависший сервис иначе держит тик или очередь вечно.\n` +
      `Если таймаут задан иначе (переменная выше) — комментарий \`// ${ALLOW_MARK} <причина>\` на строке вызова или строкой выше.`
  );
  process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
