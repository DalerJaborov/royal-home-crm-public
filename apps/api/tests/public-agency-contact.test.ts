import { describe, expect, it } from "vitest";
import { AGENCY_FACTS, companyInfoBlock } from "../src/ai/agencyFacts.js";
import { AGENCY_COMPANY_INFO, SCENARIO_JOB } from "../src/ai/leadQualifier.js";
import { buildLiveVoiceSystemPrompt } from "../src/ai/liveVoicePersona.js";
import { buildConsultantSystemPrompt } from "../src/ai/liveVoiceConsultantPersona.js";
import { cleanOutgoingReply } from "../src/ai/replyGuards.js";
import { cleanPublicCommentReply } from "../src/messengers/comments.js";
import { VACANCIES_DISABLED_RULE } from "../src/messengers/botCapabilities.js";
import { FALLBACK_ACCEPT_ERROR } from "../src/messengers/leadAcceptedReply.js";
import { CONTACT_NUMBERS } from "../src/lib/reelsCaptionTemplate.js";
import { isPublicAgencyPhone } from "../src/lib/publicAgencyContact.js";
import { detectClientLanguage } from "../src/ai/clientLanguage.js";

const PUBLIC_PHONE = "+992 44 650 14 14";
const RETIRED_PHONE = "+992 777 77 60 01";

describe("public agency telephone (owner decision 14.10.2026)", () => {
  it("shared company facts reach chat and voice without the obsolete API number", () => {
    expect(AGENCY_FACTS.phone).toBe(PUBLIC_PHONE);
    for (const prompt of [companyInfoBlock(), AGENCY_COMPANY_INFO, buildLiveVoiceSystemPrompt()]) {
      expect(prompt).toContain(PUBLIC_PHONE);
      expect(prompt).not.toContain(RETIRED_PHONE);
      expect(prompt).toContain("только для звонков");
    }
    expect(CONTACT_NUMBERS).toBe("+992 44 650-14-14");
  });

  it.each([true, false])("actual consultant voice builder uses the same telephone-only facts (Russian lock=%s)", (forceRussianOnly) => {
    const prompt = buildConsultantSystemPrompt({
      knowledge: "", caller: { numberKnown: true, selfName: null, agentName: null, dossier: "" },
      withinWorkingHours: true, forceRussianOnly,
    });
    expect(prompt).toContain(PUBLIC_PHONE);
    expect(prompt).toContain("только для звонков");
    expect(prompt).not.toContain(RETIRED_PHONE);
  });

  it.each(["ru", "tg"] as const)("%s failure fallback gives the public telephone", (language) => {
    expect(FALLBACK_ACCEPT_ERROR[language]).toContain(PUBLIC_PHONE);
    expect(FALLBACK_ACCEPT_ERROR[language]).not.toContain(RETIRED_PHONE);
  });

  it.each([
    ["Цена 40 000 USD. Наш WhatsApp: +992 44 650 14 14. Уточните район?", "?", "Позвоните:", "Занг занед:", "Уточните район?"],
    ["Цена 40 000 USD. Наш WhatsApp: +992 44 650 14 14. Уточните район?", "Рақаматон чанд?", "Позвоните:", "Занг занед:", "Уточните район?"],
    ["Цена 40 000 USD. Наш WhatsApp: +992 44 650 14 14. Уточните район?", "ман хочу", "Позвоните:", "Занг занед:", "Уточните район?"],
    ["Салом! Нарх 40 000 USD. WhatsApp +992 44 650 14 14. Кадом ноҳия?", "?", "Занг занед:", "Позвоните:", "Кадом ноҳия?"],
    ["Салом! Нарх 40 000 USD. WhatsApp +992 44 650 14 14. Кадом ноҳия?", "Как вам позвонить?", "Занг занед:", "Позвоните:", "Кадом ноҳия?"],
  ])("contact insertion follows the remaining reply, preserves facts and adds no second language: %s", (raw, client, call, foreignCall, question) => {
    expect(detectClientLanguage("?")).toBe("unknown");
    expect(detectClientLanguage("ман хочу")).toBe("mixed");
    for (const reply of [cleanOutgoingReply(raw, client), cleanPublicCommentReply(raw, client)]) {
      expect(reply).toContain("40 000 USD");
      expect(reply).toContain(question);
      expect(reply).toContain(`${call} ${PUBLIC_PHONE}`);
      expect(reply).not.toContain(foreignCall);
      expect(reply).not.toMatch(/WhatsApp/i);
    }
  });

  it.each([
    ["Как вам позвонить?", "Позвоните:", "Занг занед:"],
    ["Рақаматон чанд?", "Занг занед:", "Позвоните:"],
  ])("a bare brand/contact follows the known client rather than the brand's detector result (%s)", (client, call, foreignCall) => {
    for (const raw of ["WhatsApp +992 44 650 14 14", "Наш WhatsApp: +992 44 650 14 14"]) {
      for (const reply of [cleanOutgoingReply(raw, client), cleanPublicCommentReply(raw, client)]) {
        expect(reply).toContain(`${call} ${PUBLIC_PHONE}`);
        expect(reply).not.toContain(foreignCall);
        expect(reply).not.toMatch(/WhatsApp/i);
      }
    }
  });

  it("when both remaining reply and client are undetermined, contact recovery adds only the canonical number", () => {
    for (const raw of ["WhatsApp +992 44 650 14 14", "Наш WhatsApp: +992 44 650 14 14", "Наш номер: +992 777 77 60 01"]) {
      for (const reply of [cleanOutgoingReply(raw, "?"), cleanPublicCommentReply(raw, "?")]) {
        expect(reply).toContain(PUBLIC_PHONE);
        expect(reply).not.toMatch(/Позвоните|Занг занед|WhatsApp|Наш номер/i);
      }
    }
  });

  it.each([
    ["Наш номер: +992 44 650 14 14", "Как вам позвонить?"],
    ["Рақами мо: +992 44 650 14 14", "Рақаматон чанд?"],
  ])("actual public comment cleaner preserves %s", (raw, client) => {
    expect(cleanPublicCommentReply(raw, client)).toContain(PUBLIC_PHONE);
  });

  it.each(["", "Мой телефон +992 777 77 60 01", "777776001"])("retired agency phone is not republished even when quoted by customer: %s", (client) => {
    expect(cleanOutgoingReply(`Свяжитесь: ${RETIRED_PHONE}`, client)).not.toMatch(/777\s*77\s*60\s*01/);
  });

  it.each([
    ["Рақами мо: +992777776001", "Рақаматон чанд?", "Занг занед:"],
    ["Наш номер: +992 777 77 60 01", "Какой ваш номер?", "Позвоните:"],
  ])("actual public cleaner recovers a removed obsolete contact instead of an empty label: %s", (raw, client, call) => {
    const reply = cleanPublicCommentReply(raw, client);
    expect(reply).toContain(PUBLIC_PHONE);
    expect(reply).toContain(call);
    expect(reply).not.toMatch(/777\s*77\s*60\s*01/);
  });

  it("public phone supports tel, without becoming a WhatsApp endpoint", () => {
    expect(cleanOutgoingReply("Позвоните: tel:+992446501414")).toContain("tel:+992446501414");
    for (const link of ["wa.me/992446501414", "https://api.whatsapp.com/send?phone=992446501414", "whatsapp://send?phone=992446501414"]) {
      expect(cleanOutgoingReply(`Напишите: ${link}`, PUBLIC_PHONE)).not.toContain(link);
    }
  });

  it.each([
    ["Ваалайкум салом! Рақами мо: +992 777 77 60 01 ☎ Агар савол бошад, ба директ нависед, бо ҷону дил ёрӣ медиҳем", "Салом алэкум номер телефона чанд боша", "директ"],
    ["Здравствуйте! Наш номер: +992 777 77 60 01 ☎ Если есть вопросы, напишите в директ.", "Здравствуйте, какой ваш телефон?", "директ"],
  ])("repairs the actual labelled contact screenshot without losing the greeting and tail: %s", (raw, client, tail) => {
    const reply = cleanPublicCommentReply(raw, client);
    expect(reply).toContain(PUBLIC_PHONE);
    expect(reply).toContain(tail);
    expect(reply).not.toMatch(/777\s*77\s*60\s*01/);
  });

  it.each([
    ["Наш WhatsApp: +992 44 650 14 14", "Как вам написать?", "Позвоните:"],
    ["WhatsApp +992 44 650-14-14", "Рақаматон чанд?", "Занг занед:"],
  ])("plain-text public phone is never advertised as WhatsApp: %s", (raw, client, call) => {
    for (const reply of [cleanPublicCommentReply(raw, client), cleanOutgoingReply(raw, client)]) {
      expect(reply).toContain(PUBLIC_PHONE);
      expect(reply).toContain(call);
      expect(reply).not.toMatch(/WhatsApp|ватсап|вотсап/i);
    }
  });

  it.each(["Наш WhatsApp: +992 44 650 14 14", "Напишите на WhatsApp +992 44 650 14 14"])("corrects only the company contact span and preserves price/district/question: %s", (contact) => {
    const raw = `Цена 40 000 USD. В Сино. ${contact}. Уточните район?`;
    const reply = cleanPublicCommentReply(raw, "Какой ваш телефон?");
    expect(reply).toContain("40 000 USD");
    expect(reply).toContain("Сино");
    expect(reply).toContain("Уточните район?");
    expect(reply).toContain(`Позвоните: ${PUBLIC_PHONE}`);
    expect(reply).not.toMatch(/WhatsApp|Наш Позвоните|Напишите на Позвоните/i);
  });

  it("company allowance uses exact Tajik E164/local forms, not any foreign country with the same tail", () => {
    expect(isPublicAgencyPhone("992446501414")).toBe(true);
    expect(isPublicAgencyPhone("446501414")).toBe(true);
    expect(isPublicAgencyPhone("111446501414")).toBe(false);
    expect(cleanOutgoingReply("Контакт: +111446501414")).not.toContain("111446501414");
    expect(cleanOutgoingReply("Занг занед: 44 650-14-14")).toContain("44 650-14-14");
  });

  it.each(["Телефон собственника: +992777776001", "Ваш номер: +992777776001", "Вы написали: «Наш номер: +992777776001»"])("does not turn a foreign/customer-labelled phone into our agency contact: %s", (raw) => {
    expect(cleanPublicCommentReply(raw, "Цена?")).not.toContain(PUBLIC_PHONE);
  });

  it("removing the obsolete company exemption preserves other customer's own contacts and property prices", () => {
    const client = "мой телефон 900123456";
    expect(cleanOutgoingReply("Ваш номер +992 900 12 34 56", client)).toContain("900 12 34 56");
    expect(cleanOutgoingReply("wa.me/992900123456", client)).toContain("wa.me/992900123456");
    expect(cleanOutgoingReply("Номер собственника +992 935 55 12 34", client)).not.toContain("935 55 12 34");
    expect(cleanOutgoingReply("Цена 320 000 - 350 000 сомони, площадь 120 м²")).toContain("320 000 - 350 000");
  });

  it("resume paths give photos/text alternatives without directing files to unavailable WhatsApp", () => {
    for (const instruction of [SCENARIO_JOB, VACANCIES_DISABLED_RULE]) {
      expect(instruction).not.toContain(RETIRED_PHONE);
      expect(instruction).not.toMatch(/(?:на|наш) WhatsApp/i);
      expect(instruction).toMatch(/фото/i);
      expect(instruction).toMatch(/текст/i);
    }
  });
});
