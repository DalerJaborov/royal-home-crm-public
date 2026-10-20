import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Поиск объекта в «Нераспознанных» рекламы шлёт тот параметр, который читает
 * сервер (аудит 23.09.2026, №59): `search` сервер пропускал, и вместо найденного
 * приходили пять новых объектов.
 */
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("поиск объекта для рекламы", () => {
  it("шлёт q", () => {
    const src = read("../../hooks/useAds.ts");
    expect(src).toContain("/properties?q=");
    expect(src).not.toContain("/properties?search=");
  });
  it("сервер читает именно q", () => {
    const server = read("../../../../api/src/routes/properties/list.ts");
    expect(server).toMatch(/\bq,/);
  });
});
