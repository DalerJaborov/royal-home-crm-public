import { describe, expect, it } from "vitest";
import {
  DEFAULT_VACANCY_POST_CODES,
  parseVacancyPostCodes,
} from "../src/lib/vacancyPosts.js";
import { vacancyTurnHint } from "../src/ai/adTemplateOpener.js";

/**
 * РОЛИК ВАКАНСИИ И ПРИЗНАК, КОТОРЫЙ ПЕРЕЖИВАЕТ ПЕРВОЕ СООБЩЕНИЕ (17.09.2026).
 *
 * Сущности «пост вакансии» в CRM нет: код пересланной публикации искали только
 * среди объектов (Property.instagramUrl). Рилс вакансии не находился нигде и
 * попадал в ветку «переслали, но мы не опознали» — а она подсказывает боту фразу
 * «Видео у меня не открылось. Вы такую квартиру ищете?». Кандидату на вакансию,
 * за показ ролика которому уже заплачено.
 */

describe("список публикаций вакансии", () => {
  it("пусто — действует умолчание из кода", () => {
    expect(parseVacancyPostCodes(null)).toEqual(DEFAULT_VACANCY_POST_CODES);
    expect(parseVacancyPostCodes("")).toEqual(DEFAULT_VACANCY_POST_CODES);
    expect(parseVacancyPostCodes("   \n  \n")).toEqual(DEFAULT_VACANCY_POST_CODES);
  });

  it("умолчание — это идущая сейчас реклама вакансии", () => {
    expect(DEFAULT_VACANCY_POST_CODES).toContain("DdXBttGMLXT");
  });

  it("принимает и голый код, и ссылку целиком — по одной в строке", () => {
    const parsed = parseVacancyPostCodes(
      "DdXBttGMLXT\nhttps://www.instagram.com/reel/AbCdEf12345/?igsh=xyz\n  \nhttps://instagram.com/p/ZZZ999aaa"
    );
    expect(parsed).toEqual(["DdXBttGMLXT", "AbCdEf12345", "ZZZ999aaa"]);
  });

  it("мусор в строке не превращается в код", () => {
    // Иначе один случайный символ в настройке сделал бы «вакансией» что угодно.
    expect(parseVacancyPostCodes("не ролик, а заметка")).toEqual(DEFAULT_VACANCY_POST_CODES);
  });
});

describe("подсказка о вакансии", () => {
  const hint = vacancyTurnHint("WhatsApp");

  it("прямо запрещает фразу «видео не открылось»", () => {
    // Ровно её и получал кандидат, приславший рилс вакансии.
    expect(hint).toContain("ЗАПРЕЩЕНО говорить, что вложение, видео или публикация не");
  });

  it("запрещает спрашивать про комнаты и район", () => {
    expect(hint).toContain("ЗАПРЕЩЕНО спрашивать, какую");
    expect(hint).toContain("сколько комнат и в каком районе");
  });

  it("объявляет себя верной для ВСЕГО разговора, а не одного сообщения", () => {
    // В этом и была поломка: adHint строился по referral и действовал один ход.
    expect(hint).toContain("верно для всего разговора");
  });

  it("называет канал, из которого человек написал", () => {
    expect(hint).toContain("WhatsApp");
    expect(vacancyTurnHint("Instagram")).toContain("Instagram");
  });
});
