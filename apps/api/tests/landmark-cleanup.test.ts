import { describe, expect, it } from "vitest";
import { findDuplicateGroups, isJunkLandmarkName, junkIds, type CleanupRow } from "../src/lib/landmarkCleanup.js";

/**
 * Чистка купленного слоя ориентиров (28.11.2026): мусор («I», «HS», «1», «25») и дубли («Hyatt Regency» ×3)
 * скрываются, но НЕ трогаются записи с упоминаниями клиентов, синонимами, из рук сотрудников и разные места
 * с одним названием далеко друг от друга.
 */
function row(over: Partial<CleanupRow> & { id: string; name: string }): CleanupRow {
  return {
    source: "import",
    enabled: true,
    lat: 38.5598,
    lng: 68.787,
    mentions: 0,
    weight: 0,
    aliasCount: 0,
    hasDistrict: false,
    isCityCenter: false,
    ...over,
  };
}

describe("мусорные названия", () => {
  it.each(["I", "HS", "1", "25", "№5", " "])("«%s» — мусор", (n) => expect(isJunkLandmarkName(n)).toBe(true));
  it.each(["Hilton", "ЦУМ", "Hospital №9", "Сино", "Дом печати"])("«%s» — не мусор", (n) => expect(isJunkLandmarkName(n)).toBe(false));

  it("скрывает только купленный слой без упоминаний и синонимов", () => {
    const ids = junkIds([
      row({ id: "a", name: "I" }),
      row({ id: "b", name: "25" }),
      row({ id: "own", name: "1", source: "agent" }),
      row({ id: "named", name: "HS", mentions: 3 }),
      row({ id: "alias", name: "HS", aliasCount: 1 }),
      row({ id: "hidden", name: "I", enabled: false }),
      row({ id: "ok", name: "Hilton" }),
    ]);
    expect(ids.sort()).toEqual(["a", "b"]);
  });
});

describe("дубли", () => {
  it("«Hyatt Regency» ×3 в одной точке → одна запись остаётся, две скрываются", () => {
    const g = findDuplicateGroups([
      row({ id: "h1", name: "Hyatt Regency" }),
      row({ id: "h2", name: "Hyatt Regency" }),
      row({ id: "h3", name: "hyatt  regency" }),
    ]);
    expect(g).toHaveLength(1);
    expect(g[0].hideIds).toHaveLength(2);
    expect([g[0].keepId, ...g[0].hideIds].sort()).toEqual(["h1", "h2", "h3"]);
  });

  it("остаётся тот, которого называли клиенты", () => {
    const g = findDuplicateGroups([row({ id: "x", name: "American School" }), row({ id: "y", name: "American School", mentions: 4 })]);
    expect(g[0].keepId).toBe("y");
    expect(g[0].hideIds).toEqual(["x"]);
  });

  it("одно имя в разных концах города — разные места, не склеиваем", () => {
    const g = findDuplicateGroups([
      row({ id: "a", name: "Мечеть Нур" }),
      row({ id: "b", name: "Мечеть Нур", lat: 38.62, lng: 68.9 }),
    ]);
    expect(g).toEqual([]);
  });

  it("«Школа №3» и «Школа №5» — разные; общее слово «Школа» не склеиваем", () => {
    expect(findDuplicateGroups([row({ id: "a", name: "Школа №3" }), row({ id: "b", name: "Школа №5" })])).toEqual([]);
    expect(findDuplicateGroups([row({ id: "a", name: "Школа" }), row({ id: "b", name: "Школа" })])).toEqual([]);
  });

  it("запись сотрудника никогда не прячется, даже как дубль", () => {
    const g = findDuplicateGroups([row({ id: "own", name: "ЦУМ", source: "agent" }), row({ id: "imp", name: "ЦУМ" })]);
    expect(g[0].keepId).toBe("own");
    const g2 = findDuplicateGroups([row({ id: "own", name: "ЦУМ", source: "agent" }), row({ id: "own2", name: "ЦУМ", source: "agent" })]);
    expect(g2).toEqual([]);
  });
});
