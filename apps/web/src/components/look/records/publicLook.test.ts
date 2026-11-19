import { describe, expect, it } from "vitest";
import { publicRoyalLook } from "./publicLook";

describe("новый вид на страницах без входа (пачка records)", () => {
  it("по умолчанию — прежний вид: у клиента ни параметра, ни флага устройства", () => {
    expect(publicRoyalLook("", false)).toBe(false);
    expect(publicRoyalLook("?utm=wa", false)).toBe(false);
  });
  it("флаг устройства включает; ?look=royal включает, ?look=legacy выключает даже при флаге", () => {
    expect(publicRoyalLook("", true)).toBe(true);
    expect(publicRoyalLook("?look=royal", false)).toBe(true);
    expect(publicRoyalLook("?look=legacy", true)).toBe(false);
  });
});
