import { describe, expect, it } from "vitest";
import { collectRecruitmentResume, extractRecruitmentAnswerFacts } from "../src/lib/recruitmentResume.js";

const eventKey = "a".repeat(64);

describe("mixed recruitment name answers", () => {
  it("keeps a literal name before a separate messenger question when the accepted question was for name", () => {
    const text = "Рустам через телеграм можно или ватсап?";
    const fact = collectRecruitmentResume({ text, sourceEventKey: eventKey, sourceKind: "message", answerTo: "name" }).facts.name;

    expect(fact).toMatchObject({ value: "Рустам", quote: text, sourceEventKey: eventKey, sourceKind: "message" });
  });

  it("does not interpret the same mixed message as a name without name-question evidence", () => {
    expect(extractRecruitmentAnswerFacts("Рустам через телеграм можно или ватсап?").name).toBeUndefined();
  });

  it.each(["Монтажёр через телеграм можно?", "Не работаю через телеграм можно?", "Привет через телеграм можно?"])(
    "does not treat a profession, status, or greeting as a name: %s", text => {
      expect(extractRecruitmentAnswerFacts(text, "name").name).toBeUndefined();
    });

  it.each([
    "Можно через телеграм или ватсап?",
    "А можно через телеграм или ватсап?",
    "Свяжитесь через телеграм можно?",
    "Напишите через WhatsApp можно?",
    "Напишите через WhatsApp, пожалуйста?",
    "Пожалуйста напишите через телеграм можно?",
  ])("does not treat a communication request as a name: %s", text => {
    expect(extractRecruitmentAnswerFacts(text, "name").name).toBeUndefined();
  });

  it("keeps existing literal bare-name and explicit self-name extraction", () => {
    expect(extractRecruitmentAnswerFacts("Синтетик Тестов", "name").name?.value).toBe("Синтетик Тестов");
    expect(extractRecruitmentAnswerFacts("Меня зовут Синтетик").name?.value).toBe("Синтетик");
  });

  it("does not let a mixed-name fallback overwrite an explicit self-name", () => {
    const plain = extractRecruitmentAnswerFacts("Меня зовут Рустам", "name").name;
    const mixedText = "Меня зовут Рустам через телеграм можно или ватсап?";
    const mixed = extractRecruitmentAnswerFacts(mixedText, "name").name;

    expect(plain?.value).toBe("Рустам");
    expect(mixed).toMatchObject({ value: "Рустам" });
    expect(mixed?.quote).toBe(mixedText);
  });

  it.each([
    "Могу ли через телеграм или ватсап?",
    "Можно мне через телеграм или ватсап?",
    "Как через телеграм можно?",
  ])("does not treat a multiword question prefix as a name: %s", text => {
    expect(extractRecruitmentAnswerFacts(text, "name").name).toBeUndefined();
  });

  it("does not grant name-question interpretation to documents", () => {
    const result = collectRecruitmentResume({ text: "Рустам через телеграм можно или ватсап?", sourceEventKey: eventKey,
      sourceKind: "document", answerTo: "name" });

    expect(result.facts.name).toBeUndefined();
  });
});
