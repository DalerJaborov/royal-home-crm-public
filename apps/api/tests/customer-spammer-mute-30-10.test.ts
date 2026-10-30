import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { customerAgentVerifiedContextSchema } from "@royal-home/shared";
import { prisma } from "../src/db.js";
import { runCustomerAgentTurn, type CustomerAgentModelTurn, type CustomerCoreFrame, type CustomerCorePorts } from "../src/ai/customerAgentCore.js";
import { createProviderOperation } from "../src/ai/providerContract.js";
import { renderCustomerAgentDecision, customerAgentFixedLines, type CustomerAgentEvidence } from "../src/ai/customerAgentRenderer.js";
import { BUSINESS_QUESTION, EPHEMERAL_PHOTO_LINE, customerAgentAttachmentLines, customerAgentAttachmentQuestion } from "../src/ai/customerAgentAttachmentInput.js";
import { customerSpamInterest, customerSpamMuteFrom, customerSpamMuteGate, customerSpamMuteRecord, customerSpamTurn,
  SPAM_MUTE_MS, SPAM_WINDOW_MS } from "../src/ai/customerSpamMute.js";
import { clearCustomerSpamMute, readCustomerSpamMute, recordCustomerSpamTurn } from "../src/lib/customerSpamMuteStore.js";

const FAILURE_TALK = /не открыл|недоступн|не смог|не удалось|кушода нашуд|дастрас нест/iu;
const hash = "a".repeat(64);
const context = (turns: Array<{ role: "user" | "assistant"; text: string }> = [], publicState: Record<string, unknown> = {}) =>
  customerAgentVerifiedContextSchema.parse({ surface: "dm", revisionId: hash, turns, publicState });
function fixture(overrides: Partial<CustomerCoreFrame> = {}) {
  const controller = new AbortController();
  const operation = createProviderOperation({ managed: true, deadlineAt: Date.now() + 30_000, maxAttempts: 8, signal: controller.signal,
    accountant: { reserve: async () => true, settle: async () => {} }, supports: () => true });
  const frame: CustomerCoreFrame = { surface: "dm", language: "ru", inputText: "", knownPhoneSource: "none", requestedFacts: [], attachmentInput: { kinds: ["image"] },
    revision: { id: hash, coreHash: hash, modelSchemaHash: hash, toolSchemaHash: hash, rendererHash: hash, knowledgeSchemaHash: hash, knowledgeSourceHash: hash,
      providerProfileHash: hash, providerPolicyHash: hash, promptHash: hash,
      limits: { maxRounds: 3, maxToolCalls: 4, maxInputChars: 20_000, maxOutputChars: 2000, maxModelOutputTokens: 1024, deadlineMs: 30_000 } },
    startedAt: Date.now(), operation, verifiedContext: context(), tools: [{ name: "get_property_facts", description: "Read public facts" }], ...overrides };
  const modelTurn = vi.fn<CustomerCorePorts["modelTurn"]>(async (): Promise<CustomerAgentModelTurn> => ({
    text: JSON.stringify({ kind: "reply", refs: [], social: "none", question: "none" }), calls: [], modelParts: [] }));
  const ports = { modelTurn, executeAllowedTool: vi.fn<CustomerCorePorts["executeAllowedTool"]>(async () => ({ status: "denied", reason: "unexpected" })),
    assertCurrent: async () => true, requestStop: () => {}, observeLateToolResult: () => {} } satisfies CustomerCorePorts;
  return { frame, ports, modelTurn };
}

describe("what is a spam turn", () => {
  const foreign = { kinds: ["foreign_share" as const] };
  it.each([["Лайк камент паделится", undefined], ["", foreign], ["❤️", foreign], ["Blizkiyoooo", foreign], ["взаимка?", undefined], ["Лайк коммент жду", foreign]])(
    "%j is", (inputText, attachmentInput) => expect(customerSpamTurn({ inputText, attachmentInput })).toBe(true));
  it.each([["Салом", undefined], ["", undefined], ["", { kinds: ["share" as const] }], ["", { kinds: ["own_share_unlinked" as const] }],
    ["ин хона чанд аст?", foreign], ["Лайк камент, сколько стоит?", undefined], ["Лайк камент 992900112233", undefined]])(
    "%j is not", (inputText, attachmentInput) => expect(customerSpamTurn({ inputText, attachmentInput })).toBe(false));
});

describe("real interest lifts the mark", () => {
  it.each(["нархаш чанд?", "хонаи 2 ҳуҷрагӣ доред?", "Сколько стоит?", "продам квартиру", "мефурӯшам хона", "Хочу купить дом", "суроғаи офис?",
    "ОБ-1234", "объект №77", "+992 900 11 22 33", "900112233", "Нарх", "price?", "ҳавлӣ мехоҳам", "аренда есть?"])("%s", text => {
    expect(customerSpamInterest(text)).toBe(true);
  });
  it.each(["Лайк камент паделится", "❤️", "Blizkiyoooo ❤️", "взаимка", "Binenw 💕", "лайк за лайк", "", "спасибо", "Привет"])("%j is not interest", text => {
    expect(customerSpamInterest(text)).toBe(false);
  });
});

describe("the mark", () => {
  const t0 = new Date("2026-10-30T10:00:00Z");
  it("is not set by one spam turn, is set by the second within a week, and lasts a month", () => {
    const one = customerSpamMuteRecord({ turns: [] }, { key: "a", now: t0 });
    expect(one.mutedUntil).toBeUndefined();
    const two = customerSpamMuteRecord(one, { key: "b", now: new Date(t0.getTime() + 3600_000) });
    expect(Date.parse(two.mutedUntil!)).toBe(t0.getTime() + 3600_000 + SPAM_MUTE_MS);
  });
  it("counts a retried event once", () => {
    const once = customerSpamMuteRecord({ turns: [] }, { key: "a", now: t0 });
    expect(customerSpamMuteRecord(once, { key: "a", now: new Date(t0.getTime() + 1000) }).mutedUntil).toBeUndefined();
  });
  it("forgets turns older than a week", () => {
    const old = customerSpamMuteRecord({ turns: [] }, { key: "a", now: t0 });
    expect(customerSpamMuteRecord(old, { key: "b", now: new Date(t0.getTime() + SPAM_WINDOW_MS + 1000) }).mutedUntil).toBeUndefined();
  });
  it("muted -> silent, interest -> released, expired -> open", () => {
    const state = { turns: [], mutedUntil: new Date(t0.getTime() + 1000).toISOString() };
    expect(customerSpamMuteGate(state, { inputText: "Лайк", now: t0 })).toBe("muted");
    expect(customerSpamMuteGate(state, { inputText: "", now: t0 })).toBe("muted");
    expect(customerSpamMuteGate(state, { inputText: "нархаш чанд?", now: t0 })).toBe("released");
    expect(customerSpamMuteGate(state, { inputText: "Лайк", now: new Date(t0.getTime() + 2000) })).toBe("open");
    expect(customerSpamMuteGate({ turns: [] }, { inputText: "Лайк", now: t0 })).toBe("open");
  });
  it("an unreadable stored value is no mark", () => {
    expect(customerSpamMuteFrom({ turns: "x" })).toEqual({ turns: [] });
    expect(customerSpamMuteFrom(null)).toEqual({ turns: [] });
  });
});

describe("the mark in the database (leadDraft.spamMute)", () => {
  it("is written and cleared without touching the rest of the draft", async () => {
    const conversation = await prisma.botConversation.create({ data: { channel: "INSTAGRAM", subscriberId: `spam-mute-${randomUUID()}`,
      messages: [], leadDraft: { stage: "chatting", notes: "keep" } }, select: { id: true } });
    try {
      await recordCustomerSpamTurn(conversation.id, { eventKey: "e1", now: new Date() });
      expect((await readCustomerSpamMute(conversation.id)).mutedUntil).toBeUndefined();
      const state = await recordCustomerSpamTurn(conversation.id, { eventKey: "e2", now: new Date() });
      expect(state.mutedUntil).toBeDefined();
      expect((await readCustomerSpamMute(conversation.id)).mutedUntil).toBe(state.mutedUntil);
      const draft = (await prisma.botConversation.findUniqueOrThrow({ where: { id: conversation.id } })).leadDraft;
      expect(draft).toMatchObject({ stage: "chatting", notes: "keep" });
      await clearCustomerSpamMute(conversation.id);
      expect(await readCustomerSpamMute(conversation.id)).toEqual({ turns: [] });
      expect((await prisma.botConversation.findUniqueOrThrow({ where: { id: conversation.id } })).leadDraft).toEqual({ stage: "chatting", notes: "keep" });
    } finally { await prisma.botConversation.delete({ where: { id: conversation.id } }); }
  });
  it("works when the draft is empty", async () => {
    const conversation = await prisma.botConversation.create({ data: { channel: "INSTAGRAM", subscriberId: `spam-mute-${randomUUID()}`, messages: [] }, select: { id: true } });
    try {
      await recordCustomerSpamTurn(conversation.id, { eventKey: "e1" });
      expect((await readCustomerSpamMute(conversation.id)).turns).toHaveLength(1);
    } finally { await prisma.botConversation.delete({ where: { id: conversation.id } }); }
  });
});

describe("core: an empty file", () => {
  it("asks the business question once and not at all the second time", async () => {
    const first = fixture();
    expect(await runCustomerAgentTurn(first.frame, first.ports)).toMatchObject({ status: "ready", text: BUSINESS_QUESTION.ru, rounds: 0 });
    const second = fixture({ verifiedContext: context([{ role: "assistant", text: BUSINESS_QUESTION.ru }]) });
    expect(await runCustomerAgentTurn(second.frame, second.ports)).toMatchObject({ status: "held", reason: "attachment_question_repeat_no_reply" });
    expect(second.modelTurn).not.toHaveBeenCalled();
  });
  it("speaks Tajik in a Tajik dialogue", async () => {
    const f = fixture({ language: "tg" });
    expect(await runCustomerAgentTurn(f.frame, f.ports)).toMatchObject({ status: "ready", text: BUSINESS_QUESTION.tg });
  });
  it("does not stay silent after a different last assistant turn", async () => {
    const f = fixture({ verifiedContext: context([{ role: "assistant", text: BUSINESS_QUESTION.ru }, { role: "user", text: "квартира" }, { role: "assistant", text: "Какой район?" }]) });
    expect(await runCustomerAgentTurn(f.frame, f.ports)).toMatchObject({ status: "ready" });
  });
  it("a one-time photo asks for an ordinary one when an object is in focus or the customer sells", () => {
    const input = { kinds: ["ephemeral" as const] };
    expect(customerAgentAttachmentQuestion(input, "ru", false, true)).toBe(EPHEMERAL_PHOTO_LINE.ru);
    expect(customerAgentAttachmentQuestion(input, "tg", true)).toBe(EPHEMERAL_PHOTO_LINE.tg);
    expect(customerAgentAttachmentQuestion(input, "ru", false)).toBe(BUSINESS_QUESTION.ru);
  });
  it("a one-time photo of a seller gets the ordinary-photo request through the renderer, then silence", async () => {
    const seller = context([{ role: "user", text: "Хочу продать квартиру" }], { topic: "seller" });
    const first = fixture({ attachmentInput: { kinds: ["ephemeral"] }, verifiedContext: seller });
    expect(await runCustomerAgentTurn(first.frame, first.ports)).toMatchObject({ status: "ready", text: EPHEMERAL_PHOTO_LINE.ru });
    const again = fixture({ attachmentInput: { kinds: ["ephemeral"] },
      verifiedContext: context([{ role: "assistant", text: EPHEMERAL_PHOTO_LINE.ru }], { topic: "seller" }) });
    expect(await runCustomerAgentTurn(again.frame, again.ports)).toMatchObject({ status: "held", reason: "attachment_question_repeat_no_reply" });
  });
  it("a one-time photo with nothing in focus is the business question", async () => {
    const f = fixture({ attachmentInput: { kinds: ["ephemeral"] } });
    expect(await runCustomerAgentTurn(f.frame, f.ports)).toMatchObject({ status: "ready", text: BUSINESS_QUESTION.ru });
  });
});

describe("no template tells the customer that something failed to open", () => {
  const lang = ["ru", "tg"] as const;
  const render = (extra: Partial<Parameters<typeof renderCustomerAgentDecision>[0]>) => lang.map(language => renderCustomerAgentDecision({
    decision: { kind: "clarify", refs: [], social: "none", question: "property" }, evidence: [], inputText: "", language, requestedFacts: [],
    knownPhoneSource: "none", maxOutputChars: 2000, surface: "dm", ...extra }) ?? "");
  it("the new P7 templates never mention rent", () => {
    for (const line of [BUSINESS_QUESTION.ru, BUSINESS_QUESTION.tg, EPHEMERAL_PHOTO_LINE.ru, EPHEMERAL_PHOTO_LINE.tg]) expect(line).not.toMatch(/аренд|иҷора|ичора/iu);
  });
  it("fixed attachment, notice and renderer lines", () => {
    for (const line of [...customerAgentAttachmentLines(), ...customerAgentFixedLines()]) expect(line, line).not.toMatch(FAILURE_TALK);
  });
  it.each(["no_reference", "unsupported", "untrusted_origin", "not_found", "lookup_unavailable"] as const)("unresolved property: %s", reason => {
    const evidence = [{ ref: "e0", value: { kind: "property_unresolved", status: "missing", reason } }] as CustomerAgentEvidence[];
    for (const text of render({ decision: { kind: "clarify", refs: ["e0"], social: "none", question: "property" }, evidence, inputText: "https://other.example/x", requestedFacts: ["price"] })) {
      expect(text, text).not.toMatch(FAILURE_TALK);
      if (reason === "unsupported" || reason === "untrusted_origin") expect(text).not.toMatch(/ссылк|пайванд/iu);
    }
  });
  it("a foreign link gets the business question", () => {
    const evidence = [{ ref: "e0", value: { kind: "property_unresolved", status: "missing", reason: "untrusted_origin" } }] as CustomerAgentEvidence[];
    const [ru, tg] = render({ decision: { kind: "clarify", refs: ["e0"], social: "none", question: "property" }, evidence, inputText: "https://other.example/x", requestedFacts: ["price"] });
    expect(ru).toBe(BUSINESS_QUESTION.ru); expect(tg).toBe(BUSINESS_QUESTION.tg);
  });
  it("a partly read media set and an unintelligible voice", () => {
    const perception = { language: "unknown", transcript: "", subject: "not_visible", visible: [], readableText: "", speech: "unintelligible", incomplete: true } as const;
    const clarify = { kind: "clarify" as const, refs: [], social: "none" as const, question: "clarify_previous" as const };
    for (const text of render({ mediaPerception: perception, decision: clarify })) expect(text, text).not.toMatch(FAILURE_TALK);
    expect(render({ mediaPerception: perception, decision: clarify })).toEqual([BUSINESS_QUESTION.ru, BUSINESS_QUESTION.tg]);
    const partly = { ...perception, speech: "none", subject: "home_interior", visible: ["kitchen"] } as const;
    for (const text of render({ mediaPerception: partly, decision: { kind: "reply", refs: [], social: "none", question: "none" } })) expect(text, text).not.toMatch(FAILURE_TALK);
  });
});
