import { describe, expect, it } from "vitest";
import { propertyStatusOptions } from "../propertyStatusOptions";

/** Снятый с продажи объект агент может вернуть через проверку (аудит 23.09.2026, №60). */
describe("propertyStatusOptions", () => {
  it("агенту у снятого объекта доступно «на проверку»", () => {
    const options = propertyStatusOptions("WITHDRAWN", false);
    expect(options).toContain("PENDING_REVIEW");
    expect(options).not.toContain("AVAILABLE");
    expect(options.length).toBeGreaterThan(1);
  });
  it("маркетинг может вернуть снятый объект прямо в продажу", () => {
    expect(propertyStatusOptions("WITHDRAWN", true)).toEqual(expect.arrayContaining(["AVAILABLE", "PENDING_REVIEW"]));
  });
  it("объект в продаже агент может снять", () => {
    expect(propertyStatusOptions("AVAILABLE", false)).toEqual(["AVAILABLE", "WITHDRAWN"]);
  });
  it("из проверки агент не уводит объект в монтаж", () => {
    expect(propertyStatusOptions("PENDING_REVIEW", false)).not.toContain("EDITING");
  });
  it("на этапах подготовки агент может снять объект с продажи (№179)", () => {
    for (const stage of ["PENDING_REVIEW", "AWAITING_PHOTOS", "AWAITING_VIDEO", "EDITING"] as const) {
      expect(propertyStatusOptions(stage, false)).toContain("WITHDRAWN");
    }
  });
});
