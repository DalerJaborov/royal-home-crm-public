#!/usr/bin/env node
/**
 * ЧЕЛОВЕЧЕСКАЯ КАРТА — тот же код, рассказанный обычными словами.
 *
 * ЗАЧЕМ. `product-flows.md` точен, но читается инженером: там условия как в коде
 * («!parsed.success»), английские имена таблиц и сотни мелких шагов. Владельцу
 * нужна та же правда, но в виде «нажал на раздел → увидел экраны → нажал на экран
 * → увидел, куда он обращается → нажал на путь → увидел развилки обычными словами».
 *
 * ПРАВИЛА, ЧТОБЫ ЭТО НЕ СТАЛО ПЕРЕСКАЗОМ:
 *   • источник один — `docs/product-flows.json` и `docs/product-map.json`,
 *     то есть тот же разбор кода. Ничего не дописывается от себя;
 *   • перевод делается по словарю `docs/product-map-words.json`. Незнакомое
 *     условие НЕ выдумывается: оно остаётся как в коде и считается в
 *     «непереведённых», чтобы словарь можно было дополнять осознанно;
 *   • шум убирается по правилу, а не на глаз: остаются развилки, ответы,
 *     записи в базу и вызовы наружу; чистые чтения из базы без развилки — нет.
 *
 * Запуск:
 *   node scripts/product-map-simple.mjs         — перезаписать docs/product-map-simple.json
 *   node scripts/product-map-simple.mjs --check — проверить совпадение с кодом
 */

import { readdirSync, readFileSync, writeFileSync, statSync, existsSync } from "node:fs";
import { join, relative, dirname, resolve } from "node:path";

const ROOT = process.cwd();
const WEB_SRC = join(ROOT, "apps/web/src");
const OUT = join(ROOT, "docs/product-map-simple.json");

const F = JSON.parse(readFileSync(join(ROOT, "docs/product-flows.json"), "utf8"));
const M = JSON.parse(readFileSync(join(ROOT, "docs/product-map.json"), "utf8"));
const W = JSON.parse(readFileSync(join(ROOT, "docs/product-map-words.json"), "utf8"));

/* ------------------------------------------------------------------ *
 * 1. Перевод условий и действий.
 * ------------------------------------------------------------------ */
let untranslated = [];

/** Английское имя → русские слова по словарю частей. Неизвестная часть остаётся как есть. */
function words(token) {
  const parts = token
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[-_\s]+/)
    .map((w) => w.toLowerCase())
    .filter(Boolean);
  let known = 0;
  const ru = parts.map((p) => {
    const hit = W.parts[p] ?? W.nouns[p];
    if (hit !== undefined) {
      known++;
      return hit;
    }
    return p;
  });
  const text = ru.filter(Boolean).join(" ").trim();
  return { text: text || token, full: known === parts.length };
}

const SKIP_SEG = new Set(["req", "res", "data", "body", "params", "query", "payload", "row", "item"]);

/* Хвостовые методы не называют сущность: `data.address.trim` — это про адрес,
 * а не про «trim». Раньше такое попадало в карту английским словом и при этом
 * считалось переведённым. */
const TAIL_CALL = { trim: "заполнен", length: "количество", toLowerCase: "", toUpperCase: "", toString: "" };

function humanId(id) {
  const raw = id.split(".").filter(Boolean);
  let segs = raw.filter((x) => !SKIP_SEG.has(x));
  /* `body.trim` после отсева служебных сегментов оставался одним «trim» —
   * тогда берём и служебный сегмент, он тут единственный носитель смысла. */
  if (segs.length === 1 && Object.prototype.hasOwnProperty.call(TAIL_CALL, segs[0])) segs = raw;
  let suffix = "";
  while (segs.length > 1 && Object.prototype.hasOwnProperty.call(TAIL_CALL, segs[segs.length - 1])) {
    const tail = segs.pop();
    suffix = TAIL_CALL[tail] ? ` ${TAIL_CALL[tail]}` : suffix;
  }
  const last = segs[segs.length - 1] || id;
  const w = words(last);
  /* владелец сущности, если он есть: «район объекта», а не просто «район» */
  const owner = segs.length > 1 ? words(segs[segs.length - 2]) : null;
  const base = owner && owner.full && w.full && owner.text !== w.text ? { full: true, text: `${w.text} (${owner.text})` } : w;
  return suffix ? { full: base.full, text: `${base.text}${suffix}` } : base;
}

function negate(phrase) {
  if (phrase.startsWith("включено")) return "выключено" + phrase.slice("включено".length);
  if (phrase.startsWith("выключено")) return "включено" + phrase.slice("выключено".length);
  if (phrase.startsWith("есть ")) return "нет: " + phrase.slice(5);
  if (phrase.startsWith("нет: ")) return "есть " + phrase.slice(5);
  if (phrase.startsWith("можно ")) return "нельзя " + phrase.slice(6);
  if (phrase.startsWith("нельзя ")) return "можно " + phrase.slice(7);
  if (phrase.startsWith("настроено")) return "не настроено" + phrase.slice("настроено".length);
  if (phrase.endsWith(" есть")) return phrase.slice(0, -5) + " не найден";
  if (phrase.endsWith(" совпал")) return phrase.slice(0, -7) + " не совпал";
  if (phrase.endsWith(" задан")) return phrase.slice(0, -6) + " не задан";
  if (phrase.includes(" из списка: ")) return phrase.replace(" из списка: ", " НЕ из списка: ");
  if (phrase.includes(" содержит ")) return phrase.replace(" содержит ", " не содержит ");
  if (phrase.startsWith("это ")) return "это не " + phrase.slice(4);
  if (phrase.endsWith(" — число")) return phrase.slice(0, -8) + " — не число";
  // скобки обязательны: «не так: А и Б» читается наизнанку
  return /\s(и|или)\s/.test(phrase) ? `неверно, что «${phrase}»` : `не так: ${phrase}`;
}

function stripParens(t) {
  while (t.startsWith("(") && t.endsWith(")")) {
    let d = 0, ok = true;
    for (let i = 0; i < t.length; i++) {
      if (t[i] === "(") d++;
      else if (t[i] === ")") {
        d--;
        if (d === 0 && i < t.length - 1) ok = false;
      }
    }
    if (!ok) break;
    t = t.slice(1, -1).trim();
  }
  return t;
}

/** Разрезать по верхнему уровню: скобки и строки не в счёт. */
function splitTop(t, op) {
  const out = [];
  let d = 0, start = 0, q = "";
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) {
      if (c === "\\") i++;
      else if (c === q) q = "";
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { q = c; continue; }
    if ("([{".includes(c)) d++;
    else if (")]}".includes(c)) d--;
    else if (d === 0 && t.startsWith(op, i)) {
      out.push(t.slice(start, i));
      i += op.length - 1;
      start = i + 1;
    }
  }
  out.push(t.slice(start));
  return out.map((x) => x.trim()).filter(Boolean);
}

let partial = false;

function expr(raw, depth = 0) {
  let t = stripParens(String(raw).trim());
  if (!t || depth > 4) return null;
  if (W.phrases[t]) return W.phrases[t];

  /* Скобки в исходнике несут смысл: `(A || B) && C` — это не «A или B и C».
   * Раньше группа теряла границы, и условие читалось наизнанку — например
   * «OFFICE, или (OTHER и нет заметки)» вместо «(OFFICE или OTHER) и нет заметки». */
  const group = (rawPart, text, other) =>
    splitTop(stripParens(String(rawPart).trim()), other).length > 1 ? `(${text})` : text;

  const or = splitTop(t, "||");
  if (or.length > 1) {
    const parts = or.map((x) => expr(x, depth + 1));
    if (parts.some((x) => !x)) return null;
    return parts.map((x, k) => group(or[k], x, "&&")).join(" или ");
  }
  const and = splitTop(t, "&&");
  if (and.length > 1) {
    const parts = and.map((x) => expr(x, depth + 1));
    if (parts.some((x) => !x)) return null;
    return parts.map((x, k) => group(and[k], x, "||")).join(" и ");
  }

  if (t.startsWith("!")) {
    const inner = expr(t.slice(1), depth + 1);
    return inner ? negate(inner) : null;
  }
  t = t.replace(/^await\s+/, "");
  t = stripParens(t);

  let m;
  // право доступа: can(req, "clients.viewAll")
  if ((m = t.match(/^can\s*\(\s*\w+\s*,\s*["'`]([^"'`]+)["'`]\s*\)$/))) {
    return `есть право «${m[1]}»`;
  }
  if ((m = t.match(/^Number\.isFinite\s*\(\s*([\w$.]+)\s*\)$/))) {
    const h = humanId(m[1]);
    if (!h.full) partial = true;
    return `${h.text} — число`;
  }
  t = t.replace(/!\./g, ".").replace(/\?\./g, ".");

  // вызов функции
  if ((m = t.match(/^([\w$.]+)\s*\((.*)\)$/s))) {
    const fname = m[1].split(".").pop();
    if (W.funcs[fname]) return W.funcs[fname];
    if (fname === "test") {
      const arg = expr(m[2], depth + 1);
      return arg ? `${arg} подходит по формату` : null;
    }
    if (fname === "includes" || fname === "has") {
      const owner = m[1].slice(0, -(fname.length + 1));
      const o = owner ? humanId(owner) : null;
      const lit = m[2].match(/^["'`]([^"'`]*)["'`]$/);
      const what = lit ? `«${lit[1]}»` : (expr(m[2], depth + 1) ?? null);
      if (o && what) {
        if (!o.full) partial = true;
        return `${o.text} содержит ${what}`;
      }
      return null;
    }
    let mm;
    if ((mm = fname.match(/^is(.+)Enabled$/))) {
      const w = words(mm[1]);
      if (!w.full) partial = true;
      return `включено: ${w.text}`;
    }
    if ((mm = fname.match(/^(.+)Configured$/))) {
      const w = words(mm[1]);
      if (!w.full) partial = true;
      return `настроено: ${w.text}`;
    }
    if ((mm = fname.match(/^can(.+)$/))) {
      const w = words(mm[1]);
      if (!w.full) partial = true;
      return `можно ${w.text}`;
    }
    if ((mm = fname.match(/^is(.+)$/))) {
      const w = words(mm[1]);
      if (!w.full) partial = true;
      return `это ${w.text}`;
    }
    const w = words(fname);
    if (!w.full) return null;
    return `есть ${w.text}`;
  }

  // сравнения
  if ((m = t.match(/^([\w$.?]+)\s*(===|!==|==|!=)\s*(["'`][^"'`]*["'`]|null|undefined|true|false|-?\d+)$/))) {
    const left = humanId(m[1].replace(/\?/g, ""));
    if (!left.full) partial = true;
    const lit = m[3].replace(/^["'`]|["'`]$/g, "");
    const neg = m[2].startsWith("!");
    if (m[3] === "null" || m[3] === "undefined") return `${left.text} ${neg ? "задан" : "не задан"}`;
    if (m[3] === "true") return neg ? negate(`есть ${left.text}`) : `есть ${left.text}`;
    if (m[3] === "false") return neg ? `есть ${left.text}` : negate(`есть ${left.text}`);
    return `${left.text} ${neg ? "не" : "—"} «${lit}»`;
  }
  if ((m = t.match(/^([\w$.?]+)\s*(>=|<=|>|<)\s*(-?[\d_.]+|[\w$.]+)$/))) {
    const left = humanId(m[1].replace(/\?/g, ""));
    if (!left.full) partial = true;
    const sign = { ">": "больше", "<": "меньше", ">=": "не меньше", "<=": "не больше" }[m[2]];
    const right = /^-?[\d_.]+$/.test(m[3]) ? m[3].replace(/_/g, " ") : humanId(m[3]).text;
    return `${left.text} ${sign} ${right}`;
  }

  // список допустимых значений: ["A","B"].includes(x)
  if ((m = t.match(/^\[([^\]]+)\]\.includes\(([\w$.?]+)\)$/))) {
    const list = [...m[1].matchAll(/["'`]([^"'`]+)["'`]/g)].map((x) => `«${x[1]}»`).join(", ");
    const h = humanId(m[2].replace(/\?/g, ""));
    if (!h.full) partial = true;
    return `${h.text} из списка: ${list}`;
  }

  // просто имя
  if (/^[\w$.?]+$/.test(t)) {
    const h = humanId(t.replace(/\?/g, ""));
    if (!h.full) partial = true;
    return `есть ${h.text}`;
  }
  return null;
}

let partialConds = [];

function translateCond(raw) {
  partial = false;
  const ru = expr(raw);
  if (!ru) {
    untranslated.push(String(raw).trim());
    return null;
  }
  if (partial) partialConds.push(String(raw).trim());
  return ru;
}

function translateAct(a) {
  let m;
  a = a.replace(/\$\{[^}]*\}/g, "…");
  if ((m = a.match(/^ответ (\d{3})(?: — «(.*)»)?$/))) {
    const s = W.statuses[m[1]] || `ответ ${m[1]}`;
    return m[2] ? `${s}: «${m[2]}»` : s;
  }
  if ((m = a.match(/^ошибка \w+(?: — «(.*)»)?$/))) return m[1] ? `поломка: «${m[1]}»` : "поломка";
  if (a === "пробрасывает ошибку дальше") return "поломку разбирает общий обработчик";
  if ((m = a.match(/^(читает|считает|создаёт|меняет|удаляет|создаёт или меняет) в базе: (\w+)$/))) {
    const verb = W.verbs[`${m[1]} в базе`] || m[1];
    const n = W.nouns[m[2]] || humanId(m[2]).text;
    return `${verb}: ${n}`;
  }
  if (a === "всё внутри — одной транзакцией") return "все изменения разом: либо всё, либо ничего";
  if (a.startsWith("проверяет данные схемой")) return "проверяет, что данные заполнены правильно";
  if (a.startsWith("зовёт ")) return null;
  return a;
}

const KEEP_ACT = /^(ответ|отказ|поломка|создано|готово|перебрасывает|всё хорошо|заводит|меняет|удаляет|заводит или обновляет|все изменения|отправка|push|запрос наружу|команда телефонии|запись в журнал|запрос к ИИ)/;

/* ------------------------------------------------------------------ *
 * 2. Упрощение дерева.
 * ------------------------------------------------------------------ */
const FORKS = new Set(["if", "elseif", "else", "switch", "case", "loop", "try", "catch"]);

function simplify(nodes, depth = 0) {
  const out = [];
  for (const n of nodes) {
    const deeper = depth < 3;
    const kids = deeper ? simplify(n.c, depth + 1) : [];
    const cut = !deeper && n.c.length;
    const acts = n.a.map(translateAct).filter(Boolean);
    const keep = acts.filter((a) => KEEP_ACT.test(a));

    if (FORKS.has(n.k)) {
      let text, raw;
      if (n.k === "else") text = "иначе";
      else if (n.k === "try") text = "пробует сделать";
      else if (n.k === "catch") text = "если не получилось";
      else if (n.k === "loop") text = "и так по каждому";
      else if (n.k === "case") text = `вариант ${n.t}`;
      else if (n.k === "switch") text = "смотря что пришло";
      else {
        const ru = translateCond(n.t);
        text = (n.k === "elseif" ? "иначе если " : "если ") + (ru || n.t);
        if (!ru) raw = n.t;
      }
      const node = { t: text, k: n.k, a: keep, c: kids };
      if (raw) node.raw = raw;
      if (cut) node.more = true;
      out.push(node);
      continue;
    }

    // обычный шаг: первое действие становится его подписью, «пустых» шагов не бывает
    if (keep.length) {
      const node = { t: keep[0], k: "do", a: keep.slice(1), c: kids };
      if (cut) node.more = true;
      out.push(node);
    } else if (kids.length) {
      out.push({ t: "внутри этого шага", k: "do", a: [], c: kids });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 3. Кто какой адрес зовёт: экран → адреса.
 * ------------------------------------------------------------------ */
/* Клиент Prisma лежит в исходниках (apps/api/src/generated) и появляется только
 * после `prisma generate` — на сервере проверок он есть, на машине разработчика нет. */
const SKIP_DIR = new Set(["generated", "node_modules", "dist", "build", ".turbo"]);

function walkWeb(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  /* Порядок выдачи readdir зависит от файловой системы: на моей машине один,
   * на сервере проверок другой — и собранная карта расходилась сама с собой.
   * Сортировка делает сборку повторяемой где угодно. */
  for (const name of [...readdirSync(dir)].sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory() && SKIP_DIR.has(name)) continue;
    if (statSync(p).isDirectory()) walkWeb(p, acc);
    else if (/\.(tsx?|ts)$/.test(name)) acc.push(p);
  }
  return acc;
}

const webFiles = walkWeb(WEB_SRC);
const webSrc = new Map(webFiles.map((f) => [f, readFileSync(f, "utf8")]));

/** Локальные импорты файла — чтобы дойти от экрана до общих кусочков. */
function localImports(file) {
  const src = webSrc.get(file) || "";
  const out = [];
  /* Считаем и `from "./x"`, и `import("./x")`: Главная целиком построена на
   * ленивых импортах, и из-за этого в карте у неё было ноль действий. */
  for (const m of src.matchAll(/(?:from\s+"(\.[^"]+)"|import\s*\(\s*["'`](\.[^"'`]+)["'`]\s*\))/g)) {
    const base = resolve(dirname(file), m[1] || m[2]);
    for (const cand of [base + ".tsx", base + ".ts", join(base, "index.tsx"), join(base, "index.ts")]) {
      if (webSrc.has(cand)) {
        out.push(cand);
        break;
      }
    }
  }
  return out;
}

/** Адреса, к которым обращается файл сам, вместе с методом запроса.
 *  `api(`/clients/${id}/accept`, { method: "POST" })` — и адрес, и метод. */
function ownCalls(file) {
  const src = webSrc.get(file) || "";
  const out = [];
  /* `api<Paginated<Client>>(…)` — вложенный дженерик; прежний `<[^>]*>` рвался на
   * первом «>» и терял 42 вызова из 437, а карта при этом заявляла, что непонятых
   * вызовов нет. */
  const re = /\bapi\s*(?:<(?:[^<>]|<[^<>]*>)*>)?\s*\(\s*(["'`])((?:\\.|\$\{[^}]*\}|(?!\1)[^\\])*)\1/g;
  for (const m of re.exec ? [...src.matchAll(re)] : []) {
    const raw = m[2];
    // хвост вызова — там лежит { method: "POST" }
    // метод берём ТОЛЬКО из скобок этого вызова, иначе прилипает соседний
    let depth = 0, close = m.index;
    for (let i = src.indexOf("(", m.index); i < src.length; i++) {
      if (src[i] === "(") depth++;
      else if (src[i] === ")") {
        depth--;
        if (!depth) {
          close = i;
          break;
        }
      }
    }
    const tail = src.slice(m.index, close + 1);
    const method = (tail.match(/method\s*:\s*["'`](GET|POST|PUT|PATCH|DELETE)["'`]/i) || [])[1] || "GET";
    const path = raw
      .replace(/\$\{[^}]*\}/g, ":x") // подстановка — это параметр, а не обрезка адреса
      .replace(/\?.*$/, "")
      // `/calls${qs}` — это строка запроса, приклеенная к адресу, а не сегмент пути
      .replace(/([^/]):x$/, "$1")
      .replace(/\/+$/, "");
    if (path.startsWith("/")) out.push({ path, method: method.toUpperCase() });
  }
  return out;
}

/** Файлы, которые экран использует: сам + его импорты до двух уровней. */
function closureOf(file, depth, seen, out) {
  if (depth > 2 || seen.has(file)) return out;
  seen.add(file);
  out.set(file, Math.min(out.get(file) ?? 9, depth));
  for (const imp of localImports(file)) closureOf(imp, depth + 1, seen, out);
  return out;
}

/** Совпадение адреса интерфейса с адресом сервера — посегментно.
 *  Подстановка есть с обеих сторон: у сервера `:id`, у интерфейса `:x`
 *  (там в коде стояло `${...}`), и любая из них совпадает с чем угодно. */
const epIndex = F.endpoints.map((e, i) => ({
  i,
  method: e.method,
  segs: e.full.replace(/\/+$/, "").split("/"),
}));

function segsMatch(a, b) {
  if (a.length !== b.length) return false;
  return a.every((x, k) => {
    const y = b[k];
    return x === y || x.startsWith(":") || y.startsWith(":") || x === "*" || y.startsWith("*");
  });
}

const unknownCalls = new Set();

/* Сторож на саму выборку: если разборщик узнал меньше вызовов `api(`, чем их в
 * исходнике, часть экранов молча останется без действий — ровно это и случилось
 * с вложенными дженериками. Расхождение валит сборку. */
const missedCalls = [];
{
  /* Считаем только настоящие вызовы: `api(` с похожим на адрес первым аргументом,
   * и без комментариев — в них слово api() встречается в пояснениях. */
  const noComments = (t) =>
    t.replace(/\/\*[\s\S]*?\*\//g, (x) => x.replace(/[^\n]/g, " ")).replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  const RE_ANY = /\bapi\s*(?:<(?:[^<>]|<[^<>]*>)*>)?\s*\(\s*["'`]/g;
  for (const [f, raw] of webSrc) {
    const src = noComments(raw);
    const total = [...src.matchAll(RE_ANY)].length;
    const known = ownCalls(f).length;
    /* вызов без строкового адреса первым аргументом (собран из переменной) */
    const dynamic = [...src.matchAll(/\bapi\s*(?:<(?:[^<>]|<[^<>]*>)*>)?\s*\(\s*[A-Za-z_$]/g)].length;
    if (total - dynamic > known) {
      missedCalls.push(`${relative(ROOT, f).replace(/\\/g, "/")}: в файле ${total} вызовов, разобрано ${known}`);
    }
  }
}

function matchEndpoints(call) {
  const full = ("/api/v1" + call.path).replace(/\/+$/, "") || "/api/v1";
  const segs = full.split("/");
  const hits = epIndex.filter((x) => segsMatch(x.segs, segs) && (x.method === call.method || x.method === "ALL"));
  if (!hits.length) {
    const anyMethod = epIndex.some((x) => segsMatch(x.segs, segs));
    unknownCalls.add(`${call.method} ${full}${anyMethod ? " — адрес есть, но другим способом" : " — такого адреса на сервере нет"}`);
  }
  return hits.map((x) => x.i);
}

/* ------------------------------------------------------------------ *
 * 4. Сборка.
 * ------------------------------------------------------------------ */
const GROUPS = {
  main: "Каждый день",
  inbox: "Входящие: переписка и звонки",
  people: "Люди: клиенты и сделки",
  objects: "Объекты и сайт",
  team: "Команда и контроль",
  money: "Деньги и отчёты",
  ads: "Реклама и воронка",
  system: "Настройки и служебное",
  other: "Прочие экраны, открываются изнутри",
};

const screenClosure = new Map();
const screens = [];
for (const s of M.screens) {
  if (!s.file) continue;
  const abs = join(ROOT, s.file);
  if (!webSrc.has(abs)) continue;
  const closure = closureOf(abs, 0, new Set(), new Map());
  screenClosure.set(s.path, closure);
  const eps = new Map();
  screens.push({
    path: s.path,
    title: s.nav ? s.nav.label : null,
    group: s.nav ? s.nav.group : null,
    parent: null,
    file: s.file,
    inMenu: Boolean(s.nav),
    redirect: s.redirect || null,
    eps: [...eps.entries()].map(([i, direct]) => ({ i, direct })).sort((a, b) => a.i - b.i),
  });
}

// Экран без пункта меню (карточка клиента, карточка объекта) относится к тому же
// разделу, что и ближайший экран из меню: иначе до него нельзя дойти нажатиями.
const menuScreens = screens.filter((s) => s.inMenu);
for (const s of screens) {
  if (s.group) continue;
  let best = null;
  for (const m of menuScreens) {
    const base = m.path.replace(/\/$/, "");
    if (base && base !== "/" && s.path.startsWith(base + "/")) {
      if (!best || base.length > best.path.length) best = m;
    }
  }
  s.group = best ? best.group : "other";
  s.parent = best ? best.path : null;
  if (!s.title) {
    const last = s.path.split("/").filter(Boolean).pop() || s.path;
    if (last.startsWith(":")) {
      s.title = best && best.title ? `${best.title}: карточка` : "Карточка";
    } else {
      const w = words(last).text;
      s.title = w ? w[0].toUpperCase() + w.slice(1) : s.path;
    }
  }
}
for (const s of screens) if (!s.title) s.title = s.path;

// Общая часть, которую тянут почти все экраны (обёртка запроса, общий список),
// не делает её адреса «действиями этого экрана»: иначе «Сделки» получают
// «переписать настройки». Такие файлы в расчёт не идут.
const fileScreens = new Map();
for (const [, closure] of screenClosure) {
  for (const f of closure.keys()) fileScreens.set(f, (fileScreens.get(f) ?? 0) + 1);
}
const COMMON_LIMIT = 8;
for (const s of screens) {
  const closure = screenClosure.get(s.path) || new Map();
  const eps = new Map();
  for (const [f, depth] of closure) {
    // на втором уровне отбрасываем только то, что тянут почти все экраны
    if (depth > 1 && (fileScreens.get(f) ?? 0) > COMMON_LIMIT) continue;
    for (const c of ownCalls(f)) {
      for (const i of matchEndpoints(c)) {
        const conf = depth === 0 ? "точно" : depth === 1 ? "через часть экрана" : "через общую часть";
        const prev = eps.get(i);
        if (!prev || depth < prev.depth) eps.set(i, { depth, conf });
      }
    }
  }
  s.eps = [...eps.entries()]
    .map(([i, v]) => ({ i, direct: v.depth === 0, conf: v.conf }))
    .sort((a, b) => a.i - b.i);
}

const usedByScreen = new Map();
for (const s of screens) for (const { i } of s.eps) {
  if (!usedByScreen.has(i)) usedByScreen.set(i, []);
  usedByScreen.get(i).push(s.path);
}

const moduleLabel = new Map(M.modules.map((m) => [m.mount, m.label || ""]));
const cronLabel = new Map(M.cron.map((c) => [c.id, c.label || ""]));

/** Человеческое имя пути: «Изменить: клиент», «Принять» и т.п. */
function pathTitle(e) {
  const segs = e.full.replace(/^\/api\/v1/, "").split("/").filter((x) => x && !x.startsWith(":"));
  const last = segs[segs.length - 1] || "";
  const byId = /:\w+/.test(e.full);
  const named = W.actions[last];
  const isVerb = named && /(ть|ся)$/.test(named.split(" ")[0]);
  if (isVerb) return named[0].toUpperCase() + named.slice(1);
  const base = named || (last ? words(last).text : moduleLabel.get(e.mount) || e.mount);
  const verb = {
    GET: byId && segs.length <= 1 ? "Открыть" : "Показать",
    POST: "Добавить",
    PUT: "Заменить",
    PATCH: "Изменить",
    DELETE: "Удалить",
    ALL: "Принять запрос",
  }[e.method] || e.method;
  const text = verb ? `${verb}: ${base}` : base[0].toUpperCase() + base.slice(1);
  return text;
}

const paths = F.endpoints.map((e, i) => ({
  i,
  title: pathTitle(e),
  /* Без номера строки — см. пояснение в scripts/product-flows.mjs. */
  where: e.file,
  method: e.method,
  full: e.full,
  mount: e.mount,
  module: moduleLabel.get(e.mount) || e.mount,
  guards: e.guards,
  screens: usedByScreen.get(i) || [],
  tree: simplify(e.tree),
}));

const cron = F.cron.map((c) => ({
  id: c.id,
  when: c.when,
  label: cronLabel.get(c.id) || c.id,
  tree: simplify(c.tree),
}));

const jobs = F.jobs.map((j) => ({ kind: j.kind, tree: simplify(j.tree) }));

const uniqUntranslated = [...new Set(untranslated)].sort();
const uniqPartial = [...new Set(partialConds)].sort();
const totalConds = (() => {
  let n = 0;
  const w = (ns) => ns.forEach((x) => ((x.k === "if" || x.k === "elseif") && n++, w(x.c)));
  F.endpoints.forEach((e) => w(e.tree));
  F.cron.forEach((c) => w(c.tree));
  F.jobs.forEach((j) => w(j.tree));
  return n;
})();

const out = {
  generated_by: "scripts/product-map-simple.mjs",
  groups: GROUPS,
  totals: {
    screens: screens.length,
    paths: paths.length,
    cron: cron.length,
    jobs: jobs.length,
    conditions: totalConds,
    untranslatedUnique: uniqUntranslated.length,
    untranslatedTotal: untranslated.length,
    partialUnique: uniqPartial.length,
    translatedShare: Math.round(((totalConds - untranslated.length) / totalConds) * 100),
  },
  untranslated: uniqUntranslated,
  unknownCalls: [...unknownCalls].sort(),
  screens,
  paths,
  cron,
  jobs,
};

const text = JSON.stringify(out, null, 1) + "\n";

if (missedCalls.length) {
  console.error(
    `Разборщик не увидел часть обращений к серверу (${missedCalls.length} файлов). ` +
      `Экраны остались бы без действий, а карта — зелёной:\n  ` +
      missedCalls.join("\n  "),
  );
  process.exit(1);
}

if (process.argv.includes("--check")) {
  // \r\n→\n перед сравнением — та же защита, что в product-map.mjs/product-flows.mjs:
  // не полагаться только на .gitattributes, чтобы CRLF на диске не красил
  // совпадающую по содержимому карту как «отстала».
  if (!existsSync(OUT) || readFileSync(OUT, "utf8").replace(/\r\n/g, "\n") !== text) {
    console.error(`Человеческая карта отстала от кода: ${relative(ROOT, OUT)}. Выполните: npm run map`);
    process.exit(1);
  }
  console.log(`Человеческая карта совпадает с кодом (${paths.length} путей, ${screens.length} экранов).`);
} else {
  writeFileSync(OUT, text);
  const pct = Math.round(((totalConds - uniqUntranslated.length) / totalConds) * 100);
  console.log(
    `Человеческая карта собрана: ${screens.length} экранов, ${paths.length} путей; условий ${totalConds}, без перевода ${uniqUntranslated.length}`,
  );
}
