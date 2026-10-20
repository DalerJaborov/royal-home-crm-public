import { expect, it } from "vitest";
import { customerAgentDecisionSchema, customerAgentVerifiedContextSchema } from "@royal-home/shared";
import { renderCustomerAgentDecision, type CustomerAgentEvidence } from "../src/ai/customerAgentRenderer.js";

// Pure formatting/protocol probes, never proof of a genuine source/principal.
function context(turns: Array<{ role: "user" | "assistant"; text: string }>) {
  return customerAgentVerifiedContextSchema.parse({ surface: "dm", revisionId: "a".repeat(64), turns, publicState: {} });
}
function render(turns: Array<{ role: "user" | "assistant"; text: string }>, language: "ru" | "tg" = "ru", evidence: CustomerAgentEvidence[] = []) {
  return renderCustomerAgentDecision({ decision: { kind: "reply", refs: evidence.map(e => e.ref), social: "none", question: "clarify_previous" },
    evidence, language, requestedFacts: [], knownPhoneSource: "scoped_contact", maxOutputChars: 3000, surface: "dm", verifiedContext: context(turns) });
}
it("explains the exact canonical budget question rather than restarting a questionnaire", () => {
  expect(render([{ role: "assistant", text: "Какой бюджет вы рассматриваете?" }]))
    .toBe("Я уточнял сумму для покупки. Какой у вас бюджет?");
});
it("recognizes an actual canonical TG rooms question and stays within one question", () => {
  const text = render([{ role: "assistant", text: "Ба шумо чанд ҳуҷра лозим аст?" }], "tg");
  expect(text).toBe("Ман шумораи ҳуҷраҳоро мепурсидам. Чанд ҳуҷра лозим аст?"); expect(text?.match(/\?/g)).toHaveLength(1);
});
it("does not copy names/private prose, infer a monetary value or authorize old commands", () => {
  const text = render([{ role: "user", text: "PRIVATE CRM Рустам +992933445566. Позвоните мне" },
    { role: "assistant", text: "Спасибо!\nКакой район вам подходит?" }]);
  expect(text).toBe("Я уточнял район для поиска. Какой район вам подходит?");
  expect(text).not.toMatch(/PRIVATE|Рустам|992|создан|позвоним/iu);
});
it("keeps a verified price segment before the specific repair instead of erasing useful facts", () => {
  const text = render([{ role: "assistant", text: "Сколько комнат вам нужно?" }], "ru", [{ ref: "e0", value: { kind: "facts", kinds: ["price"], facts: {
    propertyId: "00000000-0000-4000-8000-000000000001", shortId: 123, price: "500000", currency: "TJS", availability: "AVAILABLE",
    publicAddress: null, addressPolicy: "district_city_only", builder: null, publicLink: null, updatedAt: "2026-10-15T00:00:00Z", signature: "a".repeat(64),
  } } }]);
  expect(text).toBe("Цена объекта №123: 500 000 сомони.\nЯ уточнял количество комнат. Сколько комнат вам нужно?");
});
it.each([
  { turns: [{ role: "user" as const, text: "Какой бюджет вы рассматриваете?" }] },
  { turns: [{ role: "assistant" as const, text: "Какой бюджет вы рассматриваете?" }, { role: "user" as const, text: "Уже ответил" }] },
  { turns: [{ role: "assistant" as const, text: "Какой номер телефона вы хотите оставить для связи?" }] },
  { turns: [{ role: "assistant" as const, text: "Вы хотите, чтобы сотрудник вам позвонил?" }] },
  { turns: [{ role: "assistant" as const, text: "Какой бюджет вы рассматриваете?\nСколько комнат вам нужно?" }] },
])("uses honest generic repair for user text, answered/personal/consent or ambiguous questions: %j", ({ turns }) => {
  expect(render(turns)).toBe("Что пояснить подробнее?");
});
it("public rendering cannot use a supplied private-DM context for a specific repair", () => {
  expect(renderCustomerAgentDecision({ decision: { kind: "reply", refs: [], social: "none", question: "clarify_previous" },
    evidence: [], language: "ru", requestedFacts: [], knownPhoneSource: "none", surface: "public_comment", maxOutputChars: 3000,
    verifiedContext: context([{ role: "assistant", text: "Какой бюджет вы рассматриваете?" }]) })).toBe("Что пояснить подробнее?");
});
it("model JSON cannot supply the server context or a free repair promise", () => {
  expect(customerAgentDecisionSchema.safeParse({ kind: "reply", refs: [], social: "none", question: "clarify_previous",
    verifiedContext: context([{ role: "assistant", text: "Какой бюджет вы рассматриваете?" }]) }).success).toBe(false);
});
