import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { mergeMeCache } from "../meCache";

/** «Профиль» не падает после сохранения (аудит 23.09.2026, №33). */
describe("кэш своего профиля после сохранения", () => {
  it("урезанный ответ сервера не стирает права и признак двухфакторного входа", () => {
    const old = { id: "a", fullName: "Старое", permissions: ["properties.moderate"], totpEnabled: true };
    const merged = mergeMeCache(old, { fullName: "Новое" });
    expect(merged).toEqual({ id: "a", fullName: "Новое", permissions: ["properties.moderate"], totpEnabled: true });
  });

  it("никто не кладёт в кэш профиля ответ сервера целиком", () => {
    const src = readFileSync(fileURLToPath(new URL("../../hooks/useMe.ts", import.meta.url)), "utf8");
    expect(src).not.toMatch(/setQueryData(<[^>]*>)?\(\["me"\],\s*data\)/);
  });
});
