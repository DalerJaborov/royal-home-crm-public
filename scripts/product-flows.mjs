#!/usr/bin/env node
/**
 * ЛАБИРИНТЫ — все пути сервера с развилками, вычитанные ИЗ КОДА.
 *
 * ЗАЧЕМ. `scripts/product-map.mjs` отвечает на вопрос «что есть» (экраны,
 * модули, задачи по расписанию). Он НЕ отвечает на вопрос «что происходит
 * внутри одного пути»: какие проверки стоят на входе, где развилка, куда
 * уходит «нет» и куда «да», что пишется в базу и кого зовут наружу. Раньше
 * такие схемы рисовались руками и существовали для трёх-четырёх путей из
 * трёхсот с лишним — то есть почти для всего кода их не было вообще.
 *
 * Здесь они строятся разбором исходников: для КАЖДОГО адреса сервера
 * (`router.get/post/put/patch/delete`) выписывается дерево из `if/else`,
 * `try/catch`, циклов и `switch`, а в листьях — что код реально делает:
 * ответ с кодом, ошибка, запись в базу, вызов наружу.
 *
 * ЧЕГО НЕ УМЕЕТ (и честно об этом пишет):
 *   • не исполняет код и не знает, какая ветка случится в жизни — показывает
 *     ВСЕ ветки, которые есть в исходнике;
 *   • пути, собранные из переменных, и обработчики, переданные по имени из
 *     другого файла, отмечаются ссылкой на имя, а не раскрываются;
 *   • глубже шести уровней вложенности не спускается (дальше читать глазами).
 *
 * Запуск:
 *   node scripts/product-flows.mjs          — перезаписать docs/product-flows.*
 *   node scripts/product-flows.mjs --check  — проверить, что файлы совпадают
 *                                             с кодом (код возврата 1, если нет)
 */

import { readdirSync, readFileSync, writeFileSync, statSync, existsSync } from "node:fs";
import { join, relative, dirname, resolve as resolvePath } from "node:path";

const ROOT = process.cwd();
const API_SRC = join(ROOT, "apps/api/src");
const OUT_MD = join(ROOT, "docs/product-flows.md");
const OUT_JSON = join(ROOT, "docs/product-flows.json");

const MAX_DEPTH = 6;
const MAX_TEXT = 110;

/* ------------------------------------------------------------------ *
 * 1. Маскировка строк, шаблонов, комментариев и регулярок.
 *    `struct` — для поиска структуры (скобки внутри строк не мешают),
 *    `code`   — для вырезания читаемого текста (строки на месте).
 *    Длины обеих строк совпадают с исходником, индексы общие.
 * ------------------------------------------------------------------ */
function mask(src) {
  const n = src.length;
  const struct = src.split("");
  const code = src.split("");
  // Стек состояний: строка, шаблон, выражение ${...} внутри шаблона. Без него
  // `${xs.map((p) => `№${p}`)}` разбирается как две строки, скобки перестают
  // сходиться, и роуты файла молча пропадают.
  const stack = [{ t: "code" }];
  let i = 0;
  let prev = "";
  while (i < n) {
    const top = stack[stack.length - 1];
    const c = src[i];
    const c2 = src[i + 1];

    if (top.t === "str") {
      if (c === "\\") {
        struct[i] = "s";
        struct[i + 1] = "s";
        i += 2;
        continue;
      }
      if (c === top.q) {
        stack.pop();
        prev = c;
        i++;
        continue;
      }
      struct[i] = c === "\n" ? "\n" : "s";
      i++;
      continue;
    }

    if (top.t === "tpl") {
      if (c === "\\") {
        struct[i] = "s";
        struct[i + 1] = "s";
        i += 2;
        continue;
      }
      if (c === "`") {
        stack.pop();
        prev = c;
        i++;
        continue;
      }
      if (c === "$" && c2 === "{") {
        stack.push({ t: "expr", depth: 0 });
        i += 2;
        prev = "{";
        continue;
      }
      struct[i] = c === "\n" ? "\n" : "s";
      i++;
      continue;
    }

    // code или expr
    if (c === "/" && c2 === "/") {
      let j = i;
      while (j < n && src[j] !== "\n") {
        struct[j] = " ";
        code[j] = " ";
        j++;
      }
      i = j;
      continue;
    }
    if (c === "/" && c2 === "*") {
      let j = i + 2;
      while (j < n && !(src[j] === "*" && src[j + 1] === "/")) j++;
      j = Math.min(n, j + 2);
      for (let k = i; k < j; k++) {
        const ch = src[k] === "\n" ? "\n" : " ";
        struct[k] = ch;
        code[k] = ch;
      }
      i = j;
      continue;
    }
    if (c === '"' || c === "'") {
      stack.push({ t: "str", q: c });
      i++;
      continue;
    }
    if (c === "`") {
      stack.push({ t: "tpl" });
      i++;
      continue;
    }
    if (c === "/" && /[(,=:[!&|?{};+\n]/.test(prev)) {
      let j = i + 1;
      let ok = false;
      while (j < n && src[j] !== "\n") {
        if (src[j] === "\\") {
          j += 2;
          continue;
        }
        if (src[j] === "[") {
          while (j < n && src[j] !== "]") {
            if (src[j] === "\\") j++;
            j++;
          }
        }
        if (src[j] === "/") {
          ok = true;
          break;
        }
        j++;
      }
      if (ok) {
        for (let k = i + 1; k < j; k++) struct[k] = "r";
        prev = "/";
        i = j + 1;
        continue;
      }
    }
    if (top.t === "expr") {
      if (c === "{") top.depth++;
      else if (c === "}") {
        if (top.depth === 0) {
          stack.pop();
          prev = "}";
          i++;
          continue;
        }
        top.depth--;
      }
    }
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return { struct: struct.join(""), code: code.join("") };
}

const OPEN = { "(": ")", "{": "}", "[": "]" };

function matchPair(s, idx) {
  const open = s[idx];
  const close = OPEN[open];
  if (!close) return -1;
  let d = 0;
  for (let i = idx; i < s.length; i++) {
    if (s[i] === open) d++;
    else if (s[i] === close) {
      d--;
      if (d === 0) return i;
    }
  }
  return -1;
}

function skipSpace(s, i, end) {
  while (i < end && /\s/.test(s[i])) i++;
  return i;
}

function readWord(s, i) {
  let j = i;
  while (j < s.length && /[\w$]/.test(s[j])) j++;
  return s.slice(i, j);
}

function tidy(text) {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > MAX_TEXT ? t.slice(0, MAX_TEXT - 1) + "…" : t;
}

/* ------------------------------------------------------------------ *
 * 2. Что делает один оператор: ответ, ошибка, база, вызов наружу.
 * ------------------------------------------------------------------ */
const OUTBOUND = [
  [/\bfetch\s*\(/, "запрос наружу (fetch)"],
  [/\bsendWhatsapp\w*\s*\(|\bwhatsappSend\w*\s*\(/, "отправка в WhatsApp"],
  [/\bsendTelegram\w*\s*\(/, "отправка в Telegram"],
  [/\bsendInstagram\w*\s*\(|\bigSend\w*\s*\(/, "отправка в Instagram"],
  [/\bsendPush\w*\s*\(|\bpushTo\w*\s*\(/, "push-уведомление"],
  [/\baskGemini\w*\s*\(|\bgemini\w*\s*\(/i, "запрос к ИИ (Gemini)"],
  [/\boriginate\w*\s*\(|\bamiAction\s*\(|\basterisk\w*\s*\(/i, "команда телефонии"],
  [/\blogSystemError\s*\(/, "запись в журнал ошибок"],
];

function actionsOf(text) {
  const out = [];
  const add = (s) => {
    if (s && !out.includes(s)) out.push(s);
  };

  const bare = text.trim();
  if (/^return\s*;?$/.test(bare)) return ["дальше не идёт, ничего не меняя"];
  if (/^continue\s*;?$/.test(bare)) return ["переходит к следующему"];
  if (/^break\s*;?$/.test(bare)) return ["прекращает перебор"];
  if (/^console\.(log|error|warn|info)\(/.test(bare)) return ["пишет строку в журнал сервера"];

  const status = text.match(/\.status\s*\(\s*(\d{3})\s*\)/);
  const statusVar = !status && /\.status\s*\(/.test(text);
  const errRaw = text.match(/error\s*:\s*(["'`])([^"'`]*)\1?/);
  /* Раньше текст резался на 70 символах молча, и обрывок выглядел как полная
   * фраза, которую видит клиент. Теперь обрезка видна. */
  const errMsg = errRaw
    ? [null, errRaw[2].length > 70 ? errRaw[2].slice(0, 70).replace(/\s+\S*$/, "") + "…" : errRaw[2]]
    : null;
  const replies = /\bres\b[\s\S]{0,120}?\.(json|send|redirect|sendFile|end|download|render)\s*\(/.test(text);
  if (replies || status || statusVar) {
    const code = status
      ? status[1]
      : statusVar
        ? "(код зависит от условия)"
        : /\bres\b[\s\S]{0,60}?\.redirect\s*\(/.test(text)
          ? "302"
          : "200";
    add(`ответ ${code}${errMsg ? ` — «${errMsg[1]}»` : ""}`);
  }
  const thrown = text.match(/throw\s+new\s+(\w+)\s*\(\s*["'`]?([^"'`)]{0,70})/);
  if (thrown) add(`ошибка ${thrown[1]}${thrown[2] ? ` — «${thrown[2].trim()}»` : ""}`);
  else if (/\bthrow\b/.test(text)) add("пробрасывает ошибку дальше");

  /* Работа с cookie и заголовками ответа раньше пропадала целиком: выход из
   * сессии в карте выглядел так, будто cookie никто не трогает. */
  if (/\bres\s*\.\s*clearCookie\s*\(/.test(text)) add("стирает cookie входа");
  else if (/\bres\s*\.\s*cookie\s*\(/.test(text)) add("ставит cookie входа");
  if (/\bres\s*\.\s*(?:setHeader|set|append|type|vary|attachment)\s*\(/.test(text)) add("ставит заголовок ответа");

  if (/\$transaction\s*\(/.test(text)) add("всё внутри — одной транзакцией");
  if (/\$(?:executeRaw|queryRaw)/.test(text)) add("обращается к базе своим SQL");
  for (const m of text.matchAll(
    /\b(?:prisma|tx)\s*\.\s*(\w+)\s*\.\s*(findMany|findFirst|findUnique|findUniqueOrThrow|create|createMany|update|updateMany|upsert|delete|deleteMany|count|aggregate|groupBy)\b/g,
  )) {
    const verb = {
      findMany: "читает",
      findFirst: "читает",
      findUnique: "читает",
      findUniqueOrThrow: "читает",
      count: "считает",
      aggregate: "считает",
      groupBy: "считает",
      create: "создаёт",
      createMany: "создаёт",
      update: "меняет",
      updateMany: "меняет",
      upsert: "создаёт или меняет",
      delete: "удаляет",
      deleteMany: "удаляет",
    }[m[2]];
    add(`${verb} в базе: ${m[1]}`);
  }
  for (const [re, label] of OUTBOUND) if (re.test(text)) add(label);

  const parse = text.match(/(\w+[Ss]chema)\s*\.\s*(safeParse|parse)\s*\(/);
  if (parse) add(`проверяет данные схемой ${parse[1]}`);

  return out;
}

/* ------------------------------------------------------------------ *
 * 3. Разбор тела обработчика в дерево развилок.
 * ------------------------------------------------------------------ */
function parseBlock(struct, code, start, end, depth) {
  const nodes = [];
  let i = start;
  let guard = 0;
  while (i < end && guard++ < 4000) {
    i = skipSpace(struct, i, end);
    if (i >= end) break;
    const ch = struct[i];
    if (ch === ";" || ch === "}") {
      i++;
      continue;
    }
    if (ch === "{") {
      const close = matchPair(struct, i);
      if (close < 0 || close > end) break;
      nodes.push(...parseBlock(struct, code, i + 1, close, depth));
      i = close + 1;
      continue;
    }
    const word = /[A-Za-z_$]/.test(ch) ? readWord(struct, i) : "";

    if (word === "if") {
      const res = parseIf(struct, code, i, end, depth);
      nodes.push(...res.nodes);
      i = res.next;
      continue;
    }
    if (word === "try") {
      const res = parseTry(struct, code, i, end, depth);
      nodes.push(...res.nodes);
      i = res.next;
      continue;
    }
    if (word === "switch") {
      const res = parseSwitch(struct, code, i, end, depth);
      nodes.push(...res.nodes);
      i = res.next;
      continue;
    }
    if (word === "for" || word === "while") {
      const res = parseLoop(struct, code, i, end, depth, word);
      nodes.push(...res.nodes);
      i = res.next;
      continue;
    }

    const stEnd = endOfStatement(struct, i, end);
    pushStatement(nodes, struct, code, i, stEnd, depth);
    i = stEnd;
  }
  return nodes;
}

function endOfStatement(struct, i, end) {
  let j = i;
  while (j < end) {
    const c = struct[j];
    if (OPEN[c]) {
      const close = matchPair(struct, j);
      if (close < 0 || close > end) return end;
      j = close + 1;
      continue;
    }
    if (c === ";") return j + 1;
    if (c === "}") return j;
    j++;
  }
  return end;
}

/** Оператор: его действия + то, что спрятано в переданной функции-колбэке. */
function pushStatement(nodes, struct, code, start, end, depth) {
  const text = code.slice(start, end);
  const acts = actionsOf(text);
  let children = [];
  if (depth < MAX_DEPTH) {
    const arrow = struct.indexOf("=>", start);
    if (arrow > -1 && arrow < end) {
      const braceAt = skipSpace(struct, arrow + 2, end);
      if (struct[braceAt] === "{") {
        const close = matchPair(struct, braceAt);
        if (close > 0 && close <= end) children = parseBlock(struct, code, braceAt + 1, close, depth + 1);
      }
    }
  }
  let calls = null;
  if (!acts.length && !children.length) {
    const m = text.match(/\b([\w$]{4,})\s*\(/);
    if (!m || !fnIndex.has(m[1])) return;
    calls = m[1];
  }
  const head = tidy(text.split("=>")[0] || text);
  nodes.push({ k: "do", t: head, a: calls ? [`зовёт ${calls}()`] : acts, c: children });
}

function parseIf(struct, code, i, end, depth) {
  const paren = skipSpace(struct, i + 2, end);
  if (struct[paren] !== "(") return { nodes: [], next: i + 2 };
  const pClose = matchPair(struct, paren);
  const cond = tidy(code.slice(paren + 1, pClose));
  const body = bodyAfter(struct, code, pClose + 1, end, depth);
  const node = { k: "if", t: cond, a: [], c: body.nodes };
  const nodes = [node];
  let next = body.next;
  const w = skipSpace(struct, next, end);
  if (readWord(struct, w) === "else") {
    const afterElse = skipSpace(struct, w + 4, end);
    if (readWord(struct, afterElse) === "if") {
      const chain = parseIf(struct, code, afterElse, end, depth);
      chain.nodes[0].k = "elseif";
      nodes.push(...chain.nodes);
      next = chain.next;
    } else {
      const eb = bodyAfter(struct, code, afterElse, end, depth, true);
      nodes.push({ k: "else", t: "иначе", a: [], c: eb.nodes });
      next = eb.next;
    }
  }
  return { nodes, next };
}

/** Ветка, в которой разбор не узнал ни одного действия, печатается дословно:
 *  молчание («если password» и пусто) хуже честного куска кода. */
function verbatim(struct, code, start, end) {
  const out = [];
  let i = start;
  for (let k = 0; k < 2 && i < end; k++) {
    i = skipSpace(struct, i, end);
    if (i >= end) break;
    const stEnd = endOfStatement(struct, i, end);
    const text = tidy(code.slice(i, stEnd));
    if (text) out.push({ k: "do", t: text, a: ["дословно из кода"], c: [] });
    i = stEnd;
  }
  return out;
}

function bodyAfter(struct, code, from, end, depth, atStart = false) {
  const i = atStart ? from : skipSpace(struct, from, end);
  if (struct[i] === "{") {
    const close = matchPair(struct, i);
    if (close < 0 || close > end) return { nodes: [], next: end };
    let nodes = depth < MAX_DEPTH ? parseBlock(struct, code, i + 1, close, depth + 1) : [];
    if (!nodes.length && skipSpace(struct, i + 1, close) < close) {
      nodes = verbatim(struct, code, i + 1, close);
    }
    return { nodes, next: close + 1 };
  }
  const stEnd = endOfStatement(struct, i, end);
  let nodes = [];
  pushStatement(nodes, struct, code, i, stEnd, depth + 1);
  if (!nodes.length) nodes = verbatim(struct, code, i, stEnd);
  return { nodes, next: stEnd };
}

function parseTry(struct, code, i, end, depth) {
  const brace = skipSpace(struct, i + 3, end);
  if (struct[brace] !== "{") return { nodes: [], next: i + 3 };
  const close = matchPair(struct, brace);
  const nodes = [
    { k: "try", t: "пробует", a: [], c: depth < MAX_DEPTH ? parseBlock(struct, code, brace + 1, close, depth + 1) : [] },
  ];
  let next = close + 1;
  let w = skipSpace(struct, next, end);
  if (readWord(struct, w) === "catch") {
    let j = skipSpace(struct, w + 5, end);
    if (struct[j] === "(") j = matchPair(struct, j) + 1;
    const cb = bodyAfter(struct, code, j, end, depth);
    nodes.push({ k: "catch", t: "если сорвалось", a: [], c: cb.nodes });
    next = cb.next;
    w = skipSpace(struct, next, end);
  }
  if (readWord(struct, w) === "finally") {
    const fb = bodyAfter(struct, code, w + 7, end, depth);
    nodes.push({ k: "finally", t: "в любом случае", a: [], c: fb.nodes });
    next = fb.next;
  }
  return { nodes, next };
}

function parseLoop(struct, code, i, end, depth, word) {
  let j = skipSpace(struct, i + word.length, end);
  let head = "";
  if (struct[j] === "(") {
    const close = matchPair(struct, j);
    head = tidy(code.slice(j + 1, close));
    j = close + 1;
  }
  const body = bodyAfter(struct, code, j, end, depth);
  return {
    nodes: [{ k: "loop", t: `для каждого: ${head}`, a: [], c: body.nodes }],
    next: body.next,
  };
}

function parseSwitch(struct, code, i, end, depth) {
  let j = skipSpace(struct, i + 6, end);
  let head = "";
  if (struct[j] === "(") {
    const close = matchPair(struct, j);
    head = tidy(code.slice(j + 1, close));
    j = skipSpace(struct, close + 1, end);
  }
  if (struct[j] !== "{") return { nodes: [], next: j };
  const close = matchPair(struct, j);
  const cases = [];
  let k = j + 1;
  while (k < close) {
    const w = readWord(struct, skipSpace(struct, k, close));
    if (w !== "case" && w !== "default") {
      k++;
      continue;
    }
    const start = skipSpace(struct, k, close);
    const colon = struct.indexOf(":", start);
    if (colon < 0 || colon > close) break;
    let bodyEnd = close;
    for (let p = colon + 1; p < close; p++) {
      if (OPEN[struct[p]]) {
        const cl = matchPair(struct, p);
        if (cl > 0) p = cl;
        continue;
      }
      const nw = /[A-Za-z_$]/.test(struct[p]) ? readWord(struct, p) : "";
      if ((nw === "case" || nw === "default") && !/[\w$]/.test(struct[p - 1] || " ")) {
        bodyEnd = p;
        break;
      }
      if (nw) p += nw.length - 1;
    }
    cases.push({
      k: "case",
      t: tidy(code.slice(start, colon)),
      a: [],
      c: depth < MAX_DEPTH ? parseBlock(struct, code, colon + 1, bodyEnd, depth + 1) : [],
    });
    k = bodyEnd;
  }
  return {
    nodes: [{ k: "switch", t: `смотря что в: ${head}`, a: [], c: cases }],
    next: close + 1,
  };
}

/* ------------------------------------------------------------------ *
 * 4. Где какой роутер живёт и под каким адресом подключён.
 * ------------------------------------------------------------------ */
/* Папки, которых в разборе быть не должно: `src/generated` — это клиент Prisma,
 * его кладёт `prisma generate` прямо в исходники (он в .gitignore). На моей машине
 * его нет, а на сервере проверок он есть — и собранная там карта расходилась с
 * собранной здесь. Отдельно исключены установленные пакеты и сборка. */
const SKIP_DIR = new Set(["generated", "node_modules", "dist", "build", ".turbo"]);

/* Порядок сортировки НЕ через localeCompare: он зависит от сборки ICU в Node, и
 * карта, собранная на машине разработчика, расходилась с собранной на сервере
 * проверок при одном и том же коде. Сравнение по кодам символов одинаково везде. */
const byCode = (a, b) => (a < b ? -1 : a > b ? 1 : 0);


function walkFiles(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  /* Порядок выдачи readdir зависит от файловой системы: на моей машине один,
   * на сервере проверок другой — и собранная карта расходилась сама с собой.
   * Сортировка делает сборку повторяемой где угодно. */
  for (const name of [...readdirSync(dir)].sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (SKIP_DIR.has(name)) continue;
      walkFiles(p, acc);
    }
    else if (name.endsWith(".ts") && !name.endsWith(".d.ts")) acc.push(p);
  }
  return acc;
}

/* Раньше обходили только routes/. Из-за этого мимо карты прошли адреса,
 * объявленные прямо на приложении (app.get) и роутеры, живущие вне routes/
 * (meRouter в auth/middleware.ts). Теперь обходим весь исходник сервера, а
 * сторож ниже падает, если хоть одно объявление адреса не попало в карту. */
const files = walkFiles(API_SRC);
const parsed = new Map();
for (const f of files) {
  const src = readFileSync(f, "utf8");
  parsed.set(f, { ...mask(src), src, rel: relative(ROOT, f).replace(/\\/g, "/") });
}

/* Роутеры различаются ПАРОЙ «файл + имя». Одного имени мало: `listRouter`
 * объявлен и в routes/clients/list.ts, и в routes/properties/list.ts, и при
 * ключе по имени один затирал другой — клиентские адреса уезжали к объектам,
 * а `GET /api/v1/clients` пропадал из карты целиком. */
const APP_FILE = join(API_SRC, "app.ts");
const appParsed = { ...mask(readFileSync(APP_FILE, "utf8")), rel: "apps/api/src/app.ts" };

/** Где объявлен роутер с таким именем: файл → имя. */
const declaredIn = new Map(); // "file::name" -> true
for (const [f, p] of parsed) {
  for (const m of p.struct.matchAll(/\b(?:export\s+)?const\s+([\w$]+)\s*(?::[^=]*)?=\s*Router\s*\(/g)) {
    declaredIn.set(`${f}::${m[1]}`, true);
  }
}

/** Куда ведёт импорт `import { name } from "./x.js"` в этом файле. */
function importSource(fileSrc, fileDir, name) {
  const re = new RegExp(`import\\s*\\{([^}]*\\b${name}\\b[^}]*)\\}\\s*from\\s*"([^"]+)"`);
  const m = fileSrc.match(re);
  if (!m) return null;
  const rel = m[2].replace(/\.js$/, "");
  if (!rel.startsWith(".")) return null;
  const base = resolvePath(fileDir, rel);
  for (const cand of [base + ".ts", join(base, "index.ts")]) if (parsed.has(cand)) return cand;
  return null;
}

/** Куда ведёт реэкспорт `export { name } from "./x.js"` (файлы-баррели). */
function reexportSource(fileSrc, fileDir, name) {
  const re = new RegExp(`export\\s*\\{([^}]*\\b${name}\\b[^}]*)\\}\\s*from\\s*"([^"]+)"`);
  const m = fileSrc.match(re);
  if (!m) return null;
  const rel = m[2].replace(/\.js$/, "");
  if (!rel.startsWith(".")) return null;
  const base = resolvePath(fileDir, rel);
  for (const cand of [base + ".ts", join(base, "index.ts")]) if (parsed.has(cand)) return cand;
  return null;
}

/** Ключ роутера: файл, где он ОБЪЯВЛЕН, плюс имя. Проходит импорты и баррели. */
function keyOf(file, name, src, hops = 0) {
  if (declaredIn.has(`${file}::${name}`)) return `${file}::${name}`;
  if (hops > 6) return `::${name}`;
  const text = src ?? parsed.get(file)?.code ?? "";
  const next = importSource(text, dirname(file), name) || reexportSource(text, dirname(file), name);
  if (!next) return `::${name}`;
  return keyOf(next, name, parsed.get(next)?.code ?? "", hops + 1);
}

/* Ключ роутера внутри программы — это ПОЛНЫЙ путь к файлу плюс имя. В файл
 * карты он должен попадать путём от корня репозитория: иначе карта, собранная
 * у меня, никогда не совпадёт с собранной на сервере проверок, где репозиторий
 * лежит по другому пути. Ловилось только сверкой и выглядело как «карта отстала». */
const relKey = (key) => {
  const i = key.lastIndexOf("::");
  if (i <= 0) return key;
  return `${relative(ROOT, key.slice(0, i)).replace(/\\/g, "/")}${key.slice(i)}`;
};

const isRouterName = (x) => /[\w$]*[Rr]outer$/.test(x);

/** Аргументы `use(...)`, кроме самих роутеров, — это проверки на входе для ВСЕХ путей. */
function splitUseArgs(text) {
  const routers = [];
  const guards = [];
  let depth = 0, start = 0;
  const parts = [];
  for (let i = 0; i <= text.length; i++) {
    const c = text[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    if (i === text.length || (c === "," && depth === 0)) {
      parts.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  for (const part of parts) {
    if (!part) continue;
    const id = part.match(/^([\w$.]+)/);
    if (id && isRouterName(id[1])) routers.push(id[1]);
    else guards.push(part);
  }
  return { routers, guards };
}

// куда подключён каждый роутер верхнего уровня + промежуточные проверки
const mounts = new Map(); // key -> "/api/v1/x"
const mountGuards = new Map(); // key -> [...]
/* Защиты, подключённые ОТДЕЛЬНОЙ строкой без роутера:
 * `app.use("/api/v1", apiLimiter)` и `app.use("/api/v1/auth/login", authLimiter)`.
 * Раньше такая строка пропускалась целиком, и защита от перебора пароля
 * исчезала из карты — вход выглядел вообще без проверок. */
const prefixGuards = []; // [{prefix, guards:[...]}]
for (const m of appParsed.code.matchAll(/app\.use\(\s*"([^"]+)"\s*,([\s\S]*?)\)\s*;/g)) {
  const { routers, guards } = splitUseArgs(m[2]);
  const last = routers[routers.length - 1];
  if (!m[1].startsWith("/api")) continue;
  if (!last) {
    if (guards.length) prefixGuards.push({ prefix: m[1], guards });
    continue;
  }
  const key = keyOf(APP_FILE, last, appParsed.code);
  mounts.set(key, m[1]);
  if (guards.length) mountGuards.set(key, guards);
}

/** Защиты по адресу: всё, чей префикс покрывает этот путь. */
function guardsByPath(full) {
  const out = [];
  for (const g of prefixGuards) {
    if (full === g.prefix || full.startsWith(g.prefix.replace(/\/$/, "") + "/")) out.push(...g.guards);
  }
  return out;
}

// вложенные роутеры и проверки уровня роутера
const nested = new Map(); // childKey -> {parentKey, prefix}
const routerGuards = new Map(); // key -> [...]
for (const [f, p] of parsed) {
  for (const m of p.code.matchAll(/([\w$]+)\.use\(([\s\S]*?)\)\s*;/g)) {
    const parentName = m[1];
    if (!isRouterName(parentName)) continue;
    const parentKey = keyOf(f, parentName, p.code);
    let rest = m[2];
    let prefix = "";
    const pm = rest.match(/^\s*"([^"]*)"\s*,/);
    if (pm) {
      prefix = pm[1];
      rest = rest.slice(pm[0].length);
    }
    const { routers, guards } = splitUseArgs(rest);
    for (const r of routers) {
      const childKey = keyOf(f, r, p.code);
      if (childKey === parentKey) continue;
      nested.set(childKey, { parentKey, prefix });
    }
    if (guards.length && !routers.length) {
      routerGuards.set(parentKey, (routerGuards.get(parentKey) || []).concat(guards));
    }
  }
}

/** Роутер верхнего уровня, через который этот подключён к приложению. */
function topRouterOf(key, seen = new Set()) {
  if (mounts.has(key)) return key;
  if (seen.has(key)) return key;
  seen.add(key);
  const up = nested.get(key);
  return up ? topRouterOf(up.parentKey, seen) : key;
}

function mountOf(key, seen = new Set()) {
  if (mounts.has(key)) return mounts.get(key);
  if (seen.has(key)) return "";
  seen.add(key);
  const up = nested.get(key);
  if (!up) return "";
  return mountOf(up.parentKey, seen) + (up.prefix || "");
}

/** Проверки, унаследованные от точки подключения и от самого роутера. */
function inheritedGuards(key, seen = new Set()) {
  if (seen.has(key)) return [];
  seen.add(key);
  const up = nested.get(key);
  const above = up ? inheritedGuards(up.parentKey, seen) : mountGuards.get(key) || [];
  return above.concat(routerGuards.get(key) || []);
}

/* ------------------------------------------------------------------ *
 * 5. Сбор путей.
 * ------------------------------------------------------------------ */
const GUARD_LABELS = [
  [/^requireAuth$/, "вход выполнен"],
  [/^requirePermission\(/, "есть право"],
  [/^requireRole\(/, "нужная роль"],
  [/^requireAdmin/, "только начальник"],
  [/^apiLimiter$/, "общий предел частоты запросов"],
  [/Limiter$/, "предел частоты запросов"],
];

function guardLabel(text) {
  const t = tidy(text);
  for (const [re, label] of GUARD_LABELS) {
    if (re.test(t)) {
      const arg = t.match(/\(\s*["'`]([^"'`]+)/);
      return arg ? `${label}: ${arg[1]}` : label;
    }
  }
  return t;
}

function splitArgs(struct, code, open, close) {
  const parts = [];
  let start = open + 1;
  for (let i = start; i < close; i++) {
    const c = struct[i];
    if (OPEN[c]) {
      const cl = matchPair(struct, i);
      if (cl > 0) i = cl;
      continue;
    }
    if (c === ",") {
      parts.push([start, i]);
      start = i + 1;
    }
  }
  parts.push([start, close]);
  return parts;
}

/** Пропустить угловые скобки типа: `Promise<{ x: number }>` — это ТИП, а не тело. */
function skipAngles(s, i, limit) {
  if (s[i] !== "<") return i;
  let d = 0;
  for (let j = i; j < limit; j++) {
    if (s[j] === "<") d++;
    else if (s[j] === ">") {
      d--;
      if (d === 0) return j + 1;
    } else if (s[j] === "(" || s[j] === "{" || s[j] === "[") {
      const cl = matchPair(s, j);
      if (cl < 0 || cl >= limit) return i;
      j = cl;
    }
  }
  return i;
}

/** Тело функции после её заголовка: пропускает аннотацию типа возврата. */
function bodyBrace(struct, from) {
  const limit = struct.length;
  let i = skipSpace(struct, from, limit);
  if (struct.slice(i, i + 2) === "=>") i = skipSpace(struct, i + 2, limit);
  if (struct[i] === ":") {
    i = skipSpace(struct, i + 1, limit);
    // тип может быть объектным (`: { a: number }`) или обёрнутым (`: Promise<{...}>`)
    let guard = 0;
    while (i < limit && guard++ < 200) {
      const j = skipAngles(struct, i, limit);
      if (j !== i) {
        i = skipSpace(struct, j, limit);
        continue;
      }
      if (struct[i] === "{") {
        const close = matchPair(struct, i);
        if (close < 0) return -1;
        const after = skipSpace(struct, close + 1, limit);
        // если сразу за закрывшимся объектом идёт ещё одна `{` — первая была типом
        if (struct[after] === "{") {
          i = after;
          continue;
        }
        if (struct.slice(after, after + 2) === "=>") {
          i = skipSpace(struct, after + 2, limit);
          continue;
        }
        return i;
      }
      if (/[\w$.|&\[\]"'\s,]/.test(struct[i])) {
        i++;
        continue;
      }
      if (struct[i] === "(") {
        const cl = matchPair(struct, i);
        if (cl < 0) return -1;
        i = skipSpace(struct, cl + 1, limit);
        continue;
      }
      return -1;
    }
    return -1;
  }
  return struct[i] === "{" ? i : -1;
}

/** Тело функции, объявленной в том же файле (обработчик, переданный по имени). */
function findLocalFunction(struct, code, name) {
  const pats = [
    new RegExp(`\\bfunction\\s+${name}\\s*[(<]`),
    new RegExp(`\\b(?:const|let|var)\\s+${name}\\s*=\\s*(?:async\\s*)?[(<]`),
  ];
  for (const re of pats) {
    const m = struct.match(re);
    if (!m) continue;
    let i = m.index + m[0].length - 1;
    if (struct[i] === "<") i = skipAngles(struct, i, struct.length);
    i = skipSpace(struct, i, struct.length);
    if (struct[i] !== "(") continue;
    const close = matchPair(struct, i);
    if (close < 0) continue;
    const b = bodyBrace(struct, close + 1);
    if (b < 0) continue;
    const end = matchPair(struct, b);
    if (end < 0) continue;
    return [b + 1, end];
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Задачи по расписанию и фоновые задания разбираются тем же деревом.
 * Вызов функции, объявленной где-то в apps/api/src, раскрывается на один
 * уровень: иначе «задача зовёт sendTomorrowDigest()» не говорит ровно ничего.
 * ------------------------------------------------------------------ */
const apiFiles = walkFiles(API_SRC);
const apiParsed = new Map();
for (const f of apiFiles) {
  if (parsed.has(f)) {
    apiParsed.set(f, parsed.get(f));
    continue;
  }
  const src = readFileSync(f, "utf8");
  apiParsed.set(f, { ...mask(src), src, rel: relative(ROOT, f).replace(/\\/g, "/") });
}

const fnIndex = new Map(); // имя функции -> {file, start, end}
for (const [f, p2] of apiParsed) {
  for (const m of p2.struct.matchAll(/\bexport\s+(?:async\s+)?function\s+([\w$]+)\s*[(<]/g)) {
    if (fnIndex.has(m[1])) continue;
    const span = findLocalFunction(p2.struct, p2.code, m[1]);
    if (span) fnIndex.set(m[1], { file: f, start: span[0], end: span[1] });
  }
  for (const m of p2.struct.matchAll(/\bexport\s+const\s+([\w$]+)\s*=\s*(?:async\s*)?[(<]/g)) {
    if (fnIndex.has(m[1])) continue;
    const span = findLocalFunction(p2.struct, p2.code, m[1]);
    if (span) fnIndex.set(m[1], { file: f, start: span[0], end: span[1] });
  }
}

/** Раскрыть вызовы известных функций на один уровень вглубь. */
function expandCalls(nodes, budget) {
  for (const node of nodes) {
    if (node.c.length) {
      expandCalls(node.c, budget);
      continue;
    }
    if (budget.left <= 0) return;
    const call = node.t.match(/\b([\w$]{4,})\s*\(/);
    if (!call) continue;
    const fn = fnIndex.get(call[1]);
    if (!fn) continue;
    const p2 = apiParsed.get(fn.file);
    budget.left--;
    node.c = parseBlock(p2.struct, p2.code, fn.start, fn.end, 2);
    node.from = `${call[1]}() — ${p2.rel}`;
  }
}

const METHODS = "get|post|put|patch|delete|all";
const endpoints = [];

for (const [f, p] of parsed) {
  const { struct, code, rel } = p;
  const re = new RegExp(`\\b(app|[\\w$]*[Rr]outer)\\.(${METHODS})\\s*\\(`, "g");
  for (const m of struct.matchAll(re)) {
    const open = m.index + m[0].length - 1;
    const close = matchPair(struct, open);
    if (close < 0) continue;
    const args = splitArgs(struct, code, open, close);
    const pathRaw = code.slice(args[0][0], args[0][1]).trim();
    /* Шаблонная строка со вставкой — это НЕ известный путь: `${BASE}-f` выглядел
     * как литерал и уезжал в карту дословно, вместе с подстановкой. */
    const lit = /\$\{/.test(pathRaw) ? null : pathRaw.match(/^["'`]([^"'`]*)["'`]$/);
    const routerName = m[1];
    const routerKey = keyOf(f, routerName, code);
    const mount = mountOf(routerKey);
    const guards = inheritedGuards(routerKey)
      .concat(args.slice(1, -1).map(([a, b]) => code.slice(a, b)))
      .map(guardLabel)
      .filter(Boolean);

    const [hs, he] = args[args.length - 1];
    let tree = [];
    let handlerRef = null;
    const arrow = struct.indexOf("=>", hs);
    let bodyStart = -1;
    if (arrow > -1 && arrow < he) {
      const b = skipSpace(struct, arrow + 2, he);
      if (struct[b] === "{") bodyStart = b;
    }
    if (bodyStart > -1) {
      const bodyEnd = matchPair(struct, bodyStart);
      tree = parseBlock(struct, code, bodyStart + 1, bodyEnd, 0);
    } else {
      handlerRef = tidy(code.slice(hs, he));
      const named = handlerRef.match(/([\w$]+)\s*\(/) || handlerRef.match(/^([\w$]+)$/);
      if (named) {
        const local = findLocalFunction(struct, code, named[1]);
        if (local) {
          tree = parseBlock(struct, code, local[0], local[1], 0);
          handlerRef = `${handlerRef} — раскрыто по коду функции ${named[1]}()`;
        }
      }
    }

    const line = code.slice(0, m.index).split("\n").length;
    const full = (mount + (lit ? lit[1] : "/?")).replace(/\/+$/, "") || mount;
    endpoints.push({
      method: m[2].toUpperCase(),
      line,
      path: lit ? lit[1] : `(из переменной) ${tidy(pathRaw)}`,
      mount,
      full,
      file: rel,
      router: routerName,
      top: relKey(topRouterOf(routerKey)),
      guards: guardsByPath(full).map(guardLabel).filter(Boolean).concat(guards),
      handlerRef,
      tree,
    });
  }
}

endpoints.sort((a, b) => byCode(a.full + a.method, b.full + b.method));

/* Задачи по расписанию живут не только в cron.ts: `live-calls-sweep` объявлена
 * прямо в index.ts и полгода отсутствовала в карте, потому что разборщик читал
 * один файл. Теперь обходим весь исходник сервера. */
const cronTasks = [];
const cronSites = new Set();
for (const cronFile of apiParsed.values()) {
  if (cronFile.rel.endsWith("lib/cronHeartbeat.ts")) continue; // сама обёртка
  for (const m of cronFile.struct.matchAll(/\bscheduleTracked\s*\(/g)) {
    const open = m.index + m[0].length - 1;
    const close = matchPair(cronFile.struct, open);
    if (close < 0) continue;
    const args = splitArgs(cronFile.struct, cronFile.code, open, close);
    if (args.length < 3) continue;
    const id = (cronFile.code.slice(args[0][0], args[0][1]).trim().match(/^["'`]([^"'`]*)/) || [])[1];
    const when = (cronFile.code.slice(args[1][0], args[1][1]).trim().match(/^["'`]([^"'`]*)/) || [])[1];
    if (!id) continue;
    const [hs, he] = args[2];
    const arrow = cronFile.struct.indexOf("=>", hs);
    let tree = [];
    if (arrow > -1 && arrow < he) {
      const b = skipSpace(cronFile.struct, arrow + 2, he);
      if (cronFile.struct[b] === "{") tree = parseBlock(cronFile.struct, cronFile.code, b + 1, matchPair(cronFile.struct, b), 0);
    }
    expandCalls(tree, { left: 6 });
    cronSites.add(`${cronFile.rel}:${cronFile.code.slice(0, m.index).split("\n").length}`);
    cronTasks.push({ id, when, tree, file: cronFile.rel });
  }
}
cronTasks.sort((a, b) => byCode(a.id, b.id));

/** Тело свойства объекта: `run(x) {}`, `async run(x) {}` или `run: (x) => {}`. */
function objMember(struct, code, objStart, objEnd, name) {
  const scope = struct.slice(objStart, objEnd);
  const re = new RegExp(`\\b(?:async\\s+)?${name}\\s*[:(]`);
  const m = scope.match(re);
  if (!m) return null;
  let i = objStart + m.index + m[0].length - 1;
  if (struct[i] === ":") {
    i = skipSpace(struct, i + 1, objEnd);
    if (struct.slice(i, i + 5) === "async") i = skipSpace(struct, i + 5, objEnd);
  }
  if (struct[i] !== "(") return null;
  const close = matchPair(struct, i);
  if (close < 0) return null;
  const b = bodyBrace(struct, close + 1);
  if (b > -1) return { block: [b + 1, matchPair(struct, b)] };
  // стрелка без фигурных скобок: `run: (p) => runSiteResyncAttempt(p.id)`
  let j = skipSpace(struct, close + 1, objEnd);
  if (struct[j] === ":") {
    // тип возврата без тела — пропускаем до стрелки
    const arrow = struct.indexOf("=>", j);
    if (arrow < 0 || arrow > objEnd) return null;
    j = skipSpace(struct, arrow + 2, objEnd);
  } else if (struct.slice(j, j + 2) === "=>") {
    j = skipSpace(struct, j + 2, objEnd);
  } else return null;
  // выражение-стрелка заканчивается запятой свойства, а не точкой с запятой
  let end = j;
  while (end < objEnd) {
    const c = struct[end];
    if (OPEN[c]) {
      const cl = matchPair(struct, end);
      if (cl < 0 || cl > objEnd) break;
      end = cl + 1;
      continue;
    }
    if (c === "," || c === ";") break;
    end++;
  }
  return { expr: [j, end] };
}

const jobs = [];
for (const [, p2] of apiParsed) {
  if (!p2.rel.includes("/jobs/")) continue;
  for (const m of p2.struct.matchAll(/\bexport\s+const\s+([\w$]+)\s*:\s*JobHandler<[^=]*=\s*\{/g)) {
    const objStart = p2.struct.indexOf("{", m.index + m[0].length - 1);
    const objEnd = matchPair(p2.struct, objStart);
    if (objEnd < 0) continue;
    const obj = p2.code.slice(objStart, objEnd);
    const kind = (obj.match(/type\s*:\s*["'`]([^"'`]+)/) || [])[1] || m[1];
    let tree = [];
    for (const member of ["run", "onGiveUp"]) {
      const found = objMember(p2.struct, p2.code, objStart, objEnd, member);
      if (!found) continue;
      let part = [];
      if (found.block) part = parseBlock(p2.struct, p2.code, found.block[0], found.block[1], 0);
      else {
        const holder = [];
        pushStatement(holder, p2.struct, p2.code, found.expr[0], found.expr[1], 0);
        part = holder;
      }
      expandCalls(part, { left: 4 });
      if (member === "onGiveUp" && part.length) {
        tree.push({ k: "catch", t: "когда попытки кончились", a: [], c: part });
      } else {
        tree = tree.concat(part);
      }
    }
    jobs.push({ kind, file: p2.rel, tree });
  }
}
jobs.sort((a, b) => byCode(a.kind, b.kind));


/* ------------------------------------------------------------------ *
 * 6. Вывод.
 * ------------------------------------------------------------------ */
function countNodes(nodes) {
  let n = 0;
  for (const x of nodes) n += 1 + countNodes(x.c);
  return n;
}
function countForks(nodes) {
  let n = 0;
  for (const x of nodes) {
    if (x.k === "if" || x.k === "elseif" || x.k === "switch" || x.k === "case") n++;
    n += countForks(x.c);
  }
  return n;
}

const PREFIX = { if: "если", elseif: "иначе если", else: "", try: "", catch: "", finally: "", loop: "", switch: "", case: "вариант", do: "" };

function renderNodes(nodes, indent) {
  const out = [];
  for (const x of nodes) {
    const label = PREFIX[x.k] ? `${PREFIX[x.k]} ${x.t}` : x.t;
    out.push(`${indent}- ${label}`);
    for (const a of x.a) out.push(`${indent}  · ${a}`);
    out.push(...renderNodes(x.c, indent + "  "));
  }
  return out;
}

const totalForks = endpoints.reduce((s, e) => s + countForks(e.tree), 0);
const byMount = new Map();
for (const e of endpoints) {
  /* Пустая точка подключения бывает у адресов, объявленных прямо на приложении
   * (app.get("/api/v1/health")), — это не «не подключён». */
  const key = e.mount || (e.file.endsWith("app.ts") ? "объявлено прямо в приложении" : "(не подключён)");
  if (!byMount.has(key)) byMount.set(key, []);
  byMount.get(key).push(e);
}

const md = [];
md.push("# Лабиринты: все пути сервера с развилками");
md.push("");
md.push("> Файл собран программой `scripts/product-flows.mjs` из исходников этого");
md.push("> репозитория. **Руками не править** — правка потеряется при следующей сборке,");
md.push("> а `npm run map:check` покраснеет. Изменился код — выполнить `npm run map`.");
md.push("");
md.push(
  `Путей: **${endpoints.length}**. Развилок в самих путях: **${totalForks}**; ` +
    `вместе с задачами по расписанию и фоновыми заданиями — **${
      totalForks + countForks(cronTasks.flatMap((t) => t.tree)) + countForks(jobs.flatMap((j) => j.tree))
    }**. Модулей: **${byMount.size}**.`,
);
md.push("");
md.push("### Чего в этой карте НЕТ (чтобы не принять конспект за копию)");
md.push("");
md.push("- порядок регистрации маршрутов: адреса отсортированы по алфавиту, а совпадение");
md.push("  `/clients/trash` раньше `/clients/:id` зависит от порядка в коде;");
md.push("- права как система: видно строку `requirePermission(\"x\")`, но не видно, у кого это право есть;");
md.push("- поведение экранов: только адрес, файл и пункт меню, без внутренних условий экрана;");
md.push("- схема базы и миграции (`prisma/`), `router.js`, `ops/*`, nginx и таймер выката;");
md.push("- таймауты и обработка отказа у внешних вызовов, границы транзакций, пределы выборки;");
md.push("- глубина ограничена: в этой карте 6 уровней вложенности, в человеческой — 3,");
md.push("  дальше стоит пометка «внутри есть ещё подробности»;");
md.push("- что именно требует Zod-схема: написано «проверяет данные схемой», без полей;");
md.push("- обращения фронтенда не через `api()` (голый `fetch`, `EventSource`, `sendBeacon`).");
md.push("");
md.push("Чтения: «если …» — условие из кода; «·» — что делает код в этом месте;");
md.push("вложенность — вложенность в исходнике. Показаны ВСЕ ветки, а не та,");
md.push("которая случается чаще.");
md.push("");
for (const [mount, list] of [...byMount.entries()].sort((a, b) => byCode(a[0], b[0]))) {
  md.push(`## ${mount}`);
  md.push("");
  for (const e of list) {
    md.push(`### ${e.method} ${e.full}`);
    md.push("");
    /* «Без проверки входа» — это отсутствие ИМЕННО входа, а не отсутствие любых
     * проверок: общий предел частоты висит на всём /api/v1 и молчаливо превращал
     * открытый адрес в «защищённый». */
    const hasAuth = e.guards.some((g) => /вход выполнен|есть право|нужная роль|только начальник|ключ|подпись|секрет|Signature|Secret|ApiKey|Token|authorize/i.test(g));
    md.push(
      `\`${e.file}\`${e.guards.length ? ` · на входе: ${e.guards.join(", ")}` : ""}` +
        (hasAuth ? "" : " · **вход не требуется**"),
    );
    md.push("");
    if (e.handlerRef) md.push(`- обработчик вынесен: \`${e.handlerRef}\``);
    else if (!e.tree.length) md.push("- тело без развилок и известных действий");
    else md.push(...renderNodes(e.tree, ""));
    md.push("");
  }
}

md.push("## Задачи по расписанию");
md.push("");
for (const t of cronTasks) {
  md.push(`### ${t.id} — ${t.when}`);
  md.push("");
  md.push(...(t.tree.length ? renderNodes(t.tree, "") : ["- тело без развилок и известных действий"]));
  md.push("");
}
md.push("## Фоновые задания");
md.push("");
for (const j of jobs) {
  md.push(`### ${j.kind}`);
  md.push("");
  md.push(`\`${j.file}\``);
  md.push("");
  md.push(...(j.tree.length ? renderNodes(j.tree, "") : ["- тело без развилок и известных действий"]));
  md.push("");
}

/* ------------------------------------------------------------------ *
 * 5b. Сторож «ничего не спрятано».
 *
 * Разборщик узнаёт адреса по образцу `xxxRouter.get("/...")`. Если кто-то
 * объявит адрес иначе, чем разборщик умеет читать, он молча не попадёт в карту
 * — и карта будет врать, оставаясь «зелёной». Поэтому вторым, НЕЗАВИСИМЫМ и
 * нарочно широким проходом ищем любое `<что-угодно>.<метод>("/...")` в замаскированном
 * (без строк и комментариев) исходнике сервера и сверяем с тем, что попало в карту.
 * Расхождение = ошибка сборки, а не предупреждение.
 * ------------------------------------------------------------------ */
/* Ищем ПРИЗНАК объявления маршрута, а не свой же образец: имя.метод(...) или
 * имя["метод"](...) или имя.route(...), где среди аргументов есть обработчик
 * с (req, res) либо первым аргументом стоит строка, начинающаяся со «/».
 * Приёмник значения не имеет — так попадаются псевдонимы (`const r = xRouter`),
 * параметры функций-регистраторов и скобочная запись. `req.get("X-Api-Key")`
 * и `headers.get("content-type")` под признак не подходят и не мешают. */
const CALL = new RegExp(
  `\\b([\\w$]+)\\s*(?:\\.\\s*(${METHODS}|route)|\\[\\s*["'\\\`](${METHODS}|route)["'\\\`]\\s*\\])\\s*\\(`,
  "g",
);
const HANDLER = /\(\s*_?req\b|\breq\s*:\s*[A-Z]|\(\s*_[,)]/;
/* Promise.all и подобные глобальные тёзки методов маршрутизатора. */
const NOT_ROUTER = /^(Promise|Array|Object|JSON|Math|console|Number|String|Reflect|z)$/;
const mapped = new Set(endpoints.map((e) => `${e.file}:${e.line}`));
const hidden = [];
for (const [, p] of parsed) {
  for (const m of p.code.matchAll(CALL)) {
    /* попадание внутри строки или комментария: там маска не совпадает с исходником */
    if (p.struct[m.index] !== p.code[m.index]) continue;
    if (NOT_ROUTER.test(m[1])) continue;
    const method = m[2] || m[3];
    const open = m.index + m[0].length - 1;
    const close = matchPair(p.struct, open);
    if (close < 0) continue;
    const args = p.code.slice(open + 1, close);
    const looksLikeRoute =
      method === "route" || HANDLER.test(args) || /^\s*["'`]\//.test(args);
    if (!looksLikeRoute) continue;
    const line = p.code.slice(0, m.index).split("\n").length;
    const key = `${p.rel}:${line}`;
    if (!mapped.has(key)) {
      hidden.push(`${key}  ${m[0]}…  (объявление адреса мимо карты)`);
    }
  }
}
/* Тот же приём для задач по расписанию: объявление, которое разборщик не смог
 * разобрать (нестандартные аргументы, голый cron.schedule), валит сборку. */
for (const [, p] of apiParsed) {
  if (p.rel.endsWith("lib/cronHeartbeat.ts")) continue;
  for (const m of p.struct.matchAll(/\b(?:scheduleTracked|cron\.schedule)\s*\(/g)) {
    const line = p.code.slice(0, m.index).split("\n").length;
    if (!cronSites.has(`${p.rel}:${line}`)) {
      hidden.push(`${p.rel}:${line}  ${m[0]}…  (задача по расписанию мимо карты)`);
    }
  }
}

/* Адрес, заданный переменной, попадает в карту с «/?» вместо пути — это тоже
 * молчаливая ложь, поэтому валит сборку наравне со спрятанным. */
for (const e of endpoints) {
  if (String(e.path).startsWith("(из переменной)")) {
    hidden.push(`${e.file}:${e.line}  ${e.method} ${e.path}  (путь задан переменной, карта его не знает)`);
  }
}

const json = {
  generated_by: "scripts/product-flows.mjs",
  totals: {
    endpoints: endpoints.length,
    forks: totalForks + countForks(cronTasks.flatMap((t) => t.tree)) + countForks(jobs.flatMap((j) => j.tree)),
    mounts: byMount.size,
    cron: cronTasks.length,
    jobs: jobs.length,
    hidden: hidden.length,
  },
  hidden,
  /* Номер строки в собранный файл НЕ попадает. Он нужен только внутри этого
   * прогона (сверка «объявление мимо карты», сообщения о спрятанном), а в
   * артефакте делал сверку нестабильной: любая правка в начале файла сдвигала
   * номера у всех его адресов, карта «отставала от кода», и проверка краснела
   * сразу на ВСЕХ открытых правках, даже не трогавших карту. 20.09.2026 это
   * один раз застопорило всю очередь. Путь до файла остаётся — он и был тем,
   * что читают глазами. */
  endpoints: endpoints.map(({ line, ...rest }) => rest),
  cron: cronTasks,
  jobs,
};

const mdText = md.join("\n") + "\n";
const jsonText = JSON.stringify(json, null, 1) + "\n";

/** Для `scripts/product-map.mjs`: один источник правды про адреса сервера. */
export { endpoints, cronTasks, jobs };

const RUN_AS_CLI = process.argv[1] && process.argv[1].endsWith("product-flows.mjs");

if (!RUN_AS_CLI) {
  // импортировали как модуль — ничего не писать
} else if (hidden.length) {
  console.error(
    `В коде есть объявления адресов, которых нет в карте (${hidden.length}). ` +
      `Карта соврала бы, оставшись зелёной. Проверьте разборщик:\n  ` +
      hidden.join("\n  "),
  );
  process.exit(1);
}

/* Сторож: ни в карте, ни в её данных не должно быть пути, по которому лежит
 * репозиторий на ЭТОЙ машине. Такой путь делает сверку бессмысленной — на
 * сервере проверок он другой, и карта «отстаёт» всегда. */
const leaked = [
  ["docs/product-flows.md", mdText],
  ["docs/product-flows.json", jsonText],
].filter(([, t]) => t.includes(ROOT));
if (RUN_AS_CLI && leaked.length) {
  console.error(
    `В собранную карту попал путь этой машины (${ROOT}): ${leaked.map(([n]) => n).join(", ")}. ` +
      `Пути должны быть от корня репозитория.`,
  );
  process.exit(1);
}

if (!RUN_AS_CLI) {
  // импортировали как модуль — ничего не писать
} else if (process.argv.includes("--check")) {
  const problems = [];
  for (const [file, text] of [
    [OUT_MD, mdText],
    [OUT_JSON, jsonText],
  ]) {
    // Нормализуем \r\n→\n перед сравнением: файл на диске может прийти с CRLF
    // (Windows-checkout без .gitattributes-исключения, ручное редактирование),
    // генератор всегда пишет чистый \n. Без этого сверка красит совпадающую по
    // содержимому карту как «отстала» из-за одних переводов строк.
    if (!existsSync(file) || readFileSync(file, "utf8").replace(/\r\n/g, "\n") !== text) problems.push(relative(ROOT, file));
  }
  if (problems.length) {
    console.error(`Лабиринты отстали от кода: ${problems.join(", ")}. Выполните: npm run map`);
    /* Одного имени файла мало: проверка краснела на сервере и была зелёной на
     * машине, и понять почему было не из чего. Печатаем первое расхождение. */
    for (const [file, text] of [
      [OUT_MD, mdText],
      [OUT_JSON, jsonText],
    ]) {
      if (!existsSync(file)) continue;
      const was = readFileSync(file, "utf8").replace(/\r\n/g, "\n").split("\n");
      const now = text.split("\n");
      const i = was.findIndex((l, n) => l !== now[n]);
      if (i < 0 && was.length === now.length) continue;
      const at = i < 0 ? Math.min(was.length, now.length) : i;
      console.error(
        `  ${relative(ROOT, file)}, строка ${at + 1}:\n` +
          `    в файле: ${JSON.stringify((was[at] || "(конец файла)").slice(0, 300))}\n` +
          `    в коде:  ${JSON.stringify((now[at] || "(конец файла)").slice(0, 300))}`,
      );
    }
    process.exit(1);
  }
  console.log(`Лабиринты совпадают с кодом (${endpoints.length} путей, ${json.totals.forks} развилок).`);
} else {
  writeFileSync(OUT_MD, mdText);
  writeFileSync(OUT_JSON, jsonText);
  console.log(
    `Лабиринты собраны: ${endpoints.length} путей, ${cronTasks.length} задач, ${jobs.length} заданий, ${json.totals.forks} развилок → docs/product-flows.md`,
  );
}
