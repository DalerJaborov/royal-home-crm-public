import { describe, expect, it } from "vitest";
import { customerAgentVerifiedContextSchema, type CustomerAgentCompanyPolicyTopic } from "@royal-home/shared";
import { renderCustomerAgentDecision, customerAgentFixedLines, customerAgentPolicyLines } from "../src/ai/customerAgentRenderer.js";
import { readCustomerAgentCompanyKnowledge, currentCustomerAgentKnowledgeHash } from "../src/lib/customerAgentPublicReads.js";
import { CUSTOMER_AGENT_QUALITY_CONTINUITY_UPGRADE_V3 } from "../src/lib/customerAgentQualityContinuityUpgrade.js";
import { customerAgentCompanyKnowledgeHash } from "../src/ai/customerAgentPublicProtocol.js";
import { customerAskedPolicyTopic } from "../src/ai/customerAgentPolicyAsked.js";
import { customerSellerIntakeQuestion, customerSellerIntakeQuestionLines } from "../src/ai/customerAgentIntake.js";
import { customerTextRole } from "../src/ai/customerAgentRole.js";
import { customerColloquialTajikLanguage } from "../src/ai/customerDmLanguage.js";
import { vacancyOfficeAddress, vacancyOfficeAddressTg } from "../src/ai/vacancyFacts.js";
import { OWN_SHARE_UNLINKED_LINE } from "../src/ai/customerAgentAttachmentInput.js";
import { SALES_FACTS } from "../src/ai/salesPlaybook.js";

/**
 * What the core took over from the retired «Обучение бота» (export 13.11.2026, DISTILL.md):
 * company terms by role and only on the customer's own question, warmer fixed phrases, no dash,
 * salaam, emoji-only messages, sellers asked two facts at a time, colloquial Tajik.
 */
const knowledge = readCustomerAgentCompanyKnowledge();
const sourceHash = customerAgentCompanyKnowledgeHash(knowledge);
type Turn = { role: "user" | "assistant"; text: string };
const context = (turns: Turn[] = []) =>
  customerAgentVerifiedContextSchema.parse({ surface: "dm", revisionId: "a".repeat(64), turns,
    publicState: { language: "ru", topic: "unknown", openQuestion: "none" } });
const policy = (topic: CustomerAgentCompanyPolicyTopic, inputText: string, language: "ru" | "tg" = "ru", turns: Turn[] = []) =>
  renderCustomerAgentDecision({ evidence: [{ ref: "e0", value: { kind: "company_policy", topic, knowledge, sourceHash } }],
    decision: { kind: "reply", refs: ["e0"], social: "none", question: "none" }, language, inputText, requestedFacts: [],
    knownPhoneSource: "none", maxOutputChars: 3000, surface: "dm", knowledgeSourceHash: sourceHash, verifiedContext: context(turns) });
const social = (inputText: string, turns: Turn[], socialKind: "greet" | "none" = "greet", question: "none" | "rooms" = "rooms") =>
  renderCustomerAgentDecision({ evidence: [], decision: { kind: "clarify", refs: [], social: socialKind, question }, language: "ru", inputText,
    requestedFacts: [], knownPhoneSource: "none", maxOutputChars: 3000, surface: "dm", verifiedContext: context(turns) });

const DASH = /[—–]/u;
const TOPICS = ["commission", "rental", "payment", "negotiation", "legal", "service_scope"] as const;
const ASKED: Record<CustomerAgentCompanyPolicyTopic, { ru: string; tg: string }> = {
  commission: { ru: "Продаю квартиру, сколько берёте?", tg: "Хона мефурӯшам, чанд фоиз мегиред?" },
  rental: { ru: "Квартиру в аренду сдаёте?", tg: "Хона ба иҷора медиҳед?" },
  payment: { ru: "Рассрочка или ипотека есть?", tg: "Ипотека дорен?" },
  negotiation: { ru: "Торг возможен?", tg: "Савдо ҳаст?" },
  legal: { ru: "Документы в порядке, дом не под снос?", tg: "Ҳуҷҷатҳояш тайёр аст?" },
  service_scope: { ru: "В Худжанде работаете?", tg: "Дар Хуҷанд хона доред?" },
};

describe("no dash in anything the core says on its own (owner rule: no AI signs)", () => {
  it("fixed lines, company terms in both languages, seller questions and the office address", () => {
    const lines = [...customerAgentFixedLines(), ...customerSellerIntakeQuestionLines(), vacancyOfficeAddress(), vacancyOfficeAddressTg(),
      OWN_SHARE_UNLINKED_LINE.ru, OWN_SHARE_UNLINKED_LINE.tg];
    for (const topic of TOPICS) for (const language of ["ru", "tg"] as const) lines.push(policy(topic, ASKED[topic][language], language) ?? "");
    expect(lines.filter(line => DASH.test(line))).toEqual([]);
    expect(lines.length).toBeGreaterThan(80);
  });
  it("the guard itself turns red on a dash (checked by breaking it on purpose)", () => {
    expect(["Комиссия для продавца — 2%"].filter(line => DASH.test(line))).toHaveLength(1);
  });
});

describe("a company term is printed only for the customer's own question about it", () => {
  it.each(TOPICS)("%s: asked → printed, not asked → dropped (a topic question instead of silence)", topic => {
    expect(policy(topic, ASKED[topic].ru)).toBeTruthy();
    expect(customerAskedPolicyTopic(topic, ASKED[topic].ru)).toBe(true);
    expect(customerAskedPolicyTopic(topic, "Где находится этот дом?")).toBe(false);
    expect(policy(topic, "Где находится этот дом?")).toBe("Вы хотите узнать о недвижимости или о работе?");
  });
  it("Tajik questions are recognised in the folded alphabet", () => {
    for (const topic of TOPICS) expect(customerAskedPolicyTopic(topic, ASKED[topic].tg), topic).toBe(true);
  });
  it("commission: a buyer hears it is free, a seller hears the percent, when it is paid and what is free", () => {
    // Unknown role: the buyer's side and the one question that decides the rest.
    expect(policy("commission", "Сколько стоят ваши услуги?")).toBe("Для покупателя наши услуги бесплатны.\nВы хотите купить или продать недвижимость?");
    const seller = policy("commission", "Продаю квартиру, сколько берёте?", "ru", [{ role: "user", text: "Хочу продать квартиру" }])!;
    expect(seller).toContain(`${knowledge.commission.sellerPercent}%`);
    expect(seller).toContain("один раз и только после продажи");
    expect(seller).toContain("Съёмка, видео и реклама бесплатно.");
  });
  it("payment: as the agents say it (owner 13.11.2026), no rate, no down payment, no bank name", () => {
    const text = policy("payment", "Рассрочка есть?")!;
    expect(text).toMatch(/рассрочку дают некоторые застройщики/u);
    expect(text).toMatch(/через банк/u);
    expect(text).not.toMatch(/\d|%|взнос/u);
  });
  it("bargaining says yes; documents say what we do, never a guarantee", () => {
    expect(policy("negotiation", "Торг будет?")).toMatch(/^Торг возможен\./u);
    const legal = policy("legal", "Дом не под снос?")!;
    expect(legal).toContain("нотариуса и в МБТИ"); expect(legal).not.toMatch(/гарант|кафолат/iu);
  });
});

describe("conversation manners", () => {
  it("no second hello in the middle of a conversation, unless the customer greets again", () => {
    expect(social("2 комнаты", [{ role: "user", text: "Ищу квартиру" }, { role: "assistant", text: "Какой район вам подходит?" }]))
      .not.toMatch(/Здравствуйте|Добрый день/u);
    expect(social("привет", [{ role: "assistant", text: "Какой район вам подходит?" }], "greet", "none")).toBe("Здравствуйте!");
  });
  it("a salaam is answered with «Ваалейкум ассалом!», never «Салом!»", () => {
    expect(social("Ассалому алейкум, квартира нужна", [], "greet")?.split("\n")[0]).toBe("Ваалейкум ассалом!");
    expect(social("Ассалому алейкум, нархаш чанд?", [{ role: "assistant", text: "Здравствуйте!" }], "greet", "none")).toBe("Ваалейкум ассалом!");
  });
  it("emoji only: the first message gets the business question, later just a short acknowledgement", () => {
    expect(social("👍", [], "none", "rooms")).toBe("Здравствуйте!\nЧто вас интересует: покупка или продажа недвижимости?");
    const later = social("🙏🙏", [{ role: "user", text: "аренда нужна" }, { role: "assistant", text: "Сейчас арендой не занимаемся: не сдаём и не подбираем в аренду." }], "none", "rooms");
    expect(later).toBe("Понял.");
    // "?" alone is not emoji: it keeps the "я уточнял" repair path.
    expect(social("?", [{ role: "assistant", text: "Сколько комнат вам нужно?" }], "none", "rooms")).not.toBe("Понял.");
  });
  it("the seller is asked at most two facts at a time", () => {
    expect(customerSellerIntakeQuestion([], "ru")).toBe("Для продажи напишите, пожалуйста, число комнат и площадь.");
  });
  it("«Хона реклама мекунед?» is an owner asking us to advertise: a seller", () => {
    expect(customerTextRole("Шумо хона реклама мекунед?", false)).toBe("seller");
  });
  it("colloquial Tajik verb forms count as Tajik", () => {
    expect(customerColloquialTajikLanguage("фото равон кнен")).toBe(true);
    expect(customerColloquialTajikLanguage("рақам бтен")).toBe(true);
  });
});

describe("the phone robot keeps the three useful objections instead of the lessons", () => {
  it("SALES_FACTS: installments as the owner decided, objections without figures", () => {
    expect(SALES_FACTS).toContain("ПОЧЕМУ НЕТ ЗВОНКОВ ПО ОБЪЯВЛЕНИЮ");
    expect(SALES_FACTS).toContain("БЮДЖЕТ НИЖЕ ЦЕН В РАЙОНЕ");
    expect(SALES_FACTS).toContain("ТЕХПАСПОРТ В НОВОСТРОЙКЕ, ОБМЕН НА МАШИНУ");
    expect(SALES_FACTS).not.toContain("Их НЕТ. Совсем");
  });
});

describe("the changed company facts ride only the pinned V3 edge", () => {
  it("current AGENCY_FACTS are exactly the V3 target; another change needs its own reviewed edge", () => {
    expect(currentCustomerAgentKnowledgeHash()).toBe(CUSTOMER_AGENT_QUALITY_CONTINUITY_UPGRADE_V3.toKnowledgeSource);
    expect(knowledge.installments && knowledge.mortgage).toBe(true);
  });
});

describe("an unasked company term is neither printed nor forgotten (attack 14.11.2026)", () => {
  it("only an unasked term read: the customer gets a topic question, not silence", () => {
    const text = policy("legal", "сколько заработаю за месяц агентом, гарантируете 10000?");
    expect(text).toBe("Вы хотите узнать о недвижимости или о работе?");
  });
  it("every policy line we actually sent stays known to the dialogue memory (otherwise the bot greets again)", () => {
    for (const language of ["ru", "tg"] as const) for (const topic of TOPICS) {
      const sent = policy(topic, ASKED[topic][language], language);
      expect(sent, `${topic}/${language}`).toBeTruthy();
      const known = new Set(customerAgentPolicyLines({ kind: "company_policy", topic, knowledge, sourceHash }, language, sourceHash));
      for (const line of sent!.split("\n").map(value => value.trim()).filter(Boolean)) expect(known.has(line), `${topic}/${language}: ${line}`).toBe(true);
    }
  });
  it("a policy line from another knowledge source is not trusted into memory", () => {
    expect(customerAgentPolicyLines({ kind: "company_policy", topic: "rental", knowledge, sourceHash }, "ru", "b".repeat(64))).toEqual([]);
  });
});

