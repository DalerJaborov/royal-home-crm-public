// One WhatsApp chat per OUR number (owner 26.11.2026: "один бот, одно ядро отвечает всем везде"). A WhatsApp peer IS a
// phone number, so the person who already writes to Royal Home writes to Arvan with the same subscriberId. Each number
// gets its own chat: the bot answers it from that number and under that brand, the client card sees both. Real DB.
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { encryptSecret } from "../src/crypto.js";
import type { CustomerAgentEnrollmentSubject } from "@royal-home/shared";
import { enrollCustomerAgentSubjectTx } from "../src/lib/customerAgentEnrollment.js";
import { CustomerScopeDenied, ensureCustomerEndpoint, ensureScopedBotConversation, loadCustomerTransportForConversation,
  peerChatsForScope, whatsappChatPerNumber, type ScopedCustomerEndpoint } from "../src/lib/customerConversationScope.js";
import { readCustomerLegacyCutoverReadiness } from "../src/lib/customerAgentLegacyCutover.js";
import { bindCustomerMetaSendCredentials } from "../src/lib/customerMetaTransport.js";
import { admitOutbound, noteRealInbound } from "../src/lib/outboundShield.js";
import { resetAccountsCache } from "../src/messengers/accounts.js";
import { resetMetaAccountCredsCache } from "../src/messengers/meta.js";

const runId = randomUUID().replaceAll("-", "").slice(0, 10);
const digits = runId.replace(/\D/g, "").padEnd(6, "7").slice(0, 6);
const accounts: string[] = [], scopes: string[] = [], natives: string[] = [], clients: string[] = [];
let peerSeq = 0;
const nextPeer = () => `99293${digits}${peerSeq++}`;

type Account = { id: string; externalId: string; token: string };
async function account(label: string, channel: "WHATSAPP" | "INSTAGRAM" = "WHATSAPP", brandName: string | null = null): Promise<Account> {
  const id = randomUUID(), externalId = `per-number-${label}-${runId}`, token = `synthetic-token-${label}-${id}`;
  await prisma.messengerAccount.create({ data: { id, externalId, channel, enabled: true, title: `Synthetic ${label}`, brandName,
    token: encryptSecret(token), ...(channel === "INSTAGRAM" ? { username: `synthetic_${label}_${runId}` } : {}) } });
  accounts.push(id); resetAccountsCache(); resetMetaAccountCredsCache();
  return { id, externalId, token };
}
async function chat(a: Account, peer: string, channel: "WHATSAPP" | "INSTAGRAM" = "WHATSAPP") {
  const row = await prisma.$transaction(tx => ensureScopedBotConversation(tx, { channel, subscriberId: peer, accountId: a.id, accountExternalId: a.externalId }));
  natives.push(row.id); scopes.push(row.transport.endpointScopeId);
  return row;
}
async function endpoint(a: Account, peer: string, channel: "WHATSAPP" | "INSTAGRAM" = "WHATSAPP") {
  const scoped = await prisma.$transaction(tx => ensureCustomerEndpoint(tx, { channel, subscriberId: peer, accountId: a.id, accountExternalId: a.externalId }));
  scopes.push(scoped.endpointScopeId);
  return scoped;
}
const subjectOf = (e: ScopedCustomerEndpoint, peer: string): CustomerAgentEnrollmentSubject => ({ surface: "dm", peer,
  endpoint: { endpointScopeId: e.endpointScopeId, scopeRevision: e.scopeRevision, channel: e.channel, accountId: e.accountId, transportKey: e.transportKey } });
const enroll = (s: CustomerAgentEnrollmentSubject) => prisma.$transaction(tx => enrollCustomerAgentSubjectTx(tx, s));
const chatsOf = (peer: string) => prisma.botConversation.findMany({ where: { channel: "WHATSAPP", subscriberId: peer },
  select: { id: true, accountId: true, endpointScopeId: true, clientId: true, account: { select: { brandName: true } } }, orderBy: { createdAt: "asc" } });

afterEach(() => { delete process.env.WHATSAPP_CHAT_PER_NUMBER; });
afterAll(async () => {
  await prisma.customerAgentRolloutAssignment.deleteMany({ where: { endpointScopeId: { in: [...new Set(scopes)] } } });
  await prisma.customerInquiry.deleteMany({ where: { conversationId: { in: natives } } });
  await prisma.botConversation.deleteMany({ where: { id: { in: natives } } });
  await prisma.customerInquiry.deleteMany({ where: { endpointScopeId: { in: [...new Set(scopes)] } } });
  await prisma.customerEndpointScope.deleteMany({ where: { id: { in: [...new Set(scopes)] }, transportKey: { startsWith: "messenger-account:" } } });
  await prisma.messengerAccount.deleteMany({ where: { id: { in: accounts } } });
  await prisma.client.deleteMany({ where: { id: { in: clients } } });
  resetAccountsCache(); resetMetaAccountCredsCache();
});

describe("WhatsApp: one person on two of our numbers", { timeout: 60_000 }, () => {
  it("gets two chats, each answered from its own number under its own brand, both on the same client card", async () => {
    const royal = await account("royal"), arvan = await account("arvan", "WHATSAPP", "Арван");
    const peer = nextPeer();
    const client = await prisma.client.create({ data: { fullName: `Клиент ${runId}`, phone: `+${peer}`, source: "WHATSAPP" } as never });
    clients.push(client.id);
    const first = await chat(royal, peer);
    await prisma.botConversation.update({ where: { id: first.id }, data: { clientId: client.id } });

    // The core routing decision: a chat on our OTHER number no longer holds this one (#475 workaround gone).
    const arvanEndpoint = await endpoint(arvan, peer);
    const execution = await enroll(subjectOf(arvanEndpoint, peer));
    expect(execution).toMatchObject({ lane: "LEGACY" });

    const second = await chat(arvan, peer);
    expect(second.id).not.toBe(first.id);
    expect(second.transport.endpointScopeId).toBe(arvanEndpoint.endpointScopeId);
    // Repeated messages land in the same per-number chats; nothing is merged or re-bound.
    expect((await chat(arvan, peer)).id).toBe(second.id);
    expect((await chat(royal, peer)).id).toBe(first.id);

    const rows = await chatsOf(peer);
    expect(rows).toHaveLength(2);
    expect(rows.map(r => r.accountId)).toEqual([royal.id, arvan.id]);
    expect(rows[1].account?.brandName).toBe("Арван");
    // Same phone = same person: the new chat is on the same client card at once.
    expect(rows.map(r => r.clientId)).toEqual([client.id, client.id]);

    // Reply from the correct number: each chat's captured transport binds its own phone_number_id and token.
    const creds = { waToken: "settings-token-not-used", waPhoneId: "settings-phone-not-used" };
    for (const [row, a] of [[first, royal], [second, arvan]] as const) {
      const transport = await loadCustomerTransportForConversation(row.id);
      expect(transport).toMatchObject({ accountId: a.id, accountExternalId: a.externalId });
      const bound = await bindCustomerMetaSendCredentials(creds, "WHATSAPP", peer, undefined, transport!);
      expect(bound.credentials.waPhoneId).toBe(a.externalId);
      expect(bound.token).toBe(a.token);
    }
    // The core's "move to core" readiness sees only this number's chat.
    const readiness = await readCustomerLegacyCutoverReadiness(prisma, { channel: "WHATSAPP", peer,
      endpointScopeId: arvanEndpoint.endpointScopeId, scopeKey: `readiness-${runId}` });
    expect(readiness).toMatchObject({ ready: true, nativeId: second.id });
  });

  it("the chat's satellites live per number too: outbound shield state and shown-property marks (old channel key gone for WhatsApp)", async () => {
    const royal = await account("sat-royal"), arvan = await account("sat-arvan");
    const peer = nextPeer();
    const a = await chat(royal, peer), b = await chat(arvan, peer);
    // Shield: the inbound note of each number creates that number's own state (before the migration the second one hit
    // the old (channel, subscriberId) key, became compat_collision, and the bot could not answer on the second number).
    await noteRealInbound({ transport: a.transport, channel: "WHATSAPP", subscriberId: peer, providerId: `wamid.sat-a-${runId}` });
    await noteRealInbound({ transport: b.transport, channel: "WHATSAPP", subscriberId: peer, providerId: `wamid.sat-b-${runId}` });
    const shield = await prisma.outboundShieldState.findMany({ where: { channel: "WHATSAPP", subscriberId: peer }, select: { endpointScopeId: true } });
    expect(shield.map(s => s.endpointScopeId).sort()).toEqual([a.transport.endpointScopeId, b.transport.endpointScopeId].sort());
    const verdict = await admitOutbound({ transport: b.transport, channel: "WHATSAPP", subscriberId: peer, text: `Здравствуйте ${runId}` });
    expect(verdict).toMatchObject({ allowed: true });
    // Shown-property marks: one per number for WhatsApp, still one per peer for Instagram.
    await prisma.shownProperty.create({ data: { channel: "WHATSAPP", recipientId: peer, shortId: 4242, endpointScopeId: a.transport.endpointScopeId } });
    await prisma.shownProperty.create({ data: { channel: "WHATSAPP", recipientId: peer, shortId: 4242, endpointScopeId: b.transport.endpointScopeId } });
    await expect(prisma.shownProperty.create({ data: { channel: "INSTAGRAM", recipientId: `ig-${peer}`, shortId: 4242, endpointScopeId: null } })
      .then(() => prisma.shownProperty.create({ data: { channel: "INSTAGRAM", recipientId: `ig-${peer}`, shortId: 4242, endpointScopeId: null } })))
      .rejects.toThrow();
    await prisma.shownProperty.deleteMany({ where: { recipientId: { in: [peer, `ig-${peer}`] } } });
    await prisma.outboundShieldState.deleteMany({ where: { subscriberId: peer } });
  });

  it("first messages to both numbers at the same moment: one chat per number, never a duplicate", async () => {
    const royal = await account("race-royal"), arvan = await account("race-arvan");
    const peer = nextPeer();
    const made = await Promise.all([chat(royal, peer), chat(arvan, peer), chat(royal, peer), chat(arvan, peer)]);
    expect(new Set(made.map(r => r.id)).size).toBe(2);
    expect(await chatsOf(peer)).toHaveLength(2);
  });

  it("two different client cards on the chats of one number: the new chat is not bound to either (a person decides)", async () => {
    const a = await account("cards-a"), b = await account("cards-b"), c = await account("cards-c");
    const peer = nextPeer();
    const one = await prisma.client.create({ data: { fullName: `Один ${runId}`, phone: `+99291${digits}1`, source: "WHATSAPP" } as never });
    const two = await prisma.client.create({ data: { fullName: `Два ${runId}`, phone: `+99291${digits}2`, source: "WHATSAPP" } as never });
    clients.push(one.id, two.id);
    await prisma.botConversation.update({ where: { id: (await chat(a, peer)).id }, data: { clientId: one.id } });
    await prisma.botConversation.update({ where: { id: (await chat(b, peer)).id }, data: { clientId: two.id } });
    const third = await chat(c, peer);
    expect((await prisma.botConversation.findUniqueOrThrow({ where: { id: third.id } })).clientId).toBeNull();
  });

  it("kill switch off: no new second chat (the #475 hold), existing per-number chats keep working", async () => {
    expect(whatsappChatPerNumber({ WHATSAPP_CHAT_PER_NUMBER: "off" })).toBe(false);
    expect(whatsappChatPerNumber({})).toBe(true);
    const royal = await account("off-royal"), arvan = await account("off-arvan");
    const peer = nextPeer();
    await chat(royal, peer);
    const already = nextPeer();
    await chat(royal, already); const split = await chat(arvan, already);

    process.env.WHATSAPP_CHAT_PER_NUMBER = "off";
    const other = await endpoint(arvan, peer);
    expect(await enroll(subjectOf(other, peer))).toMatchObject({ lane: "HELD", reason: "whatsapp_peer_on_other_number" });
    await expect(chat(arvan, peer)).rejects.toMatchObject({ reason: "compat_collision" });
    expect(await chatsOf(peer)).toHaveLength(1);
    // A chat that already exists on this number is still its chat.
    expect((await chat(arvan, already)).id).toBe(split.id);
    expect(await enroll(subjectOf(await endpoint(arvan, already), already))).not.toMatchObject({ lane: "HELD" });
  });

  it("an old chat without a known number (LEGACY_UNKNOWN) is never split by a guess", async () => {
    const arvan = await account("legacy-arvan");
    const peer = nextPeer();
    await prisma.$executeRaw`INSERT INTO "CustomerEndpointScope" ("id","realmKey","channel","transportKey","kind","updatedAt")
      VALUES (${randomUUID()},'royal-home','WHATSAPP','legacy-bot:WHATSAPP','LEGACY_UNKNOWN',now()) ON CONFLICT ("realmKey","channel","transportKey") DO NOTHING`;
    const legacyScope = await prisma.customerEndpointScope.findFirstOrThrow({ where: { realmKey: "royal-home", channel: "WHATSAPP", transportKey: "legacy-bot:WHATSAPP" } });
    const legacy = await prisma.botConversation.create({ data: { channel: "WHATSAPP", subscriberId: peer, accountId: null, endpointScopeId: legacyScope.id,
      messages: [{ role: "user", content: "Синтетическая старая история" }] } });
    natives.push(legacy.id);
    const other = await endpoint(arvan, peer);
    expect(await enroll(subjectOf(other, peer))).toMatchObject({ lane: "HELD", reason: "legacy_native_scope_collision" });
    await expect(chat(arvan, peer)).rejects.toBeInstanceOf(CustomerScopeDenied);
    expect(await chatsOf(peer)).toHaveLength(1);
  });

  it("Instagram keeps one chat per peer: the database still refuses a duplicate there, WhatsApp allows one per number", async () => {
    const igA = await account("ig-a", "INSTAGRAM"), igB = await account("ig-b", "INSTAGRAM");
    const igPeer = `ig-per-number-${runId}`;
    const igChat = await chat(igA, igPeer, "INSTAGRAM");
    const igOther = await endpoint(igB, igPeer, "INSTAGRAM");
    await expect(chat(igB, igPeer, "INSTAGRAM")).rejects.toBeInstanceOf(CustomerScopeDenied);
    expect(await enroll(subjectOf(igOther, igPeer))).toMatchObject({ lane: "HELD", reason: "legacy_native_scope_collision" });
    // Database level (the migration): the partial unique key still covers Instagram.
    await expect(prisma.$executeRaw`INSERT INTO "BotConversation" ("id","endpointScopeId","channel","subscriberId","accountId","messages","updatedAt")
      VALUES (${randomUUID()},${igOther.endpointScopeId},'INSTAGRAM',${igPeer},${igB.id},'[]'::jsonb,now())`).rejects.toThrow();
    expect(await prisma.botConversation.count({ where: { channel: "INSTAGRAM", subscriberId: igPeer } })).toBe(1);
    expect(igChat.id).toBeTruthy();
  });

  it("the one rule: other WhatsApp numbers coexist, unknown-number rows and other channels block", () => {
    const own = { endpointScopeId: "s1", scopeKind: "NORMAL" }, otherNumber = { endpointScopeId: "s2", scopeKind: "NORMAL" };
    const legacy = { endpointScopeId: "s3", scopeKind: "LEGACY_UNKNOWN" };
    expect(peerChatsForScope("WHATSAPP", [own, otherNumber], "s1", true)).toEqual({ own: [own], blocking: [], otherNumberHold: false });
    expect(peerChatsForScope("WHATSAPP", [otherNumber], "s1", true)).toEqual({ own: [], blocking: [], otherNumberHold: false });
    expect(peerChatsForScope("WHATSAPP", [otherNumber], "s1", false)).toEqual({ own: [], blocking: [otherNumber], otherNumberHold: true });
    expect(peerChatsForScope("WHATSAPP", [own, otherNumber], "s1", false)).toEqual({ own: [own], blocking: [], otherNumberHold: false });
    expect(peerChatsForScope("WHATSAPP", [otherNumber, legacy], "s1", true)).toEqual({ own: [], blocking: [otherNumber, legacy], otherNumberHold: false });
    expect(peerChatsForScope("INSTAGRAM", [otherNumber], "s1", true)).toEqual({ own: [], blocking: [otherNumber], otherNumberHold: false });
  });
});
