import { describe, expect, it } from "vitest";
import { stripMarkdown, cleanOutgoingReply } from "../src/ai/replyGuards.js";
import { languageInstruction } from "../src/ai/clientLanguage.js";
import { otherCountryRefusalReply } from "../src/messengers/conversation.js";
import { priceGuardFallbackReply } from "../src/ai/leadQualifier.js";
import { availabilityGuardFallbackReply } from "../src/ai/availabilityGuard.js";

/**
 * Ревизия бота 02.10.2026, правка «разговор»: мелочи, по которым клиент узнаёт
 * автомат, — разметка, чужой язык в отказе, две фразы на двух языках встык.
 */
describe("разметка чат-бота не доходит до клиента", () => {
  it("звёздочки, решётки и обратные кавычки снимаются, слова остаются", () => {
    expect(stripMarkdown("**2-хонага** дар Сино")).toBe("2-хонага дар Сино");
    expect(stripMarkdown("## Варианты\nСино")).toBe("Варианты\nСино");
    expect(stripMarkdown("Цена *окончательная*.")).toBe("Цена окончательная.");
    expect(stripMarkdown("код `ROYAL`")).toBe("код ROYAL");
    expect(stripMarkdown("__важно__")).toBe("важно");
  });

  it("одиночная звёздочка без пары не трогается", () => {
    expect(stripMarkdown("Оценка 5* по отзывам")).toBe("Оценка 5* по отзывам");
  });

  it("весь путь отправки тоже снимает разметку", () => {
    const out = cleanOutgoingReply("**Квартира в Сино**, 3 комнаты.", "квартира в сино есть?");
    expect(out).not.toContain("*");
    expect(out).toContain("Квартира в Сино");
  });
});

describe("отказ и запасные фразы — на языке клиента", () => {
  it("объект за границей: русскому продавцу — по-русски", () => {
    expect(otherCountryRefusalReply("ru")).toMatch(/Таджикистане/);
    expect(otherCountryRefusalReply("tg")).toMatch(/Тоҷикистон/);
  });

  it("смесь не получает две фразы на двух языках встык", () => {
    expect(priceGuardFallbackReply("mixed")).toEqual(priceGuardFallbackReply("tg"));
    expect(availabilityGuardFallbackReply("mixed")).toEqual(availabilityGuardFallbackReply("tg"));
  });

  it("указание про смесь больше не спорит само с собой", () => {
    const mixed = languageInstruction("mixed");
    expect(mixed).not.toMatch(/нельзя начать по-русски и закончить таджикской/);
    expect(mixed).toMatch(/та же смесь/);
  });
});
