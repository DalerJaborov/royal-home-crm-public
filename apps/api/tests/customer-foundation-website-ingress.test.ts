import { beforeEach, describe, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ order: [] as string[], propertyOn: false,
  admission: vi.fn(), turn: vi.fn(), inbound: vi.fn() }));
vi.mock("../src/db.js", async importOriginal => {
  const original = await importOriginal<typeof import("../src/db.js")>();
  return { ...original, prisma: { $disconnect: () => original.prisma.$disconnect() } };
});
vi.mock("../src/lib/customerPropertyContextFlag.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/lib/customerPropertyContextFlag.js")>()), customerPropertyContextEnabled: () => f.propertyOn }));
vi.mock("../src/lib/customerPropertyAdmission.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/lib/customerPropertyAdmission.js")>()), admitCustomerPropertyInput: f.admission }));
vi.mock("../src/lib/outboundShield.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/lib/outboundShield.js")>()), noteRealInbound: f.inbound }));
vi.mock("../src/messengers/conversation.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/messengers/conversation.js")>()), processMessengerTurn: f.turn }));
vi.mock("../src/messengers/sharedMedia.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/messengers/sharedMedia.js")>()), recordPageInterest: vi.fn(async () => null),
  sharedMediaHint: vi.fn(async () => ""), describeProperty: vi.fn() }));
vi.mock("../src/lib/resolvePropertyFromPageUrl.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/lib/resolvePropertyFromPageUrl.js")>()), resolvePropertyFromPageUrl: vi.fn(async () => null) }));
vi.mock("../src/ai/inboundScreen.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/ai/inboundScreen.js")>()), screenIncomingText: () => ({ action: "allow" }) }));
import { handleWebsiteChatTurn, recordWebsiteChatMessageOnly } from "../src/messengers/websiteChat.js";
const admitted = { status: "admitted", fresh: true, ticket: { eventKey: "a".repeat(64), order: "1", scopeKey: "b".repeat(64),
  conversationId: "00000000-0000-4000-8000-000000000001", accountId: null, channel: "WEBSITE", evidence: [] } };

describe("actual Website adapter foundation admission wiring independent of property rollout", () => {
  beforeEach(() => {
    f.propertyOn = false; f.order.length = 0; vi.clearAllMocks();
    f.inbound.mockImplementation(async () => { f.order.push("shield-undo"); });
    f.admission.mockImplementation(async (input: { eventId?: string }) => { f.order.push("foundation-admission");
      return input.eventId ? admitted : { status: "denied", reason: "missing_identity" }; });
    f.turn.mockResolvedValue({ reply: "", ready: false, accepted: false, shouldReply: false });
  });
  it("property OFF still registers the foundation turn after shield undo, with no property focus/evidence", async () => {
    await handleWebsiteChatTurn({ sessionId: "fixture-session-123456", messageId: "fixture-stable-mid", text: "Здравствуйте" });
    expect(f.order).toEqual(["shield-undo", "foundation-admission"]);
    expect(f.admission).toHaveBeenCalledWith(expect.objectContaining({ channel: "WEBSITE", peer: "fixture-session-123456",
      eventId: "fixture-stable-mid", evidence: [], deferFocusUntilClassification: true }));
    expect(f.turn).toHaveBeenCalledWith(expect.objectContaining({ customerPropertyAdmission: admitted }));
  });
  it("a legacy widget without MID continues its legacy turn without inventing durable identity", async () => {
    await handleWebsiteChatTurn({ sessionId: "fixture-session-123456", text: "Здравствуйте" });
    expect(f.admission).toHaveBeenCalledWith(expect.objectContaining({ eventId: undefined, authenticatedInput: undefined }));
    expect(f.turn).toHaveBeenCalledTimes(1);
    expect(f.turn.mock.calls[0][0].messageId).toBeUndefined();
  });
  it("carries the exact internal frame and stable MID through the normal and bot-off staff-ledger paths", async () => {
    const authenticatedInput = Object.freeze({}) as never;
    const input = { sessionId: "fixture-session-123456", messageId: "fixture-stable-mid", text: "Здравствуйте", authenticatedInput };
    await handleWebsiteChatTurn(input);
    expect(f.turn).toHaveBeenLastCalledWith(expect.objectContaining({ customerAuthenticatedInput: authenticatedInput, messageId: input.messageId }));
    await recordWebsiteChatMessageOnly(input);
    expect(f.turn).toHaveBeenLastCalledWith(expect.objectContaining({ customerAuthenticatedInput: authenticatedInput,
      messageId: input.messageId, customerPropertyAdmission: admitted, silent: true }));
    expect(f.admission).toHaveBeenCalledTimes(2);
  });
});
