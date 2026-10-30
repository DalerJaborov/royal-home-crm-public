import { describe, expect, it, vi } from "vitest";
import { customerAgentVerifiedContextSchema } from "@royal-home/shared";
import { runCustomerAgentTurn, type CustomerAgentModelTurn, type CustomerCoreFrame, type CustomerCorePorts } from "../src/ai/customerAgentCore.js";
import { createProviderOperation } from "../src/ai/providerContract.js";
import { renderCustomerAgentDecision, type CustomerAgentEvidence, type CustomerAgentObservation } from "../src/ai/customerAgentRenderer.js";
import { customerAgentCompanyInformationHash } from "../src/ai/customerAgentPublicProtocol.js";
import { customerDmAbuseKind, customerDmForeignShareNoise } from "../src/ai/customerAgentAbuse.js";
import { customerAgentAttachmentQuestion, customerAgentMarkForeignShare, FOREIGN_SHARE_LINE, OWN_SHARE_UNLINKED_LINE } from "../src/ai/customerAgentAttachmentInput.js";
import { customerForeignShareCandidate } from "../src/lib/customerSharedPublication.js";

const hash = "a".repeat(64);
const context = (turns: Array<{ role: "user" | "assistant"; text: string }> = [], publicState: Record<string, unknown> = {}) =>
  customerAgentVerifiedContextSchema.parse({ surface: "dm", revisionId: hash, turns, publicState });
const foreign = { kinds: ["foreign_share" as const] };
function fixture(overrides: Partial<CustomerCoreFrame> = {}) {
  const controller = new AbortController();
  const operation = createProviderOperation({ managed: true, deadlineAt: Date.now() + 30_000, maxAttempts: 8, signal: controller.signal,
    accountant: { reserve: async () => true, settle: async () => {} }, supports: () => true });
  const frame: CustomerCoreFrame = { surface: "dm", language: "ru", inputText: "", knownPhoneSource: "none", requestedFacts: [], attachmentInput: foreign,
    revision: { id: hash, coreHash: hash, modelSchemaHash: hash, toolSchemaHash: hash, rendererHash: hash, knowledgeSchemaHash: hash, knowledgeSourceHash: hash,
      providerProfileHash: hash, providerPolicyHash: hash, promptHash: hash,
      limits: { maxRounds: 3, maxToolCalls: 4, maxInputChars: 20_000, maxOutputChars: 2000, maxModelOutputTokens: 1024, deadlineMs: 30_000 } },
    startedAt: Date.now(), operation, verifiedContext: context(),
    tools: [{ name: "get_property_facts", description: "Read public facts" }, { name: "get_company_information", description: "Office" }], ...overrides };
  const modelTurn = vi.fn<CustomerCorePorts["modelTurn"]>(async (): Promise<CustomerAgentModelTurn> => ({
    text: JSON.stringify({ kind: "reply", refs: [], social: "none", question: "none" }), calls: [], modelParts: [] }));
  const executeAllowedTool = vi.fn<CustomerCorePorts["executeAllowedTool"]>(async () => ({ status: "denied", reason: "unexpected" }));
  const ports = { modelTurn, executeAllowedTool, assertCurrent: async () => true, requestStop: () => {}, observeLateToolResult: () => {} } satisfies CustomerCorePorts;
  return { frame, ports, modelTurn, executeAllowedTool };
}

describe("like-exchange spam in the abuse guard", () => {
  it.each(["Лайк камент паделится", "лайк за лайк", "Лайк ❤️ камень жду", "Лайк коммент поделись", "взаимка?", "l4l", "Like for like", "Камент паделись", "Лойк камент"])("%s is spam", text => {
    expect(customerDmAbuseKind(text)).toBe("spam");
  });
  it.each(["Поделитесь номером агента", "Мне понравилась квартира, лайк вашей странице", "Лайк", "Какой комментарий оставить?", "взаимно, хорошего дня", "Добрый день, подскажите цену"])("%s is not spam", text => {
    expect(customerDmAbuseKind(text)).toBeNull();
  });
});

describe("foreign-share noise", () => {
  it.each(["", "   ", "❤️", "🔥🔥", "Лайк камент паделится", "Blizkiyoooo ❤️", "Binenw 💕", "Blizkiyoooo", "ha ha"])("%j carries nothing asked", text => {
    expect(customerDmForeignShareNoise(text)).toBe(true);
  });
  it.each(["ин хона чанд аст?", "Цена?", "Сколько стоит", "Салом", "Salom", "narx", "price", "3 xona", "Нарх", "Хона мехоҳам", "good apartment please sell"])("%j stays with the model", text => {
    expect(customerDmForeignShareNoise(text)).toBe(false);
  });
});

describe("foreign share marking", () => {
  it("marks only a lone-share input, only when the server says so", () => {
    expect(customerAgentMarkForeignShare({ kinds: ["share"] }, "foreign_share")).toEqual(foreign);
    expect(customerAgentMarkForeignShare({ kinds: ["share"] }, false)).toEqual({ kinds: ["share"] });
    expect(customerAgentMarkForeignShare({ kinds: ["share", "image"] }, "foreign_share")).toEqual({ kinds: ["share", "image"] });
    expect(customerAgentMarkForeignShare(undefined, "foreign_share")).toBeUndefined();
  });
  it("is only a candidate when the share is the sole property evidence", () => {
    const shared = { origin: "shared_media" };
    expect(customerForeignShareCandidate({ kinds: ["share"], propertyEvidence: [shared] })).toBe(true);
    expect(customerForeignShareCandidate({ kinds: ["share"], propertyEvidence: [shared, { origin: "story" }] })).toBe(false);
    expect(customerForeignShareCandidate({ kinds: ["share"], propertyEvidence: [shared, { origin: "message" }] })).toBe(false);
    expect(customerForeignShareCandidate({ kinds: ["share", "image"], propertyEvidence: [shared] })).toBe(false);
    expect(customerForeignShareCandidate({ kinds: ["share"], propertyEvidence: [] })).toBe(false);
    expect(customerForeignShareCandidate({ kinds: undefined, propertyEvidence: [shared] })).toBe(false);
  });
});

describe("core: a publication of somebody else", () => {
  it("answers the first one with one short line, no model, no read, no question", async () => {
    const f = fixture();
    const result = await runCustomerAgentTurn(f.frame, f.ports);
    expect(result).toMatchObject({ status: "ready", text: FOREIGN_SHARE_LINE.ru, rounds: 0, toolCalls: 0 });
    expect(f.modelTurn).not.toHaveBeenCalled(); expect(f.executeAllowedTool).not.toHaveBeenCalled();
  });
  it("answers in Tajik when the dialogue is Tajik", async () => {
    const f = fixture({ language: "tg" });
    expect(await runCustomerAgentTurn(f.frame, f.ports)).toMatchObject({ status: "ready", text: FOREIGN_SHARE_LINE.tg });
  });
  it("is silent for the second one: no model, no text, only a no-reply hold", async () => {
    const f = fixture({ verifiedContext: context([{ role: "assistant", text: FOREIGN_SHARE_LINE.ru }]) });
    const result = await runCustomerAgentTurn(f.frame, f.ports);
    expect(result).toMatchObject({ status: "held", reason: "foreign_share_no_reply", cause: "foreign_share_no_reply" });
    expect(f.modelTurn).not.toHaveBeenCalled();
  });
  it("counts the older generic share question as already answered", async () => {
    const f = fixture({ verifiedContext: context([{ role: "assistant", text: "Что хотите узнать по этой публикации?" }]) });
    expect(await runCustomerAgentTurn(f.frame, f.ports)).toMatchObject({ status: "held", reason: "foreign_share_no_reply" });
  });
  it.each(["Лайк камент паделится", "Blizkiyoooo ❤️", "Binenw 💕", "❤️"])("%s: the line only, never the office address or a question", async inputText => {
    const f = fixture({ inputText });
    const result = await runCustomerAgentTurn(f.frame, f.ports);
    expect(result).toMatchObject({ status: "ready", text: FOREIGN_SHARE_LINE.ru });
    expect(f.modelTurn).not.toHaveBeenCalled();
  });
  it("a real question about the forwarded publication still reaches the model", async () => {
    const f = fixture({ inputText: "ин хона чанд аст?", language: "tg" });
    f.modelTurn.mockResolvedValueOnce({ text: JSON.stringify({ kind: "clarify", refs: [], social: "none", question: "property" }), calls: [], modelParts: [] });
    const result = await runCustomerAgentTurn(f.frame, f.ports);
    expect(result.status).toBe("ready");
    expect(f.modelTurn).toHaveBeenCalledTimes(1);
  });
  it("does not apply to a job dialogue", async () => {
    const f = fixture({ verifiedContext: context([], { topic: "job" }) });
    const result = await runCustomerAgentTurn(f.frame, f.ports);
    expect(result.status === "ready" && result.text === FOREIGN_SHARE_LINE.ru).toBe(false);
  });
});

describe("core: our own publication without a linked object", () => {
  const own = { kinds: ["own_share_unlinked" as const] };
  it("marks a lone share as own-unlinked and keeps it distinct from foreign", () => {
    expect(customerAgentMarkForeignShare({ kinds: ["share"] }, "own_share_unlinked")).toEqual(own);
  });
  it.each([["ru", OWN_SHARE_UNLINKED_LINE.ru], ["tg", OWN_SHARE_UNLINKED_LINE.tg]] as const)("says it once in %s, even with perception", async (language, line) => {
    const f = fixture({ attachmentInput: own, language });
    expect(await runCustomerAgentTurn(f.frame, f.ports)).toMatchObject({ status: "ready", text: line, rounds: 0 });
    expect(f.modelTurn).not.toHaveBeenCalled();
    const text = line.includes("наша") ? "Это наша" : "";
    expect(line).not.toContain("не наша"); expect(text).toBeDefined();
  });
  it("is silent the second time", async () => {
    const f = fixture({ attachmentInput: own, verifiedContext: context([{ role: "assistant", text: OWN_SHARE_UNLINKED_LINE.ru }]) });
    expect(await runCustomerAgentTurn(f.frame, f.ports)).toMatchObject({ status: "held", reason: "foreign_share_no_reply" });
  });
});

describe("renderer: office address only on request", () => {
  const info = { name: "Royal Home", city: "Душанбе", office: "ул. Тестовая, 1", services: "Продажа и помощь в покупке", hours: { start: "09:30", end: "18:00", daysOff: [0] } };
  const company: CustomerAgentObservation = { kind: "company_information", information: info, sourceHash: customerAgentCompanyInformationHash(info) };
  const render = (inputText: string, extra: Record<string, unknown> = {}) => renderCustomerAgentDecision({
    decision: { kind: "reply", refs: ["e0"], social: "thank", question: "none" }, evidence: [{ ref: "e0", value: company }] as CustomerAgentEvidence[],
    inputText, language: "ru", requestedFacts: [], knownPhoneSource: "none", maxOutputChars: 2000, surface: "dm", ...extra });
  it.each(["Спасибо!", "Ташаккур", "👍", ""])("does not print the address for %j", inputText => {
    const text = render(inputText) ?? "";
    expect(text).not.toContain("Тестовая"); expect(text).not.toContain("09:30");
  });
  it.each(["Где ваш офис?", "Адрес подскажите", "Когда вы работаете?", "Куҷо ҳастед?"])("still prints it for %j", inputText => {
    expect(render(inputText) ?? "").toMatch(/Тестовая|09:30/);
  });
  it("keeps it for a job candidate", () => {
    expect(render("Спасибо!", { verifiedContext: context([], { topic: "job" }) }) ?? "").toContain("Тестовая");
  });
});

describe("renderer: attachment templates are not repeated", () => {
  const asked = (kind: "image" | "unknown") => customerAgentAttachmentQuestion({ kinds: [kind] }, "ru", false);
  const render = (kind: "image" | "unknown", turns: Array<{ role: "user" | "assistant"; text: string }>) => renderCustomerAgentDecision({
    decision: { kind: "clarify", refs: [], social: "none", question: "clarify_previous" }, evidence: [], inputText: "", attachmentInput: { kinds: [kind] },
    language: "ru", requestedFacts: [], knownPhoneSource: "none", maxOutputChars: 2000, surface: "dm", verifiedContext: context(turns) });
  it("asks once, then says so instead of repeating the template", () => {
    expect(render("image", [])).toBe(asked("image"));
    const again = render("image", [{ role: "user", text: "photo" }, { role: "assistant", text: asked("image") }]);
    expect(again).not.toBe(asked("image")); expect(again).toMatch(/уже писал/);
  });
  it("the unknown attachment line is a human sentence", () => {
    expect(asked("unknown")).toBe("Вложение не открылось. Напишите текстом, что вас интересует.");
    expect(customerAgentAttachmentQuestion({ kinds: ["unknown"] }, "tg", false)).toBe("Файл кушода нашуд. Бо матн нависед, чӣ лозим аст.");
  });
});
