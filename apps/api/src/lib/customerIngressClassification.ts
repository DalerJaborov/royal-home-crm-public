import { createHash } from "node:crypto";
import type { TxClient } from "../db.js";
import { isOwnInFlightEcho, type EchoHistoryEntry } from "../messengers/inFlightEcho.js";
import { isFinalCustomerInputFrame } from "./customerInputFrame.js";
import type { CustomerNormalizedIngressInput, CustomerPendingVerification } from "./customerIngressPayload.js";
import { inspectCustomerDeliveryObservation } from "./customerDeliveryObservation.js";

type ReadDb = Pick<TxClient, "$queryRaw">;
const normalizeName = (value: string) => value.trim().replace(/^@/, "").toLowerCase();
const normalizeText = (value: string) => value.replace(/\s+/g, " ").trim();
export async function readRecoveryOwnIdentities(db: ReadDb) {
  const accounts = await db.$queryRaw<Array<{ id: string; channel: string; username: string | null; externalId: string; messagingId: string | null; extraExternalIds: string[] }>>`
    SELECT "id","channel","username","externalId","messagingId","extraExternalIds" FROM "MessengerAccount" ORDER BY "id" LIMIT 129`;
  const settings = await db.$queryRaw<Array<{ pageId: string | null; waId: string | null }>>`
    SELECT "metaPageId" AS "pageId","metaWaPhoneId" AS "waId" FROM "Settings" WHERE "id"='singleton'`;
  const staff = await db.$queryRaw<Array<{ phone: string }>>`SELECT "phone" FROM "Agent" ORDER BY "id" LIMIT 513`;
  if (accounts.length > 128 || staff.length > 512 || settings.length !== 1) throw new Error("Own identity registry unavailable");
  const ids = new Set(accounts.flatMap(row => [row.externalId, row.messagingId, ...row.extraExternalIds]).filter((value): value is string => !!value));
  for (const value of [settings[0].pageId, settings[0].waId]) if (value) ids.add(value);
  const usernames = new Set(accounts.map(row => row.username).filter((value): value is string => !!value).map(normalizeName));
  const staffPhones = new Set(staff.map(row => row.phone.replace(/\D/g, "")).filter(Boolean));
  return { ids, usernames, staffPhones, instagramComplete: accounts.filter(row => row.channel === "INSTAGRAM").every(row => !!row.username?.trim()),
    whatsappAccountIds: accounts.filter(row => row.channel === "WHATSAPP").map(row => row.id), installedWhatsappId: settings[0].waId,
    hash: createHash("sha256").update(JSON.stringify({ accounts, settings, staff })).digest("hex") };
}
export type CustomerPendingFrameClassification =
  | { status: "eligible" }
  | { status: "ignored"; reason: "provider_echo" | "referral_only" | "bare_template" | "own_account" | "staff_sender" | "outgoing_mid" }
  | { status: "held"; reason: "old_classification_unavailable" | "own_identity_required" | "own_identity_registry_incomplete" |
      "sender_observation_stale" | "delivery_ambiguous" | "history_ambiguous" | "unscoped_outgoing_mid" | "unsupported_channel" | "own_phone_identity_unavailable" };

/** Read-only classifier, NOT an authority factory. The caller is the existing
 * authority module and passes only its decrypted pending WeakMap evidence.
 * DB/query failure throws to HOLD; no empty-cache/failure-as-false fallback. */
export async function classifyCustomerPendingFrame(db: ReadDb, payload: CustomerNormalizedIngressInput,
  verification: CustomerPendingVerification, observedSender?: { username: string; ownIdentitiesHash: string }): Promise<CustomerPendingFrameClassification> {
  if (payload.channel === "WEBSITE") return { status: "held", reason: "unsupported_channel" };
  if (payload.observations.providerEcho) return { status: "ignored", reason: "provider_echo" };
  if (payload.observations.referralOnly) return { status: "ignored", reason: "referral_only" };
  if (!payload.observations.classifier) return { status: "held", reason: "old_classification_unavailable" };
  if (payload.observations.classifier.bareTemplateEcho) return { status: "ignored", reason: "bare_template" };
  const own = await readRecoveryOwnIdentities(db);
  let ownAccountSender = own.ids.has(payload.peer);
  if (ownAccountSender) return { status: "ignored", reason: "own_account" };
  const fromStaff = payload.channel === "WHATSAPP" && own.staffPhones.has(payload.peer.replace(/\D/g, ""));
  if (fromStaff) return { status: "ignored", reason: "staff_sender" };
  const delivery = await inspectCustomerDeliveryObservation({ endpointScopeId: verification.endpointScopeId, peerId: payload.peer,
    mid: payload.eventId, observedAt: new Date(verification.issuedAt) }, db);
  if (delivery.status === "known_own") return { status: "ignored", reason: "outgoing_mid" };
  if (delivery.status !== "none") return { status: "held", reason: "delivery_ambiguous" };
  const natives = await db.$queryRaw<Array<{ messages: unknown }>>`SELECT "messages" FROM "BotConversation"
    WHERE "endpointScopeId"=${verification.endpointScopeId} AND "channel"=${payload.channel} AND "subscriberId"=${payload.peer}
      AND "accountId" IS NOT DISTINCT FROM ${verification.accountId} LIMIT 2`;
  if (natives.length > 1) return { status: "held", reason: "history_ambiguous" };
  const rawHistory = natives[0]?.messages;
  const history = Array.isArray(rawHistory) ? rawHistory.filter((entry): entry is EchoHistoryEntry => !!entry && typeof entry === "object") : [];
  const knownOutgoingMid = history.some(entry => entry.role === "assistant" && (entry.mid === payload.eventId || entry.mid2 === payload.eventId));
  if (knownOutgoingMid) return { status: "ignored", reason: "outgoing_mid" };
  // Legacy global marks have no native binding. Use them only to HOLD, never
  // as positive input evidence, and never consult process-local sentAt cache.
  const marks = await db.$queryRaw<Array<{ createdAt: Date }>>`SELECT "createdAt" FROM "ProcessedMessage"
    WHERE "channel"='out:meta' AND "messageId"=${payload.eventId} LIMIT 1`;
  if (marks.length) return { status: "held", reason: "unscoped_outgoing_mid" };
  // Do not move the echo window to worker-start time or use future history.
  const arrivalHistory = history.filter(entry => typeof entry.at === "string" && Number.isFinite(Date.parse(entry.at)) && Date.parse(entry.at) <= verification.issuedAt);
  const inFlightBotEcho = isOwnInFlightEcho(arrivalHistory, payload.inputText, verification.issuedAt);
  if (inFlightBotEcho) return { status: "held", reason: "history_ambiguous" };
  const text = normalizeText(payload.inputText);
  if (text && history.some(entry => entry.role === "assistant" && typeof entry.content === "string" &&
      normalizeText(entry.content) === text && (typeof entry.at !== "string" || !Number.isFinite(Date.parse(entry.at)) ||
        Date.parse(entry.at) <= verification.issuedAt && verification.issuedAt - Date.parse(entry.at) <= 120_000 && entry.by?.kind !== "bot"))) {
    return { status: "held", reason: "history_ambiguous" };
  }
  if (payload.channel === "INSTAGRAM") {
    if (!own.instagramComplete) return { status: "held", reason: "own_identity_registry_incomplete" };
    if (!observedSender) return { status: "held", reason: "own_identity_required" };
    if (observedSender.ownIdentitiesHash !== own.hash) return { status: "held", reason: "sender_observation_stale" };
    ownAccountSender = own.usernames.has(normalizeName(observedSender.username));
    if (ownAccountSender) return { status: "ignored", reason: "own_account" };
  }
  if (payload.channel === "WHATSAPP") {
    const businessPhone = payload.observations.classifier.recipientPhoneDigits;
    if (!businessPhone || !/^\+?\d{8,15}$/.test(payload.peer) || own.whatsappAccountIds.some(id => id !== verification.accountId) ||
        own.installedWhatsappId && own.installedWhatsappId !== payload.accountExternalId) {
      return { status: "held", reason: "own_phone_identity_unavailable" };
    }
    ownAccountSender = payload.peer.replace(/^\+/, "") === businessPhone;
    if (ownAccountSender) return { status: "ignored", reason: "own_account" };
  }
  return isFinalCustomerInputFrame({ kind: payload.eventKind === "postback" ? "postback" : "message",
    isEcho: payload.observations.providerEcho, referralOnly: payload.observations.referralOnly,
    bareTemplateEcho: payload.observations.classifier.bareTemplateEcho,
    // Negatives here are results of the actual DB/attested checks above, not
    // defaults invented by a replay caller or model-supplied flags.
    ownAccountSender, fromStaff, knownOutgoingMid, inFlightBotEcho })
    ? { status: "eligible" } : { status: "held", reason: "history_ambiguous" };
}
