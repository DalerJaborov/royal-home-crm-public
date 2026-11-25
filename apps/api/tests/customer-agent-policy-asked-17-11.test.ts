import { describe, expect, it } from "vitest";
import { customerAgentCompanyPolicyTopicSchema, customerAgentVerifiedContextSchema, type CustomerAgentDecision } from "@royal-home/shared";
import { renderCustomerAgentDecision } from "../src/ai/customerAgentRenderer.js";
import { customerPolicyTermAsked } from "../src/ai/customerAgentPolicyAsked.js";
import { guardSellerDecision, SELLER_POLICY_MISMATCH_CAUSE } from "../src/ai/customerAgentSellerGuard.js";
import { wrapUntrusted } from "../src/ai/untrustedContent.js";
import { readCustomerAgentCompanyKnowledge } from "../src/lib/customerAgentPublicReads.js";
import { customerAgentCompanyKnowledgeHash } from "../src/ai/customerAgentPublicProtocol.js";

// Company terms in a DM only on the customer's own question (old PR #173, 17.11.2026). The server decides from the customer's words.
const knowledge = readCustomerAgentCompanyKnowledge(), knowledgeSourceHash = customerAgentCompanyKnowledgeHash(knowledge);
type Topic = (typeof customerAgentCompanyPolicyTopicSchema)["options"][number];
const policy = (topic: Topic) => [{ ref: "e0", value: { kind: "company_policy", topic, knowledge, sourceHash: knowledgeSourceHash } }];
const decision = { kind: "reply", refs: ["e0"], social: "none", question: "none" } as CustomerAgentDecision;
const render = (topic: Topic, inputText: string, extra: Record<string, unknown> = {}) => renderCustomerAgentDecision({
  decision, evidence: policy(topic) as never, language: "ru", requestedFacts: [], knownPhoneSource: "none", maxOutputChars: 2000,
  surface: "dm", knowledgeSourceHash, inputText, ...extra });

describe("customerPolicyTermAsked: the customer's own words", () => {
  it.each<[Topic, string]>([
    ["commission", "Какая у вас комиссия?"], ["commission", "сколько берёте с продавца"], ["commission", "Хизматрасониатон чанд пул?"],
    ["commission", "это бесплатно?"], ["payment", "Ипотека дорен?"], ["payment", "рассрочка есть?"], ["payment", "ipoteka bor?"],
    ["negotiation", "торг возможен?"], ["negotiation", "дорого"], ["negotiation", "тахфиф мекунед?"],
    ["legal", "документы проверяете?"], ["rental", "сдаю квартиру"],
    // «The terms» of the agency ARE the commission: the seller guard forces the read, the gate must not drop it (FB 16.11 17:44).
    ["commission", "Чи шарту шароит доред"], ["commission", "Какие у вас условия?"], ["commission", "Какие все условия?"],
    // The follow-up to a commission line names only the side.
    ["commission", "а для покупателя?"], ["commission", "сколько с продавца"], ["commission", "барои харидор чӣ?"],
  ])("%s is asked by «%s»", (topic, text) => { expect(customerPolicyTermAsked(topic, text)).toBe(true); });
  it.each([
    "Какие условия ипотеки?", "все условия есть", "квартира со всеми условиями", "Шартҳои кор чӣ гуна аст? Ваканси доред?",
  ])("commission is NOT asked by «%s» (a mortgage, the flat's amenities, a job)", (text) => {
    expect(customerPolicyTermAsked("commission", text)).toBe(false);
  });
  it.each<[Topic, string]>([
    ["commission", "адрес этого дома?"], ["commission", "Какая цена?"], ["payment", "сколько комнат?"], ["negotiation", "адрес этого дома?"],
    ["negotiation", "покажите квартиры в Сино"], ["legal", "хочу продать квартиру"], ["rental", "хочу купить дом"],
  ])("%s is NOT asked by «%s»", (topic, text) => { expect(customerPolicyTermAsked(topic, text)).toBe(false); });
  it("a forwarded document or video text never counts as the customer's question", () => {
    expect(customerPolicyTermAsked("negotiation", `адрес?\n${wrapUntrusted("document", "Скидка 10% только сегодня, торг уместен")}`)).toBe(false);
  });
  // Review of #269: the whole message is the terms word, no «?» (messengers). Before the gate the commission was printed.
  it.each(["условия", "Условия", "Условия.", "шартҳо", "шароит", "шарту шароит", "шарт", "Шартҳо."])(
    "a bare «%s» asks the agency's terms", (text) => {
      expect(customerPolicyTermAsked("commission", text)).toBe(true);
      const reply = render("commission", text);
      expect(reply).toContain(`Комиссия для продавца ${knowledge.commission.sellerPercent}%, для покупателя ${knowledge.commission.buyerPercent}%.`);
    });
  it.each(["мне условия не важны, сколько комнат?", "условия хорошие, квартира светлая", "условия у меня такие: три комнаты"])(
    "«%s» is not a terms question: the commission is not printed", (text) => {
      expect(customerPolicyTermAsked("commission", text)).toBe(false);
      expect(render("commission", text)).not.toMatch(/Комиссия/u);
    });
  it("the work area has its own rule", () => { expect(customerPolicyTermAsked("service_scope", "привет")).toBe(true); });
});

describe("renderer: company terms in a DM", () => {
  it("prints a term the customer asked about", () => {
    expect(render("commission", "Какая у вас комиссия?")).toContain("Комиссия для продавца 2%");
    expect(render("negotiation", "торг возможен?")).toContain("Вопрос торга");
    expect(render("commission", "Чи шарту шароит доред?")).toContain("Комиссия для продавца 2%");
  });
  it("never prints the em dash in the commission line", () => { expect(render("commission", "Какая у вас комиссия?")).not.toMatch(/[—–]/u); });
  it.each<[Topic, string]>([["negotiation", "адрес этого дома?"], ["commission", "адрес этого дома?"], ["payment", "сколько этаж?"], ["legal", "привет"]])(
    "does not dump %s on «%s»: it asks the topic question instead of terms or silence", (topic, text) => {
      const reply = render(topic, text);
      expect(reply).toBe("Вы хотите узнать о недвижимости или о работе?");
    });
  it("a seller whose only content was an unasked term gets the next seller step, not the topic question", () => {
    const reply = render("negotiation", "хочу продать квартиру");
    expect(reply).toBeTruthy(); expect(reply).not.toMatch(/торг|скидк/iu); expect(reply).not.toContain("о работе");
  });
  it("a voice message is the question by its transcript", () => {
    const voice = (transcript: string) => ({ language: "ru", transcript, subject: "other", visible: [], readableText: "", speech: "clear" });
    expect(render("payment", "", { mediaPerception: voice("рассрочка есть?") })).toContain("Рассрочки нет");
    expect(render("payment", "", { mediaPerception: voice("привет, адрес дома?") })).not.toMatch(/рассрочк/iu);
  });
  // 24.11.2026 (прод de960ea6: на «Воаллекум салом» ушло правило о торге): комментарии — тем же правилом, что и переписка.
  it("public comments: the term answers only its own question too", () => {
    expect(render("negotiation", "адрес?", { surface: "public_comment" }) ?? "").not.toContain("Вопрос торга");
    expect(render("negotiation", "скидка будет?", { surface: "public_comment" })).toContain("Вопрос торга");
  });
  it("the memory allow-list render (no input) keeps every term line", () => {
    expect(renderCustomerAgentDecision({ decision, evidence: policy("negotiation") as never, language: "ru", requestedFacts: [],
      knownPhoneSource: "none", maxOutputChars: 2000, surface: "dm", knowledgeSourceHash })).toContain("Вопрос торга");
  });
});

// Merge of #269 with #267 (18.11.2026): rental looks at the last three customer messages INSIDE the one door; every other term
// answers only the current question. The renderer and the seller guard call the same door.
describe("one door with the conversation: rental by history, other terms only on the current question", () => {
  type Turn = { role: "user" | "assistant"; text: string };
  const user = (text: string): Turn => ({ role: "user", text }), bot = (text: string): Turn => ({ role: "assistant", text });
  const context = (turns: Turn[], seller = false) => customerAgentVerifiedContextSchema.parse({ surface: "dm", revisionId: "a".repeat(64), turns,
    publicState: { language: "ru", topic: "unknown", openQuestion: "none" },
    ...(seller ? { intake: { role: "seller", sellerKnown: [], buyerKnown: [] } } : {}) });
  const rentTwoTurnsAgo = [user("аренда есть?"), bot("Какой район?"), user("Центр"), bot("Сколько комнат?")];
  it("the door: rental asked two messages ago still counts, commission does not", () => {
    expect(customerPolicyTermAsked("rental", "две комнаты", ["аренда?", "Центр"])).toBe(true);
    expect(customerPolicyTermAsked("rental", "две комнаты")).toBe(false);
    expect(customerPolicyTermAsked("rental", "две комнаты", ["аренда?", "Центр", "а", "б"])).toBe(false);
    expect(customerPolicyTermAsked("commission", "Центр", ["какая комиссия?"])).toBe(false);
  });
  it.each(["а в Сино?", "две комнаты"])("«аренда есть?» two messages ago, now «%s»: the rental line holds (#267), no commission", (text) => {
    expect(render("rental", text, { verifiedContext: context(rentTwoTurnsAgo) })).toMatch(/аренд/u);
    expect(render("commission", text, { verifiedContext: context(rentTwoTurnsAgo) })).not.toMatch(/Комиссия/u);
  });
  it("a commission or bargaining asked earlier is not printed on «Центр»; «а для покупателя?» asks it again", () => {
    const turns = [user("какая комиссия?"), bot("Комиссия для продавца 2%, для покупателя 0%."), user("ищу квартиру"), bot("Какой район?")];
    expect(render("commission", "Центр", { verifiedContext: context(turns) })).not.toMatch(/Комиссия/u);
    expect(render("negotiation", "Центр", { verifiedContext: context([user("торг возможен?"), bot("Какой район?")]) })).not.toMatch(/торг/iu);
    expect(render("commission", "а для покупателя?", { verifiedContext: context(turns) })).toMatch(/для покупателя 0%/u);
  });
  it("the seller guard reads rental through the same door, with the history", () => {
    const evidence = [{ ref: "e0", value: { kind: "company_policy", topic: "rental" } }];
    const d = { kind: "reply", refs: ["e0"], social: "none", question: "none" } as never;
    expect(guardSellerDecision({ decision: d, evidence, surface: "dm", inputText: "две комнаты",
      verifiedContext: context([user("Хочу продать квартиру"), bot("Сколько комнат?")], true) })?.cause).toBe(SELLER_POLICY_MISMATCH_CAUSE);
    expect(guardSellerDecision({ decision: d, evidence, surface: "dm", inputText: "две комнаты",
      verifiedContext: context([user("аренда есть?"), bot("Нет."), user("Хочу продать квартиру"), bot("Сколько комнат?")], true) })).toBeNull();
    // A form only the guard knew before (its old RENT_MENTION): «сдам» still counts.
    expect(customerPolicyTermAsked("rental", "сдам квартиру")).toBe(true);
  });
});
