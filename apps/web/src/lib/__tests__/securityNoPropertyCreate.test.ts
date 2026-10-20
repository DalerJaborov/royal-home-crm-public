import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { roleCreatesProperties } from "../permissions";

/**
 * A12 (глубокая проверка 02.10.2026), решение владельца: служба безопасности
 * объекты не заводит. Сервер отвечает отказом на POST /properties
 * (routes/properties/shared.ts::propertyCreateDeniedReason), а экраны не
 * рисуют ей «Новый объект» — ни на компьютере, ни на телефоне, а прямая
 * ссылка на мастер уводит на список.
 */
const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), "utf8").replace(/\r\n/g, "\n");

describe("СБ не заводит объекты — экран", () => {
  it("роль СБ объекты не заводит, остальные — да", () => {
    expect(roleCreatesProperties("SECURITY")).toBe(false);
    expect(roleCreatesProperties("SHAREHOLDER")).toBe(false);
    for (const role of ["DIRECTOR", "ADMIN", "MANAGER", "AGENT", "MARKETING", "EDITOR"]) {
      expect(roleCreatesProperties(role)).toBe(true);
    }
  });

  it("кнопка «Объект» на списке (компьютер) — под проверкой", () => {
    expect(read("pages/Properties.tsx")).toMatch(
      /\{canCreateProperty && \(\s*<button className="pill ghost" type="button" onClick=\{\(\) => navigate\("\/properties\/new"\)\}>/
    );
  });

  it("«+» на списке (телефон) — под проверкой", () => {
    expect(read("components/mobile/MobilePropertiesList.tsx")).toMatch(
      /\{canCreateProperty && \(\s*<Link to="\/properties\/new"/
    );
  });

  it("прямая ссылка на мастер уводит СБ на список", () => {
    expect(read("pages/PropertyForm.tsx")).toMatch(
      /if \(!canCreateProperty\) return <Navigate to="\/properties" replace \/>;/
    );
  });

  it("меню «+» у СБ без «Новый объект»", () => {
    const fab = read("components/FabMenu.tsx");
    const block = fab.slice(fab.indexOf('if (role === "SECURITY")'));
    expect(block.slice(0, block.indexOf("}"))).not.toMatch(/objectNew/);
  });
});
