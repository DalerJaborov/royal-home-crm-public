import { describe, expect, it } from "vitest";
import {
  ruDateLabel, ruDateTimeLabel, ruFieldFormatHint, ruFieldPlaceholder, ruFieldText, ruMonthLabel, ruTimeLabel,
  supportsNativeField, wantsRuOverlay,
} from "./ruFormat";

describe("дата, месяц и время по-русски (К01: «November 2026» на iPhone)", () => {
  it("месяц: «Ноябрь 2026», без «г.» и без английского", () => {
    expect(ruMonthLabel("2026-11")).toBe("Ноябрь 2026");
    expect(ruMonthLabel("2027-01")).toBe("Январь 2027");
    expect(ruMonthLabel("")).toBe("");
    expect(ruMonthLabel("2026-13")).toBe("2026-13");
  });
  it("дата: «20 ноября 2026»; несуществующий день не превращается в соседний месяц", () => {
    expect(ruDateLabel("2026-11-20")).toBe("20 ноября 2026");
    expect(ruDateLabel("2026-03-01")).toBe("1 марта 2026");
    expect(ruDateLabel("2026-02-31")).toBe("2026-02-31");
    expect(ruDateLabel("мусор")).toBe("мусор");
  });
  it("время: 24 часа, секунды отрезаются", () => {
    expect(ruTimeLabel("14:30")).toBe("14:30");
    expect(ruTimeLabel("09:05:00")).toBe("09:05");
    expect(ruTimeLabel("25:00")).toBe("25:00");
  });
  it("дата и время: «20 ноября 2026, 14:30»", () => {
    expect(ruDateTimeLabel("2026-11-20T14:30")).toBe("20 ноября 2026, 14:30");
    expect(ruDateTimeLabel("2026-11-20")).toBe("2026-11-20");
    expect(ruDateTimeLabel("2026-11-20T99:99")).toBe("2026-11-20T99:99");
  });
  it("пустое поле — понятная подсказка, а не пустота", () => {
    expect(ruFieldText("date", "")).toEqual({ text: "Выберите дату", empty: true });
    expect(ruFieldText("month", undefined)).toEqual({ text: "Выберите месяц", empty: true });
    expect(ruFieldText("time", "  ")).toEqual({ text: "Выберите время", empty: true });
    expect(ruFieldPlaceholder("datetime-local")).toBe("Выберите дату и время");
    expect(ruFieldText("date", "2026-11-20")).toEqual({ text: "20 ноября 2026", empty: false });
  });
  it("в тексте на экране нет английских названий месяцев", () => {
    for (let m = 1; m <= 12; m++) {
      const mm = String(m).padStart(2, "0");
      expect(ruMonthLabel(`2026-${mm}`)).toMatch(/^[А-ЯЁ][а-яё]+ 2026$/);
      expect(ruDateLabel(`2026-${mm}-15`)).toMatch(/^15 [а-яё]+ 2026$/);
    }
  });
});

describe("поддержка родного поля и выбор режима", () => {
  const fakeDoc = (supported: string[]) => ({
    createElement: () => {
      const el = { type: "text", setAttribute(_: string, v: string) { this.type = supported.includes(v) ? v : "text"; } };
      return el;
    },
  }) as unknown as Document;

  it("Safari на Mac / старый Firefox: type=month не поддержан — поле станет обычным текстовым", () => {
    expect(supportsNativeField("month", fakeDoc(["date", "time"]))).toBe(false);
    expect(supportsNativeField("date", fakeDoc(["date", "time"]))).toBe(true);
  });
  it("подсказка формата есть для каждого вида", () => {
    for (const kind of ["date", "month", "time", "datetime-local"] as const) expect(ruFieldFormatHint(kind)).toMatch(/Г|Ч/);
  });
  it("подпись поверх поля — на телефоне и сенсорном экране, на компьютере поле родное", () => {
    const win = (ua: string, coarse: boolean) => ({ navigator: { userAgent: ua }, matchMedia: () => ({ matches: coarse }) }) as unknown as Window;
    expect(wantsRuOverlay(win("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)", false))).toBe(true);
    expect(wantsRuOverlay(win("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", true))).toBe(true); // iPad в режиме «сайт для компьютера»
    expect(wantsRuOverlay(win("Mozilla/5.0 (Windows NT 10.0; Win64; x64)", false))).toBe(false);
  });
});
