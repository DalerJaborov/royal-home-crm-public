#!/usr/bin/env node
/**
 * У КАЖДОГО ДЕЙСТВИЯ ЖУРНАЛА ДОЛЖНА БЫТЬ ПОДПИСЬ (22.09.2026).
 *
 * «Архив» и «Настройки → Система» показывают запись журнала так:
 *   AUDIT_ACTION_LABELS[entry.action] ?? entry.action
 * Подстановка без подписи молча падает на служебный код в нижнем регистре —
 * «property_tiktok_published», «reactivation_auto_accept_call». Ничего не
 * ломается, ошибок нет, и заметить это можно только глазами в самом журнале:
 * на 22.09.2026 подписи были у 21 действия из 104.
 *
 * Сторож сверяет два списка: какие действия сервер РЕАЛЬНО пишет
 * (logAudit/logSystemAudit в apps/api/src) и какие подписаны в
 * apps/web/src/lib/audit.ts. Новое действие без подписи — ошибка сборки, а не
 * находка через месяц.
 *
 * Про сущности (второй аргумент, AUDIT_ENTITY_LABELS) — та же проверка ниже.
 *
 *   node scripts/audit-log-labels.mjs
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, sep as SEP } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const API_SRC = join(ROOT, "apps", "api", "src");
const LABELS_FILE = join(ROOT, "apps", "web", "src", "lib", "audit.ts");

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    // src/generated — клиент Prisma, своего журнала там нет, а файлов десятки тысяч.
    if (name === "generated") continue;
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (full.endsWith(".ts")) out.push(full);
  }
  return out;
}

/**
 * РАЗБОР ВЫЗОВА. Действие и сущность — первый и второй аргументы
 * logSystemAudit и второй с третьим у logAudit (у того первым идёт req).
 * Аргументы режутся по запятым верхнего уровня, а не регэкспом по всему
 * вызову: имя действия бывает тернарником
 * (`material === "photos" ? "PROPERTY_PHOTOS_APPROVED" : "PROPERTY_VIDEO_APPROVED"`,
 * routes/properties/moderation.ts), и такие обе ветки обязаны попасть в
 * проверку — иначе сторож даёт ложную уверенность, что хуже, чем его
 * отсутствие. Читать весь вызов целиком нельзя: в `meta` лежат свои строчные
 * значения в верхнем регистре (статусы, каналы), и они не действия.
 */
function splitArgs(text, openIndex) {
  const args = [];
  let depth = 0;
  let current = "";
  let quote = null;
  for (let i = openIndex + 1; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      current += ch;
      if (ch === "\\") {
        current += text[++i] ?? "";
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      current += ch;
      continue;
    }
    if ("([{".includes(ch)) depth++;
    if (")]}".includes(ch)) {
      if (ch === ")" && depth === 0) {
        args.push(current);
        return args;
      }
      depth--;
    }
    if (ch === "," && depth === 0) {
      args.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  return args;
}

const literals = (arg) => [...(arg ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]);

/**
 * Ветви тернарника без его условия. Действия бывают и в нижнем регистре
 * (`"interview_invite_call_outcome"`, 02.10.2026), а в условии тернарника
 * стоят строчки того же вида: `reason === "freeze" ? "AGENT_FROZEN_…" : …`,
 * `verdict === "bad" ? …`. Без отрезания условия «freeze» и «bad» читались бы
 * как действия журнала. Берём текст после первого `?` верхнего уровня (не
 * `?.` и не `??`) вне кавычек; без тернарника — аргумент целиком.
 */
function ternaryBranches(arg) {
  const text = arg ?? "";
  let quote = null;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if ("([{".includes(ch)) depth++;
    else if (")]}".includes(ch)) depth--;
    else if (ch === "?" && depth === 0 && text[i + 1] !== "." && text[i + 1] !== "?" && text[i - 1] !== "?") {
      return text.slice(i + 1);
    }
  }
  return text;
}

/** Действие журнала: КОД_В_ВЕРХНЕМ или код_в_нижнем регистре. До 02.10.2026
 *  сторож знал только верхний и молча пропускал три действия звонков-роботов
 *  («Архив» показывал их служебным кодом). */
const ACTION_RE = /^(?:[A-Z][A-Z0-9_]*|[a-z][a-z0-9_]*)$/;

const usedActions = new Map(); // действие -> файл, где встретилось первым
const usedEntities = new Map();
for (const file of walk(API_SRC)) {
  if (file.endsWith(`lib${SEP}audit.ts`)) continue; // сами объявления logAudit/logSystemAudit
  const text = readFileSync(file, "utf8");
  const where = file.slice(ROOT.length).replace(/\\/g, "/");
  for (const m of text.matchAll(/log(System)?Audit\(/g)) {
    const args = splitArgs(text, m.index + m[0].length - 1);
    const offset = m[1] ? 0 : 1; // у logAudit первым идёт req
    for (const action of literals(ternaryBranches(args[offset]))) {
      if (ACTION_RE.test(action) && !usedActions.has(action)) usedActions.set(action, where);
    }
    for (const entity of literals(args[offset + 1])) {
      if (/^[A-Z][A-Za-z0-9]*$/.test(entity) && !usedEntities.has(entity)) usedEntities.set(entity, where);
    }
  }
}

const labelsText = readFileSync(LABELS_FILE, "utf8");
function labelledKeys(mapName) {
  const start = labelsText.indexOf(`export const ${mapName}`);
  if (start < 0) throw new Error(`В apps/web/src/lib/audit.ts не нашёлся ${mapName}`);
  const body = labelsText.slice(start, labelsText.indexOf("};", start));
  return new Set([...body.matchAll(/^\s{2}([A-Za-z][A-Za-z0-9_]*):/gm)].map((m) => m[1]));
}

const problems = [];
for (const [name, map] of [
  ["AUDIT_ACTION_LABELS", usedActions],
  ["AUDIT_ENTITY_LABELS", usedEntities],
]) {
  const known = labelledKeys(name);
  for (const [key, where] of [...map].sort()) {
    if (!known.has(key)) problems.push(`  ${key}  — пишется в ${where}, подписи в ${name} нет`);
  }
}

if (problems.length > 0) {
  console.error(
    `Журнал действий покажет служебный код вместо слов (${problems.length}):\n\n` +
      problems.join("\n") +
      "\n\nДобавьте подпись по-русски в apps/web/src/lib/audit.ts — так же, как у\n" +
      "соседних действий. Это то, что владелец читает в «Архиве» и в\n" +
      "«Настройках → Система»; без подписи там будет «property_tiktok_published».\n"
  );
  process.exit(1);
}

console.log(`Журнал действий: подписи есть у всех (${usedActions.size} действий, ${usedEntities.size} сущностей) — ok`);
