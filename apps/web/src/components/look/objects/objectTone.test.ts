import { describe, expect, it } from "vitest";
import { districtOnce, stagePillView } from "./objectTone";

/** Владелец 20.11.2026: «На проверке, 60 дн.» красная с огнём; «Исмоили Сомони» три раза подряд. */
describe("плашка этапа на карточке объекта", () => {
  it("обычный этап — спокойный, с понятным текстом", () => {
    expect(stagePillView({ tone: "sky", label: "На проверке, 3 дн." }, { inPipeline: true, daysInStage: 3, limitDays: 5, overdue: false }))
      .toEqual({ tone: "warn", label: "На проверке · 3 дн." });
  });
  it("просрочка — жёлтая и с названным сроком, не красная с огнём", () => {
    const v = stagePillView({ tone: "crit", label: "На монтаже, 4 дн." }, { inPipeline: true, daysInStage: 4, limitDays: 3, overdue: true });
    expect(v).toEqual({ tone: "warn", label: "На монтаже · 4 дн. (срок 3)" });
  });
  it("красная — только когда срок превышен втрое и больше", () => {
    expect(stagePillView({ tone: "crit", label: "На проверке, 60 дн." }, { inPipeline: true, daysInStage: 60, limitDays: 3, overdue: true }).tone).toBe("crit");
    expect(stagePillView({ tone: "crit", label: "На проверке, 8 дн." }, { inPipeline: true, daysInStage: 8, limitDays: 3, overdue: true }).tone).toBe("warn");
  });
  it("без этапа конвейера подпись не меняется", () => {
    expect(stagePillView({ tone: "ok", label: "В продаже" }, { inPipeline: false, daysInStage: 0, limitDays: null, overdue: false })).toEqual({ tone: "ok", label: "В продаже" });
    expect(stagePillView({ tone: "neutral", label: "Резерв" }, null)).toEqual({ tone: "neutral", label: "Резерв" });
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
