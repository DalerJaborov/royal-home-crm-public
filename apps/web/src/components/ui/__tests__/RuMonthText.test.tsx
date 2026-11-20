import { describe, expect, it } from "vitest";
import { ruMonthLabel } from "../RuMonthText";

describe("месяц по-русски поверх родного поля", () => {
  it("«Ноябрь 2026», а не «November 2026» и не «ноябрь 2026 г.»", () => {
    expect(ruMonthLabel("2026-11")).toBe("Ноябрь 2026");
    expect(ruMonthLabel("2027-01")).toBe("Январь 2027");
  });
  it("кривое значение не роняет подпись", () => expect(ruMonthLabel("")).toBe(""));
});
