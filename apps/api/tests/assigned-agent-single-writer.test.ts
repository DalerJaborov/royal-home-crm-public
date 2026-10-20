import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * СТОРОЖ ЕДИНОГО ВХОДА `changeClientAgent` (аудит владения 11.09.2026, дыра
 * №1/№6, `docs/ownership-audit-11-09.md`). Правило владельца: клиент не
 * должен уйти от агента (или наоборот) без строки в истории — единственный
 * способ это гарантировать это запретить прямую запись `assignedAgentId` в
 * `Client.update(`/`updateMany(` ВЕЗДЕ, кроме `lib/changeClientAgent.ts`
 * самой.
 *
 * Не полноценный AST-парсер — учитывает строки/шаблоны при подсчёте скобок
 * (чтобы `)` внутри текста причины не обрывал разбор раньше времени) и ищет
 * `assignedAgentId:` СТРОГО внутри блока `data:` конкретного вызова
 * `.client.update(`/`.client.updateMany(`, а не во всём вызове (иначе ловил
 * бы легитимные чтения из `where`/`select`).
 *
 * ВТОРАЯ проверка (добавлена 13.09.2026, после находки: `PATCH /clients/:id`
 * писал `assignedAgentId` в обход `changeClientAgent()` именно через
 * динамический `...data`, который первая проверка по определению не видит —
 * `const { desiredPlaces, ...data } = parsed.data;` нигде не содержит
 * литерала `assignedAgentId:`). Ищет деструктуризацию вида
 * `const { …, ...rest } = parsed.data;` / `= req.body;`: если `rest`-связка
 * НЕ исключает `assignedAgentId` явно (ни как `assignedAgentId:`, ни как
 * переименование `assignedAgentId: чтоУгодно`), а сама rest-переменная потом
 * встречается словом внутри любого вызова `.client.update(`/`updateMany(` в
 * том же файле — это тот же самый обход, пойманный по форме, а не по имени
 * поля. Эвристика: не отличает «встречается внутри вызова» от «встречается
 * именно в data:», и не проверяет, что rest-переменную по пути не пересобрали
 * без опасного поля — совпадений в остальном репозитории на 13.09.2026 нет
 * (agents.ts/expenses.ts/me.ts используют `...rest` для Agent/Expense/пароля,
 * их `rest` ни разу не встречается рядом с `.client.update`), но при появлении
 * ложного срабатывания правильный ответ — сузить эвристику, а не выключить.
 *
 * ТРЕТЬЯ и ЧЕТВЁРТАЯ проверки (17.09.2026, ownership policy A1, разбор
 * `docs/audit/recon-17-09/02-auto-transfer-mechanisms.md` §е) — две дыры первой
 * проверки, найденные на живом коде:
 *  (е.1) shorthand-свойство `{ assignedAgentId, ... }` (без `:`) не совпадало с
 *        regex `/\bassignedAgentId\s*:/` — расширена до `[:,}]` прямо в
 *        `findViolations`.
 *  (е.2) `data`-ПЕРЕМЕННАЯ: `const data = {...}; data.assignedAgentId = x; ...
 *        tx.client.update({ data })` — литерала `assignedAgentId:` в САМОМ
 *        вызове `.client.update(` нет вовсе, поле пишется присваиванием
 *        СВОЙСТВА заранее собранного объекта. `findPropertyAssignmentViolations`
 *        ищет запись `<ident>.assignedAgentId = …` (не `===`/`!==`) и проверяет,
 *        что тот же `<ident>` затем передаётся в `.client.update(`/`updateMany(`
 *        как весь `data:` (литералом-идентификатором или тем же именем-shorthand).
 *
 * ИЗВЕСТНЫЕ, ПОКА НЕ ИСПРАВЛЕННЫЕ НАРУШЕНИЯ (это же задание, вне его зоны —
 * `docs/archive/agent-briefs/ownership-policy-a1-17-09.md` ограничивает А1 механизмами
 * `reassignment.ts`/`firstCall.ts`/`agentOccupancyShield.ts`/claim-pool;
 * `intake.ts`/`card.ts`/`lib/clientLifecycle.ts` — пачка А2). Расширять детектор
 * и одновременно молча гасить его находки в чужой зоне было бы хуже, чем не
 * расширять вовсе — поэтому каждое такое место отмечено В САМОМ КОДЕ комментарием
 * `LAW-A2-PENDING`, и обе новые проверки пропускают находку, только если этот
 * маркер стоит на той же строке или в нескольких строках прямо над ней. Это не
 * ослабляет проверку: НОВОЕ нарушение той же формы где угодно ещё в репозитории
 * (в том числе в этих же файлах, но без маркера рядом) продолжает падать тестом.
 */
const LAW_A2_PENDING_MARKER = "LAW-A2-PENDING";
/** Сколько строк над найденной строкой смотрим на маркер. Комментарий обычно
 *  многострочный (объяснение + ссылка на отчёт) и стоит перед ЦЕЛЫМ выражением,
 *  а найденная строка — конкретный `assignedAgentId` внутри него, который может
 *  оказаться на несколько строк ниже начала комментария (найдено 17.09.2026:
 *  4 строки не хватило до `data.assignedAgentId = null` в ветке `else`,
 *  вложенной на 12 строк ниже маркера, — решено и окном, и вторым маркером
 *  прямо у этой строки, окно оставлено с запасом на подобные случаи). */
const LAW_A2_PENDING_LOOKBACK_LINES = 6;

/** `line` — 1-based номер строки (как из `src.slice(0, idx).split("\n").length`). */
function isKnownPendingA2(src: string, line: number): boolean {
  const lines = src.split("\n");
  const from = Math.max(0, line - 1 - LAW_A2_PENDING_LOOKBACK_LINES);
  const window = lines.slice(from, line).join("\n");
  return window.includes(LAW_A2_PENDING_MARKER);
}

const SRC_ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../src");

const WHITELIST_FILES = new Set([path.join("lib", "changeClientAgent.ts")]);

const WHITELIST_DIR_SEGMENTS = ["tests", "seed", "__mocks__"];

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (WHITELIST_DIR_SEGMENTS.includes(entry.name)) continue;
      out.push(...listTsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

/** Индекс закрывающей скобки, парной открывающей на позиции `openIdx`
 *  (символ на `openIdx` обязан быть `open`), с учётом строк/шаблонов —
 *  скобки внутри `"..."`/`'...'`/`` `...` `` не считаются. */
function matchingBracket(src: string, openIdx: number, open: string, close: string): number {
  let depth = 0;
  let inString: '"' | "'" | "`" | null = null;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    if (inString) {
      if (c === "\\") {
        i++; // экранированный символ — пропускаем следующий как есть
        continue;
      }
      if (c === inString) inString = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      inString = c as '"' | "'" | "`";
      continue;
    }
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

interface Violation {
  file: string;
  line: number;
  snippet: string;
}

const CALL_RE = /\.client\.(update|updateMany)\s*\(/g;

function findViolations(file: string): Violation[] {
  const src = fs.readFileSync(file, "utf-8");
  const violations: Violation[] = [];

  for (const m of src.matchAll(CALL_RE)) {
    const openParenIdx = m.index! + m[0].length - 1; // индекс "("
    const closeParenIdx = matchingBracket(src, openParenIdx, "(", ")");
    if (closeParenIdx === -1) continue; // не разобрали — не наша забота этого теста
    const args = src.slice(openParenIdx + 1, closeParenIdx);

    // Ищем ключ data: на верхнем уровне объекта аргументов.
    const dataKeyRe = /\bdata\s*:/g;
    for (const dm of args.matchAll(dataKeyRe)) {
      const afterColon = dm.index! + dm[0].length;
      // Пропускаем пробелы/переносы до первого значимого символа.
      let valueStart = afterColon;
      while (valueStart < args.length && /\s/.test(args[valueStart])) valueStart++;
      if (args[valueStart] !== "{") continue; // не литерал объекта — статически не проверяем
      const valueEnd = matchingBracket(args, valueStart, "{", "}");
      if (valueEnd === -1) continue;
      const dataBlock = args.slice(valueStart, valueEnd + 1);
      // Ловит и обычный литерал (`assignedAgentId: x`), и shorthand-свойство
      // (`{ assignedAgentId, ... }` / `{ ..., assignedAgentId }`) — расширено
      // 17.09.2026 (ownership policy A1, отчёт 02 §е: card.ts/intake.ts уходили
      // от прежней regex именно через эту форму записи). `(?<!\.)` — иначе
      // ЧТЕНИЕ `x.assignedAgentId` как ЗНАЧЕНИЯ другого поля (`lastAgentId:
      // client.assignedAgentId`, `duplicateReviewAskedAgentId:
      // candidate.assignedAgentId` — оба легитимны и живут в репозитории уже
      // сейчас) ложно совпадало бы с `[,}]`-веткой: закрывающая скобка/запятая
      // после точечного доступа не отличалась от закрывающей после shorthand-
      // свойства без этой проверки.
      const hit = /(?<!\.)\bassignedAgentId\s*[:,}]/.exec(dataBlock);
      if (hit) {
        const upToHit = src.slice(0, openParenIdx + 1 + valueStart + hit.index);
        const line = upToHit.split("\n").length;
        if (isKnownPendingA2(src, line)) continue; // известно, вне зоны этого задания — см. LAW-A2-PENDING выше
        violations.push({
          file,
          line,
          snippet: dataBlock.slice(Math.max(0, hit.index - 20), hit.index + 40).replace(/\s+/g, " ").trim(),
        });
      }
    }
  }

  return violations;
}

/**
 * Деструктуризация вида `const { a, b, ...rest } = parsed.data;` / `= req.body;`.
 * Не парсер: предполагает плоский объектный паттерн без вложенных `{}` внутри
 * фигурных скобок деструктуризации (что верно для всего репозитория на
 * 13.09.2026) — вложенный паттерн просто не даст match и пройдёт незамеченным,
 * а не даст ложное срабатывание.
 */
const REST_DESTRUCTURE_RE = /const\s*\{([^{}]*)\}\s*=\s*(?:parsed\.data|req\.body)\s*;/g;

interface RestViolation {
  file: string;
  line: number;
  restVar: string;
}

function findRestSpreadViolations(file: string): RestViolation[] {
  const src = fs.readFileSync(file, "utf-8");
  const violations: RestViolation[] = [];

  // Есть ли в файле вообще запись в Client — без этого rest-переменная не может
  // быть тем самым обходом, каким бы именем она ни называлась.
  if (!/\.client\.(update|updateMany)\s*\(/.test(src)) return violations;

  for (const m of src.matchAll(REST_DESTRUCTURE_RE)) {
    const propsText = m[1];
    const restMatch = /\.\.\.(\w+)/.exec(propsText);
    if (!restMatch) continue; // без rest-элемента — нечего проносить мимо литеральной проверки выше
    const restVar = restMatch[1];
    if (/\bassignedAgentId\b/.test(propsText)) continue; // явно исключено (литерал или переименование) — безопасно

    // rest-переменная встречается словом внутри аргументов КАКОГО-ЛИБО
    // .client.update(/updateMany( в этом же файле?
    let usedNearClientWrite = false;
    for (const callM of src.matchAll(CALL_RE)) {
      const openParenIdx = callM.index! + callM[0].length - 1;
      const closeParenIdx = matchingBracket(src, openParenIdx, "(", ")");
      if (closeParenIdx === -1) continue;
      const args = src.slice(openParenIdx + 1, closeParenIdx);
      if (new RegExp(`\\b${restVar}\\b`).test(args)) {
        usedNearClientWrite = true;
        break;
      }
    }
    if (!usedNearClientWrite) continue;

    const upToMatch = src.slice(0, m.index!);
    const line = upToMatch.split("\n").length;
    violations.push({ file, line, restVar });
  }

  return violations;
}

/** Запись СВОЙСТВА (`ident.assignedAgentId = x`), не сравнение (`===`/`!==`). */
const PROP_ASSIGN_RE = /\b([A-Za-z_$][\w$]*)\.assignedAgentId\s*=(?!=)/g;

interface PropAssignViolation {
  file: string;
  line: number;
  varName: string;
}

/**
 * (е.2) `<ident>.assignedAgentId = …`, где `<ident>` затем передаётся ЦЕЛИКОМ
 * как `data:` в `.client.update(`/`updateMany(` — литералом-идентификатором
 * (`data: enrich`) или тем же именем-shorthand (`{ ..., data }` при
 * `ident === "data"`). См. разбор в шапке файла.
 */
function findPropertyAssignmentViolations(file: string): PropAssignViolation[] {
  const src = fs.readFileSync(file, "utf-8");
  const violations: PropAssignViolation[] = [];
  if (!/\.client\.(update|updateMany)\s*\(/.test(src)) return violations;

  for (const m of src.matchAll(PROP_ASSIGN_RE)) {
    const varName = m[1];
    let feedsClientWrite = false;
    for (const callM of src.matchAll(CALL_RE)) {
      const openParenIdx = callM.index! + callM[0].length - 1;
      const closeParenIdx = matchingBracket(src, openParenIdx, "(", ")");
      if (closeParenIdx === -1) continue;
      const args = src.slice(openParenIdx + 1, closeParenIdx);
      const bareDataRe = new RegExp(`\\bdata\\s*:\\s*${varName}\\b`);
      // shorthand `{ ..., data, ... }` — только когда сама переменная зовётся
      // "data" (иначе это не shorthand для ключа data, а что-то другое).
      const shorthandRe = new RegExp(`[{,]\\s*${varName}\\s*[,}]`);
      if (bareDataRe.test(args) || (varName === "data" && shorthandRe.test(args))) {
        feedsClientWrite = true;
        break;
      }
    }
    if (!feedsClientWrite) continue;

    const line = src.slice(0, m.index!).split("\n").length;
    if (isKnownPendingA2(src, line)) continue; // известно, вне зоны этого задания — см. LAW-A2-PENDING выше
    violations.push({ file, line, varName });
  }

  return violations;
}

describe("assignedAgentId — единственная точка записи", () => {
  it("нигде вне lib/changeClientAgent.ts не пишет Client.assignedAgentId напрямую", () => {
    const files = listTsFiles(SRC_ROOT).filter((f) => {
      const rel = path.relative(SRC_ROOT, f);
      return !WHITELIST_FILES.has(rel);
    });

    const allViolations = files.flatMap((f) => findViolations(f));

    if (allViolations.length > 0) {
      const report = allViolations
        .map((v) => `  ${path.relative(SRC_ROOT, v.file)}:${v.line} — ...${v.snippet}...`)
        .join("\n");
      throw new Error(
        `Найдена прямая запись Client.assignedAgentId в обход lib/changeClientAgent.ts:\n${report}\n\n` +
          `Каждая смена assignedAgentId обязана идти через changeClientAgent()/markClientLost() ` +
          `(docs/ownership-audit-11-09.md) — иначе клиент может уйти от агента без строки в истории.`
      );
    }

    expect(allViolations).toHaveLength(0);
  });

  it("rest-деструктуризация из parsed.data/req.body, использованная в Client.update(/updateMany(, явно исключает assignedAgentId", () => {
    const files = listTsFiles(SRC_ROOT).filter((f) => {
      const rel = path.relative(SRC_ROOT, f);
      return !WHITELIST_FILES.has(rel);
    });

    const allViolations = files.flatMap((f) => findRestSpreadViolations(f));

    if (allViolations.length > 0) {
      const report = allViolations
        .map((v) => `  ${path.relative(SRC_ROOT, v.file)}:${v.line} — ...${v.restVar} используется рядом с Client.update(/updateMany( и не исключает assignedAgentId`)
        .join("\n");
      throw new Error(
        `Найдена rest-связка из parsed.data/req.body, которая может протащить assignedAgentId в Client.update(/updateMany( в обход lib/changeClientAgent.ts:\n${report}\n\n` +
          `Добавьте явное \`assignedAgentId: _ignoredAssignedAgentId\` (или любое другое имя) в деструктуризацию — ` +
          `как это сделано в POST/PATCH /clients (routes/clients/card.ts) — чтобы поле не могло попасть в rest-объект.`
      );
    }

    expect(allViolations).toHaveLength(0);
  });

  it("данные для Client.update(/updateMany( не собираются присваиванием .assignedAgentId заранее собранной переменной (е.2)", () => {
    const files = listTsFiles(SRC_ROOT).filter((f) => {
      const rel = path.relative(SRC_ROOT, f);
      return !WHITELIST_FILES.has(rel);
    });

    const allViolations = files.flatMap((f) => findPropertyAssignmentViolations(f));

    if (allViolations.length > 0) {
      const report = allViolations
        .map((v) => `  ${path.relative(SRC_ROOT, v.file)}:${v.line} — ${v.varName}.assignedAgentId = … передаётся в Client.update(/updateMany( как data`)
        .join("\n");
      throw new Error(
        `Найдена запись Client.assignedAgentId через присваивание свойства заранее собранной переменной, ` +
          `в обход lib/changeClientAgent.ts:\n${report}\n\n` +
          `Либо переведите этот путь на changeClientAgent(), либо (если это уже известное, взятое в работу ` +
          `нарушение вне текущей пачки) отметьте строку комментарием LAW-A2-PENDING рядом.`
      );
    }

    expect(allViolations).toHaveLength(0);
  });
});
