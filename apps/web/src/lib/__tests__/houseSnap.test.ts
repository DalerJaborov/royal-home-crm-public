import { describe, expect, it } from "vitest";
import { snapNote, snappedFromLookup } from "../houseSnap";
import { medianPhotoPoint } from "../draftUploads";

// Точка по фото/по телефону — на дом (28.09.2026): переносим только на ответ
// «рядом дом», один выброс среди снимков точку не утаскивает.
describe("точка на дом", () => {
  it("«рядом дом» — берём точку внутри дома и подпись улица+номер", () => {
    const s = snappedFromLookup({
      confidence: "nearby",
      street: "проспект Рудаки",
      houseNumber: "181",
      building: { lat: 38.5601, lng: 68.7742, distanceM: 14 },
    });
    expect(s).toEqual({ lat: 38.5601, lng: 68.7742, label: "проспект Рудаки, 181", movedM: 14 });
    expect(snapNote(s!, "photo")).toContain("Точка по фото стояла в 14 м от дома");
    expect(snapNote(s!, "phone")).toContain("Ваша позиция была");
  });

  it("точка уже в доме или дома рядом нет — не двигаем", () => {
    const building = { lat: 38.56, lng: 68.77, distanceM: 0 };
    expect(snappedFromLookup({ confidence: "contour", street: "x", houseNumber: "1", building })).toBeNull();
    expect(snappedFromLookup({ confidence: "district_only", street: null, houseNumber: null, building: null })).toBeNull();
  });

  it("медиана снимков отбрасывает выброс дальше 150 м", () => {
    const home = { lat: 38.56, lng: 68.77 };
    const pts = [
      { lat: home.lat + 0.00005, lng: home.lng },
      { lat: home.lat - 0.00005, lng: home.lng + 0.00005 },
      { lat: home.lat, lng: home.lng - 0.00005 },
      { lat: home.lat + 0.01, lng: home.lng + 0.01 }, // снимок из другого места, ~1,4 км
    ];
    const m = medianPhotoPoint(pts)!;
    expect(Math.abs(m.lat - home.lat)).toBeLessThan(0.0001);
    expect(Math.abs(m.lng - home.lng)).toBeLessThan(0.0001);
    expect(medianPhotoPoint([])).toBeNull();
  });

  it("два разных адреса — берётся плотное скопление, а не точка посередине", () => {
    const a = { lat: 38.56, lng: 68.77 };
    const b = { lat: 38.563, lng: 68.77 }; // ~330 м севернее
    const m = medianPhotoPoint([a, { lat: a.lat + 0.00003, lng: a.lng }, b])!;
    expect(Math.abs(m.lat - a.lat)).toBeLessThan(0.0001);
  });
});
