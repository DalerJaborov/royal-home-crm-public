import { beforeEach, describe, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ verify: vi.fn(), admit: vi.fn(), history: vi.fn(), scope: vi.fn(), focus: vi.fn() }));
vi.mock("../src/db.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/db.js")>();
  return { ...original, prisma: { botConversation: { findUnique: f.history }, $disconnect: () => original.prisma.$disconnect() } };
});
vi.mock("../src/lib/customerPropertyContextFlag.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/lib/customerPropertyContextFlag.js")>()), customerPropertyContextEnabled: () => false }));
vi.mock("../src/lib/customerPropertyAdmission.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/lib/customerPropertyAdmission.js")>()), verifyCustomerPropertyAdmission: f.verify,
  admitCustomerPropertyInput: f.admit, customerPropertyInputAlreadyManaged: vi.fn() }));
vi.mock("../src/lib/customerConversationScope.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/lib/customerConversationScope.js")>()), findScopedBotConversation: f.scope }));
vi.mock("../src/lib/customerPropertyFocus.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/lib/customerPropertyFocus.js")>()), completeCustomerPropertyFocus: f.focus,
  persistCustomerPropertyBatchEvidence: f.focus, readCustomerPropertyFocus: f.focus }));
vi.mock("../src/lib/customerPropertyRegistry.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/lib/customerPropertyRegistry.js")>()), customerPropertyRegistry: {} }));
vi.mock("../src/lib/customerPropertyResolver.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/lib/customerPropertyResolver.js")>()), resolveCustomerPropertyEvidence: vi.fn() }));
vi.mock("../src/lib/customerPropertyFacts.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/lib/customerPropertyFacts.js")>()), readCustomerPropertyFacts: vi.fn() }));
vi.mock("../src/lib/botTurnTrace.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/lib/botTurnTrace.js")>()), traceCustomerPropertyResolution: vi.fn() }));
import { prepareCustomerPropertyAdmission } from "../src/lib/customerPropertyTurnContext.js";
import { customerPropertyAdmissionSchema } from "@royal-home/shared";
const ticket = customerPropertyAdmissionSchema.parse({ eventKey: "a".repeat(64), scopeKey: "b".repeat(64), order: "17",
  conversationId: "00000000-0000-4000-8000-000000000001", endpointScopeId: "00000000-0000-4000-8000-000000000002",
  accountId: null, channel: "WEBSITE", evidence: [] });
const admitted = { status: "admitted" as const, ticket };
const input = { channel: "WEBSITE", subscriberId: "fixture-session-123456", text: "Здравствуйте" };
describe("foundation original ticket survives property OFF without resolver effects", () => {
  beforeEach(() => { vi.clearAllMocks(); f.verify.mockResolvedValue(admitted); f.scope.mockResolvedValue({ id: ticket.conversationId });
    f.history.mockResolvedValue({ messages: [{ role: "user", content: input.text, customerPropertyAdmission: ticket }] }); });
  it("retains a provided original admission for history/debounce, never allocates or touches focus", async () => {
    expect(await prepareCustomerPropertyAdmission({ ...input, customerPropertyAdmission: admitted })).toEqual({ admission: admitted, batch: [admitted] });
    expect(f.verify).toHaveBeenCalledWith(ticket); expect(f.admit).not.toHaveBeenCalled(); expect(f.focus).not.toHaveBeenCalled();
  });
  it("restores an original durable ticket on retry while property is OFF", async () => {
    expect(await prepareCustomerPropertyAdmission({ ...input, skipSaveIncoming: true })).toEqual({ admission: admitted, batch: [admitted] });
    expect(f.verify).toHaveBeenCalledWith(ticket); expect(f.admit).not.toHaveBeenCalled(); expect(f.focus).not.toHaveBeenCalled();
  });
  it("already-managed retry remains fenced rather than allocating a new legacy answer", async () => {
    f.verify.mockResolvedValue({ status: "denied", reason: "already_managed" });
    expect((await prepareCustomerPropertyAdmission({ ...input, skipSaveIncoming: true })).admission).toEqual({ status: "denied", reason: "already_managed" });
    expect(f.admit).not.toHaveBeenCalled();
  });
  it("missing MID and fresh direct legacy call do not invent a foundation order", async () => {
    expect(await prepareCustomerPropertyAdmission({ ...input, customerPropertyAdmission: { status: "denied", reason: "missing_identity" } })).toEqual({ admission: undefined, batch: [] });
    expect(await prepareCustomerPropertyAdmission(input)).toEqual({ admission: undefined, batch: [] });
    expect(f.verify).not.toHaveBeenCalled(); expect(f.admit).not.toHaveBeenCalled(); expect(f.focus).not.toHaveBeenCalled();
  });
});
