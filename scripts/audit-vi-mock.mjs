#!/usr/bin/env node
/**
 * СТОРОЖ ПОДМЕН `vi.mock` БЕЗ `importOriginal` (находка №204, ночная проверка 24.09.2026).
 *
 * ЗАЧЕМ. Фабричная подмена `vi.mock("../src/x.js", () => ({ a, b }))` отрезает
 * модуль ЦЕЛИКОМ: отдаёт только `a` и `b`. Стоит кому-то в коде добавить к
 * модулю `x` новый вывоз и вызвать его там, где тест подменил `x`, — и тест
 * падает не на своей проверке, а внутри чужого файла: «No "<имя>" export is
 * defined on the mock». Красным становится не тот, кто менял код, а все тесты
 * подряд, которые подменяли этот модуль (живой случай — #584,
 * `recordMontajerMessage`; описан в CLAUDE.md, «Ловушки»).
 *
 * ЧТО ДЕЛАЕТ. Обходит `apps/api/tests`, находит `vi.mock("<путь из репозитория>", <фабрика>)`,
 * в фабрике которой нет `importOriginal` / `importActual`, и сверяет имена:
 * каждое вывозимое (runtime) имя модуля обязано встречаться в тексте фабрики.
 * Нет — подмена «узкая», и такая подмена в НОВОМ месте не проходит.
 * Лечение: `vi.mock(путь, async (importOriginal) => ({ ...(await importOriginal()), a, b }))`.
 * Если тест НАМЕРЕННО глушит весь модуль (чтобы не было побочных эффектов) —
 * запись в `.vi-mock-baseline.json`, раздел `intentional`, с причиной.
 *
 * ЧЕГО НЕ ЛОВИТ. Подмены пакетов из node_modules (там чужие вывозы не растут от
 * наших правок), `vi.doMock`, имена, добавляемые через `export *` из нерелятивных
 * путей. Проверка по ТЕКСТУ фабрики: имя в комментарии сойдёт за «отдано» —
 * сторож дешёвый, а не всеведущий.
 *
 * БАЗА. Существующие узкие подмены — в `.vi-mock-baseline.json`:
 *   legacy       — список ключей «тест::модуль», накопленных до 01.10.2026; их
 *                  переводят на importOriginal по мере правок, и список только убывает;
 *   intentional  — ключ → причина, почему подмена должна остаться узкой.
 * Без флага база только читается: валят лишь НОВЫЕ ключи; устаревшие записи
 * (подмену исправили) печатаются как «можно убрать».
 *
 *   node scripts/audit-vi-mock.mjs            # проверить
 *   node scripts/audit-vi-mock.mjs --list     # показать все узкие подмены
 *   node scripts/audit-vi-mock.mjs --update   # пересобрать legacy (добавляет новые, убирает исправленные;
 *                                             # `intentional` не трогает)
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE = join(ROOT, ".vi-mock-baseline.json");

/* ───────── разбор текста ───────── */

/** Индекс закрывающей скобки для открывающей в `text[open]`; пропускает строки и комментарии. */
export function matchParen(text, open) {
  const pairs = { "(": ")", "[": "]", "{": "}" };
  const stack = [];
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    const n = text[i + 1];
    if (c === "/" && n === "/") {
      i = text.indexOf("\n", i);
      if (i < 0) return -1;
      continue;
    }
    if (c === "/" && n === "*") {
      i = text.indexOf("*/", i + 2);
      if (i < 0) return -1;
      i += 1;
      continue;
    }
    if (c === "'" || c === '"') {
      for (i++; i < text.length && text[i] !== c; i++) if (text[i] === "\\") i++;
      continue;
    }
    if (c === "`") {
      for (i++; i < text.length && text[i] !== "`"; i++) {
        if (text[i] === "\\") i++;
        else if (text[i] === "$" && text[i + 1] === "{") {
          const end = matchParen(text, i + 1);
          if (end < 0) return -1;
          i = end;
        }
      }
      continue;
    }
    if (pairs[c]) stack.push(pairs[c]);
    else if (c === ")" || c === "]" || c === "}") {
      if (stack.pop() !== c) return -1;
      if (!stack.length) return i;
    }
  }
  return -1;
}

/** Все `vi.mock(...)` файла: путь, текст фабрики (или null — автоподмена). */
export function findMocks(text) {
  const out = [];
  const re = /\bvi\.mock\s*\(/g;
  let m;
  while ((m = re.exec(text))) {
    const open = m.index + m[0].length - 1;
    const close = matchParen(text, open);
    if (close < 0) continue;
    const args = text.slice(open + 1, close);
    const spec = /^\s*(['"`])([^'"`]+)\1\s*(?:,([\s\S]*))?$/.exec(args);
    if (!spec) continue;
    out.push({ path: spec[2], factory: spec[3] === undefined ? null : spec[3] });
  }
  return out;
}

/** Вывозимые runtime-имена модуля (типы и интерфейсы не считаются). `export *` разворачивается по относительным путям. */
export function exportsOf(file, seen = new Set()) {
  if (seen.has(file)) return new Set();
  seen.add(file);
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return new Set();
  }
  const names = new Set();
  for (const m of text.matchAll(/^export\s+(?:declare\s+)?(?:async\s+)?(?:const\s+enum|const|let|var|function\s*\*?|class|enum)\s+([A-Za-z_$][\w$]*)/gm)) {
    names.add(m[1]);
  }
  if (/^export\s+default\b/m.test(text)) names.add("default");
  for (const m of text.matchAll(/^export\s+(type\s+)?\{([^}]*)\}(?:\s*from\s*['"]([^'"]+)['"])?/gm)) {
    if (m[1]) continue; // export type { … }
    for (const part of m[2].split(",")) {
      const item = part.trim();
      if (!item || /^type\s/.test(item)) continue;
      const alias = /\bas\s+([A-Za-z_$][\w$]*)\s*$/.exec(item);
      names.add(alias ? alias[1] : item);
    }
  }
  for (const m of text.matchAll(/^export\s+\*\s+from\s+['"]([^'"]+)['"]/gm)) {
    const target = resolveModule(dirname(file), m[1]);
    if (target) for (const n of exportsOf(target, seen)) names.add(n);
  }
  return names;
}

/** `../src/x.js` → реальный файл `.ts`/`.tsx`/`.js` внутри репозитория, либо null. */
export function resolveModule(fromDir, spec) {
  if (!spec.startsWith(".")) return null;
  const base = resolve(fromDir, spec);
  const stem = base.replace(/\.(m?js|jsx)$/, "");
  const candidates = [base, `${stem}.ts`, `${stem}.tsx`, `${base}.ts`, join(base, "index.ts"), join(stem, "index.ts")];
  for (const c of candidates) {
    try {
      if (statSync(c).isFile() && /\.(ts|tsx|js|mjs)$/.test(c)) return c;
    } catch {
      /* нет такого */
    }
  }
  return null;
}

const has = (text, name) =>
  new RegExp(`(?<![\\w$])${name.replace(/\$/g, "\\$")}(?![\\w$])`).test(text);

/** Узкие подмены одного файла теста: [{ key, missing }]. */
export function narrowMocks(testFile, text, root = ROOT) {
  const res = new Map();
  for (const mock of findMocks(text)) {
    if (mock.factory === null) continue; // автоподмена — vitest сам видит все имена
    if (/\bimportOriginal\b|\bimportActual\b/.test(mock.factory)) continue;
    const target = resolveModule(dirname(testFile), mock.path);
    if (!target) continue;
    const missing = [...exportsOf(target)].filter((n) => !has(mock.factory, n)).sort();
    if (!missing.length) continue;
    const key = `${relative(root, testFile).replace(/\\/g, "/")}::${relative(root, target).replace(/\\/g, "/")}`;
    const prev = res.get(key);
    // Один модуль подменён дважды в файле — берём худший случай.
    if (!prev || prev.missing.length < missing.length) res.set(key, { key, missing });
  }
  return [...res.values()];
}

/* ───────── обход и база ───────── */

function walk(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, acc);
    else if (/\.test\.tsx?$/.test(entry) || /[\\/]helpers[\\/]/.test(full)) acc.push(full);
  }
  return acc;
}

export function scan(root = ROOT) {
  const found = [];
  for (const f of walk(join(root, "apps/api/tests")).sort()) {
    if (!/\.tsx?$/.test(f)) continue;
    found.push(...narrowMocks(f, readFileSync(f, "utf8"), root));
  }
  return found;
}

function readBaseline(file) {
  if (!existsSync(file)) return { legacy: [], intentional: {} };
  try {
    const j = JSON.parse(readFileSync(file, "utf8"));
    return { legacy: j.legacy || [], intentional: j.intentional || {} };
  } catch {
    console.error(`Не разобрать ${relative(ROOT, file)} — проверка не может быть честной.`);
    process.exit(1);
  }
}

function writeBaseline(file, legacy, intentional) {
  const body = {
    _: "База для scripts/audit-vi-mock.mjs (подмены vi.mock без importOriginal). legacy — накопленные до 01.10.2026 узкие подмены «тест::модуль», только убывает (npm run audit:mocks -- --update убирает исправленные и добавляет новые — добавлять без причины нельзя). intentional — подмена НАМЕРЕННО узкая, причина обязательна. Разбор — в шапке скрипта.",
    intentional,
    legacy: [...legacy].sort(),
  };
  writeFileSync(file, JSON.stringify(body, null, 2) + "\n");
}

function main() {
  const args = process.argv.slice(2);
  const found = scan();
  const base = readBaseline(BASELINE);

  for (const [k, reason] of Object.entries(base.intentional)) {
    if (!String(reason).trim()) {
      console.error(`В ${relative(ROOT, BASELINE)} у «${k}» нет причины — запись не принимается.`);
      process.exit(1);
    }
  }

  if (args.includes("--list")) {
    console.log(`Узких подмен vi.mock (без importOriginal): ${found.length}`);
    for (const f of found) console.log(`  ${f.key}  — не хватает: ${f.missing.slice(0, 6).join(", ")}${f.missing.length > 6 ? "…" : ""}`);
    return;
  }

  if (args.includes("--update")) {
    const keys = found.map((f) => f.key).filter((k) => !(k in base.intentional));
    writeBaseline(BASELINE, keys, base.intentional);
    console.log(`База пересобрана: узких подмен ${keys.length} (намеренных ${Object.keys(base.intentional).length}).`);
    return;
  }

  const allowed = new Set([...base.legacy, ...Object.keys(base.intentional)]);
  const fresh = found.filter((f) => !allowed.has(f.key));
  const foundKeys = new Set(found.map((f) => f.key));
  const stale = [...allowed].filter((k) => !foundKeys.has(k));
  if (stale.length) {
    console.log(`Из ${relative(ROOT, BASELINE)} можно убрать (подмену уже исправили или удалили): ${stale.length} шт. — npm run audit:mocks -- --update`);
  }
  if (!fresh.length) {
    console.log(`Подмены vi.mock: новых узких нет (в базе ${found.length}).`);
    return;
  }
  console.error(
    `\nУЗКАЯ ПОДМЕНА vi.mock БЕЗ importOriginal — ${fresh.length} шт.\n` +
      `Подмена отдаёт меньше имён, чем есть у модуля: когда модуль обзаведётся новым вывозом,\n` +
      `упадут чужие тесты («No "<имя>" export is defined on the mock», класс правки #584).\n`,
  );
  for (const f of fresh) console.error(`  ${f.key}\n      не отдаёт: ${f.missing.join(", ")}`);
  console.error(
    `\nЧто делать: vi.mock(путь, async (importOriginal) => ({ ...(await importOriginal()), …твои имена }))\n` +
      `Если модуль ДОЛЖЕН быть заглушен целиком (побочные эффекты) — запись в\n` +
      `${relative(ROOT, BASELINE)}, раздел intentional, с причиной.`,
  );
  process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
