import { describe, expect, it } from "vitest";
import { publicRoyalLook, rememberedStaffLook } from "./publicLook";

function storage(entries: Record<string, string>) {
  const keys = Object.keys(entries);
  return { length: keys.length, key: (i: number) => keys[i] ?? null, getItem: (k: string) => entries[k] ?? null };
}

describe("новый вид на страницах без входа (пачка records)", () => {
  it("по умолчанию — прежний вид: у клиента ни параметра, ни ключа сотрудника", () => {
    expect(publicRoyalLook("", rememberedStaffLook(storage({})))).toBe(false);
    expect(publicRoyalLook("?utm=wa", rememberedStaffLook(storage({ "rh-shell:1": "clean" })))).toBe(false);
  });
  it("?look=royal включает, ?look=legacy выключает даже при запомненном выборе", () => {
    expect(publicRoyalLook("?look=royal", false)).toBe(true);
    expect(publicRoyalLook("?look=legacy", true)).toBe(false);
  });
  it("запомненный выбор сотрудника (rh-look:<id> = royal) включает; legacy и чужие ключи — нет", () => {
    expect(rememberedStaffLook(storage({ "rh-look:a1": "legacy", "rh-look:b2": "royal" }))).toBe(true);
    expect(rememberedStaffLook(storage({ "rh-look:a1": "legacy" }))).toBe(false);
    expect(rememberedStaffLook(storage({ "rh-lookalike": "royal", "x-rh-look:1": "royal" }))).toBe(false);
  });
  it("закрытое хранилище — прежний вид, без ошибки", () => {
    const broken = { length: 1, key: () => { throw new Error("SecurityError"); }, getItem: () => null };
    expect(rememberedStaffLook(broken)).toBe(false);
    expect(rememberedStaffLook(null)).toBe(false);
  });
});
