import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CustomerPropertyAdmission, CustomerPropertyEvidence } from "@royal-home/shared";
// Explicit DATABASE_URL supplied by the stand runner; do not load local keys.
vi.mock("../src/loadEnv.js", () => ({}));
import { prisma } from "../src/db.js";
import { admitCustomerPropertyInput, verifyCustomerPropertyAdmission } from "../src/lib/customerPropertyAdmission.js";
import { readCustomerPropertyFocus, completeCustomerPropertyFocus, persistCustomerPropertyBatchEvidence } from "../src/lib/customerPropertyFocus.js";
import { customerPropertyRegistry } from "../src/lib/customerPropertyRegistry.js";
import { readCustomerPropertyFacts } from "../src/lib/customerPropertyFacts.js";

const tag = `p03-${randomUUID()}`;
const peers: string[] = [];
const propertyIds: string[] = [];
const accountIds: string[] = [];
const ticketKeys = new Set<string>();
let externalId: string;
const evidence = (id: string): CustomerPropertyEvidence[] => [{ kind: "media", origin: "shared_media", reference: id }];
function peer(): string { const value = `${tag}-${peers.length}`; peers.push(value); return value; }
async function admit(target: string, id: string, refs = evidence(id)): Promise<CustomerPropertyAdmission> {
  const result = await admitCustomerPropertyInput({ channel: "INSTAGRAM", peer: target, accountExternalId: externalId, eventKind: "message", eventId: id, evidence: refs });
  expect(result.status).toBe("admitted");
  if (result.status !== "admitted") throw new Error(`Admission denied: ${result.reason}`);
  ticketKeys.add(result.ticket.eventKey);
  return result.ticket;
}
beforeAll(async () => {
  const url = new URL(process.env.DATABASE_URL ?? "");
  if (process.env.CUSTOMER_CONTEXT_TEST_DATABASE) {
    expect(url.hostname).toBe("localhost"); expect(url.port).toBe("15500");
    expect(url.pathname).toBe(`/${process.env.CUSTOMER_CONTEXT_TEST_DATABASE}`);
  }
  const [current] = await prisma.$queryRaw<{ name: string }[]>`SELECT current_database() AS name`;
  expect(current.name).toBe(url.pathname.slice(1));
  externalId = `${tag}-account`;
  const account = await prisma.messengerAccount.create({ data: { channel: "INSTAGRAM", externalId, title: tag, token: "fictional-token-never-used" } });
  accountIds.push(account.id);
});
afterAll(async () => {
  // P11 retains tombstones rather than cascading tickets with native deletion.
  // These UUID-account scopes and collected event keys are fixture-owned only.
  const scopes = await prisma.customerEndpointScope.findMany({ where: { messengerAccountId: { in: accountIds } }, select: { id: true } });
  const scopeIds = scopes.map(scope => scope.id);
  await prisma.customerPropertyIngressTicket.deleteMany({ where: { OR: [{ eventKey: { in: [...ticketKeys] } }, { endpointScopeId: { in: scopeIds } }] } });
  await prisma.botConversation.deleteMany({ where: { subscriberId: { in: peers }, channel: "INSTAGRAM" } });
  await prisma.customerInquiry.deleteMany({ where: { endpointScopeId: { in: scopeIds } } });
  await prisma.customerEndpointScope.deleteMany({ where: { id: { in: scopeIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.messengerAccount.deleteMany({ where: { id: { in: accountIds } } });
  await prisma.$disconnect();
});

describe("customer property PostgreSQL admission/focus fences", () => {
  it("duplicates preserve the immutable order and cannot reopen completed focus", async () => {
    const target = peer(); const a = await admit(target, "A");
    const pending = await readCustomerPropertyFocus(a); expect(pending?.focus.status).toBe("pending");
    const id = randomUUID();
    expect(await completeCustomerPropertyFocus(a, pending!, { status: "resolved", propertyId: id, candidates: [id], reason: "unique", provenance: a.evidence })).toBe(true);
    const duplicate = await admit(target, "A");
    expect(duplicate.order).toBe(a.order); expect(duplicate.eventKey).toBe(a.eventKey);
    expect((await readCustomerPropertyFocus(a))?.focus).toMatchObject({ status: "resolved", propertyId: id, generation: pending!.focus.generation });
  });
  it("late completion A cannot adopt pending B even when supplied snapshot B explicitly", async () => {
    const target = peer(); const a = await admit(target, "A"); const old = await readCustomerPropertyFocus(a);
    const b = await admit(target, "B"); const latest = await readCustomerPropertyFocus(a);
    expect(BigInt(b.order)).toBeGreaterThan(BigInt(a.order));
    expect(latest?.focus.eventKey).toBe(b.eventKey);
    const id = randomUUID(); const resolution = { status: "resolved" as const, propertyId: id, candidates: [id], reason: "unique" as const, provenance: a.evidence };
    expect(await completeCustomerPropertyFocus(a, old!, resolution)).toBe(false);
    expect(await completeCustomerPropertyFocus(a, latest!, resolution)).toBe(false);
    expect(await persistCustomerPropertyBatchEvidence(a, latest!, a.evidence)).toBeNull();
    expect((await readCustomerPropertyFocus(b))?.focus.status).toBe("pending");
  });
  it("A paused after order allocation cannot register over completed B", async () => {
    const target = peer();
    let unblock!: () => void; let allocated!: () => void;
    const gate = new Promise<void>((resolve) => { unblock = resolve; });
    const observed = new Promise<void>((resolve) => { allocated = resolve; });
    const original = prisma.$transaction.bind(prisma);
    let pauseOnce = true;
    const spy = vi.spyOn(prisma, "$transaction").mockImplementation(((fn: (tx: unknown) => Promise<unknown>, options: unknown) =>
      original(async (tx) => fn(new Proxy(tx, { get(object, key) {
        const value = Reflect.get(object, key);
        if (key !== "$queryRaw") return typeof value === "function" ? value.bind(object) : value;
        return async (...args: unknown[]) => {
          const result = await value.apply(object, args);
          if (pauseOnce && Array.isArray(args[0]) && args[0].join("").includes("nextval")) {
            pauseOnce = false; allocated(); await gate;
          }
          return result;
        };
      } })), options as never)) as typeof prisma.$transaction);
    const aPromise = admit(target, "paused-A");
    try {
      await observed;
      const b = await admit(target, "B"); const snapshot = await readCustomerPropertyFocus(b); const id = randomUUID();
      expect(await completeCustomerPropertyFocus(b, snapshot!, { status: "resolved", propertyId: id, candidates: [id], reason: "unique", provenance: b.evidence })).toBe(true);
      unblock(); const a = await aPromise;
      expect(BigInt(a.order)).toBeLessThan(BigInt(b.order));
      expect((await readCustomerPropertyFocus(a))?.focus).toMatchObject({ eventKey: b.eventKey, status: "resolved", propertyId: id });
    } finally { unblock(); await aPromise; spy.mockRestore(); }
  });
  it("a current account rebind rejects old ticket verification/read/completion", async () => {
    const target = peer(); const a = await admit(target, "A"); const snapshot = await readCustomerPropertyFocus(a);
    const other = await prisma.messengerAccount.create({ data: { channel: "INSTAGRAM", externalId: `${tag}-rebind`, title: tag, token: "fictional-token-never-used" } }); accountIds.push(other.id);
    await prisma.botConversation.update({ where: { id: a.conversationId }, data: { accountId: other.id } });
    expect(await verifyCustomerPropertyAdmission(a)).toEqual({ status: "denied", reason: "account_mismatch" });
    expect(await readCustomerPropertyFocus(a)).toBeNull();
    const id = randomUUID();
    expect(await completeCustomerPropertyFocus(a, snapshot!, { status: "resolved", propertyId: id, candidates: [id], reason: "unique", provenance: a.evidence })).toBe(false);
  });
  it("debounce conflicts persist before lookup and ordinary file/text inputs preserve focus", async () => {
    const target = peer(); const a = await admit(target, "A"); const b = await admit(target, "B");
    const snapshot = await readCustomerPropertyFocus(b);
    expect(await persistCustomerPropertyBatchEvidence(b, snapshot!, [...a.evidence, ...b.evidence])).not.toBeNull();
    const staleProperty = randomUUID();
    expect(await completeCustomerPropertyFocus(b, snapshot!, { status: "resolved", propertyId: staleProperty, candidates: [staleProperty], reason: "unique", provenance: b.evidence })).toBe(false);
    const reloaded = await readCustomerPropertyFocus(b); expect(reloaded?.focus.evidence).toEqual([...a.evidence, ...b.evidence]);
    expect(await completeCustomerPropertyFocus(b, reloaded!, { status: "ambiguous", propertyId: null, candidates: [], reason: "conflict", provenance: reloaded!.focus.evidence })).toBe(true);
    const c = await admit(target, "C", []);
    expect((await readCustomerPropertyFocus(c))?.focus).toMatchObject({ status: "ambiguous", propertyId: null, eventKey: b.eventKey });
  });
  it("known retry is lookup-only and cannot resurrect a deleted conversation epoch", async () => {
    const target = peer(); const a = await admit(target, "A");
    expect((await verifyCustomerPropertyAdmission(a)).status).toBe("admitted");
    await prisma.botConversation.delete({ where: { id: a.conversationId } });
    expect(await verifyCustomerPropertyAdmission(a)).toEqual({ status: "denied", reason: "retry_ticket_missing" });
    expect(await prisma.botConversation.count({ where: { subscriberId: target } })).toBe(0);
    expect(await prisma.customerPropertyIngressTicket.findUniqueOrThrow({ where: { eventKey: a.eventKey } })).toMatchObject({
      conversationId: null, originalConversationId: a.conversationId, tombstonedAt: expect.any(Date), order: BigInt(a.order), scopeKey: a.scopeKey,
    });
  });
  it("account mismatch cannot overwrite a pre-existing conversation binding", async () => {
    // This is the Gate-A compatibility collision oracle. A different file's
    // ACTIVE/scoped policy must not turn it into a Phase-B/old-index probe.
    const policy = await prisma.customerRuntimePolicy.findUniqueOrThrow({ where: { id: "singleton" }, select: { contractVersion: true } });
    await prisma.customerRuntimePolicy.update({ where: { id: "singleton" }, data: { contractVersion: "compat" } });
    try {
      const target = peer(); const a = await admit(target, "A");
      const other = await prisma.messengerAccount.create({ data: { channel: "INSTAGRAM", externalId: `${tag}-other`, title: tag, token: "fictional-token-never-used" } }); accountIds.push(other.id);
      const attempt = await admitCustomerPropertyInput({ channel: "INSTAGRAM", peer: target, accountId: other.id, eventKind: "message", eventId: "B", evidence: evidence("B") });
      expect(attempt).toEqual({ status: "denied", reason: "account_mismatch" });
      expect((await prisma.botConversation.findUniqueOrThrow({ where: { id: a.conversationId } })).accountId).toBe(a.accountId);
    } finally { await prisma.customerRuntimePolicy.update({ where: { id: "singleton" }, data: policy }); }
  });
  it("concurrent admissions share one minimal conversation; highest admitted order wins", async () => {
    const target = peer();
    const original = prisma.$transaction.bind(prisma);
    const errors: unknown[] = [];
    const spy = vi.spyOn(prisma, "$transaction").mockImplementation(((...args: unknown[]) => (original as (...args: unknown[]) => Promise<unknown>)(...args).catch((error) => {
      errors.push({ code: error.code, name: error.name, meta: error.meta }); throw error;
    })) as typeof prisma.$transaction);
    let admissions: Awaited<ReturnType<typeof admitCustomerPropertyInput>>[];
    try {
      admissions = await Promise.all(Array.from({ length: 10 }, (_, n) => admitCustomerPropertyInput({ channel: "INSTAGRAM", peer: target, accountExternalId: externalId, eventKind: "message", eventId: `event-${n}`, evidence: evidence(`media-${n}`) })));
    } finally { spy.mockRestore(); }
    expect(admissions.map((result) => result.status), JSON.stringify(errors)).toEqual(Array(10).fill("admitted"));
    const accepted = admissions.flatMap((result) => result.status === "admitted" ? [result.ticket] : []);
    expect(accepted.length).toBeGreaterThan(0);
    expect(new Set(accepted.map((item) => item.conversationId)).size).toBe(1);
    const latest = accepted.reduce((a, b) => BigInt(a.order) > BigInt(b.order) ? a : b);
    expect((await readCustomerPropertyFocus(latest))?.focus.eventKey).toBe(latest.eventKey);
    expect(await prisma.botConversation.count({ where: { subscriberId: target } })).toBe(1);
  });
  it("missing stable identity does not allocate a conversation/ticket", async () => {
    const target = peer();
    expect(await admitCustomerPropertyInput({ channel: "INSTAGRAM", peer: target, accountExternalId: externalId, eventKind: "message", evidence: evidence("A") })).toEqual({ status: "denied", reason: "missing_identity" });
    expect(await prisma.botConversation.count({ where: { subscriberId: target } })).toBe(0);
  });
  it("bare media tail collision stays ambiguous while qualified full ID remains exact", async () => {
    const tail = `${Date.now()}${Math.floor(Math.random() * 10000)}`;
    const create = async (publishedPostIds: Record<string, string>) => {
      const row = await prisma.property.create({ data: { title: tag, type: "APARTMENT", areaSqm: 100, price: 100_000_000, currency: "USD", status: "AVAILABLE", condition: "GOOD", publishedChannels: ["FACEBOOK"], publishedPostIds } });
      propertyIds.push(row.id); return row;
    };
    const a = await create({ FACEBOOK: `111_${tail}` }); const b = await create({ FACEBOOK_POST: tail });
    expect((await customerPropertyRegistry.media(tail)).sort()).toEqual([a.id, b.id].sort());
    expect(await customerPropertyRegistry.media(`111_${tail}`)).toEqual([a.id]);
    const facts = await readCustomerPropertyFacts(a.id, "INSTAGRAM");
    expect(facts).toMatchObject({ price: "100000000", currency: "USD", builder: null, addressPolicy: "district_city_only" });
    await prisma.property.update({ where: { id: a.id }, data: { offSite: true } });
    expect(await readCustomerPropertyFacts(a.id, "INSTAGRAM")).toBeNull();
  });
});
