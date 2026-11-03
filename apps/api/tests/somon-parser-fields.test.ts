import { describe, expect, it } from "vitest";
import { normalizeRepair, toListing, type SomonRawAd } from "../src/lib/market/somonParser";

const ad: SomonRawAd = {
  id: 1,
  title: "3-комн. квартира, 5 этаж, 82 м², Славянский",
  url: "/adv/1_x/",
  price_without_currency: "900000",
  currency: "TJS",
  rubric: { slug: "3-komnatnyie", ancestors: [{ slug: "nedvizhimost" }, { slug: "prodazha-kvartir" }] },
};

describe("somonParser: признаки для подбора похожих", () => {
  it("не выдумывает то, чего нет в списке somon.tj", () => {
    const l = toListing(ad)!;
    expect(l.repair).toBeNull();
    expect(l.buildingType).toBeNull();
    expect(l.isNewBuilding).toBeNull();
    expect(l.buildingReady).toBeNull();
    expect(l.exchangePossible).toBeNull();
    expect(l.latitude).toBeNull();
    expect(l.longitude).toBeNull();
    expect(l.rooms).toBe(3);
  });

  it("нормирует ремонт в пять кодов", () => {
    expect(normalizeRepair("Дизайнерский ремонт")).toBe("DESIGNER");
    expect(normalizeRepair("коробка")).toBe("SHELL");
    expect(normalizeRepair("предчистовая")).toBe("WHITE");
    expect(normalizeRepair("требует ремонта")).toBe("PARTIAL");
    expect(normalizeRepair("Евроремонт")).toBe("RENOVATED");
    expect(normalizeRepair("")).toBeNull();
    expect(normalizeRepair(null)).toBeNull();
  });
});
