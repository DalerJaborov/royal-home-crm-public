import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ScopedCustomerQualifierLane } from "../src/lib/customerQualifierContext.js";
import type { MessengerTurnInput } from "../src/messengers/conversation.js";
// Invocation tests with explicit fake provider/business seams. Not a signature,
// PG transaction or channel-delivery proof; those use the normal integration gates.
const f = vi.hoisted(() => ({ model: vi.fn(), refresh: vi.fn(), record: vi.fn(), append: vi.fn(), budgetRead: vi.fn(), pinRead: vi.fn(), spend: vi.fn(),
  budget: vi.fn(), filter: vi.fn(), shield: vi.fn() }));
vi.mock("../src/db.js", async importOriginal => {
  const original = await importOriginal<typeof import("../src/db.js")>();
  return { ...original, prisma: { botConversation: { findUnique: f.budgetRead },
    customerPropertyIngressTicket: { findUnique: f.pinRead },
    $disconnect: () => original.prisma.$disconnect() } };
});
vi.mock("../src/ai/leadQualifier.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/ai/leadQualifier.js")>()), runQualifyTurn: f.model }));
vi.mock("../src/ai/topicLock.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/ai/topicLock.js")>()), EMPTY_TOPIC_STATE: { topic: null, topicLabel: null, openQuestion: null, offTopicTurns: 0 } }));
vi.mock("../src/lib/aiDailyBudget.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/lib/aiDailyBudget.js")>()), aiDailyBudgetOf: f.budget, spendAiTurns: f.spend }));
vi.mock("../src/lib/customerQualifierContext.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/lib/customerQualifierContext.js")>()), refreshCustomerQualifierProjection: f.refresh }));
vi.mock("../src/lib/customerQualifierLedger.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/lib/customerQualifierLedger.js")>()), recordScopedCustomerInput: f.record, appendScopedCustomerReply: f.append }));
vi.mock("../src/lib/outboundShield.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/lib/outboundShield.js")>()), repeatBlockedTexts: f.shield }));
vi.mock("../src/messengers/replyChain.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/messengers/replyChain.js")>()), finalizeBotReply: f.filter,
  inClientLanguage: (text: { ru: string }, _input: string) => text.ru }));
import { processScopedCustomerQualifierTurn } from "../src/messengers/customerQualifierTurn.js";

const frame = Object.freeze({ fixture: "runtime frame seam" });
const principal = Object.freeze({ scope: { accountId: "account-A" }, authority: { fence: { inquiryId: "inquiry-A" } },
  knownContact: { clientId: "PRIVATE-INTERNAL-CLIENT-ID", contactProfileId: "PRIVATE-INTERNAL-PROFILE-ID" } });
function lane(): ScopedCustomerQualifierLane {
  return { mode: "scoped", principal, authenticatedInput: frame,
    ticket: { conversationId: "native-A", eventKey: "event-A", order: "10" },
    context: { mode: "scoped_customer", history: [{ role: "user", content: "Сколько стоит квартира?" }],
      draft: { stage: "chatting" }, knownPhoneSource: "none" }, publicState: { topic: "buyer" } } as unknown as ScopedCustomerQualifierLane;
}
function input(): MessengerTurnInput {
  return { channel: "INSTAGRAM", subscriberId: "peer-A", text: "RAW-ENRICHED-PRIVATE-OLD-TEXT", name: "PRIVATE-OLD-NAME",
    turnHint: "PRIVATE-OLD-HINT", adTopic: "job", messageId: "mid-A" };
}
beforeEach(() => {
  vi.clearAllMocks();
  f.refresh.mockImplementation(async value => ({ status: "current", context: value.context }));
  f.record.mockResolvedValue(true); f.append.mockResolvedValue(true);
  f.pinRead.mockResolvedValue({ intakeAgentRevisionId: null });
  f.budgetRead.mockResolvedValue({ id: "native-A", aiTurnsToday: 0 }); f.budget.mockReturnValue({ turnsLeft: 10, dayKey: "2026-10-15" });
  f.spend.mockResolvedValue(undefined); f.model.mockResolvedValue({ reply: ["Цена 400 000 USD. Какой район нужен?"], ready: false, lead: {} });
  f.filter.mockImplementation(async value => ({ bubbles: value.reply })); f.shield.mockResolvedValue([]);
});

describe("early scoped read-only qualifier invocation", () => {
  it("does not run a model without durable input persistence", async () => {
    f.record.mockResolvedValue(false);
    expect((await processScopedCustomerQualifierTurn(input(), lane())).shouldReply).toBe(false);
    expect(f.model).not.toHaveBeenCalled(); expect(f.append).not.toHaveBeenCalled();
  });
  it("records a silent input without a model, effects or reaction permission", async () => {
    const result = await processScopedCustomerQualifierTurn({ ...input(), silent: true }, lane());
    expect(f.record).toHaveBeenCalledTimes(1); expect(f.model).not.toHaveBeenCalled(); expect(result.silenced).toBe("held");
  });
  it("leaves a durably core-selected input to its worker without an inline model or reply", async () => {
    f.pinRead.mockResolvedValue({ intakeAgentRevisionId: "original-core-revision" });
    const result = await processScopedCustomerQualifierTurn(input(), lane());
    expect(result.shouldReply).toBe(false); expect(result.silenced).toBe("held");
    expect(f.pinRead).toHaveBeenCalledWith({ where: { eventKey: "event-A" }, select: { intakeAgentRevisionId: true } });
    expect(f.model).not.toHaveBeenCalled(); expect(f.spend).not.toHaveBeenCalled();
    expect(f.refresh).not.toHaveBeenCalled(); expect(f.filter).not.toHaveBeenCalled(); expect(f.append).not.toHaveBeenCalled();
  });
  it("passes only the approved current-IN projection and no inherited name/hint/scenario/profile", async () => {
    const value = lane(); const result = await processScopedCustomerQualifierTurn(input(), value);
    const [history, draft, options] = f.model.mock.calls[0];
    expect(history).toEqual(value.context.history); expect(draft).toEqual({ stage: "chatting" });
    expect(options).toMatchObject({ customerContext: value.context, contactProfile: null, phoneKnown: false,
      abilities: { callback: false, showings: false, askOwner: false, vacancies: false } });
    expect(options.name).toBeUndefined(); expect(options.scenarioId).toBeUndefined(); expect(options.showcase).toBeUndefined();
    expect(JSON.stringify([history, draft, options])).not.toContain("PRIVATE");
    expect(result.customerReplyPrincipal).toBe(principal); expect(result.accepted).toBe(false);
    expect(Object.keys(result)).not.toContain("customerReplyPrincipal");
    const serialized = JSON.stringify(result);
    expect(serialized).toContain("400 000 USD"); expect(serialized).not.toContain("customerReplyPrincipal");
    expect(serialized).not.toContain("PRIVATE-INTERNAL");
    expect(Object.getOwnPropertyDescriptor(result, "customerReplyPrincipal")).toMatchObject({ enumerable: false, writable: false, configurable: false });
  });
  it("holds ownership/rebind changes while the model awaits", async () => {
    f.model.mockImplementation(async () => { f.refresh.mockResolvedValue({ status: "held", reason: "changed" });
      return { reply: ["Ответ"], ready: false, lead: {} }; });
    expect((await processScopedCustomerQualifierTurn(input(), lane())).shouldReply).toBe(false);
    expect(f.filter).not.toHaveBeenCalled(); expect(f.append).not.toHaveBeenCalled();
  });
  it("holds a revocation during filtering and never appends old OUT", async () => {
    f.filter.mockImplementation(async value => { f.refresh.mockResolvedValue({ status: "held", reason: "revoked" }); return { bubbles: value.reply }; });
    expect((await processScopedCustomerQualifierTurn(input(), lane())).shouldReply).toBe(false); expect(f.append).not.toHaveBeenCalled();
  });
  it.each(["callbackRequest", "askOwner", "jobApplication", "showPropertyNumber", "sendGuide", "showing"])("does not acknowledge a blocked %s action as executed", async field => {
    f.model.mockResolvedValue({ reply: ["Уже записал, отправил и оформил"], ready: false, lead: {}, [field]: true });
    const result = await processScopedCustomerQualifierTurn(input(), lane());
    expect(result.reply).toBe("Запрос пока не оформлен."); expect(result.accepted).toBe(false); expect(result.ready).toBe(false);
    expect(f.filter.mock.calls[0][0].reply).toEqual(["Запрос пока не оформлен."]);
    expect(f.filter.mock.calls[0][1].regenerate).toBeUndefined();
  });
  it("a ready request-stage preserves its useful answer without granting a legacy effect", async () => {
    f.model.mockResolvedValue({ reply: ["Цена 400 000 USD. Какой район нужен?"], ready: true, lead: {} });
    const result = await processScopedCustomerQualifierTurn(input(), lane());
    expect(result.reply).toContain("400 000 USD"); expect(result.reply).toContain("Какой район нужен?");
    expect(result.ready).toBe(false); expect(result.accepted).toBe(false);
    expect(f.filter.mock.calls[0][0].reply).not.toEqual(["Запрос пока не оформлен."]);
  });
  it.each(["current_input", "scoped_contact"])("uses a freshly validated %s availability for prompt and final no-reask", async source => {
    f.refresh.mockImplementation(async value => ({ status: "current", context: { ...value.context, knownPhoneSource: source } }));
    await processScopedCustomerQualifierTurn(input(), lane());
    expect(f.model.mock.calls[0][2].phoneKnown).toBe(true); expect(f.filter.mock.calls[0][0].phoneKnown).toBe(true);
  });
  it("does not schedule a legacy retry or invent a receipt for invalid/null model output", async () => {
    f.model.mockResolvedValue(null); const result = await processScopedCustomerQualifierTurn(input(), lane());
    expect(result.aiUnavailable).toBe(true); expect(result.shouldReply).toBe(false); expect(f.append).not.toHaveBeenCalled();
  });
  it("preserves a paid-turn ceiling and holds empty unbound media interpretations", async () => {
    f.budget.mockReturnValue({ turnsLeft: 0, dayKey: "2026-10-15" });
    expect((await processScopedCustomerQualifierTurn(input(), lane())).shouldReply).toBe(false);
    const original = lane(); const media = { ...original, context: { ...original.context, history: [{ role: "user" as const, content: "" }] } };
    expect((await processScopedCustomerQualifierTurn(input(), media)).shouldReply).toBe(false); expect(f.model).not.toHaveBeenCalled();
  });
  it("returns no customer OUT when the final atomic ledger fence refuses", async () => {
    f.append.mockResolvedValue(false);
    expect((await processScopedCustomerQualifierTurn(input(), lane())).shouldReply).toBe(false);
  });
});
