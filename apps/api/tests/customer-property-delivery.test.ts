import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../src/ai/shared.js";
// Complete DB substitution deliberately exports the entire runtime surface:
// no original pool/dotenv, no DB/network in this transport-boundary test.
const db = vi.hoisted(() => ({ $executeRaw: vi.fn(), $queryRaw: vi.fn(), $disconnect: vi.fn(),
  botConversation: { findUnique: vi.fn() }, property: { findUnique: vi.fn() }, settings: { findUnique: vi.fn() },
  messengerAccount: { findFirst: vi.fn(), findMany: vi.fn(), findUnique: vi.fn() }, processedMessage: { create: vi.fn() },
  systemError: { create: vi.fn(), findFirst: vi.fn() } }));
vi.mock("../src/db.js", () => ({ prisma: db }));
import { managedCustomerPropertyReply, managedCustomerPropertyMessage, sendManagedCustomerPropertyReply } from "../src/lib/customerPropertyDelivery.js";
import { projectCustomerPropertyFacts, renderCustomerPropertyFacts } from "../src/lib/customerPropertyFacts.js";
import { customerPropertyPromptHistory, customerPropertyTurnTerminal } from "../src/lib/customerPropertyHistory.js";
import { customerPropertyScopeKey } from "../src/lib/customerPropertyScope.js";
import { parseIncoming, sendMessage } from "../src/messengers/meta.js";
import * as shield from "../src/lib/outboundShield.js";
import { resetOutgoingMids } from "../src/messengers/outgoingMids.js";
import { customerPropertyEvidenceFromMeta } from "../src/lib/customerPropertyEvidence.js";
import { encryptSecret } from "../src/crypto.js";
import type { CustomerTransportReference } from "../src/lib/customerConversationScope.js";

const binding = { id: randomUUID(), channel: "WHATSAPP" as const, subscriberId: "fictional-peer", accountId: randomUUID() };
// Fictitious installed namespace for the actual Meta bind/resolve boundary;
// these rows grant no customer identity, private read or action authority.
const transport: CustomerTransportReference = { channel: binding.channel, accountId: binding.accountId,
  accountExternalId: "fictional-phone-id", endpointScopeId: randomUUID(),
  transportKey: `messenger-account:${binding.accountId}`, scopeRevision: "0" };
const scopeKey = customerPropertyScopeKey(binding.channel, binding.subscriberId, binding.accountId);
const propertyId = randomUUID(); const generation = randomUUID();
let property: ReturnType<typeof fixtureProperty>;
let stored: Record<string, unknown>;
function fixtureProperty() { return { id: propertyId, shortId: 123, price: "100000000", currency: "TJS", updatedAt: new Date("2026-10-14T00:00:00Z"),
  district: { name: "Сино", city: "Душанбе" }, status: "AVAILABLE", deletedAt: null, offSite: false, publishedOnSite: true,
  publishedChannels: [], instagramUrl: null, siteListingId: null }; }
function fixturePart() {
  const ticket = { eventKey: "a".repeat(64), order: "1", conversationId: binding.id, channel: binding.channel,
    accountId: binding.accountId, scopeKey, evidence: [] };
  const facts = projectCustomerPropertyFacts(property, binding.channel)!;
  const context = { ticket, snapshot: { focus: { version: 1 as const, scopeKey, generation, lastEvidenceOrder: "1", eventKey: ticket.eventKey,
    status: "resolved" as const, propertyId, evidence: [] }, revision: 1 }, facts, superseded: false };
  const part = managedCustomerPropertyReply(binding, context, renderCustomerPropertyFacts(facts, ["price", "address"], "ru"), { status: "admitted", ticket });
  stored = { channel: binding.channel, subscriberId: binding.subscriberId, accountId: binding.accountId, optedOutAt: null,
    pausedUntil: null, account: { enabled: true }, client: null, customerPropertyFocus: context.snapshot.focus,
    customerPropertyFocusRevision: 1, messages: [managedCustomerPropertyMessage(part)] };
  db.botConversation.findUnique.mockImplementation(async () => stored);
  return part;
}
beforeEach(() => {
  vi.resetAllMocks(); resetOutgoingMids(); property = fixtureProperty();
  db.settings.findUnique.mockResolvedValue(null); db.property.findUnique.mockImplementation(async () => property);
  db.$executeRaw.mockResolvedValue(1); db.messengerAccount.findFirst.mockResolvedValue(null);
  vi.stubEnv("SETTINGS_ENCRYPTION_KEY", "1".repeat(64));
  const account = { id: binding.accountId, channel: binding.channel, externalId: transport.accountExternalId,
    messagingId: null, extraExternalIds: [], token: encryptSecret("fictional-token"), enabled: true };
  db.messengerAccount.findMany.mockImplementation(async ({ where }: { where: { channel: string; id?: string } }) => {
    expect(where).toEqual({ channel: binding.channel, id: binding.accountId }); return [account];
  });
  db.messengerAccount.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => {
    expect(where).toEqual({ id: binding.accountId }); return account;
  });
  db.$queryRaw.mockImplementation(async (query: TemplateStringsArray, ...values: unknown[]) => {
    const sql = query.join("?");
    if (sql.includes('FROM "Settings" st LEFT JOIN "CustomerEndpointScope"') && sql.includes('st."metaAppSecret"')) {
      expect(values).toEqual([binding.channel, binding.channel, binding.channel, "settings:WHATSAPP:fictional-phone-id"]);
      return [];
    }
    if (sql.includes('FROM "CustomerEndpointScope"') && sql.includes('WHERE "realmKey"')) {
      expect(values).toEqual(["royal-home", binding.channel, transport.transportKey]);
      return [{ id: transport.endpointScopeId, messengerAccountId: binding.accountId, kind: "NORMAL", scopeRevision: 0n }];
    }
    throw new Error("Unexpected SQL in no-DB property delivery routing fixture");
  });
  db.processedMessage.create.mockResolvedValue({}); db.systemError.findFirst.mockResolvedValue(null); db.systemError.create.mockResolvedValue({});
  vi.stubEnv("META_WA_PHONE_ID", "fictional-phone-id"); vi.stubEnv("BOT_PROPERTY_CONTEXT_ENABLED", "1");
  vi.spyOn(shield, "admitOutbound").mockResolvedValue({ allowed: true, kind: "reply" });
  vi.spyOn(console, "error").mockImplementation(() => {}); vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ messages: [{ id: "fictional-mid" }] }), { status: 200 })));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("actual managed Meta fact OUT boundary without DB or network", () => {
  it("provider acceptance survives exact receipt stamp failure with no repeat POST", async () => {
    const part = fixturePart(); db.$executeRaw.mockRejectedValue(new Error("fictional receipt write failure"));
    expect(await sendManagedCustomerPropertyReply(part, () => sendMessage("WHATSAPP", binding.subscriberId, part.text, "fictional-token", { transport }))).toBe("accepted");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(customerPropertyTurnTerminal([{ role: "user", content: "цена?", customerPropertyAdmission: { eventKey: "a".repeat(64), order: "1", conversationId: binding.id, channel: binding.channel, accountId: binding.accountId, scopeKey, evidence: [] } }, managedCustomerPropertyMessage(part)])).toBe(true);
  });
  it("a 2xx response with no MID is accepted, never permission to replay", async () => {
    const part = fixturePart(); vi.mocked(fetch).mockResolvedValue(new Response("{}", { status: 200 }));
    expect(await sendManagedCustomerPropertyReply(part, () => sendMessage("WHATSAPP", binding.subscriberId, part.text, "fictional-token", { transport }))).toBe("accepted");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("new focus during typing holds the old exact text without calling transport", async () => {
    const part = fixturePart(); stored.customerPropertyFocusRevision = 2;
    const send = vi.fn(async () => "fictional-mid");
    expect(await sendManagedCustomerPropertyReply(part, send)).toBe("held"); expect(send).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
  it("changed price after shield/config but before actual POST is held", async () => {
    const part = fixturePart(); let lookups = 0;
    db.settings.findUnique.mockImplementation(async () => { if (++lookups === 2) property.price = "120000000"; return null; });
    expect(await sendManagedCustomerPropertyReply(part, () => sendMessage("WHATSAPP", binding.subscriberId, part.text, "fictional-token", { transport }))).toBe("held");
    expect(fetch).not.toHaveBeenCalled(); expect(shield.admitOutbound).toHaveBeenCalledTimes(1);
  });
  it("a network reset after POST is unknown and never resends the whole turn", async () => {
    const part = fixturePart(); vi.mocked(fetch).mockRejectedValue(Object.assign(new TypeError("fictional reset"), { cause: { code: "ECONNRESET" } }));
    expect(await sendManagedCustomerPropertyReply(part, () => sendMessage("WHATSAPP", binding.subscriberId, part.text, "fictional-token", { transport }))).toBe("unknown");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([
    { offSite: true }, { deletedAt: new Date() }, { status: "SOLD" },
    { publishedOnSite: false, instagramUrl: null, publishedChannels: [] },
  ])("withdrawn/private/unpublished facts never reach an actual POST: %j", async (change) => {
    const part = fixturePart(); Object.assign(property, change);
    expect(await sendManagedCustomerPropertyReply(part, () => sendMessage("WHATSAPP", binding.subscriberId, part.text, "fictional-token", { transport }))).toBe("held");
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(["pending", "held", "cancelled", "unknown"] as const)("%s part never becomes a prompt/reply anchor", (status) => {
    const part = fixturePart(); const message = managedCustomerPropertyMessage(part); message.customerPropertyDelivery!.status = status;
    expect(customerPropertyPromptHistory([null as unknown as ChatMessage, { role: "user", content: "цена?" }, message])).toEqual([{ role: "user", content: "цена?" }]);
  });
  it("null resolution context keeps the saved admitted event correlation", () => {
    const full = fixturePart(); const ticket = { eventKey: "a".repeat(64), order: "1", conversationId: binding.id, channel: binding.channel, accountId: binding.accountId, scopeKey, evidence: [] };
    const neutral = managedCustomerPropertyReply(binding, null, "Какой объект?", { status: "admitted", ticket });
    expect(neutral.delivery.inputEventKey).toBe(ticket.eventKey);
    expect(customerPropertyTurnTerminal([{ role: "user", content: "цена?", customerPropertyAdmission: ticket }, managedCustomerPropertyMessage(neutral)])).toBe(true);
    expect(full.text).toContain("100 000 000 сомони");
  });
  it("actual postback parser retains referral and second CDN publication ID", () => {
    const body = { object: "instagram", entry: [{ id: "fictional-account", messaging: [
      { sender: { id: "fictional-peer" }, recipient: { id: "fictional-account" }, postback: { mid: "fictional-click", payload: "info", title: "Подробнее", referral: { ad_id: "fictional-ad" } } },
      { sender: { id: "fictional-peer" }, recipient: { id: "fictional-account" }, message: { mid: "fictional-share", attachments: [
        { type: "share", payload: { url: "https://lookaside.fbsbx.com/ig_messaging_cdn/a", ig_post_media_id: "11111" } },
        { type: "share", payload: { url: "https://lookaside.fbsbx.com/ig_messaging_cdn/b", reel_video_id: "22222" } },
      ] } },
    ] }] };
    const parsed = parseIncoming(body, undefined, false);
    expect(customerPropertyEvidenceFromMeta(parsed[0])).toContainEqual({ kind: "ad", origin: "postback_referral", reference: "fictional-ad" });
    expect(customerPropertyEvidenceFromMeta(parsed[1])).toEqual(expect.arrayContaining([
      { kind: "media", origin: "shared_media", reference: "11111" }, { kind: "media", origin: "shared_media", reference: "22222" },
    ]));
    expect(customerPropertyEvidenceFromMeta(parsed[1]).every((item) => item.kind !== "untrusted_reference")).toBe(true);
  });
});
