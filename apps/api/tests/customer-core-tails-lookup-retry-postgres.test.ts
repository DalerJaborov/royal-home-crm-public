import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, afterEach, describe, expect, it, vi } from "vitest";
import type { CustomerPropertyAdmission, CustomerPropertyEvidence } from "@royal-home/shared";
// Explicit DATABASE_URL supplied by the stand runner; do not load local keys.
vi.mock("../src/loadEnv.js", () => ({}));
vi.mock("../src/lib/systemError.js", async importOriginal => ({ ...(await importOriginal<typeof import("../src/lib/systemError.js")>()), logSystemError: vi.fn() }));
import { prisma } from "../src/db.js";
import { admitCustomerPropertyInput } from "../src/lib/customerPropertyAdmission.js";
import { readCustomerPropertyFocus } from "../src/lib/customerPropertyFocus.js";
import { customerPropertyRegistry } from "../src/lib/customerPropertyRegistry.js";
import { resolveCustomerPropertyTurnContext } from "../src/lib/customerPropertyTurnContext.js";
import { customerPropertyUnresolvedReason } from "../src/lib/customerPropertyUnresolvedReason.js";

const tag = `g2-${randomUUID()}`;
const peers: string[] = [];
const accountIds: string[] = [];
const ticketKeys = new Set<string>();
let externalId: string;
const link: CustomerPropertyEvidence[] = [{ kind: "url", origin: "message", reference: "https://royalhome.tj/listing/12" }];
const PROPERTY = randomUUID();
function peer(): string { const value = `${tag}-${peers.length}`; peers.push(value); return value; }
async function admit(target: string, id: string, refs: CustomerPropertyEvidence[]): Promise<CustomerPropertyAdmission> {
  const result = await admitCustomerPropertyInput({ channel: "INSTAGRAM", peer: target, accountExternalId: externalId, eventKind: "message", eventId: id, evidence: refs });
  if (result.status !== "admitted") throw new Error(`Admission denied: ${result.reason}`);
  ticketKeys.add(result.ticket.eventKey);
  return result.ticket;
}
const turn = (ticket: CustomerPropertyAdmission) => resolveCustomerPropertyTurnContext({ status: "admitted", ticket }, [ticket]);

beforeAll(async () => {
  externalId = `${tag}-account`;
  const account = await prisma.messengerAccount.create({ data: { channel: "INSTAGRAM", externalId, title: tag, token: "fictional-token-never-used" } });
  accountIds.push(account.id);
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  const scopes = await prisma.customerEndpointScope.findMany({ where: { messengerAccountId: { in: accountIds } }, select: { id: true } });
  const scopeIds = scopes.map(scope => scope.id);
  await prisma.customerPropertyIngressTicket.deleteMany({ where: { OR: [{ eventKey: { in: [...ticketKeys] } }, { endpointScopeId: { in: scopeIds } }] } });
  await prisma.botConversation.deleteMany({ where: { subscriberId: { in: peers }, channel: "INSTAGRAM" } });
  await prisma.customerInquiry.deleteMany({ where: { endpointScopeId: { in: scopeIds } } });
  await prisma.customerEndpointScope.deleteMany({ where: { id: { in: scopeIds } } });
  await prisma.messengerAccount.deleteMany({ where: { id: { in: accountIds } } });
  await prisma.$disconnect();
});

describe("G2 a failed link read is retried on the next inbound turn without a new link", () => {
  it("turn 1: read fails; turn 2 (no link): object found", async () => {
    const target = peer();
    const url = vi.spyOn(customerPropertyRegistry, "url").mockRejectedValue(new Error("db down"));
    const a = await admit(target, "A", link);
    const first = await turn(a);
    expect(first?.snapshot.focus).toMatchObject({ status: "missing", lookupAttempts: 1 });
    expect(customerPropertyUnresolvedReason(first!.snapshot.focus.evidence, "missing", first!.snapshot.focus.lookupAttempts)).toBe("lookup_unavailable");
    expect(url).toHaveBeenCalledTimes(2); // the in-turn immediate retry

    url.mockReset(); url.mockResolvedValue([PROPERTY]);
    const b = await admit(target, "B", []); // an ordinary message: no new link
    const second = await turn(b);
    expect(second?.snapshot.focus).toMatchObject({ status: "resolved", propertyId: PROPERTY, eventKey: a.eventKey });
    expect(second?.snapshot.focus.lookupAttempts).toBeUndefined();
    expect(url).toHaveBeenCalledTimes(1);
    expect((await readCustomerPropertyFocus(b))?.focus).toMatchObject({ status: "resolved", propertyId: PROPERTY });
  });

  it("gives up after two attempts: the third turn does not read again", async () => {
    const target = peer();
    const url = vi.spyOn(customerPropertyRegistry, "url").mockRejectedValue(new Error("db down"));
    const a = await admit(target, "A", link);
    await turn(a);
    const second = await turn(await admit(target, "B", []));
    expect(second?.snapshot.focus).toMatchObject({ status: "missing", lookupAttempts: 2 });
    url.mockClear(); url.mockResolvedValue([PROPERTY]);
    const third = await turn(await admit(target, "C", []));
    expect(third?.snapshot.focus).toMatchObject({ status: "missing", lookupAttempts: 2 });
    expect(url).not.toHaveBeenCalled();
  });

  it("a definite «not found» is never retried, and a new link starts afresh", async () => {
    const target = peer();
    const url = vi.spyOn(customerPropertyRegistry, "url").mockResolvedValue([]);
    const a = await admit(target, "A", link);
    expect((await turn(a))?.snapshot.focus).toMatchObject({ status: "missing" });
    expect(url).toHaveBeenCalledTimes(1);
    const second = await turn(await admit(target, "B", []));
    expect(second?.snapshot.focus.status).toBe("missing");
    expect(second?.snapshot.focus.lookupAttempts).toBeUndefined();
    expect(url).toHaveBeenCalledTimes(1);
  });

  it("a new link after a failure replaces the retry state", async () => {
    const target = peer();
    const url = vi.spyOn(customerPropertyRegistry, "url").mockRejectedValue(new Error("db down"));
    await turn(await admit(target, "A", link));
    url.mockReset(); url.mockResolvedValue([PROPERTY]);
    const fresh = await admit(target, "B", [{ kind: "url", origin: "message", reference: "https://royalhome.tj/listing/13" }]);
    const context = await turn(fresh);
    expect(context?.snapshot.focus).toMatchObject({ status: "resolved", propertyId: PROPERTY, eventKey: fresh.eventKey });
    expect(context?.snapshot.focus.lookupAttempts).toBeUndefined();
  });

  it("two simultaneous turns re-read once (compare-and-set on the focus revision)", async () => {
    const target = peer();
    const url = vi.spyOn(customerPropertyRegistry, "url").mockRejectedValue(new Error("db down"));
    await turn(await admit(target, "A", link));
    url.mockReset(); url.mockResolvedValue([PROPERTY]);
    const [b, c] = [await admit(target, "B", []), await admit(target, "C", [])];
    await Promise.all([turn(b), turn(c)]);
    expect(url.mock.calls.length).toBeLessThanOrEqual(1);
    expect((await readCustomerPropertyFocus(c))?.focus.status).toMatch(/resolved|missing|pending/);
  });
});
