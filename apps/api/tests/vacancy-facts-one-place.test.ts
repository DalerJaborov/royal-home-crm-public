import { describe, expect, it } from "vitest";
import { SCENARIO_JOB } from "../src/ai/leadQualifier.js";
import { buildInterviewInviteCallPrompt } from "../src/ai/interviewInviteCallPersona.js";
import { VACANCY_FACTS, VACANCY_SHARED_PHRASES, vacancyOfficeAddress } from "../src/ai/vacancyFacts.js";

/**
 * ЧАТ И РОБОЗВОНОК ГОВОРЯТ О ВАКАНСИИ ОДНО И ТО ЖЕ.
 *
 * Владелец 28.09.2026: «всё, что для вакансий в сообщениях ИИ-агента, должно
 * касаться и робозвонка — это всегда связано». Факты лежат в одном модуле
 * (ai/vacancyFacts.ts); этот тест сторожит, что ОБА промта собраны из него:
 * адрес и цифры совпадают буквально. Отстал один из промтов — тест называет,
 * какой строки в нём нет.
 */
describe("Факты о вакансии — одно место для чата и робота", () => {
  const robotRu = buildInterviewInviteCallPrompt({
    candidateName: "Анна",
    interviewAt: new Date("2026-09-29T06:00:00Z"),
    address: null,
    language: "ru",
  });

  it("ключевые факты есть и в чате, и в звонке слово в слово", () => {
    for (const phrase of VACANCY_SHARED_PHRASES) {
      expect(SCENARIO_JOB, `чат: ${phrase}`).toContain(phrase);
      expect(robotRu, `робот: ${phrase}`).toContain(phrase);
    }
  });

  it("адрес офиса — Дом печати, Бухоро 49, с ориентирами", () => {
    expect(vacancyOfficeAddress()).toBe(
      "Душанбе, ул. Бухоро 49, Bukhoro Tower (Дом печати), 2 этаж; ориентиры — Школа №1, Поликлиника №13, Славянский университет (РТСУ), старая София"
    );
    expect(SCENARIO_JOB).toContain(vacancyOfficeAddress());
    expect(robotRu).toContain(vacancyOfficeAddress());
  });

  it("адрес из Настроек главнее адреса офиса", () => {
    const custom = buildInterviewInviteCallPrompt({
      candidateName: null,
      interviewAt: new Date("2026-09-29T06:00:00Z"),
      address: "ул. Айни 45",
      language: "ru",
    });
    expect(custom).toContain("адрес: ул. Айни 45");
    expect(custom).not.toContain("адрес: Душанбе, ул. Бухоро 49");
  });

  it("деньги — ровно так, как сказал владелец 28.09.2026", () => {
    expect(VACANCY_FACTS.pay).toMatchObject({
      commissionTotalPct: 2,
      agentPct: 1,
      splitPct: 0.5,
      newbieFromUsd: 500,
      experiencedFromUsd: 1000,
    });
    expect(SCENARIO_JOB).toContain("делится пополам, по 0,5%");
  });

  it("ни чат, ни робот не обещают само трудоустройство", () => {
    expect(SCENARIO_JOB).toContain("НЕ обещай: это решает руководство на собеседовании");
    expect(robotRu).toContain("Трудоустройство не обещай");
  });
});

describe("адрес офиса знают и чат-бот, и голосовой робот (10.10.2026)", () => {
  it("AGENCY_COMPANY_INFO и знания робота содержат один и тот же адрес с этажом и ориентирами", async () => {
    const { AGENCY_COMPANY_INFO } = await import("../src/ai/leadQualifier.js");
    const { agencyHoursBlock } = await import("../src/ai/liveVoiceKnowledge.js");
    for (const part of ["Душанбе", "ул. Бухоро 49", "Bukhoro Tower", "Дом печати", "2 этаж", "Школа №1", "Поликлиника №13"]) {
      expect(AGENCY_COMPANY_INFO, `чат-бот: ${part}`).toContain(part);
      expect(agencyHoursBlock({ start: "09:30", end: "18:00" }), `робот: ${part}`).toContain(part);
    }
    expect(agencyHoursBlock(null)).not.toContain("в справочнике нет");
  });
});
