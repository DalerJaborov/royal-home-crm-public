import { describe, expect, it } from "vitest";
import { bookedShowingsByProperty } from "../clientFormat";

/** LOCAL-ONLY-WEB02: отменённый или проведённый показ не считается назначенным (04.10.2026). */
const NOW = Date.parse("2026-10-04T10:00:00Z");
const FUTURE = "2026-10-10T09:00:00Z";
const base = { type: "SHOWING", propertyId: "p1", nextActionDate: FUTURE, nextAction: "Показ", declinedAt: null, completedAt: null };

describe("bookedShowingsByProperty", () => {
  it("живой будущий показ попадает в список", () => {
    expect(bookedShowingsByProperty([base], NOW).get("p1")).toBe(FUTURE);
  });

  it("отменённый (задача снята вместе с отказом, дата осталась): кнопка «Назначить показ» доступна", () => {
    const cancelled = { ...base, nextAction: null, declinedAt: "2026-10-04T08:00:00Z" };
    expect(bookedShowingsByProperty([cancelled], NOW).has("p1")).toBe(false);
  });

  it("проведённый не считается назначенным", () => {
    expect(bookedShowingsByProperty([{ ...base, completedAt: "2026-10-04T09:00:00Z" }], NOW).has("p1")).toBe(false);
  });

  it("прошедший и чужого типа не считаются", () => {
    expect(bookedShowingsByProperty([{ ...base, nextActionDate: "2026-10-01T09:00:00Z" }], NOW).size).toBe(0);
    expect(bookedShowingsByProperty([{ ...base, type: "CALL" }], NOW).size).toBe(0);
  });
});
