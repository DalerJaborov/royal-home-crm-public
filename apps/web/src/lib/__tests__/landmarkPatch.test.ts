import { describe, expect, it } from "vitest";
import { landmarkPatchFromForm } from "../landmarkPatch";

/** Настройки → Ориентиры: стёртые адрес и радиус должны очищаться (23.09.2026, №30). */
describe("landmarkPatchFromForm", () => {
  const base = { name: " ЦУМ ", category: "ТЦ", point: { lat: 38.5, lng: 68.7 }, weight: 50 as const, isCityCenter: false };

  it("пустые адрес и радиус уходят как null — сервер их очищает", () => {
    const patch = landmarkPatchFromForm({ ...base, address: "  ", radiusM: "" });
    expect(patch.address).toBeNull();
    expect(patch.radiusM).toBeNull();
    // И переживают JSON, в отличие от undefined.
    expect(JSON.parse(JSON.stringify(patch))).toMatchObject({ address: null, radiusM: null });
  });

  it("заполненные поля — как есть", () => {
    expect(landmarkPatchFromForm({ ...base, address: "Рудаки 1", radiusM: "300" })).toMatchObject({
      name: "ЦУМ",
      address: "Рудаки 1",
      radiusM: 300,
    });
  });
});
