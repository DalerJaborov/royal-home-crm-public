// Two WhatsApp numbers on one core (27.11.2026): Royal Home in Settings + Arvan as a MessengerAccount row.
// Prod 26.11 14:17–21:35 UTC: every Royal Home WhatsApp message (18 customers) ended HELD «own_phone_identity_unavailable»
// a minute after the Arvan row appeared — the classifier allowed exactly ONE WhatsApp installation. The rule now: the sender
// must not be ANY of our numbers, every other enabled number must be known in digits (lib/whatsappOwnNumbers.ts), and an
// unknown one still holds (never a guess). Real Postgres: the classifier reads the actual registry.
import { createHash, createHmac, randomInt, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import { encryptSecret } from "../src/crypto.js";
import { classifyCustomerPendingFrame } from "../src/lib/customerIngressClassification.js";
import type { CustomerNormalizedIngressInput, CustomerPendingVerification } from "../src/lib/customerIngressPayload.js";
import { learnWhatsappOwnNumbersFromWebhook, rememberWhatsappOwnNumber, resetWhatsappOwnNumbersCache } from "../src/lib/whatsappOwnNumbers.js";
import { WA_OWN_NUMBER_ALERT_TAG, fetchMissingWhatsappOwnNumbers, runWhatsappOwnNumberGuard } from "../src/lib/whatsappOwnNumberLookup.js";
import { isOwnAccountSender, resetOwnAccountCache } from "../src/lib/ownAccountGuard.js";
import { classifyRecoveredCustomerPendingInput, recoverCustomerPendingEnvelope, registerAuthenticatedMetaCustomerRequest } from "../src/lib/customerIngressAuthority.js";
import { persistVerifiedCustomerIngressBatch } from "../src/lib/customerIngressProducer.js";
import { resetMetaAccountCredsCache } from "../src/messengers/meta.js";
import { resetAccountsCache } from "../src/messengers/accounts.js";
import { createCustomerRolloutFixture } from "./helpers/customerRolloutFixture.js";

const runId = randomUUID().replaceAll("-", "").slice(0, 10);
const mainId = `own-phone-main-${runId}`, arvanExternal = `own-phone-arvan-${runId}`, sandboxId = `own-phone-sandbox-${runId}`;
const digitsOf = () => `99288${String(randomInt(0, 10_000_000)).padStart(7, "0")}`;
const mainDigits = digitsOf(), arvanDigits = digitsOf();
let arvanRow = "", settingsBefore: { metaWaPhoneId: string | null; metaWaToken: string | null };
const foreignFilled: string[] = [];

function frame(peer: string, recipient: string, recipientDigits: string, accountId: string | null) {
  const eventId = `wamid.${randomUUID()}`;
  const payload: CustomerNormalizedIngressInput = { version: 1, channel: "WHATSAPP", peer, accountExternalId: recipient, eventKind: "message",
    eventId, inputText: "Салом, нарх чанд?", source: { path: "$.entry[0].changes[0].value.messages[0]", frameHash: createHash("sha256").update(eventId).digest("hex") },
    observations: { providerEcho: false, referralOnly: false, classifier: { version: 1, bareTemplateEcho: false, recipientPhoneDigits: recipientDigits } },
    media: [], propertyEvidence: [] };
  const verification: CustomerPendingVerification = { version: 1, classification: "PENDING_ENVELOPE", provenance: "meta_signature",
    assurance: "public_envelope", issuerSource: "verified_public_envelope", accountId, endpointScopeId: randomUUID(), scopeRevision: "1",
    policyRevision: "1", issuedAt: Date.now(), source: payload.source,
    verifierCredential: { source: "settings_app_secret", sourceId: "singleton", fingerprint: "c".repeat(64) } };
  return { payload, verification };
}
const customer = () => `99291${String(randomInt(0, 10_000_000)).padStart(7, "0")}`;
const toMain = (peer: string) => frame(peer, mainId, mainDigits, null);
const toArvan = (peer: string) => frame(peer, arvanExternal, arvanDigits, arvanRow);
// Other test files may hold their own enabled WhatsApp rows at this moment: they are «our numbers» for the classifier
// too. Give the ones without digits synthetic digits so only THIS file's numbers decide the outcome.
async function fillStrangers() {
  const strangers = await prisma.messengerAccount.findMany({ where: { channel: "WHATSAPP", enabled: true, externalId: { notIn: [mainId, arvanExternal] } },
    select: { externalId: true } });
  for (const { externalId } of strangers) {
    const added = await prisma.$executeRaw`INSERT INTO "WhatsappOwnNumber" ("phoneNumberId","digits","source","updatedAt")
      VALUES (${externalId},${digitsOf()},'webhook',now()) ON CONFLICT DO NOTHING`;
    if (added) foreignFilled.push(externalId);
  }
  resetWhatsappOwnNumbersCache();
}
const classify = async (f: ReturnType<typeof frame>) => {
  await fillStrangers();
  return classifyCustomerPendingFrame(prisma, f.payload, f.verification);
};
const forget = (...ids: string[]) => prisma.whatsappOwnNumber.deleteMany({ where: { phoneNumberId: { in: ids } } }).then(() => resetWhatsappOwnNumbersCache());

beforeAll(async () => {
  settingsBefore = await prisma.settings.findUniqueOrThrow({ where: { id: "singleton" }, select: { metaWaPhoneId: true, metaWaToken: true } });
  await prisma.settings.update({ where: { id: "singleton" }, data: { metaWaPhoneId: mainId, metaWaToken: encryptSecret(`synthetic-main-token-${runId}`) } });
  arvanRow = randomUUID();
  await prisma.messengerAccount.create({ data: { id: arvanRow, channel: "WHATSAPP", externalId: arvanExternal, title: "Synthetic Arvan",
    brandName: "Арван", enabled: true, isDefault: false, token: encryptSecret(`synthetic-arvan-token-${runId}`) } });
  await forget(mainId, arvanExternal, sandboxId);
  resetOwnAccountCache();
});
afterEach(() => { vi.unstubAllGlobals(); });
afterAll(async () => {
  await forget(mainId, arvanExternal, sandboxId, ...foreignFilled);
  await prisma.pendingDirectorAlert.deleteMany({ where: { tag: WA_OWN_NUMBER_ALERT_TAG } });
  await prisma.messengerAccount.deleteMany({ where: { id: arvanRow } });
  await prisma.settings.update({ where: { id: "singleton" }, data: settingsBefore });
  resetOwnAccountCache();
});

describe("WhatsApp: customers of BOTH our numbers are answered, our own numbers never", { timeout: 30_000 }, () => {
  it("a Royal Home customer is eligible once the Arvan number is known in digits (prod 26.11: held for every customer)", async () => {
    await forget(arvanExternal);
    expect(await classify(toMain(customer()))).toEqual({ status: "held", reason: "own_phone_identity_unavailable" });
    expect(await rememberWhatsappOwnNumber(arvanExternal, `+${arvanDigits}`, "connect", { trusted: true })).toBe(true);
    expect(await classify(toMain(customer()))).toEqual({ status: "eligible" });
  });

  it("an Arvan customer is eligible once the Royal Home number is known (the old rule held every Arvan message too)", async () => {
    await rememberWhatsappOwnNumber(arvanExternal, arvanDigits, "connect", { trusted: true });
    await forget(mainId);
    expect(await classify(toArvan(customer()))).toEqual({ status: "held", reason: "own_phone_identity_unavailable" });
    await rememberWhatsappOwnNumber(mainId, mainDigits, "webhook");
    expect(await classify(toArvan(customer()))).toEqual({ status: "eligible" });
  });

  it("our other number writing in is ignored as our own, in both directions (no bot-to-bot loop)", async () => {
    await rememberWhatsappOwnNumber(mainId, mainDigits, "webhook");
    await rememberWhatsappOwnNumber(arvanExternal, arvanDigits, "webhook");
    expect(await classify(toMain(arvanDigits))).toEqual({ status: "ignored", reason: "own_account" });
    expect(await classify(toArvan(`+${mainDigits}`))).toEqual({ status: "ignored", reason: "own_account" });
    expect(await classify(toMain(mainDigits))).toEqual({ status: "ignored", reason: "own_account" });
  });

  it("a frame whose recipient is not the installation of its endpoint is held, never answered from the other number", async () => {
    await rememberWhatsappOwnNumber(mainId, mainDigits, "webhook");
    await rememberWhatsappOwnNumber(arvanExternal, arvanDigits, "webhook");
    expect(await classify(frame(customer(), mainId, mainDigits, arvanRow))).toEqual({ status: "held", reason: "own_phone_identity_unavailable" });
    expect(await classify(frame(customer(), arvanExternal, arvanDigits, null))).toEqual({ status: "held", reason: "own_phone_identity_unavailable" });
  });

  it("a disabled second number is not required, a new unknown enabled one holds again", async () => {
    await rememberWhatsappOwnNumber(mainId, mainDigits, "webhook");
    await forget(arvanExternal);
    await prisma.messengerAccount.update({ where: { id: arvanRow }, data: { enabled: false } });
    try {
      expect(await classify(toMain(customer()))).toEqual({ status: "eligible" });
    } finally {
      await prisma.messengerAccount.update({ where: { id: arvanRow }, data: { enabled: true } });
    }
    expect(await classify(toMain(customer()))).toEqual({ status: "held", reason: "own_phone_identity_unavailable" });
  });

  it("the signed webhook teaches our numbers and ignores a foreign (sandbox) phone_number_id", async () => {
    await forget(mainId, arvanExternal);
    await learnWhatsappOwnNumbersFromWebhook({ object: "whatsapp_business_account", entry: [{ id: "waba", changes: [
      { field: "messages", value: { metadata: { phone_number_id: arvanExternal, display_phone_number: `+${arvanDigits.slice(0, 3)} ${arvanDigits.slice(3)}` }, statuses: [] } },
      { field: "messages", value: { metadata: { phone_number_id: sandboxId, display_phone_number: "15550001111" }, messages: [] } },
    ] }] });
    const rows = await prisma.whatsappOwnNumber.findMany({ where: { phoneNumberId: { in: [arvanExternal, sandboxId] } } });
    expect(rows.map(r => [r.phoneNumberId, r.digits, r.source])).toEqual([[arvanExternal, arvanDigits, "webhook"]]);
  });

  it("an unknown number is read from Meta once, with that number's own key; a failed read writes nothing", async () => {
    await forget(mainId, arvanExternal);
    const seen: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: { headers: Record<string, string> }) => {
      seen.push(`${new URL(url).pathname.split("/").pop()} ${init.headers.Authorization}`);
      if (url.includes(arvanExternal)) return new Response(JSON.stringify({ id: arvanExternal, display_phone_number: `+${arvanDigits}` }), { status: 200 });
      return new Response(JSON.stringify({ error: { message: "synthetic failure", code: 100 } }), { status: 400 });
    }));
    expect(await fetchMissingWhatsappOwnNumbers()).toBe(1);
    expect(seen).toContain(`${arvanExternal} Bearer synthetic-arvan-token-${runId}`);
    expect(seen).toContain(`${mainId} Bearer synthetic-main-token-${runId}`);
    const rows = await prisma.whatsappOwnNumber.findMany({ where: { phoneNumberId: { in: [mainId, arvanExternal] } } });
    expect(rows.map(r => [r.phoneNumberId, r.digits, r.source])).toEqual([[arvanExternal, arvanDigits, "graph"]]);
    // The failed number is not asked again at once (no Meta request per customer message while it stays unknown).
    seen.length = 0;
    expect(await fetchMissingWhatsappOwnNumbers()).toBe(0);
    expect(seen).toEqual([]);
  });

  it("the cron guard: messages held and a number still unknown → one CRITICAL to the director a day, none once known", async () => {
    await forget(arvanExternal);
    await rememberWhatsappOwnNumber(mainId, mainDigits, "webhook");
    await prisma.pendingDirectorAlert.deleteMany({ where: { tag: WA_OWN_NUMBER_ALERT_TAG } });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { message: "synthetic failure" } }), { status: 400 })));
    expect(await runWhatsappOwnNumberGuard(new Date(), async () => 4)).toMatchObject({ held: 4, alerted: true });
    const alert = await prisma.pendingDirectorAlert.findFirstOrThrow({ where: { tag: WA_OWN_NUMBER_ALERT_TAG } });
    expect(alert.level).toBe("CRITICAL");
    expect(alert.body).toContain("Synthetic Arvan");
    expect(await runWhatsappOwnNumberGuard(new Date(), async () => 4)).toMatchObject({ alerted: false });
    expect(await prisma.pendingDirectorAlert.count({ where: { tag: WA_OWN_NUMBER_ALERT_TAG } })).toBe(1);
    await prisma.pendingDirectorAlert.deleteMany({ where: { tag: WA_OWN_NUMBER_ALERT_TAG } });
    await rememberWhatsappOwnNumber(arvanExternal, arvanDigits, "webhook");
    await fillStrangers();
    expect(await runWhatsappOwnNumberGuard(new Date(), async () => 4)).toEqual({ fetched: 0, held: 4, alerted: false });
  });

  it("the old bot's guard knows our WhatsApp numbers by digits, only in WhatsApp", async () => {
    await rememberWhatsappOwnNumber(arvanExternal, arvanDigits, "webhook");
    resetOwnAccountCache();
    expect(await isOwnAccountSender({ senderId: arvanDigits, channel: "WHATSAPP" })).toBe(true);
    expect(await isOwnAccountSender({ senderId: customer(), channel: "WHATSAPP" })).toBe(false);
    expect(await isOwnAccountSender({ senderId: arvanDigits, channel: "INSTAGRAM" })).toBe(false);
  });
});

// The glue of the core (customerIngressAuthority.ts::classifyRecoveredCustomerPendingInput): a REAL signed WhatsApp frame to
// the Arvan row, persisted as a pending ticket, while the Settings number is not yet known in digits. The core must look
// the number up and classify AGAIN — also when someone else (an Arvan webhook, the cron guard) stored it at the same moment
// and our own lookup wrote nothing (independent review of #495: the re-check was skipped then, held for good).
describe("core glue: held own-number → lookup → the actual classifier again", { timeout: 60_000 }, () => {
  const glueMain = `own-phone-glue-main-${runId}`, glueMainDigits = digitsOf(), secret = `synthetic-glue-secret-${runId}`;
  const glueArvan = randomUUID(), glueArvanExternal = `own-phone-glue-arvan-${runId}`, glueArvanDigits = digitsOf();
  let rollout: Awaited<ReturnType<typeof createCustomerRolloutFixture>>;
  let glueSettings: { metaWaPhoneId: string | null; metaWaToken: string | null; botEnabled: boolean; metaEnabled: boolean; botWhatsappEnabled: boolean };
  const scopes: string[] = [];
  beforeAll(async () => {
    glueSettings = await prisma.settings.findUniqueOrThrow({ where: { id: "singleton" },
      select: { metaWaPhoneId: true, metaWaToken: true, botEnabled: true, metaEnabled: true, botWhatsappEnabled: true } });
    rollout = await createCustomerRolloutFixture();
    // Its own Settings number: the earlier lookup test left a 5-minute pause on the first one.
    await prisma.settings.update({ where: { id: "singleton" }, data: { metaWaPhoneId: glueMain, metaWaToken: encryptSecret(`synthetic-glue-main-token-${runId}`),
      botEnabled: true, metaEnabled: true, botWhatsappEnabled: true } });
    await prisma.messengerAccount.create({ data: { id: glueArvan, channel: "WHATSAPP", externalId: glueArvanExternal, title: "Synthetic glue Arvan",
      enabled: true, isDefault: false, token: encryptSecret(`synthetic-glue-arvan-token-${runId}`), appSecret: encryptSecret(secret) } });
    resetAccountsCache(); resetMetaAccountCredsCache(); resetOwnAccountCache();
  });
  afterAll(async () => {
    const tickets = await prisma.customerPropertyIngressTicket.findMany({ where: { endpointScopeId: { in: scopes } }, select: { eventKey: true } });
    await prisma.backgroundJob.deleteMany({ where: { dedupeKey: { in: tickets.map(t => `customer-inbox-consume:${t.eventKey}`) } } });
    await prisma.customerPropertyIngressTicket.deleteMany({ where: { endpointScopeId: { in: scopes } } });
    await prisma.botConversation.deleteMany({ where: { accountId: glueArvan } });
    await prisma.customerEndpointScope.deleteMany({ where: { id: { in: scopes } } });
    await prisma.messengerAccount.deleteMany({ where: { id: glueArvan } });
    await forget(glueMain, glueArvanExternal);
    await prisma.settings.update({ where: { id: "singleton" }, data: glueSettings });
    await rollout.restore();
    resetAccountsCache(); resetMetaAccountCredsCache(); resetOwnAccountCache();
  });
  async function pendingToArvan() {
    const peer = customer(), eventId = `wamid.${randomUUID()}`;
    const endpoint = await rollout.allowDm({ peer, accountId: glueArvan, accountExternalId: glueArvanExternal, channel: "WHATSAPP" });
    scopes.push(endpoint.endpointScopeId);
    const body = { object: "whatsapp_business_account", entry: [{ id: "synthetic-waba", changes: [{ field: "messages", value: {
      metadata: { phone_number_id: glueArvanExternal, display_phone_number: `+${glueArvanDigits}` }, contacts: [{ wa_id: peer, profile: { name: "Synthetic" } }],
      messages: [{ from: peer, id: eventId, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: "Салом, нарх?" } }] } }] }] };
    const rawBody = Buffer.from(JSON.stringify(body));
    const request = { rawBody, get: () => `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}` };
    registerAuthenticatedMetaCustomerRequest(request);
    const stored = await persistVerifiedCustomerIngressBatch(request);
    if (stored.status !== "persisted") throw new Error(`not persisted: ${JSON.stringify(stored)}`);
    const eventKey = stored.tickets[0].eventKey;
    await prisma.backgroundJob.updateMany({ where: { dedupeKey: `customer-inbox-consume:${eventKey}` }, data: { runAt: new Date("2099-01-01") } });
    const recovered = await recoverCustomerPendingEnvelope(eventKey);
    if (recovered.status !== "pending") throw new Error(`not pending: ${JSON.stringify(recovered)}`);
    return recovered.envelope;
  }

  it("the Settings number is unknown: the core reads it from Meta with the Settings key and the customer passes", async () => {
    await forget(glueMain);
    await rememberWhatsappOwnNumber(glueArvanExternal, glueArvanDigits, "webhook");
    await fillStrangers();
    const envelope = await pendingToArvan();
    const asked: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: { headers: Record<string, string> }) => {
      asked.push(`${new URL(url).pathname.split("/").pop()} ${init.headers.Authorization}`);
      if (url.includes(glueMain)) return new Response(JSON.stringify({ id: glueMain, display_phone_number: `+${glueMainDigits}` }), { status: 200 });
      return new Response(JSON.stringify({ error: { message: "synthetic" } }), { status: 400 });
    }));
    const result = await classifyRecoveredCustomerPendingInput(envelope);
    expect(result.status, JSON.stringify(result)).toBe("classified");
    expect(asked).toContain(`${glueMain} Bearer synthetic-glue-main-token-${runId}`);
  });

  it("race: the number is stored by someone else while our lookup fails — the frame is still checked again and passes", async () => {
    await forget(glueMain);
    await rememberWhatsappOwnNumber(glueArvanExternal, glueArvanDigits, "webhook"); // our recipient pair writes nothing new
    await fillStrangers();
    const envelope = await pendingToArvan();
    vi.stubGlobal("fetch", vi.fn(async () => {
      // Another process (a webhook of that number, the cron guard) stores the number in the same moment.
      await prisma.$executeRaw`INSERT INTO "WhatsappOwnNumber" ("phoneNumberId","digits","source","updatedAt")
        VALUES (${glueMain},${glueMainDigits},'webhook',now()) ON CONFLICT DO NOTHING`;
      return new Response(JSON.stringify({ error: { message: "synthetic timeout" } }), { status: 500 });
    }));
    const result = await classifyRecoveredCustomerPendingInput(envelope);
    expect(result.status, JSON.stringify(result)).toBe("classified");
  });

  it("the number stays unknown (Meta refuses, nobody else learns it): held, never answered on a guess", async () => {
    // A fresh unknown second row: the first Settings number already failed once and sits in the 5-minute pause.
    const extra = randomUUID();
    await prisma.messengerAccount.create({ data: { id: extra, channel: "WHATSAPP", externalId: `own-phone-glue-extra-${runId}`, title: "Synthetic extra",
      enabled: true, isDefault: false, token: encryptSecret(`synthetic-glue-extra-token-${runId}`) } });
    try {
      await rememberWhatsappOwnNumber(glueMain, glueMainDigits, "webhook");
      await rememberWhatsappOwnNumber(glueArvanExternal, glueArvanDigits, "webhook");
      const envelope = await pendingToArvan();
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { message: "synthetic" } }), { status: 400 })));
      expect(await classifyRecoveredCustomerPendingInput(envelope)).toEqual({ status: "held", reason: "own_phone_identity_unavailable" });
    } finally {
      await prisma.messengerAccount.deleteMany({ where: { id: extra } });
      await forget(`own-phone-glue-extra-${runId}`);
    }
  });
});
