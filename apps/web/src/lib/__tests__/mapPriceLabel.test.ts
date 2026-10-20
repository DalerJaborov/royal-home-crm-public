import { describe, expect, it } from "vitest";
import { clusterPlaque, priceLabel } from "../mapGeoJson";
import type { MapCluster } from "../../hooks/usePropertiesMap";

// Плашка цены на карте (24.09.2026): $85 000 и 850 000 сомони раньше обе
// читались «85 т.»/«850 т.» без знака валюты — вторая казалась вдесятеро дороже.
describe("priceLabel — плашка цены в валюте объекта", () => {
  it("доллары — со знаком $ впереди", () => {
    expect(priceLabel(85_000, "USD")).toBe("$85 т.");
  });

  it("сомони — со знаком «с.», как у formatMoney", () => {
    expect(priceLabel(850_000, "TJS")).toBe("850 т. с.");
  });

  it("одна и та же цифра в разных валютах даёт разные подписи", () => {
    expect(priceLabel(85_000, "USD")).not.toBe(priceLabel(85_000, "TJS"));
  });

  it("без валюты — сомони (кластеры считаются сервером в сомони)", () => {
    expect(priceLabel(58_000)).toBe("58 т. с.");
  });

  it("меньше тысячи — число целиком, а не «0 т.»", () => {
    expect(priceLabel(400, "USD")).toBe("$400");
  });

  it("миллионы — «млн» с одной цифрой после запятой", () => {
    expect(priceLabel(1_250_000, "TJS")).toBe("1,3 млн с.");
    expect(priceLabel(2_000_000, "USD")).toBe("$2 млн");
  });
});

describe("clusterPlaque — плашка кластера в сомони", () => {
  it("минимум «от …» подписан сомони", () => {
    const c = { id: "c1", name: "82-й мкр", lat: 38.5, lng: 68.7, count: 14, minPrice: 58_000 } as MapCluster;
    expect(clusterPlaque(c)).toBe("14 · от 58 т. с.");
  });
});
