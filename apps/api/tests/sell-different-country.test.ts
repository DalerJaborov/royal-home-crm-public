import { describe, expect, it } from "vitest";
import { mergeDraft, type LeadDraft, type QualifyResult } from "../src/ai/leadQualifier.js";

/**
 * Продажа объекта ЗА ПРЕДЕЛАМИ Таджикистана (Россия и т.п.) — владелец 19.08.2026:
 * бот взял номер клиента, предлагавшего объект в РФ, хотя мы работаем только по
 * Таджикистану. locationDifferentCountry — новое поле, отдельное от
 * locationOutsideDushanbe («другой город РТ» — эту заявку берём, просто не по
 * обычному пайплайну), и mergeDraft/acceptLead обязаны различать их.
 */
describe("locationDifferentCountry", () => {
  const baseDraft: LeadDraft = { stage: "chatting" };

  function qualify(overrides: Partial<QualifyResult["lead"]>, ready = true): QualifyResult {
    return {
      reply: ["ok"],
      ready,
      intent: "sell",
      lead: { ...overrides },
    };
  }

  it("сохраняет locationDifferentCountry в черновике", () => {
    const merged = mergeDraft(baseDraft, qualify({ locationDifferentCountry: true }));
    expect(merged.locationDifferentCountry).toBe(true);
  });

  it("не переводит стадию в awaiting_phone для другой страны, даже если ready=true", () => {
    const merged = mergeDraft(baseDraft, qualify({ locationDifferentCountry: true }));
    expect(merged.stage).toBe("chatting");
  });

  /**
   * ИЗМЕНЕНО 17.09.2026 (владелец: «номер принять можно, но НЕ обещать, что агент
   * позвонит»). Раньше стадия уходила в awaiting_phone, и ensurePhoneAskKept
   * (ai/leadQualifier.ts) дописывал в отказ ровно то обещание звонка, которое
   * теперь запрещено, — тем же приёмом, что и у locationDifferentCountry.
   * Телефон, оставленный клиентом самим, всё равно ловится ниже по стеку
   * (extractVolunteeredPhone, messengers/conversation.ts) — просто код больше
   * сам его не выпрашивает.
   */
  it("НЕ переводит стадию в awaiting_phone для другого города Таджикистана (владелец 17.09.2026)", () => {
    const merged = mergeDraft(baseDraft, qualify({ locationOutsideDushanbe: true }));
    expect(merged.stage).toBe("chatting");
  });

  it("сбрасывает districtName при locationDifferentCountry, как и при locationOutsideDushanbe", () => {
    const withDistrict: LeadDraft = { ...baseDraft, districtName: "Сино" };
    const merged = mergeDraft(withDistrict, qualify({ locationDifferentCountry: true }));
    expect(merged.districtName).toBeUndefined();
  });

  it("locationDifferentCountry переживает следующий ход без нового значения от модели", () => {
    const draft: LeadDraft = { ...baseDraft, locationDifferentCountry: true };
    const merged = mergeDraft(draft, qualify({}, false));
    expect(merged.locationDifferentCountry).toBe(true);
  });
});
