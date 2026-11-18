import { describe, expect, it } from "vitest";
import { SELLER_SWITCH_KEYS, SELLER_SWITCH_VISIBLE_KEYS } from "@royal-home/shared";

// Владелец 18.11.2026: «Робот звонит собственнику» выключен и не должен быть виден на экране.
describe("блок «Работа с продавцами»", () => {
  it("не показывает выключатель робота-проверки собственника", () => {
    expect(SELLER_SWITCH_VISIBLE_KEYS).not.toContain("sellerProbeCallEnabled");
  });
  it("остальные выключатели на месте и в прежнем порядке", () => {
    expect(SELLER_SWITCH_VISIBLE_KEYS).toEqual(SELLER_SWITCH_KEYS.filter((k) => k !== "sellerProbeCallEnabled"));
  });
});
