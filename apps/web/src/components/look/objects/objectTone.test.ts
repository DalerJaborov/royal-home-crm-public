import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { districtOnce, stagePillView, TONE_ICON } from "./objectTone";

/** Владелец 20.11.2026: «На проверке, 60 дн.» красная с огнём; «Исмоили Сомони» три раза подряд. */
describe("плашка этапа: одна функция на список и карточку", () => {
  const stage = (daysInStage: number, limitDays: number | null, overdue: boolean) => ({ inPipeline: true, daysInStage, limitDays, overdue });
  it("обычный этап — нейтральный, с понятным текстом и без значка тревоги", () => {
    const v = stagePillView({ tone: "sky", label: "На проверке, 3 дн." }, stage(3, 5, false));
    expect(v).toEqual({ tone: "neutral", label: "На проверке · 3 дн." });
    expect(TONE_ICON[v.tone]).toBeNull();
  });
  it("срок прошёл — жёлтая, называет сколько дней", () => {
    expect(stagePillView({ tone: "crit", label: "На монтаже, 4 дн." }, stage(4, 3, true))).toEqual({ tone: "warn", label: "На монтаже · срок прошёл на 1 дн." });
    expect(stagePillView({ tone: "crit", label: "На монтаже, 4 дн." }, stage(4, null, true))).toEqual({ tone: "warn", label: "На монтаже · срок прошёл" });
  });
  it("сильная просрочка (втрое и больше) — красная, но без огня и текстом", () => {
    const v = stagePillView({ tone: "crit", label: "На проверке, 60 дн." }, stage(60, 3, true));
    expect(v).toEqual({ tone: "crit", label: "На проверке · просрочено на 57 дн." });
    expect(TONE_ICON.crit).not.toBe("flame");
    expect(stagePillView({ tone: "crit", label: "На проверке, 8 дн." }, stage(8, 3, true)).tone).toBe("warn");
  });
  it("без этапа конвейера подпись не меняется; «В продаже» остаётся зелёной", () => {
    expect(stagePillView({ tone: "ok", label: "В продаже" }, { inPipeline: false, daysInStage: 0, limitDays: null, overdue: false })).toEqual({ tone: "ok", label: "В продаже" });
    expect(stagePillView({ tone: "neutral", label: "Резерв" }, null)).toEqual({ tone: "neutral", label: "Резерв" });
  });
  it("список и карточка берут плашку из одной функции", () => {
    const item = readFileSync(new URL("./RoyalPropertyItem.tsx", import.meta.url), "utf8");
    const summary = readFileSync(new URL("./RoyalPropertySummary.tsx", import.meta.url), "utf8");
    expect(item).toContain("propertyStagePill("); expect(summary).toContain("propertyStagePill(");
    expect(item).not.toContain("toneFromChipClass("); expect(summary).not.toContain("toneFromChipTone(");
  });
});

describe("район в карточке один раз", () => {
  it("район уже в заголовке — в адресе его нет", () => {
    expect(districtOnce("3-комн · Исмоили Сомони, в продаже", "Исмоили Сомони", "ул. Рудаки, 5")).toEqual({ inTitle: true, place: "ул. Рудаки, 5" });
  });
  it("района нет в заголовке — он стоит в строке адреса один раз", () => {
    expect(districtOnce("3-комн квартира", "Шохмансур", "ул. Турсунзода, 64")).toEqual({ inTitle: false, place: "Шохмансур, ул. Турсунзода, 64" });
    expect(districtOnce("Дом", "Шохмансур", "Шохмансур, 12").place).toBe("Шохмансур, 12");
    expect(districtOnce("Дом", "Шохмансур", null).place).toBe("Шохмансур");
  });
  it("ориентир дописывается, пустое остаётся пустым", () => {
    expect(districtOnce("Дом", null, "ул. Айни", "у школы 12").place).toBe("ул. Айни — у школы 12");
    expect(districtOnce("Дом", null, null).place).toBe("");
  });
});
