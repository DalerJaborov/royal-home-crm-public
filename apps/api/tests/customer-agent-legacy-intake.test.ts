import { describe, expect, it } from "vitest";
import { customerAgentIntake, customerSellerIntakeQuestion } from "../src/ai/customerAgentIntake.js";
import { renderCustomerAgentDecision, customerAgentRenderedQuestion } from "../src/ai/customerAgentRenderer.js";
import { wrapUntrusted } from "../src/ai/untrustedContent.js";
import type { CustomerAgentVerifiedContext } from "@royal-home/shared";

const user = (text: string) => ({ role: "user" as const, text });
const context = (intake: NonNullable<CustomerAgentVerifiedContext["intake"]>): CustomerAgentVerifiedContext => ({
  surface: "dm", revisionId: "a".repeat(64), turns: [], publicState: { language: "ru", topic: "unknown", openQuestion: "none" }, intake,
});
function reply(text: string, verifiedContext?: CustomerAgentVerifiedContext, surface: "dm" | "public_comment" = "dm") {
  return renderCustomerAgentDecision({ decision: { kind: "clarify", refs: [], social: "none", question: "rooms" }, evidence: [],
    requestedFacts: [], knownPhoneSource: "none", maxOutputChars: 3000, language: "ru", surface, inputText: text, verifiedContext });
}

describe("legacy seller intake through bounded customer-core progress", () => {
  it("asks all missing seller parameters together and does not ask known rooms/area again", () => {
    const value = customerAgentIntake([user("Хочу продать квартиру. 2 комнаты, 54 м2")]);
    expect(value.role).toBe("seller");
    expect(value.sellerKnown).toEqual(expect.arrayContaining(["rooms", "area"]));
    const text = customerSellerIntakeQuestion(value.sellerKnown, "ru");
    expect(text).toContain("район или ориентир"); expect(text).toContain("этаж");
    expect(text).toContain("одним сообщением"); expect(text).not.toMatch(/число комнат|площадь|номер телефона|сохран|агенту/iu);
  });
  it("retains fields beyond the short displayed history via the server summary", () => {
    const prior = context({ role: "seller", sellerKnown: ["rooms", "area", "district", "condition", "price"], buyerKnown: [] });
    const text = reply("3 этаж", prior);
    expect(text).toContain("фото или видео"); expect(text).not.toContain("напишите");
    expect(customerAgentRenderedQuestion({ decision: { kind: "clarify", refs: [], social: "none", question: "rooms" },
      evidence: [], surface: "dm", knownPhoneSource: "none", verifiedContext: prior, inputText: "3 этаж" })).toBe("seller_details");
  });
  it("uses the Tajik seller detector without switching the output to Russian", () => {
    const value = customerAgentIntake([user("Ман хона мефурӯшам. 3 ҳуҷра, 80 м2, ошёнаи 4")]);
    expect(value.role).toBe("seller"); expect(value.sellerKnown).toEqual(expect.arrayContaining(["rooms", "area", "floor"]));
    const text = customerSellerIntakeQuestion(value.sellerKnown, "tg");
    expect(text).toContain("Ҳамаашро дар як паём"); expect(text).not.toMatch(/шумораи ҳуҷраҳо|масоҳат|ошёна|телефон/iu);
  });
  it("does not learn the seller's own facts from a forwarded video/document or assistant prose", () => {
    const forwarded = wrapUntrusted("video", "2 комнаты 80 м2 3 этаж Сино с ремонтом цена 500000 сомони");
    const value = customerAgentIntake([{ role: "assistant", text: "У вас 2 комнаты, 80 м2" }, user(`Хочу продать квартиру ${forwarded}`)]);
    expect(value.role).toBe("seller"); expect(value.sellerKnown).toEqual([]);
  });
  it("starts fresh after an explicit seller to buyer topic change", () => {
    const value = customerAgentIntake([user("Продаю 3 комнаты 90 м2 в Сино"), user("Теперь хочу купить квартиру, до 700000 сомони")]);
    expect(value.role).toBe("buyer"); expect(value.sellerKnown).toEqual([]); expect(value.buyerKnown).toEqual(["budget"]);
    expect(reply("Теперь хочу купить квартиру", context({ role: "seller", sellerKnown: ["rooms"], buyerKnown: [] }))).not.toContain("Для продажи");
  });
  it.each(["Не хочу продать квартиру", "Не продаю свою квартиру", "Не хочу купить квартиру"])("does not turn a negation into an intake role: %s", text => {
    expect(customerAgentIntake([], text).role).toBe("unknown");
  });
  it("does not reuse a private seller summary in a public comment", () => {
    expect(reply("А что нужно?", context({ role: "seller", sellerKnown: ["rooms"], buyerKnown: [] }), "public_comment")).toBe("Сколько комнат вам нужно?");
  });
});

describe("buyer progress without invented financial facts or repeated questions", () => {
  it("keeps bounded own wishes and currency corrections, omitting a foreign listing and the prior seller task", () => {
    const value = customerAgentIntake([user("Продаю 3 комнаты в Сино"), user("Теперь хочу купить квартиру, бюджет до 80000 долларов"),
      user(wrapUntrusted("video", "7 комнат цена 9000000 сомони")), user("Поправка: до 700000 сомони, 2 комнаты")]);
    expect(value.statements).toEqual(["Теперь хочу купить квартиру, бюджет до 80000 долларов", "Поправка: до 700000 сомони, 2 комнаты"]);
    expect(customerAgentIntake(Array.from({ length: 10 }, (_, i) => user(`Ищу квартиру ${i} ${"а".repeat(200)}`))).statements).toHaveLength(6);
    expect(customerAgentIntake([user(`Ищу квартиру ${"а".repeat(400)} до 700000 сомони`) ]).statements).toEqual([]);
    expect(value.statements.every(text => text.length <= 360)).toBe(true);
  });
  it("does not treat a listing's quoted price as the buyer's budget", () => {
    const value = customerAgentIntake([user("Хочу купить квартиру"), user("Она стоит 500000 сомони?")]);
    expect(value.role).toBe("buyer"); expect(value.buyerKnown).not.toContain("budget");
  });
  it("asks the next missing preference rather than re-asking rooms", () => {
    expect(reply("Да", context({ role: "buyer", sellerKnown: [], buyerKnown: ["rooms"] }))).toBe("Какой район вам подходит?");
  });
  it("keeps a useful question after all basic buyer preferences are known", () => {
    expect(reply("Да", context({ role: "buyer", sellerKnown: [], buyerKnown: ["rooms", "budget", "location"] }))).toContain("этаж или состояние ремонта");
  });
});
