import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * СТОРОЖ: ЛЮБОЙ ПУТЬ, ГДЕ ОБЪЕКТ ПОЯВЛЯЕТСЯ ИЛИ ПОЛУЧАЕТ ТОЧКУ, СВЕРЯЕТ ЕГО С РЕЕСТРОМ СТРОЕК (25.11.2026).
 *
 * Класс бага: автосвязь при создании стояла в crud.ts ПОСЛЕ раннего выхода «объект в конвейере», и при создании почти никогда
 * не срабатывала; геокодер, точка из фото, объект с сайта и принятая заявка на правку её не звали вовсе. Новый путь создания
 * или записи точки без вызова двери lib/constructionRegistry/autoLinkOnSave.ts краснит этот тест.
 */
const SRC = path.resolve(__dirname, "../src");
const rel = (f: string) => path.relative(SRC, f).replace(/\\/g, "/");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "generated" || name === "node_modules") continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith(".ts")) out.push(full);
  }
  return out;
}

/** Создание объекта или запись точки (координаты от геокодера/снимка помечаются geocodedAt: new Date()). */
const CREATES_OR_PLACES = /\bproperty\.(create|createMany|upsert)\(|geocodedAt:\s*new Date\(\)/;
/** Дверь: автосвязь или выбор сотрудника в поле «Застройщик и разрешение» (без выбора — та же автосвязь, 25.11.2026). */
const CALLS_DOOR = /autoLinkPropertyById\(|applyRegistryChoice\(/;

/** Пути, которым сверять нечем или которые сверяет кто-то другой — с причиной. */
const EXEMPT: Record<string, string> = {
  "routes/import.ts": "импорт CSV не ставит точку: сверять нечем, объект сверится, когда точку поставят формой или геокодером",
};

/** Пути, которые меняют адрес или описание без создания и без точки: обязаны звать дверь сами. */
const MUST_CALL = [
  "routes/properties/crud.ts", // создание (мастер, форма, черновик Шабнам) и правка карточки
  "routes/properties/changeRequestExecutor.ts", // принятая заявка на правку карточки
  "routes/siteNotifications.ts", // принятая правка с сайта
  "routes/webhooks.ts", // объект с сайта
  "jobs/geocode.ts", // точка от геокодера
  "routes/properties/photos.ts", // точка из GPS снимка
];

describe("реестр строек: все пути создания и смены точки зовут автосвязь", () => {
  const files = walk(SRC);

  it("каждый файл, который создаёт объект или пишет ему точку, зовёт дверь реестра (или исключён с причиной)", () => {
    const writers = files.filter((f) => CREATES_OR_PLACES.test(readFileSync(f, "utf8"))).map(rel);
    expect(writers.length).toBeGreaterThanOrEqual(4); // сторож не должен опустеть молча
    const missing = writers.filter((r) => !EXEMPT[r] && !CALLS_DOOR.test(readFileSync(path.join(SRC, r), "utf8")));
    expect(missing, `Создают объект или ставят точку без сверки с реестром: ${missing.join(", ")}`).toEqual([]);
  });

  it("пути правки адреса и описания зовут дверь", () => {
    const missing = MUST_CALL.filter((r) => !CALLS_DOOR.test(readFileSync(path.join(SRC, r), "utf8")));
    expect(missing).toEqual([]);
  });

  it("геокодер зовёт дверь и когда точку нашёл, и когда адрес не нашёлся (снять старую связь)", () => {
    const geocode = readFileSync(path.join(SRC, "jobs/geocode.ts"), "utf8");
    expect(geocode.match(/autoLinkPropertyById\(/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    const notFound = geocode.indexOf("не найден ни в справочнике домов");
    const firstCall = geocode.indexOf("autoLinkPropertyById(", notFound);
    const nextReturn = geocode.indexOf("return;", notFound);
    expect(firstCall).toBeGreaterThan(notFound);
    expect(firstCall).toBeLessThan(nextReturn);
  });

  it("при создании дверь зовётся ДО раннего выхода «объект в конвейере»", () => {
    const crud = readFileSync(path.join(SRC, "routes/properties/crud.ts"), "utf8");
    const call = crud.indexOf("applyRegistryChoice(property.id, parsedDraftRef.data.registry, req.agent.id)");
    const earlyReturn = crud.indexOf("if (isPipelineStatus(property.status) || property.offSite)");
    expect(call).toBeGreaterThan(0);
    expect(earlyReturn).toBeGreaterThan(0);
    expect(call).toBeLessThan(earlyReturn);
  });

  it("при правке дверь зовётся ДО ветки автопубликации", () => {
    const crud = readFileSync(path.join(SRC, "routes/properties/crud.ts"), "utf8");
    const call = crud.indexOf("applyRegistryChoice(updated.id, registryChoice.data.registry, req.agent!.id)");
    const autoPublish = crud.indexOf("if (willAutoPublish) {");
    expect(call).toBeGreaterThan(0);
    expect(call).toBeLessThan(autoPublish);
  });
});
