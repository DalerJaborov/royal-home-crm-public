import { describe, it, expect } from "vitest";
import React from "react";
import { renderToString } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseDocuments, serializeDocuments, missingRequired } from "../propertyDocuments";
import { PropertyDocumentsCard, PropertyDocumentsField } from "../../components/PropertyDocuments";

/** Документы объекта галочками (решение Dan 24.09.2026) поверх прежней строки. */
describe("документы объекта — строка и галочки", () => {
  it("пресеты мастера и старой формы раскладываются по галочкам", () => {
    expect(parseDocuments("Договор + техпаспорт").have).toEqual(["Договор", "Техпаспорт"]);
    expect(parseDocuments("Договор / Техпаспорт").have).toEqual(["Договор", "Техпаспорт"]);
    expect(parseDocuments("Техпаспорт").have).toEqual(["Техпаспорт"]);
    expect(parseDocuments("Нет документов")).toEqual({ have: [], other: "" });
    expect(parseDocuments(null)).toEqual({ have: [], other: "" });
  });

  it("незнакомое остаётся «другими документами» как написано", () => {
    expect(parseDocuments("Договор, справка из БТИ")).toEqual({ have: ["Договор"], other: "справка из БТИ" });
  });

  it("запись идёт в постоянном порядке, чтение её не меняет", () => {
    const value = serializeDocuments(["Доверенность", "Договор"], "справка из БТИ");
    expect(value).toBe("Договор, Доверенность, справка из БТИ");
    const back = parseDocuments(value);
    expect(serializeDocuments(back.have, back.other)).toBe(value);
  });

  it("ничего не отмечено — null, строка не длиннее 200 знаков", () => {
    expect(serializeDocuments([], "  ")).toBeNull();
    expect(serializeDocuments(["Договор"], "х".repeat(500))!.length).toBeLessThanOrEqual(200);
  });

  it("не хватает договора и техпаспорта, пока их не отметили", () => {
    expect(missingRequired(["Доверенность"])).toEqual(["Договор", "Техпаспорт"]);
    expect(missingRequired(["Договор", "Техпаспорт"])).toEqual([]);
  });

  it("просмотр: видно, что есть и чего нет, без «сделку не закроют»", () => {
    const html = renderToString(<PropertyDocumentsCard documents="Договор + техпаспорт" />);
    expect(html).toContain("Договор");
    expect(html).not.toContain("не хватает");
    const empty = renderToString(<PropertyDocumentsCard documents={null} />).replace(/<!-- -->/g, "");
    expect(empty).toContain("Для сделки не хватает: договор и техпаспорт.");
    expect(empty).not.toContain("сделку не закроют");
  });

  it("правка: пять галочек, отмеченные — из строки", () => {
    const html = renderToString(<PropertyDocumentsField documents="Договор" onSave={() => {}} />);
    expect(html.match(/type="checkbox"/g)).toHaveLength(5);
    expect(html.match(/checked=""/g)).toHaveLength(1);
  });

  it("на компьютере нет отдельной вкладки «Документы»", () => {
    const src = readFileSync(join(__dirname, "../../pages/PropertyDetail.tsx"), "utf8");
    expect(src).not.toContain('["docs", "Документы"]');
    expect(src).not.toContain("Документы не указаны. Без них сделку не закроют.");
    // Один блок документов (docsBlock) на единую карточку ПК и телефона, во вкладке «Коротко».
    expect(src.match(/<PropertyDocumentsCard /g)).toHaveLength(1);
    expect(src.match(/\{docsBlock\}/g)).toHaveLength(1);
  });
});
