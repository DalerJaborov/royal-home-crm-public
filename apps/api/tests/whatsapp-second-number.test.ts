// Second WhatsApp number (Arvan, 26.11.2026). A WhatsApp peer IS a phone number: the same person writing to both of our
// numbers meets their existing chat (global unique channel+peer). That used to be the 503 collision guard — Meta retries
// and drops the message. Now it is held for a person, and the text lands in the person's ONE existing CRM chat.
import { createHash, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { encryptSecret } from "../src/crypto.js";
import type { CustomerAgentEnrollmentSubject } from "@royal-home/shared";
import { enrollCustomerAgentSubjectTx } from "../src/lib/customerAgentEnrollment.js";
import { ensureCustomerEndpoint, ensureScopedBotConversation, type ScopedCustomerEndpoint } from "../src/lib/customerConversationScope.js";
import { recordHeldCustomerMessage } from "../src/lib/customerHeldMessage.js";
import { customerRoutingHoldDisposition } from "../src/lib/customerRoutingHold.js";
import type { CustomerNormalizedIngressInput } from "../src/lib/customerIngressPayload.js";
import { accountBecomesDefault, resetAccountsCache } from "../src/messengers/accounts.js";
import { resetMetaAccountCredsCache } from "../src/messengers/meta.js";

const accounts: string[] = [], scopes: string[] = [], natives: string[] = [];
const runId = randomUUID().replaceAll("-", "").slice(0, 10);

async function account(channel: "WHATSAPP" | "INSTAGRAM", label: string) {
  const id = randomUUID(), externalId = `second-number-${label}-${runId}`;
  await prisma.messengerAccount.create({ data: { id, externalId, channel, enabled: true, title: `Synthetic ${label}`,
    token: encryptSecret(`synthetic-token-${id}`), ...(channel === "INSTAGRAM" ? { username: `synthetic_${label}_${runId}` } : {}) } });
  accounts.push(id); resetAccountsCache(); resetMetaAccountCredsCache();
  return { id, externalId };
}
async function endpoint(channel: "WHATSAPP" | "INSTAGRAM", a: { id: string; externalId: string }, peer: string) {
  const scoped = await prisma.$transaction(tx => ensureCustomerEndpoint(tx, { channel, subscriberId: peer, accountId: a.id, accountExternalId: a.externalId }));
  scopes.push(scoped.endpointScopeId);
  return scoped;
}
async function chat(channel: "WHATSAPP" | "INSTAGRAM", a: { id: string; externalId: string }, peer: string) {
  const row = await prisma.$transaction(tx => ensureScopedBotConversation(tx, { channel, subscriberId: peer, accountId: a.id, accountExternalId: a.externalId }));
  natives.push(row.id); scopes.push(row.transport.endpointScopeId);
  return row;
}
const subjectOf = (e: ScopedCustomerEndpoint, peer: string): CustomerAgentEnrollmentSubject => ({ surface: "dm", peer,
  endpoint: { endpointScopeId: e.endpointScopeId, scopeRevision: e.scopeRevision, channel: e.channel, accountId: e.accountId, transportKey: e.transportKey } });
const enroll = (s: CustomerAgentEnrollmentSubject) => prisma.$transaction(tx => enrollCustomerAgentSubjectTx(tx, s));
function input(peer: string, accountExternalId: string, eventId: string, text: string): CustomerNormalizedIngressInput {
  return { version: 1, channel: "WHATSAPP", peer, accountExternalId, eventKind: "message", eventId, inputText: text,
    source: { path: "$.entry[0].changes[0].value.messages[0]", frameHash: createHash("sha256").update(eventId).digest("hex") },
    observations: { providerEcho: false, referralOnly: false, classifier: { version: 1, bareTemplateEcho: false } },
    media: [], propertyEvidence: [] };
}

afterAll(async () => {
  await prisma.customerInquiry.deleteMany({ where: { conversationId: { in: natives } } });
  await prisma.botConversation.deleteMany({ where: { id: { in: natives } } });
  await prisma.customerEndpointScope.deleteMany({ where: { id: { in: [...new Set(scopes)] } } });
  await prisma.messengerAccount.deleteMany({ where: { id: { in: accounts } } });
  resetAccountsCache(); resetMetaAccountCredsCache();
});

describe("a WhatsApp customer on our other number", { timeout: 30_000 }, () => {
  it("is held for a person (ACK + report), not the 503 guard that loses the message", async () => {
    const royal = await account("WHATSAPP", "royal"), arvan = await account("WHATSAPP", "arvan");
    const peer = `99290${runId.replace(/\D/g, "").padEnd(7, "1").slice(0, 7)}`;
    const existing = await chat("WHATSAPP", royal, peer);
    const other = await endpoint("WHATSAPP", arvan, peer);
    const execution = await enroll(subjectOf(other, peer));
    expect(execution).toMatchObject({ lane: "HELD", reason: "whatsapp_peer_on_other_number" });
    expect(customerRoutingHoldDisposition("whatsapp_peer_on_other_number")).toBe("report");

    // The text goes into the person's existing chat, once per provider MID.
    const mid = `wamid.second-number-${runId}`;
    const first = await recordHeldCustomerMessage({ reason: "whatsapp_peer_on_other_number", input: input(peer, arvan.externalId, mid, "Есть 2-комнатная?"), transport: other });
    expect(first).toMatchObject({ conversationId: existing.id, channel: "WHATSAPP", peer });
    expect(first.unrecorded).toBeUndefined();
    const again = await recordHeldCustomerMessage({ reason: "whatsapp_peer_on_other_number", input: input(peer, arvan.externalId, mid, "Есть 2-комнатная?"), transport: other });
    expect(again.conversationId).toBe(existing.id);
    const stored = await prisma.botConversation.findUniqueOrThrow({ where: { id: existing.id }, select: { messages: true, accountId: true } });
    const lines = (stored.messages as Array<{ mid?: string; heldRouting?: boolean; content?: string }>).filter(m => m.mid === mid);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ heldRouting: true, content: "Есть 2-комнатная?" });
    // The chat keeps its own number: no silent re-binding to the other brand.
    expect(stored.accountId).toBe(royal.id);
    expect(await prisma.botConversation.count({ where: { channel: "WHATSAPP", subscriberId: peer } })).toBe(1);
  });

  it("Instagram keeps the deliberate 503 collision guard (per-account peer IDs never collide legitimately)", async () => {
    const first = await account("INSTAGRAM", "ig-a"), second = await account("INSTAGRAM", "ig-b");
    const peer = `ig-peer-${runId}`;
    await chat("INSTAGRAM", first, peer);
    const other = await endpoint("INSTAGRAM", second, peer);
    expect(await enroll(subjectOf(other, peer))).toMatchObject({ lane: "HELD", reason: "legacy_native_scope_collision" });
    expect(customerRoutingHoldDisposition("legacy_native_scope_collision")).toBe("unavailable");
  });
});

describe("a new WhatsApp/Facebook row never takes over the Settings number by itself", () => {
  it("sole row becomes default only when nothing answers through Settings; an explicit choice wins", () => {
    expect(accountBecomesDefault({ explicit: undefined, rowsInChannel: 1, installedInSettings: false })).toBe(true);
    expect(accountBecomesDefault({ explicit: undefined, rowsInChannel: 1, installedInSettings: true })).toBe(false);
    expect(accountBecomesDefault({ explicit: undefined, rowsInChannel: 2, installedInSettings: false })).toBe(false);
    expect(accountBecomesDefault({ explicit: true, rowsInChannel: 3, installedInSettings: true })).toBe(true);
    expect(accountBecomesDefault({ explicit: false, rowsInChannel: 1, installedInSettings: false })).toBe(false);
  });
});
