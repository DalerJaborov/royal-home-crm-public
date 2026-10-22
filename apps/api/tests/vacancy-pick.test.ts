import { describe, expect, it } from "vitest";
import { looksLikeNonCandidate, pickVacancyKey } from "../src/lib/vacancyPick.js";

describe("pickVacancyKey", () => {
  it("по умолчанию — агент по недвижимости", () => {
    expect(pickVacancyKey("Хочу работать риелтором, опыт продаж 2 года")).toBe("real-estate-agent");
    expect(pickVacancyKey("")).toBe("real-estate-agent");
  });
  it("слова про видео и SMM ведут в SMM / видеограф", () => {
    expect(pickVacancyKey("Умею монтировать, делаю Reels")).toBe("smm-videographer");
    expect(pickVacancyKey("опыт СММ и таргет")).toBe("smm-videographer");
    expect(pickVacancyKey("Работал видеографом")).toBe("smm-videographer");
    expect(pickVacancyKey("ищу работу, дизайнер")).toBe("smm-videographer");
    expect(pickVacancyKey("Могу снимать на телефон")).toBe("smm-videographer");
  });
  it("ключевое слово из таблицы главнее, если указывает на одну вакансию", () => {
    const kw = [{ word: "Агент2026", positionKey: "real-estate-agent" }];
    expect(pickVacancyKey("агент2026 видео", kw)).toBe("real-estate-agent");
    const kw2 = [{ word: "клип", positionKey: "smm-videographer" }];
    expect(pickVacancyKey("хочу делать клип", kw2)).toBe("smm-videographer");
  });
  it("слово из таблицы на другую вакансию тоже работает", () => {
    expect(pickVacancyKey("код бухгалтер", [{ word: "бухгалтер", positionKey: "accountant" }])).toBe("accountant");
  });
});

describe("looksLikeNonCandidate", () => {
  it("продавец и покупатель", () => {
    expect(looksLikeNonCandidate("Продаю квартиру в центре")).toBe(true);
    expect(looksLikeNonCandidate("Хочу купить 2-комнатную")).toBe(true);
  });
  it("разговор о работе не считается", () => {
    expect(looksLikeNonCandidate("Ищу работу, продаю товары")).toBe(false);
    expect(looksLikeNonCandidate("привет")).toBe(false);
  });
});
