import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Телефон, список объектов: фильтр «просрочено» (глубокая проверка 02.10.2026,
 * F15). На ПК строка «Этап просрочен у N» — ссылка на /properties?overdue=1, а
 * на телефоне — простой текст; пришедший по ссылке (Маркетинг, главная
 * монтажёра) фильтр `overdue=1` на телефоне был невидим: ни чипа, ни учёта в
 * счётчике фильтров — список молча урезан, снять фильтр нельзя.
 */
const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../components/mobile/MobilePropertiesList.tsx");

describe("MobilePropertiesList: фильтр «просрочено» виден и снимается", () => {
  const text = fs.readFileSync(FILE, "utf8").replace(/\r\n/g, "\n");
  it("есть чип «Просрочено», переключающий filters.overdue", () => {
    expect(text).toMatch(/key: "overdue"/);
    expect(text).toMatch(/overdue: f\.overdue \? undefined : "1"/);
  });
  it("фильтр учтён в счётчике дополнительных фильтров", () => {
    expect(text).toMatch(/filters\.noVideo,\n\s*filters\.overdue,\n\s*\]\.filter\(Boolean\)/);
  });
});
