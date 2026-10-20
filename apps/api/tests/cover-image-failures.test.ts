import { describe, expect, it } from "vitest";
import { explainFailure } from "../src/ai/coverImage.js";

/**
 * Отказ рисования обязан объяснять, ЧТО ЧИНИТЬ, а не только «не получилось».
 *
 * Разбор 22.08.2026 занял полдня ровно потому, что четыре разные беды выглядели
 * одинаково. Хуже всех — два вида 429: обычный значит «подожди пару минут», а
 * FreeTier — «проект не подключён к оплате, ожидание не поможет никогда». Живой
 * случай того же дня: ключ отвечал текстовым моделям и молчал на рисующих, и это
 * читалось как сломанный ключ, хотя ключ был исправен.
 */
describe("объяснение отказа рисования", () => {
  it("отличает проект без оплаты от обычного превышения частоты", () => {
    const freeTier = explainFailure(
      429,
      '{ "error": { "code": 429, "message": "You exceeded your current quota", ' +
        '"details": [{ "quotaId": "GenerateRequestsPerDayPerProjectPerModel-FreeTier" }] } }'
    );
    expect(freeTier).toContain("не подключён к оплате");
    expect(freeTier).toContain("Billing");

    const throttled = explainFailure(429, '{ "error": { "message": "Resource has been exhausted" } }');
    expect(throttled).not.toContain("не подключён к оплате");
    expect(throttled).toContain("через несколько минут");
  });

  it("закрытая модель отправляет к кнопке «Проверить», а не к оплате", () => {
    const gone = explainFailure(404, "This model is no longer available to new users");
    expect(gone).toContain("Проверить");
    expect(gone).not.toContain("Billing");
  });

  it("мёртвый ключ назван мёртвым ключом", () => {
    for (const status of [401, 403]) {
      expect(explainFailure(status, "invalid authentication credentials")).toContain("Ключ Gemini отклонён");
    }
  });

  it("незнакомый код не теряет ответ Google — иначе снова гадать", () => {
    const unknown = explainFailure(503, "The model is overloaded. Please try again later.");
    expect(unknown).toContain("503");
    expect(unknown).toContain("overloaded");
  });
});
