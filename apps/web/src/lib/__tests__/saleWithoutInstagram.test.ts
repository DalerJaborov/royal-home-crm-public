import { describe, expect, it } from "vitest";
import { ApiError } from "../apiError";
import { saleWithoutInstagramOffer } from "../saleWithoutInstagram";

/**
 * Кнопка «Вывести в продажу без Instagram» (17.11.2026, ОБ-000193) появляется только когда сервер
 * в отказе «Готово» сказал, что этому человеку можно (`withoutInstagram.allowed`). Экран правило
 * не повторяет — проверяем, что он читает ответ сервера и не показывает кнопку в остальных случаях.
 */
const refusal = (data: unknown, status = 409) => new ApiError("Объект не готов", status, data);

describe("saleWithoutInstagramOffer", () => {
  it("директору: 409 NOT_READY с allowed — кнопка и сети, где ролик вышел", () => {
    const offer = saleWithoutInstagramOffer(
      refusal({ code: "NOT_READY", withoutInstagram: { allowed: true, needsDirector: false, channels: ["Facebook", "YouTube"] } }),
    );
    expect(offer).toEqual({ channels: ["Facebook", "YouTube"] });
  });

  it("агенту (allowed: false, нужен директор) — кнопки нет, остаётся текст «попросите директора»", () => {
    expect(
      saleWithoutInstagramOffer(refusal({ code: "NOT_READY", withoutInstagram: { allowed: false, needsDirector: true, channels: ["YouTube"] } })),
    ).toBeNull();
  });

  it("ролик не вышел никуда, другой код, другой статус или не ошибка API — кнопки нет", () => {
    expect(saleWithoutInstagramOffer(refusal({ code: "NOT_READY", withoutInstagram: { allowed: true, channels: [] } }))).toBeNull();
    expect(saleWithoutInstagramOffer(refusal({ code: "NOT_EDITING" }))).toBeNull();
    expect(saleWithoutInstagramOffer(refusal({ code: "NOT_READY", withoutInstagram: { allowed: true, channels: ["YouTube"] } }, 403))).toBeNull();
    expect(saleWithoutInstagramOffer(new Error("сеть"))).toBeNull();
    expect(saleWithoutInstagramOffer(null)).toBeNull();
    expect(saleWithoutInstagramOffer(refusal(undefined))).toBeNull();
  });
});
