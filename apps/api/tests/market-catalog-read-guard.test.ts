import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * СТОРОЖ: каждое чтение рыночного каталога идёт с правилом рубрик Somon (12.11.2026).
 *
 * 11.11.2026 в каталог «квартирами» легли ~13,5 тыс. чужих объявлений Somon (общая лента). Пока
 * их не вычистили — и на случай, если чужое когда-нибудь снова просочится, — ни одно чтение не
 * должно брать их в цены, подбор и сверку. Правило одно: `marketCatalogWhere()` (lib/market/somonRubrics.ts).
 *
 * Как проверяется: в apps/api/src находится каждый вызов `<x>.marketListing.<чтение>(…)`. Вызов
 * защищён, если в его аргументе есть `marketCatalogWhere(` — прямо или через построитель условия
 * из того же файла (`segmentsWhere(q)`, `...base`), в теле которого оно есть. Незащищённый вызов
 * допустим только из списка ALLOWED ниже, с причиной и точным числом таких вызовов в файле.
 * Новое чтение каталога без правила — красная проверка. Сырой SQL по "MarketListing" — тоже в списке.
 */

const SRC = join(__dirname, "..", "src");
const READ_OPS = "findMany|findFirst|findFirstOrThrow|findUnique|findUniqueOrThrow|count|groupBy|aggregate";
const CALL = new RegExp(`\\b\\w+\\.marketListing\\.(${READ_OPS})\\(`, "g");

/** Чтения без правила — сознательно. Ключ: `<файл от src>#<операция>` → сколько таких вызовов. */
const ALLOWED: Record<string, { count: number; why: string }> = {
  "lib/market/marketStore.ts#findMany": { count: 1, why: "запись обхода: свои же строки по source + sourceId, чтобы обновить, а не создать дубль" },
  "lib/market/paydoIncremental.ts#findMany": { count: 1, why: "только Paydo, по sourceId: известна ли страница" },
  "lib/market/purgeSomonJunk.ts#findMany": { count: 1, why: "скрипт чистки читает мусор нарочно" },
  "lib/market/runCrawl.ts#count": { count: 1, why: "ручной обход печатает размер таблицы целиком" },
  "routes/marketContact.ts#findFirst": { count: 1, why: "номер продавца по id объявления, которое агенту уже показали" },
};
/** Файлы, которым разрешён сырой SQL по таблице каталога. */
const RAW_SQL_ALLOWED = new Set(["lib/market/purgeSomonJunk.ts"]);

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === "generated" ? [] : walk(full);
    return full.endsWith(".ts") ? [full] : [];
  });
}

/** Текст аргумента вызова: от «(» до парной «)». */
function callArgument(text: string, openAt: number): string {
  let depth = 0;
  for (let i = openAt; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")" && --depth === 0) return text.slice(openAt, i + 1);
  }
  return text.slice(openAt);
}

/** Определение построителя условия в том же файле содержит правило. */
function builderHasRule(text: string, name: string): boolean {
  const def = new RegExp(`(?:function\\s+${name}\\s*\\(|const\\s+${name}\\s*[=:])`).exec(text);
  if (!def) return false;
  return text.slice(def.index, def.index + 2500).includes("marketCatalogWhere(");
}

function isGuarded(text: string, arg: string): boolean {
  if (arg.includes("marketCatalogWhere(")) return true;
  const names = new Set([...arg.matchAll(/\.\.\.(\w+)/g), ...arg.matchAll(/\b(\w+)\(/g)].map((m) => m[1]));
  return [...names].some((n) => builderHasRule(text, n));
}

function unguardedCalls(files: Array<{ path: string; text: string }>): Map<string, number> {
  const found = new Map<string, number>();
  for (const { path, text } of files) {
    for (const m of text.matchAll(CALL)) {
      const arg = callArgument(text, m.index! + m[0].length - 1);
      if (isGuarded(text, arg)) continue;
      const key = `${path}#${m[1]}`;
      found.set(key, (found.get(key) ?? 0) + 1);
    }
  }
  return found;
}

const files = walk(SRC).map((full) => ({ path: relative(SRC, full).replace(/\\/g, "/"), text: readFileSync(full, "utf8").replace(/\r\n/g, "\n") }));

describe("сторож чтения каталога рынка", () => {
  it("каждое чтение MarketListing — с правилом рубрик Somon или в списке исключений с причиной", () => {
    const unguarded = unguardedCalls(files);
    const unexpected = [...unguarded].filter(([key, n]) => !ALLOWED[key] || n > ALLOWED[key].count);
    expect(unexpected, "новое чтение каталога без marketCatalogWhere() — добавьте правило (или причину в ALLOWED)").toEqual([]);
  });

  it("список исключений не врёт: каждая запись в нём ещё нужна", () => {
    const unguarded = unguardedCalls(files);
    const stale = Object.entries(ALLOWED).filter(([key, v]) => (unguarded.get(key) ?? 0) !== v.count);
    expect(stale.map(([k]) => k)).toEqual([]);
  });

  it("сырой SQL по таблице каталога — только там, где разрешён", () => {
    const raw = files.filter((f) => /FROM\s+"MarketListing"/.test(f.text) && !RAW_SQL_ALLOWED.has(f.path)).map((f) => f.path);
    expect(raw).toEqual([]);
  });

  it("сторож краснеет на настоящей поломке: чтение без правила ловится, через построитель — нет", () => {
    const bad = { path: "x.ts", text: "async function f() { return prisma.marketListing.findMany({ where: { isActive: true } }); }" };
    const viaBuilder = { path: "y.ts", text: "function w() { return { AND: [marketCatalogWhere()] }; }\nasync function f() { return prisma.marketListing.count({ where: w() }); }" };
    const viaSpread = { path: "z.ts", text: "const base = { AND: [marketCatalogWhere()] };\nasync function f() { return tx.marketListing.groupBy({ by: ['source'], where: { ...base } }); }" };
    expect([...unguardedCalls([bad, viaBuilder, viaSpread])]).toEqual([["x.ts#findMany", 1]]);
  });
});
