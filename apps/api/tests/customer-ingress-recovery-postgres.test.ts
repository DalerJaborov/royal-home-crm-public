import { createHmac, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import { encryptSecret } from "../src/crypto.js";
import { createCustomerRolloutFixture } from "./helpers/customerRolloutFixture.js";
import { verifySignature, resetMetaAccountCredsCache } from "../src/messengers/meta.js";
import { registerAuthenticatedMetaCustomerRequest, inspectAuthenticatedCustomerInput, recoverCustomerPendingEnvelope,
  classifyRecoveredCustomerPendingInput } from "../src/lib/customerIngressAuthority.js";
import { persistVerifiedCustomerIngressBatch } from "../src/lib/customerIngressProducer.js";
import { recoverAndFinalizeCustomerInboxInput } from "../src/lib/customerIngressRecovery.js";
import { ensureScopedBotConversation } from "../src/lib/customerConversationScope.js";
import * as normalizer from "../src/lib/customerIngressNormalize.js";

// Real HMAC + HTTP raw bytes + producer + PG + current canonical accept. The
// isolated HTTP adapter stops at the actual pre-ACK producer boundary, modelling
// process loss BEFORE live classification; it is not the whole webhooks router.
// Meta username GET is the only stubbed transport; no model/paid/physical OUT.
const ownedAccounts: string[] = [];
let a: { id: string; externalId: string; secret: string; token: string; username: string };
let settings: Awaited<ReturnType<typeof readSettings>>;
let rollout: Awaited<ReturnType<typeof createCustomerRolloutFixture>>;
function readSettings() { return prisma.settings.findUniqueOrThrow({ where: { id: "singleton" }, select: { botEnabled: true, metaEnabled: true, botInstagramEnabled: true } }); }
async function account() {
  const id = randomUUID(), externalId = `synthetic-recovery-${id}`, secret = `synthetic-recovery-secret-${id}`, token = `synthetic-recovery-token-${id}`;
  const username = `own_${id.replace(/-/g, "").slice(0, 12)}`;
  await prisma.messengerAccount.create({ data: { id, externalId, channel: "INSTAGRAM", title: "Synthetic recovery", username,
    enabled: true, token: encryptSecret(token), appSecret: encryptSecret(secret) } });
  ownedAccounts.push(id); resetMetaAccountCredsCache(); return { id, externalId, secret, token, username };
}
const http = express();
http.use(express.raw({ type: "application/json", limit: "2mb" }));
http.post("/", async (req, res, next) => {
  try {
    if (!await verifySignature(req.body, req.get("x-hub-signature-256"))) { res.sendStatus(403); return; }
    const verified = Object.assign(req, { rawBody: req.body as Buffer });
    registerAuthenticatedMetaCustomerRequest(verified);
    const result = await persistVerifiedCustomerIngressBatch(verified);
    res.status(result.status === "persisted" ? 200 : result.status === "denied" ? 403 : 503).json(result);
  } catch (error) { next(error); }
});
function frame(text = "Нарх?", extra: Record<string, unknown> = {}, owner = a, peer = `synthetic-peer-${randomUUID()}`) {
  const eventId = `synthetic-mid-${randomUUID()}`;
  const body = { object: "instagram", entry: [{ id: owner.externalId, messaging: [{ sender: { id: peer }, recipient: { id: owner.externalId },
    timestamp: Date.now(), message: { mid: eventId, text, ...extra } }] }] };
  return { body, peer, eventId, owner };
}
async function send(f: ReturnType<typeof frame>, signingKey = f.owner.secret) {
  const raw = JSON.stringify(f.body), signature = createHmac("sha256", signingKey).update(raw).digest("hex");
  return request(http).post("/").set("Content-Type", "application/json").set("x-hub-signature-256", `sha256=${signature}`).send(raw);
}
async function pending(f: ReturnType<typeof frame>) {
  await rollout.allowDm({ peer: f.peer, accountId: f.owner.id, accountExternalId: f.owner.externalId });
  const response = await send(f); expect(response.status).toBe(200);
  const result = response.body; expect(result.status).toBe("persisted");
  const eventKey: string = result.tickets[0].eventKey;
  await prisma.backgroundJob.updateMany({ where: { dedupeKey: `customer-inbox-consume:${eventKey}` }, data: { runAt: new Date("2099-01-01") } });
  return prisma.customerPropertyIngressTicket.findUniqueOrThrow({ where: { eventKey } });
}
let profileStatus = 200, profileUsername = "synthetic_customer";
let duringRead: (() => Promise<void>) | undefined;
const fakeGet = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
  const target = new URL(String(url)), peer = decodeURIComponent(target.pathname.split("/").at(-1)!);
  if (target.origin !== "https://graph.instagram.com" || !target.pathname.startsWith("/v23.0/synthetic-peer-") ||
      target.search !== "?fields=username" || init?.method !== "GET" || (init.headers as Record<string, string>)?.Authorization !== `Bearer ${a.token}`) {
    throw new Error("Unexpected synthetic profile transport");
  }
  if (duringRead) await duringRead();
  return new Response(JSON.stringify({ id: peer, username: profileUsername }), { status: profileStatus });
});
async function childFinalize(eventKey: string, peer: string) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "rh-pending-final-recovery-"));
  try {
    const require = createRequire(import.meta.url), recovery = new URL("../src/lib/customerIngressRecovery.ts", import.meta.url).href;
    const authority = new URL("../src/lib/customerIngressAuthority.ts", import.meta.url).href, db = new URL("../src/db.ts", import.meta.url).href;
    const code = `let reads=0;globalThis.fetch=async(url,init)=>{
      const u=new URL(String(url));if(u.origin!=='https://graph.instagram.com'||u.pathname!==${JSON.stringify(`/v23.0/${peer}`)}||u.search!=='?fields=username'||init.method!=='GET'||init.headers.Authorization!==${JSON.stringify(`Bearer ${a.token}`)})throw new Error('unexpected synthetic I/O');
      reads++;return new Response(JSON.stringify({id:${JSON.stringify(peer)},username:'synthetic_customer'}));};
      const r=await import(${JSON.stringify(recovery)}),a=await import(${JSON.stringify(authority)}),d=await import(${JSON.stringify(db)});
      try{const value=await r.recoverAndFinalizeCustomerInboxInput(${JSON.stringify(eventKey)});
        const e=value.status==='finalized'?a.inspectAuthenticatedCustomerInput(value.input):null;
        console.log(JSON.stringify({status:value.status,reason:value.reason,reads,brand:!!e,order:value.ticket?.order,issuedAt:e?.issuedAt,assurance:e?.assurance}));}
      finally{await d.prisma.$disconnect();}`;
    const { stdout } = await promisify(execFile)(process.execPath, ["--max-old-space-size=384", "--import", pathToFileURL(require.resolve("tsx")).href,
      "--input-type=module", "--eval", code], { cwd: directory, timeout: 30_000, maxBuffer: 32_000, windowsHide: true,
      env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, TEMP: process.env.TEMP, TMP: process.env.TMP,
        NODE_ENV: "test", TEST_ENV_PIN: "1", DATABASE_URL: process.env.DATABASE_URL, SETTINGS_ENCRYPTION_KEY: "1".repeat(64),
        IG_PROXY_URL: "", GEMINI_PROXY_URL: "", JWT_ACCESS_SECRET: "synthetic-recovery-child-access-secret-32characters",
        JWT_REFRESH_SECRET: "synthetic-recovery-child-refresh-secret-32characters" } });
    return JSON.parse(stdout.trim());
  } finally { await rm(directory, { recursive: true, force: true }); }
}
beforeAll(async () => {
  settings = await readSettings();
  rollout = await createCustomerRolloutFixture();
  await prisma.settings.update({ where: { id: "singleton" }, data: { botEnabled: true, metaEnabled: true, botInstagramEnabled: true } });
  a = await account();
});
beforeEach(() => {
  profileStatus = 200; profileUsername = "synthetic_customer"; duringRead = undefined; fakeGet.mockClear();
  vi.stubGlobal("fetch", fakeGet); vi.stubEnv("IG_PROXY_URL", ""); vi.stubEnv("GEMINI_PROXY_URL", "");
  vi.stubEnv("BOT_PROPERTY_CONTEXT_ENABLED", "0");
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
afterAll(async () => {
  try {
    if (!ownedAccounts.length) return;
    const scopes = await prisma.customerEndpointScope.findMany({ where: { messengerAccountId: { in: ownedAccounts } }, select: { id: true } });
    const scopeIds = scopes.map(row => row.id);
    const tickets = await prisma.customerPropertyIngressTicket.findMany({ where: { endpointScopeId: { in: scopeIds } }, select: { eventKey: true } });
    await prisma.backgroundJob.deleteMany({ where: { dedupeKey: { in: tickets.map(row => `customer-inbox-consume:${row.eventKey}`) } } });
    await prisma.customerPropertyIngressTicket.deleteMany({ where: { endpointScopeId: { in: scopeIds } } });
    await prisma.customerInquiry.deleteMany({ where: { endpointScopeId: { in: scopeIds } } });
    await prisma.botConversation.deleteMany({ where: { accountId: { in: ownedAccounts } } });
    await prisma.customerEndpointScope.deleteMany({ where: { id: { in: scopeIds } } });
    await prisma.messengerAccount.deleteMany({ where: { id: { in: ownedAccounts } } });
  } finally {
    if (settings) await prisma.settings.update({ where: { id: "singleton" }, data: settings });
    if (rollout) await rollout.restore();
    resetMetaAccountCredsCache();
  }
});

describe("genuine pending → FINAL across process loss", () => {
  it("rejects actual invalid HTTP signature and another own-key target without any observation/grant", async () => {
    const f = frame(); expect((await send(f, "synthetic-wrong-key")).status).toBe(403);
    const b = await account(), other = frame("Нарх?", {}, b);
    expect((await send(other, a.secret)).status).toBe(403);
    expect(await prisma.customerPropertyIngressTicket.count({ where: { endpointScope: { messengerAccountId: b.id } } })).toBe(0);
    expect(fakeGet).not.toHaveBeenCalled();
  });
  it("fresh child can classify pending by real bounded GET and commit SAME order/age/assurance FINAL", async () => {
    const f = frame(), row = await pending(f);
    expect(row).toMatchObject({ conversationId: null, originalConversationId: null, originCiphertext: null });
    expect(await childFinalize(row.eventKey, f.peer)).toEqual({ status: "finalized", reads: 1, brand: true,
      order: row.order.toString(), issuedAt: row.receivedAt.getTime(), assurance: "protected_namespace" });
    const final = await prisma.customerPropertyIngressTicket.findUniqueOrThrow({ where: { eventKey: row.eventKey } });
    expect(final.order).toBe(row.order); expect(final.receivedAt).toEqual(row.receivedAt); expect(final.originCapturedAt).toEqual(row.receivedAt);
    expect(final.senderObservationVersion).toBe(1); expect(final.senderObservationCiphertext).not.toContain("synthetic_customer");
    expect(final.originalConversationId).toBeTruthy(); expect(final.originalConversationId).toBe(final.conversationId);
    expect(await childFinalize(row.eventKey, f.peer)).toMatchObject({ status: "finalized", reads: 0, brand: true, order: row.order.toString() });
  });
  it("profile unavailable is held without a native, FINAL, model or artificial not-own flag", async () => {
    const f = frame(), row = await pending(f); profileStatus = 404;
    expect(await recoverAndFinalizeCustomerInboxInput(row.eventKey)).toMatchObject({ status: "held" });
    expect(await prisma.customerPropertyIngressTicket.findUniqueOrThrow({ where: { eventKey: row.eventKey } })).toMatchObject({ conversationId: null, originCiphertext: null, senderObservationCiphertext: null });
    expect(fakeGet).toHaveBeenCalledTimes(1);
  });
  it("a second fresh process can use the persisted attestation after crash BEFORE FINAL, with no new GET/age", async () => {
    const f = frame(), row = await pending(f), recovered = await recoverCustomerPendingEnvelope(row.eventKey);
    expect(recovered.status).toBe("pending"); if (recovered.status !== "pending") throw new Error("Actual pending proof required");
    const classified = await classifyRecoveredCustomerPendingInput(recovered.envelope);
    expect(classified.status).toBe("classified"); if (classified.status !== "classified") throw new Error("Actual classifier required");
    expect(inspectAuthenticatedCustomerInput(classified.input)?.acceptedFence).toBeUndefined();
    const before = await prisma.customerPropertyIngressTicket.findUniqueOrThrow({ where: { eventKey: row.eventKey } });
    expect(before).toMatchObject({ conversationId: null, originCiphertext: null, senderObservationVersion: 1 });
    expect(await childFinalize(row.eventKey, f.peer)).toMatchObject({ status: "finalized", reads: 0, brand: true,
      order: row.order.toString(), issuedAt: row.receivedAt.getTime() });
    const after = await prisma.customerPropertyIngressTicket.findUniqueOrThrow({ where: { eventKey: row.eventKey } });
    expect(after.senderObservationCiphertext).toBe(before.senderObservationCiphertext); expect(after.senderObservedAt).toEqual(before.senderObservedAt);
  });
  it("attested own Instagram username is ignored, not silently promoted", async () => {
    const row = await pending(frame()); profileUsername = a.username;
    expect(await recoverAndFinalizeCustomerInboxInput(row.eventKey)).toEqual({ status: "ignored", reason: "own_account" });
    expect(await prisma.customerPropertyIngressTicket.findUniqueOrThrow({ where: { eventKey: row.eventKey } })).toMatchObject({ conversationId: null, originCiphertext: null });
  });
  it("actual raw template attachment is captured and ignored without GET", async () => {
    const row = await pending(frame("", { attachments: [{ type: "template", payload: {} }] }));
    expect(await recoverAndFinalizeCustomerInboxInput(row.eventKey)).toEqual({ status: "ignored", reason: "bare_template" }); expect(fakeGet).not.toHaveBeenCalled();
  });
  it("known exact scoped assistant MID stays outgoing without profile I/O", async () => {
    const f = frame(), row = await pending(f);
    const native = await prisma.$transaction(tx => ensureScopedBotConversation(tx, { channel: "INSTAGRAM", subscriberId: f.peer, accountExternalId: a.externalId }));
    await prisma.botConversation.update({ where: { id: native.id }, data: { messages: [{ role: "assistant", by: { kind: "agent" }, content: "Synthetic staff OUT", mid: f.eventId, at: new Date(row.receivedAt.getTime() - 1000).toISOString() }] } });
    expect(await recoverAndFinalizeCustomerInboxInput(row.eventKey)).toEqual({ status: "ignored", reason: "outgoing_mid" }); expect(fakeGet).not.toHaveBeenCalled();
    expect((await prisma.customerPropertyIngressTicket.findUniqueOrThrow({ where: { eventKey: row.eventKey } })).originCiphertext).toBeNull();
  });
  it("credential rotation DURING actual GET cannot mint FINAL or store a refreshed observation", async () => {
    const row = await pending(frame());
    const before = await prisma.messengerAccount.findUniqueOrThrow({ where: { id: a.id }, select: { appSecret: true } });
    duringRead = async () => { await prisma.messengerAccount.update({ where: { id: a.id }, data: { appSecret: encryptSecret("synthetic-rotation-during-get") } }); };
    try {
      expect(await recoverAndFinalizeCustomerInboxInput(row.eventKey)).toMatchObject({ status: "held" });
      expect(await prisma.customerPropertyIngressTicket.findUniqueOrThrow({ where: { eventKey: row.eventKey } })).toMatchObject({ conversationId: null, originCiphertext: null, senderObservationCiphertext: null });
    } finally { await prisma.messengerAccount.update({ where: { id: a.id }, data: before }); resetMetaAccountCredsCache(); }
  });
  it("old metadata-free immutable payload redelivers normally but is never silently upgraded", async () => {
    const f = frame(), actualNormalize = normalizer.normalizeAuthenticatedCustomerIngress;
    const spy = vi.spyOn(normalizer, "normalizeAuthenticatedCustomerIngress").mockImplementation(input => {
      const result = actualNormalize(input);
      for (const entry of result.entries) delete entry.observations.classifier; // actual older-version producer shape
      return result;
    });
    let first: Awaited<ReturnType<typeof pending>>;
    try { first = await pending(f); } finally { spy.mockRestore(); }
    const second = await pending(f);
    expect(second.order).toBe(first.order); expect(second.receivedAt).toEqual(first.receivedAt);
    expect(second.payloadCiphertext).toBe(first.payloadCiphertext); expect(second.payloadHash).toBe(first.payloadHash);
    expect(await recoverAndFinalizeCustomerInboxInput(first.eventKey)).toEqual({ status: "held", reason: "old_classification_unavailable" });
    expect(fakeGet).not.toHaveBeenCalled();
  });
  it("original proof expires without a GET, native creation or renewed issue time", async () => {
    const row = await pending(frame()), clock = vi.spyOn(Date, "now").mockReturnValue(row.receivedAt.getTime() + 15 * 60_000 + 1);
    try { expect(await recoverAndFinalizeCustomerInboxInput(row.eventKey)).toMatchObject({ status: "held" }); }
    finally { clock.mockRestore(); }
    expect(fakeGet).not.toHaveBeenCalled();
    expect(await prisma.customerPropertyIngressTicket.findUniqueOrThrow({ where: { eventKey: row.eventKey } })).toMatchObject({ conversationId: null, originCiphertext: null, senderObservedAt: null });
  });
  it("late original A cannot adopt newer accepted B after its real profile read was paused", async () => {
    const fA = frame(), rowA = await pending(fA);
    let entered!: () => void, release!: () => void, firstRead = true;
    const inside = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    duringRead = async () => { if (firstRead) { firstRead = false; entered(); await gate; } };
    const completingA = recoverAndFinalizeCustomerInboxInput(rowA.eventKey);
    let barrierTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([inside, completingA.then(result => {
        throw new Error(`Actual profile barrier not reached: ${result.status}${"reason" in result ? `/${result.reason}` : ""}`);
      }), new Promise<never>((_resolve, reject) => {
        barrierTimer = setTimeout(() => reject(new Error("Actual profile barrier did not start within 5s")), 5000);
      })]);
      clearTimeout(barrierTimer);
      const fB = frame("Адрес?", {}, a, fA.peer), rowB = await pending(fB), resultB = await recoverAndFinalizeCustomerInboxInput(rowB.eventKey);
      expect(resultB.status).toBe("finalized"); if (resultB.status !== "finalized") throw new Error("Actual newer FINAL required");
      const before = await prisma.customerInquiry.findUniqueOrThrow({ where: { conversationId: resultB.ticket.conversationId } });
      release(); expect(await completingA).toMatchObject({ status: "held" });
      const after = await prisma.customerInquiry.findUniqueOrThrow({ where: { id: before.id } });
      expect(after.lastAcceptedEventKey).toBe(rowB.eventKey); expect(after.lastAcceptedOrder).toBe(rowB.order);
      expect(after.stateRevision).toBe(before.stateRevision); expect(after.ownershipEpoch).toBe(before.ownershipEpoch);
      expect((await prisma.customerPropertyIngressTicket.findUniqueOrThrow({ where: { eventKey: rowA.eventKey } })).originCiphertext).toBeNull();
    } finally { clearTimeout(barrierTimer); release(); await completingA; }
  });
  it("a forged JSON pending object cannot become an input brand", async () => {
    const f = frame(), row = await pending(f), pendingProof = await recoverCustomerPendingEnvelope(row.eventKey);
    expect(pendingProof.status).toBe("pending");
    expect(await classifyRecoveredCustomerPendingInput({} as Parameters<typeof classifyRecoveredCustomerPendingInput>[0])).toMatchObject({ status: "held" });
    expect(fakeGet).not.toHaveBeenCalled();
  });
  it("deleted original native/tombstone cannot be recreated by pending recovery", async () => {
    const f = frame(), row = await pending(f), first = await recoverAndFinalizeCustomerInboxInput(row.eventKey);
    expect(first.status).toBe("finalized"); if (first.status !== "finalized") throw new Error("Genuine fixture FINAL required");
    expect(inspectAuthenticatedCustomerInput(first.input)?.issuedAt).toBe(row.receivedAt.getTime());
    await prisma.botConversation.delete({ where: { id: first.ticket.conversationId } }); fakeGet.mockClear();
    expect(await recoverAndFinalizeCustomerInboxInput(row.eventKey)).toMatchObject({ status: "held" });
    expect(await prisma.botConversation.count({ where: { accountId: a.id, subscriberId: f.peer } })).toBe(0); expect(fakeGet).not.toHaveBeenCalled();
  });
});
