import { describe, expect, it } from "vitest";
import { recruitmentContactPreviewSchema } from "@royal-home/shared";
import { buildRecruitmentCommunicationContent } from "../src/lib/recruitmentCommunicationContent.js";
import { vacancyOfficeMapUrl } from "../src/ai/vacancyFacts.js";

const facts = { name: "Синтетик", titleRu: "SMM / видеограф", titleTg: "SMM / видеограф", detailsRu: "Монтаж и съёмка. Работа в офисе.",
  detailsTg: "Наворбардорӣ ва таҳрир.", address: "Тестовый офис", missing: ["experience", "tools"] as ("experience" | "tools")[] };
describe("staff-approved recruitment messages", () => {
  it("fits the SMS limit with the production office address and the default map link (23.10.2026)", () => {
    const address = "город Душанбе, дом печати, улица Бухоро 49, 2 этаж, Bukhoro Tower, Ориентиры, Школа1, Поликлиника 13";
    const result = buildRecruitmentCommunicationContent({ purpose: "INVITE", channels: ["SMS"], language: "ru",
      interviewAt: "2026-10-23T10:00:00Z", mapUrl: vacancyOfficeMapUrl() }, { ...facts, titleRu: "Агент по недвижимости", address });
    expect(result.text).toContain(vacancyOfficeMapUrl());
    expect(result.text.length).toBeLessThanOrEqual(600);
  });
  it("uses the selected role only and repeats the exact Dushanbe appointment without inventing commission or documents", () => {
    const result = buildRecruitmentCommunicationContent({ purpose: "INVITE", channels: ["SMS", "ASSISTANT_CALL"], language: "ru",
      interviewAt: "2026-10-22T09:30:00Z", mapUrl: "https://www.google.com/maps?q=office", preparation: "Портфолио по желанию" }, facts);
    expect(result.text).toContain("14:30"); expect(result.text).not.toContain("время Душанбе"); expect(result.text.startsWith("Приглашаем")).toBe(true); expect(result.text).not.toContain("Решение о найме");
    expect(result.text).toContain(facts.address); expect(result.callPrompt).toContain(facts.detailsRu);
    expect(result.callPrompt).not.toMatch(/оклада нет|2%|паспорт/u);
    expect(result.callPrompt).toContain("голосовой помощник"); expect(result.callPrompt).toContain("сам встречу не переноси");
  });
  it("asks only missing fields and never turns clarification into an invitation or hiring decision", () => {
    const result = buildRecruitmentCommunicationContent({ purpose: "CLARIFY", channels: ["ASSISTANT_CALL"], language: "tg" }, facts);
    expect(result.text).toContain("таҷрибаи корӣ"); expect(result.text).toContain("барномаҳо");
    expect(result.callPrompt).toContain("Не назначай собеседование"); expect(result.callPrompt).not.toContain(facts.detailsRu);
    expect(() => buildRecruitmentCommunicationContent({ purpose: "CLARIFY", channels: ["SMS"], language: "ru" }, { ...facts, missing: [] })).toThrow("no_missing");
  });
  it("validates all external fields and disallows synthetic social recipients, untrusted links and ambiguous purposes", () => {
    const base = { purpose: "INVITE", channels: ["SMS"], language: "ru", interviewAt: "2026-10-22T09:30:00Z" };
    expect(recruitmentContactPreviewSchema.safeParse(base).success).toBe(true);
    for (const mapUrl of ["http://www.google.com/maps", "https://maps.google.com.evil.invalid/x", "https://user@www.google.com/maps"]) {
      expect(recruitmentContactPreviewSchema.safeParse({ ...base, mapUrl }).success).toBe(false);
    }
    expect(recruitmentContactPreviewSchema.safeParse({ ...base, channels: ["SMS", "SMS"] }).success).toBe(false);
    expect(recruitmentContactPreviewSchema.safeParse({ ...base, phone: "+992000000000" }).success).toBe(false);
    expect(recruitmentContactPreviewSchema.safeParse({ ...base, purpose: "CLARIFY" }).success).toBe(false);
  });
});
