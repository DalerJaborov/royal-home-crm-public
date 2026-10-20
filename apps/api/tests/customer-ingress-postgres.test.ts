import { createHmac, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import { encryptSecret } from "../src/crypto.js";
import { persistVerifiedCustomerIngressBatch, consumeCustomerInboxTicket } from "../src/lib/customerIngressProducer.js";
import { captureAuthenticatedCustomerInput, inspectAuthenticatedCustomerInput, registerAuthenticatedMetaCustomerRequest,
  verifyAndRegisterMetaCustomerIssuer, recoverAuthenticatedCustomerInput, recoverCustomerPendingEnvelope,
  inspectRecoveredCustomerPendingEnvelope } from "../src/lib/customerIngressAuthority.js";
import { admitCustomerPropertyInput, verifyCustomerPropertyAdmission } from "../src/lib/customerPropertyAdmission.js";
import { recordScopedCustomerInput } from "../src/lib/customerQualifierLedger.js";
import { customerPropertyEventKey, customerPropertyScopeKey } from "../src/lib/customerPropertyScope.js";
import { createCustomerRolloutFixture } from "./helpers/customerRolloutFixture.js";

// Real PG/HMAC/parser/FINAL boundary. No model/provider calls. Child proof uses
// an empty cwd + explicit synthetic env, without this worker's WeakMaps.
const accountIds: string[] = [], ticketKeys: string[] = [], nativeIds: string[] = [], inquiryIds: string[] = [];
const syntheticMasterKey = '1'.repeat(64);
let settings: Awaited<ReturnType<typeof readSettings>>;
let rollout: Awaited<ReturnType<typeof createCustomerRolloutFixture>>;
function readSettings() { return prisma.settings.findUniqueOrThrow({ where: { id: "singleton" }, select: { botEnabled: true, metaEnabled: true, botInstagramEnabled: true } }); }
async function account() {
  const id = randomUUID(), externalId = `synthetic-inbox-${id}`, secret = `synthetic-secret-${id}`;
  await prisma.messengerAccount.create({ data: { id, externalId, channel: "INSTAGRAM", title: "Synthetic P11", enabled: true,
    token: encryptSecret(`synthetic-token-${id}`), appSecret: encryptSecret(secret) } });
  accountIds.push(id); return { id, externalId, secret };
}
function request(a: Awaited<ReturnType<typeof account>>, peer = `synthetic-peer-${randomUUID()}`, eventId = randomUUID(), text = "Нархшчансумай") {
  const rawBody = Buffer.from(JSON.stringify({ object: "instagram", entry: [{ id: a.externalId, messaging: [{ sender: { id: peer },
    recipient: { id: a.externalId }, timestamp: Date.now(), message: { mid: eventId, text } }] }] }));
  const req = { rawBody, get: (_name: string) => `sha256=${createHmac("sha256", a.secret).update(rawBody).digest("hex")}` };
  registerAuthenticatedMetaCustomerRequest(req); return { req, peer, eventId, text, a };
}
async function pending(f: ReturnType<typeof request>) {
  await rollout.allowDm({ peer: f.peer, accountId: f.a.id, accountExternalId: f.a.externalId });
  const result = await persistVerifiedCustomerIngressBatch(f.req);
  expect(result.status).toBe("persisted"); if (result.status !== "persisted") throw new Error("Pending intake failed");
  ticketKeys.push(...result.tickets.map(t => t.eventKey));
  await prisma.backgroundJob.updateMany({ where: { dedupeKey: { in: result.tickets.map(t => `customer-inbox-consume:${t.eventKey}`) } }, data: { runAt: new Date("2099-01-01") } });
  return result.tickets[0];
}
async function final(f: ReturnType<typeof request>) {
  const persisted = await pending(f);
  expect(await verifyAndRegisterMetaCustomerIssuer(f.req, { channel: "INSTAGRAM", accountId: f.a.id, accountExternalId: f.a.externalId })).toBe(true);
  const input = captureAuthenticatedCustomerInput(f.req, { channel: "INSTAGRAM", peer: f.peer, accountExternalId: f.a.externalId,
    eventKind: "message", eventId: f.eventId, inputText: f.text });
  if (!input) throw new Error("Actual issuer frame missing");
  const admitted = await admitCustomerPropertyInput({ channel: "INSTAGRAM", peer: f.peer, accountId: f.a.id, accountExternalId: f.a.externalId,
    eventKind: "message", eventId: f.eventId, evidence: [], authenticatedInput: input });
  expect(admitted.status).toBe("admitted"); if (admitted.status !== "admitted") throw new Error(`FINAL intake denied: ${admitted.reason}`);
  nativeIds.push(admitted.ticket.conversationId);
  const inquiry = await prisma.customerInquiry.findUniqueOrThrow({ where: { conversationId: admitted.ticket.conversationId } }); inquiryIds.push(inquiry.id);
  expect(await recordScopedCustomerInput({ channel: "INSTAGRAM", subscriberId: f.peer }, input, admitted.ticket)).toBe(true);
  return { ...f, input, ticket: admitted.ticket, persisted };
}
async function childRecovery(eventKey: string) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "rh-inbox-recovery-"));
  try {
    const require = createRequire(import.meta.url), authorityUrl = new URL("../src/lib/customerIngressAuthority.ts", import.meta.url).href;
    const dbUrl = new URL("../src/db.ts", import.meta.url).href;
    const code = `globalThis.fetch=()=>{throw new Error('synthetic network forbidden')};
      const a=await import(${JSON.stringify(authorityUrl)}),d=await import(${JSON.stringify(dbUrl)});
      try { const p=await a.recoverCustomerPendingEnvelope(${JSON.stringify(eventKey)}),r=await a.recoverAuthenticatedCustomerInput(${JSON.stringify(eventKey)});
      console.log(JSON.stringify({pending:p.status,final:r.status,brand:r.status==='recovered'&&!!a.inspectAuthenticatedCustomerInput(r.input)})); }
      finally { await d.prisma.$disconnect(); }`;
    const { stdout } = await promisify(execFile)(process.execPath, ["--max-old-space-size=384", "--import", pathToFileURL(require.resolve("tsx")).href,
      "--input-type=module", "--eval", code], { cwd: directory, timeout: 30_000, maxBuffer: 32_000, windowsHide: true,
      env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, TEMP: process.env.TEMP, TMP: process.env.TMP,
        NODE_ENV: "test", TEST_ENV_PIN: "1", DATABASE_URL: process.env.DATABASE_URL, SETTINGS_ENCRYPTION_KEY: syntheticMasterKey,
        JWT_ACCESS_SECRET: "synthetic-p11-child-access-secret-32characters", JWT_REFRESH_SECRET: "synthetic-p11-child-refresh-secret-32characters" } });
    return JSON.parse(stdout.trim());
  } finally { await rm(directory, { recursive: true, force: true }); }
}
beforeAll(async () => {
  // The parent and the restarted child must encrypt/decrypt with the same
  // synthetic key. Depending on a developer/CI key makes recovery fail before
  // the durable-ingress behavior is exercised.
  vi.stubEnv('SETTINGS_ENCRYPTION_KEY', syntheticMasterKey);
  settings = await readSettings(); rollout = await createCustomerRolloutFixture();
  await prisma.settings.update({ where: { id: "singleton" }, data: { botEnabled: true, metaEnabled: true, botInstagramEnabled: true } });
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Synthetic P11 forbids provider HTTP"); }));
});
afterAll(async () => {
  vi.unstubAllEnvs();
  expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals();
  await prisma.backgroundJob.deleteMany({ where: { dedupeKey: { in: [...new Set(ticketKeys)].map(k => `customer-inbox-consume:${k}`) } } });
  await prisma.customerPropertyIngressTicket.deleteMany({ where: { eventKey: { in: ticketKeys } } });
  await prisma.customerInquiry.deleteMany({ where: { id: { in: inquiryIds } } });
  await prisma.botConversation.deleteMany({ where: { id: { in: nativeIds } } });
  await prisma.customerEndpointScope.deleteMany({ where: { messengerAccountId: { in: accountIds } } });
  await prisma.messengerAccount.deleteMany({ where: { id: { in: accountIds } } });
  if (settings) await prisma.settings.update({ where: { id: "singleton" }, data: settings });
  if (rollout) await rollout.restore();
});
describe("durable ingress evidence without synthetic authority", () => {
  it("commits pending+required job once, no native/FINAL, and recovers pending in a fresh process", async () => {
    const f = request(await account()), first = await pending(f), row = await prisma.customerPropertyIngressTicket.findUniqueOrThrow({ where: { eventKey: first.eventKey } });
    expect(row).toMatchObject({ conversationId: null, originalConversationId: null, originCiphertext: null, processingState: "RECEIVED" });
    expect(await prisma.botConversation.count({ where: { accountId: f.a.id, subscriberId: f.peer } })).toBe(0);
    expect(await pending(f)).toMatchObject({ eventKey: first.eventKey, order: first.order, fresh: false });
    expect((await prisma.customerPropertyIngressTicket.findUniqueOrThrow({ where: { eventKey: first.eventKey } })).receivedAt).toEqual(row.receivedAt);
    expect(await prisma.backgroundJob.count({ where: { dedupeKey: `customer-inbox-consume:${first.eventKey}` } })).toBe(1);
    const recovered = await recoverCustomerPendingEnvelope(first.eventKey); expect(recovered.status).toBe("pending");
    if (recovered.status === "pending") {
      expect(inspectRecoveredCustomerPendingEnvelope(recovered.envelope)?.payload.inputText).toBe(f.text);
      expect(inspectAuthenticatedCustomerInput(recovered.envelope)).toBeNull();
    }
    expect(await childRecovery(first.eventKey)).toEqual({ pending: "pending", final: "held", brand: false });
    expect(await consumeCustomerInboxTicket(first.eventKey)).toEqual({ status: "held", reason: "own_identity_registry_incomplete" });
    expect(await prisma.customerPropertyIngressTicket.findUniqueOrThrow({where:{eventKey:first.eventKey}})).toMatchObject({originCiphertext:null,inputRecordedAt:null});
  });
  it("actual canonical FINAL+input append recovers branded input after a real process restart", async () => {
    const f = await final(request(await account()));
    expect(await childRecovery(f.ticket.eventKey)).toEqual({ pending: "pending", final: "recovered", brand: true });
    const recovered = await recoverAuthenticatedCustomerInput(f.ticket.eventKey); expect(recovered.status).toBe("recovered");
    if (recovered.status === "recovered") expect(inspectAuthenticatedCustomerInput(recovered.input)).toMatchObject({ inputText: f.text, assurance: "protected_namespace" });
    expect(await recoverAuthenticatedCustomerInput("0".repeat(64))).toMatchObject({ status: "held" });
  });
  it("raw A is persisted even when parsed body attempts to substitute B", async () => {
    const f = request(await account()); Object.assign(f.req, { body: { text: "forged B", messageId: "forged-B" } });
    const t = await pending(f), recovered = await recoverCustomerPendingEnvelope(t.eventKey);
    expect(recovered.status).toBe("pending");
    if (recovered.status === "pending") expect(inspectRecoveredCustomerPendingEnvelope(recovered.envelope)?.payload).toMatchObject({ inputText: f.text, eventId: f.eventId });
  });
  it("new accepted IN invalidates original FINAL without adopting its new fence", async () => {
    const a = await account(), first = await final(request(a)), next = await final(request(a, first.peer));
    expect(await recoverAuthenticatedCustomerInput(first.ticket.eventKey)).toMatchObject({ status: "held" });
    expect(await recoverAuthenticatedCustomerInput(next.ticket.eventKey)).toMatchObject({ status: "recovered" });
  });
  it("credential A→B→A cannot restore an original grant", async () => {
    const f = await final(request(await account())), old = await prisma.messengerAccount.findUniqueOrThrow({ where: { id: f.a.id }, select: { appSecret: true } });
    await prisma.messengerAccount.update({ where: { id: f.a.id }, data: { appSecret: encryptSecret("synthetic-rotated-key") } });
    await prisma.messengerAccount.update({ where: { id: f.a.id }, data: { appSecret: old.appSecret } });
    expect(await recoverCustomerPendingEnvelope(f.ticket.eventKey)).toMatchObject({ status: "held" });
    expect(await recoverAuthenticatedCustomerInput(f.ticket.eventKey)).toMatchObject({ status: "held" });
  });
  it("deleted native leaves immutable tombstone and replay cannot recreate it", async () => {
    const f = await final(request(await account())); await prisma.botConversation.delete({ where: { id: f.ticket.conversationId } });
    expect(await verifyCustomerPropertyAdmission(f.ticket)).toMatchObject({ status: "denied", reason: "retry_ticket_missing" });
    expect(await recoverAuthenticatedCustomerInput(f.ticket.eventKey)).toMatchObject({ status: "held" });
    expect(await admitCustomerPropertyInput({ channel: "INSTAGRAM", peer: f.peer, accountId: f.a.id, accountExternalId: f.a.externalId,
      eventKind: "message", eventId: f.eventId, evidence: [] })).toMatchObject({ status: "denied", reason: "retry_ticket_missing" });
    expect(await prisma.botConversation.count({ where: { accountId: f.a.id, subscriberId: f.peer } })).toBe(0);
  });
  it("required job insertion failure rolls back captured ticket", async () => {
    const f = request(await account()), endpoint = await rollout.allowDm({ peer: f.peer, accountId: f.a.id, accountExternalId: f.a.externalId });
    const scopeKey = customerPropertyScopeKey("INSTAGRAM", f.peer, f.a.id, endpoint.endpointScopeId), eventKey = customerPropertyEventKey(scopeKey, "message", f.eventId);
    ticketKeys.push(eventKey);
    await prisma.backgroundJob.create({ data: { type: "customer-inbox-consume", payload: { version: 1, eventKey }, maxAttempts: 5,
      dedupeKey: `customer-inbox-consume:${eventKey}`, runAt: new Date("2099-01-01") } });
    expect(await persistVerifiedCustomerIngressBatch(f.req)).toMatchObject({ status: "unavailable" });
    expect(await prisma.customerPropertyIngressTicket.findUnique({ where: { eventKey } })).toBeNull();
    expect(await prisma.botConversation.count({ where: { accountId: f.a.id, subscriberId: f.peer } })).toBe(0);
  });
});
