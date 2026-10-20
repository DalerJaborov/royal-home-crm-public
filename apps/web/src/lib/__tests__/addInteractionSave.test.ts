import { describe, expect, it, vi } from "vitest";
import { buildAiClientPatch, saveInteractionWithCard } from "../addInteractionSave";

/**
 * Окно записи разговора (глубокая проверка 02.10.2026, F4).
 *
 * «Сохранить» делало два шага: взаимодействие, затем правку карточки по
 * подсказке ИИ. Ответ ИИ не проверялся схемой — «комнат: 2.5» или бюджет 0
 * давали 400 на втором шаге, окно оставалось открытым, и повторное «Сохранить»
 * заводило ВТОРОЙ такой же разговор (ключ повтора новый на каждый вызов).
 */
describe("buildAiClientPatch — только то, что примет сервер", () => {
  it("отбрасывает дробные комнаты и нулевой бюджет, оставляет годное", () => {
    const patch = buildAiClientPatch(
      { desiredRooms: 2.5, budgetMin: 0, budgetMax: 90000, requirementsNotes: "у метро" },
      undefined
    );
    expect(patch).toEqual({ budgetMax: 90000, requirementsNotes: "у метро" });
  });

  it("район — по имени из справочника, без учёта регистра", () => {
    const id = "6b1f8f5e-2c8e-4c57-9d0e-3f6f1d3a2b10";
    expect(buildAiClientPatch({ desiredDistrict: "сино" }, [{ id, name: "Сино" }])).toEqual({ desiredDistrictId: id });
  });

  it("район — тем же ключом, что на сервере: таджикское и русское написание совпадают", () => {
    const id = "6b1f8f5e-2c8e-4c57-9d0e-3f6f1d3a2b11";
    expect(buildAiClientPatch({ desiredDistrict: "Шохмансур" }, [{ id, name: "Шоҳмансур" }])).toEqual({
      desiredDistrictId: id,
    });
  });

  it("null от ИИ — поле не трогается", () => {
    expect(buildAiClientPatch({ budgetMin: null, desiredRooms: 3 }, undefined)).toEqual({ desiredRooms: 3 });
  });
});

describe("saveInteractionWithCard — повтор не заводит второй разговор", () => {
  it("второй шаг упал — повтор пропускает уже сохранённое взаимодействие", async () => {
    const saveInteraction = vi.fn().mockResolvedValue({ id: "i1" });
    const updateCard = vi.fn().mockRejectedValueOnce(new Error("400")).mockResolvedValueOnce({});
    let saved = false;
    const markSaved = () => {
      saved = true;
    };

    await expect(saveInteractionWithCard({ alreadySaved: saved, saveInteraction, markSaved, updateCard })).rejects.toThrow(
      "400"
    );
    await saveInteractionWithCard({ alreadySaved: saved, saveInteraction, markSaved, updateCard });

    expect(saveInteraction).toHaveBeenCalledTimes(1);
    expect(updateCard).toHaveBeenCalledTimes(2);
  });

  it("правки карточки нет — только взаимодействие", async () => {
    const saveInteraction = vi.fn().mockResolvedValue({});
    await saveInteractionWithCard({ alreadySaved: false, saveInteraction, markSaved: () => {}, updateCard: null });
    expect(saveInteraction).toHaveBeenCalledTimes(1);
  });
});
