import { describe, expect, it } from "vitest";
import { isSameStreet, mergePointAddress, type OsmPointAddress, type OwnPointAddress, isSameDistrictName } from "../pointAddress";
import { parseNominatimReverse } from "../reverseGeocode";

const osmStreetOnly: OsmPointAddress = {
  address: "улица Айни",
  street: "улица Айни",
  houseNumber: null,
  districtName: "район Шохмансур",
};

function own(partial: Partial<OwnPointAddress>): OwnPointAddress {
  return {
    street: "улица Садриддина Айни",
    houseNumber: "48",
    microdistrict: null,
    confidence: "contour",
    district: { id: "d1", name: "Шохмансур" },
    ...partial,
  };
}

describe("адрес точки: номер дома не теряется (23.09.2026)", () => {
  it("OSM дал только улицу, точка внутри контура дома — номер из справочника", () => {
    expect(mergePointAddress(osmStreetOnly, own({})).address).toBe("улица Садриддина Айни, 48");
  });

  it("OSM сам знает номер — берём OSM", () => {
    const osm: OsmPointAddress = { address: "улица Айни, 50", street: "улица Айни", houseNumber: "50", districtName: null };
    expect(mergePointAddress(osm, own({})).address).toBe("улица Айни, 50");
  });

  it("дом только рядом и улица та же — номер подставляется", () => {
    expect(mergePointAddress(osmStreetOnly, own({ confidence: "nearby" })).address).toBe("улица Садриддина Айни, 48");
  });

  it("дом только рядом, но улица ДРУГАЯ — чужой номер не подставляем (жалоба 14.09)", () => {
    const r = mergePointAddress(osmStreetOnly, own({ confidence: "nearby", street: "проспект Рудаки" }));
    expect(r.address).toBe("улица Айни");
  });

  it("дом без улицы в микрорайоне — «мкр, номер»", () => {
    const r = mergePointAddress(null, own({ street: null, microdistrict: "82 мкр", houseNumber: "14" }));
    expect(r.address).toBe("82 мкр, 14");
  });

  it("OSM не ответил — адрес из справочника; справочник не ответил — OSM как был", () => {
    expect(mergePointAddress(null, own({})).address).toBe("улица Садриддина Айни, 48");
    expect(mergePointAddress(osmStreetOnly, null).address).toBe("улица Айни");
  });

  it("дома нет вовсе — улица справочника лучше пустоты", () => {
    const r = mergePointAddress(null, own({ houseNumber: null, confidence: "district_only" }));
    expect(r.address).toBe("улица Садриддина Айни");
  });

  it("район — наш, по границе, а не разметка OSM", () => {
    expect(mergePointAddress(osmStreetOnly, own({})).districtName).toBe("Шохмансур");
    expect(mergePointAddress(osmStreetOnly, null).districtName).toBe("район Шохмансур");
  });
});

describe("одна ли улица", () => {
  it("сокращения и полное имя", () => {
    expect(isSameStreet("улица Айни", "улица Садриддина Айни")).toBe(true);
    expect(isSameStreet("ул. Айни", "Садриддина Айни")).toBe(true);
    expect(isSameStreet("проспект Рудаки", "улица Айни")).toBe(false);
    expect(isSameStreet("", "улица Айни")).toBe(false);
  });

  it("таджикское и латинское написание — та же улица (28.09.2026, «нигде нет номеров дома»)", () => {
    expect(isSameStreet("хиёбони Рӯдакӣ", "проспект Рудаки")).toBe(true);
    expect(isSameStreet("Rudaki Avenue", "проспект Рудаки")).toBe(true);
    expect(isSameStreet("кӯчаи Ҳусейнзода", "улица Хусейнзода")).toBe(true);
    expect(isSameStreet("кӯчаи Айнӣ", "проспект Рудаки")).toBe(false);
  });

  it("OSM пишет улицу по-таджикски без номера — номер берётся из справочника", () => {
    const osm: OsmPointAddress = { address: "хиёбони Рӯдакӣ", street: "хиёбони Рӯдакӣ", houseNumber: null, districtName: null };
    const own: OwnPointAddress = { street: "проспект Рудаки", houseNumber: "181", microdistrict: null, confidence: "nearby", district: null };
    expect(mergePointAddress(osm, own).address).toBe("проспект Рудаки, 181");
  });
});

describe("разбор ответа Nominatim", () => {
  it("улица и номер отдельными полями", () => {
    const r = parseNominatimReverse({ address: { road: "улица Айни", house_number: "12" } });
    expect(r).toMatchObject({ address: "улица Айни, 12", street: "улица Айни", houseNumber: "12" });
  });
  it("без номера — houseNumber пуст", () => {
    expect(parseNominatimReverse({ address: { road: "улица Айни" } }).houseNumber).toBeNull();
  });
});

describe("isSameDistrictName — район в любом написании (28.09.2026)", () => {
  it("латиница, таджикский и «район» перед названием — тот же район", () => {
    expect(isSameDistrictName("Sino", "Сино")).toBe(true);
    expect(isSameDistrictName("ноҳияи Шоҳмансур", "Шохмансур")).toBe(true);
    expect(isSameDistrictName("район Фирдавсӣ", "Фирдавси")).toBe(true);
    expect(isSameDistrictName("Ismoili Somoni district", "Исмоили Сомони")).toBe(true);
  });

  it("соседний район — не тот же", () => {
    expect(isSameDistrictName("Sino", "Шохмансур")).toBe(false);
    expect(isSameDistrictName("ноҳияи Фирдавсӣ", "Исмоили Сомони")).toBe(false);
    expect(isSameDistrictName("район", "Сино")).toBe(false);
  });
});
