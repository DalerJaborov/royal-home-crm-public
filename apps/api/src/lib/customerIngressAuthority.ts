import { z } from "zod";
import { createHmac, timingSafeEqual } from "node:crypto";
import { prisma, type TxClient } from "../db.js";
import { decryptSecretSafe } from "../crypto.js";
import type { CustomerFence, CustomerPropertyAdmission } from "@royal-home/shared";
import { readInstalledCustomerTransport } from "./customerInstalledTransport.js";
import { ensureCustomerEndpoint, type CustomerTransportReference } from "./customerConversationScope.js";
import { isFinalCustomerInputFrame } from "./customerInputFrame.js";
import { customerDbVerifierCredential, type CustomerVerifierCredential } from "./customerOriginCredential.js";
import { customerPendingVerificationSchema, decryptCustomerIngressEnvelope, type CustomerNormalizedIngressInput, type CustomerPendingVerification } from "./customerIngressPayload.js";
import { decryptCustomerFinalOrigin, encryptCustomerFinalOrigin, type CustomerFinalOrigin } from "./customerOriginPayload.js";
import { customerPropertyEventKey, customerPropertyScopeKey } from "./customerPropertyScope.js";
import { isActiveTransactionClient } from "./transactionScope.js";
import { classifyCustomerPendingFrame, readRecoveryOwnIdentities, type CustomerPendingFrameClassification } from "./customerIngressClassification.js";
import { readRecoveryInstagramCredential, readRecoveryInstagramUsername } from "./customerInstagramSenderRead.js";
import { decryptCustomerSenderObservation, encryptCustomerSenderObservation, type CustomerSenderObservationContext } from "./customerSenderObservation.js";
import { lockCustomerNative } from "./customerNativeLock.js";

const requestProvenance = new WeakMap<object, "meta_signature" | "website_application_key">();
const requestCapturedAt = new WeakMap<object, number>();
type MetaIssuer = { protectedMetaAccountId: string | null; accountId: string | null; channel: string; externalId: string;
  endpointScopeId: string; scopeRevision: string; policyRevision: string;
  issuerSource: "account_secret" | "single_channel_global" | "verified_public_envelope";
  verifierCredential?: CustomerVerifierCredential | null };
const boundIssuers = new WeakMap<object, Map<string, MetaIssuer>>();
const publicIssuers = new WeakMap<object, Map<string, MetaIssuer>>();
const inputSchema = z.object({ channel: z.enum(["INSTAGRAM", "FACEBOOK", "WHATSAPP", "WEBSITE"]),
  peer: z.string().min(1).max(512), accountExternalId: z.string().min(1).max(512).optional(),
  eventId: z.string().min(1).max(512), inputText: z.string().max(8000),
  eventKind: z.enum(["message", "postback", "website_message", "direct"]),
}).strict();
type InputEvidence = z.infer<typeof inputSchema> & {
  provenance: "meta_signature" | "website_application_key";
  protectedMetaAccountId: string | null;
  protectedMetaEndpointScopeId: string | null;
  issuerAccountId: string | null;
  assurance: "protected_namespace" | "public_envelope" | "website_public_input";
  issuerSource: "account_secret" | "single_channel_global" | "verified_public_envelope" | "website_application_key";
  issuerEndpointScopeId: string | null; issuerScopeRevision: string | null;
  issuerPolicyRevision: string | null;
  acceptedFence?: CustomerFence;
  issuedAt: number;
  verifierCredential?: CustomerVerifierCredential | null;
};
const inputs = new WeakMap<object, InputEvidence>();
declare const inputBrand: unique symbol;
export type AuthenticatedCustomerInput = { readonly [inputBrand]: true };

/** Called only by the signature/key middleware after actual verification.
 * No secret/body content is retained; a customer JSON object cannot reproduce
 * the request's runtime provenance marker. Never accepts phone/staff claims. */
export function registerAuthenticatedMetaCustomerRequest(request: object): void {
  requestProvenance.set(request, "meta_signature");
  if (!requestCapturedAt.has(request)) requestCapturedAt.set(request, Date.now());
}
export function registerAuthenticatedWebsiteCustomerRequest(request: object): void {
  requestProvenance.set(request, "website_application_key");
  if (!requestCapturedAt.has(request)) requestCapturedAt.set(request, Date.now());
}
/** Read-only middleware evidence for the same-request durable normalizer. This
 * is not FINAL-IN classification or a customer/write authority. */
export function authenticatedCustomerRequestEvidence(request: object): { provenance: "meta_signature" | "website_application_key"; issuedAt: number } | null {
  const provenance = requestProvenance.get(request), issuedAt = requestCapturedAt.get(request);
  return provenance && issuedAt !== undefined && Date.now() >= issuedAt && Date.now() - issuedAt <= 15 * 60_000 ? { provenance, issuedAt } : null;
}
export interface CustomerMetaIssuerStore {
  readTarget(channel: string, externalId: string): Promise<Array<{ id: string; explicitSecret: boolean; secret: string | null;
    endpointScopeId: string | null; scopeRevision: string | null; policyRevision: string | null;
    verifierCredential?: CustomerVerifierCredential | null }>>;
  readGlobalSecrets(): Promise<{ global: string | null; instagram: string | null;
    credentials?: { global: CustomerVerifierCredential | null; instagram: CustomerVerifierCredential | null } }>;
  readInstalledTarget?(channel: string, externalId: string): Promise<{ signingSecret: string | null; endpointScopeId: string | null;
    scopeRevision: string | null; policyRevision: string | null; signingCredential?: CustomerVerifierCredential | null } | null>;
}
function issuerStoreFor(db: Pick<TxClient, "$queryRaw" | "settings">): CustomerMetaIssuerStore { return {
  async readTarget(channel, externalId) {
    // Key and rev share one statement snapshot: reading an old key then a new
    // scope revision in separate awaits would revive a rotated credential.
    const rows = await db.$queryRaw<{ id: string; appSecret: string | null; endpointScopeId: string | null; scopeRevision: bigint | null; policyRevision: bigint | null }[]>`
      SELECT a."id", a."appSecret", s."id" AS "endpointScopeId", s."scopeRevision", p."policyRevision"
      FROM "MessengerAccount" a LEFT JOIN "CustomerEndpointScope" s ON s."messengerAccountId"=a."id"
        AND s."realmKey"='royal-home' AND s."channel"=a."channel" AND s."transportKey"=('messenger-account:'||a."id") AND s."kind"='NORMAL'
      LEFT JOIN "CustomerRuntimePolicy" p ON p."id"='singleton'
      WHERE a."channel"=${channel} AND (a."externalId"=${externalId} OR a."messagingId"=${externalId} OR ${externalId}=ANY(a."extraExternalIds"))
      LIMIT 2`;
    return rows.map(row => ({ id: row.id, explicitSecret: !!row.appSecret, secret: decryptSecretSafe(row.appSecret) || null,
      verifierCredential: customerDbVerifierCredential("account_app_secret", row.id, row.appSecret, decryptSecretSafe(row.appSecret)),
      endpointScopeId: row.endpointScopeId, scopeRevision: row.scopeRevision?.toString() ?? null, policyRevision: row.policyRevision?.toString() ?? null }));
  },
  async readGlobalSecrets() {
    const settings = await db.settings.findUnique({ where: { id: "singleton" }, select: { metaAppSecret: true, metaIgAppSecret: true } });
    const dbGlobal = decryptSecretSafe(settings?.metaAppSecret ?? null), dbInstagram = decryptSecretSafe(settings?.metaIgAppSecret ?? null);
    return { global: dbGlobal || process.env.META_APP_SECRET || null,
      instagram: dbInstagram || process.env.META_IG_APP_SECRET || null,
      credentials: { global: customerDbVerifierCredential("settings_meta_app_secret", "singleton", settings?.metaAppSecret, dbGlobal),
        instagram: customerDbVerifierCredential("settings_meta_ig_app_secret", "singleton", settings?.metaIgAppSecret, dbInstagram) } };
  },
  async readInstalledTarget(channel, externalId) { return readInstalledCustomerTransport(db, channel, externalId); },
}; }
const issuerStore = issuerStoreFor(prisma);

/** Called by the SAME-raw-request normalizer/persister. This records verified
 * envelope provenance only; there is no native/accepted fence or FINAL brand. */
export async function captureCustomerPendingVerification(request: object & { rawBody?: Buffer; get(name: string): string | undefined },
  entry: CustomerNormalizedIngressInput, endpoint: CustomerTransportReference, db: TxClient): Promise<CustomerPendingVerification | null> {
  const requestEvidence = authenticatedCustomerRequestEvidence(request);
  if (!requestEvidence || endpoint.channel !== entry.channel) return null;
  const [policy] = await db.$queryRaw<Array<{ policyRevision: bigint }>>`SELECT "policyRevision" FROM "CustomerRuntimePolicy" WHERE "id"='singleton'`;
  if (!policy) return null;
  if (entry.channel === "WEBSITE") return customerPendingVerificationSchema.parse({ version: 1, classification: "PENDING_ENVELOPE",
    provenance: "website_application_key", assurance: "website_public_input", issuerSource: "website_application_key",
    accountId: null, endpointScopeId: endpoint.endpointScopeId, scopeRevision: endpoint.scopeRevision,
    policyRevision: policy.policyRevision.toString(), issuedAt: requestEvidence.issuedAt, source: entry.source, verifierCredential: null });
  const store = issuerStoreFor(db), target = { channel: entry.channel, accountId: endpoint.accountId, accountExternalId: entry.accountExternalId };
  const strong = await verifyAndRegisterMetaCustomerIssuer(request, target, store);
  if (!strong && !await verifyAndRegisterPublicMetaCustomerIssuer(request, target, store)) return null;
  const key = JSON.stringify([entry.channel, entry.accountExternalId]);
  const issuer = (strong ? boundIssuers : publicIssuers).get(request)?.get(key);
  if (!issuer || issuer.endpointScopeId !== endpoint.endpointScopeId || issuer.scopeRevision !== endpoint.scopeRevision ||
      issuer.policyRevision !== policy.policyRevision.toString()) return null;
  return customerPendingVerificationSchema.parse({ version: 1, classification: "PENDING_ENVELOPE", provenance: "meta_signature",
    assurance: strong ? "protected_namespace" : "public_envelope", issuerSource: issuer.issuerSource,
    accountId: issuer.accountId, endpointScopeId: issuer.endpointScopeId, scopeRevision: issuer.scopeRevision,
    policyRevision: issuer.policyRevision, issuedAt: requestEvidence.issuedAt, source: entry.source,
    verifierCredential: issuer.verifierCredential ?? null });
}
function exactSignature(rawBody: Buffer, header: string, secret: string): boolean {
  if (!/^sha256=[a-f\d]{64}$/i.test(header)) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  const actual = Buffer.from(header.slice(7), "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
/** Same-body target key check only: no namespace creation or branded issuer. */
async function readVerifiedMetaRoutingTarget(
  request: object & { rawBody?: Buffer; get(name: string): string | undefined },
  target: { channel: "INSTAGRAM" | "FACEBOOK" | "WHATSAPP"; peer: string; accountExternalId?: string },
  store: CustomerMetaIssuerStore,
): Promise<{ accountId: string | null } | null> {
  if (!target.peer || target.peer.length > 512 || requestProvenance.get(request) !== "meta_signature" || !request.rawBody || !target.accountExternalId) return null;
  const rawBody = request.rawBody;
  const header = request.get("x-hub-signature-256"); if (!header) return null;
  const rows = await store.readTarget(target.channel, target.accountExternalId);
  let keys: string[];
  if (rows.length === 0 && (target.channel === "WHATSAPP" || target.channel === "FACEBOOK")) {
    const installed = await store.readInstalledTarget?.(target.channel, target.accountExternalId);
    if (!installed?.signingSecret) return null;
    keys = [installed.signingSecret];
  } else if (rows.length === 1) {
    if (await store.readInstalledTarget?.(target.channel, target.accountExternalId)) return null;
    const globals = await store.readGlobalSecrets();
    // Multiple IG fallback keys allow routing/public-envelope assurance only;
    // the separate strong issuer still requires own key or one relevant key.
    keys = (rows[0].explicitSecret ? [rows[0].secret]
      : [globals.global, ...(target.channel === "INSTAGRAM" ? [globals.instagram] : [])]).filter((key): key is string => !!key);
  } else return null;
  if (!keys.some(key => exactSignature(rawBody, header, key))) return null;
  return { accountId: rows[0]?.id ?? null };
}
/** An unnumbered referral can become public context only for the SAME verified
 * request and configured target keys. This never creates scope/native/ticket or
 * registers an issuer/input/private/action authority; a future MID is required. */
export async function verifyMetaCustomerReferralTarget(
  request: object & { rawBody?: Buffer; get(name: string): string | undefined },
  target: { channel: "INSTAGRAM" | "FACEBOOK" | "WHATSAPP"; peer: string; accountExternalId?: string },
  store: CustomerMetaIssuerStore = issuerStore,
): Promise<boolean> {
  try { return !!await readVerifiedMetaRoutingTarget(request, target, store); }
  catch (error) {
    console.error("[customer-issuer] referral target verification unavailable", error instanceof Error ? error.name : "unknown");
    return false;
  }
}
/** First genuine input on an env-only installation may create its routing
 * namespace. This never adopts an old native, imports memory, or mints input/
 * write authority. Echo/status/staff and arbitrary caller JSON cannot substitute
 * for the middleware's verified request and same-body configured-target HMAC. */
export async function initializeVerifiedCustomerEndpoint(
  request: object & { rawBody?: Buffer; get(name: string): string | undefined },
  target: { channel: "INSTAGRAM" | "FACEBOOK" | "WHATSAPP"; peer: string; accountExternalId?: string },
  frame: Parameters<typeof isFinalCustomerInputFrame>[0], store: CustomerMetaIssuerStore = issuerStore,
): Promise<CustomerTransportReference | null> {
  if (!isFinalCustomerInputFrame(frame)) return null;
  try {
    const verified = await readVerifiedMetaRoutingTarget(request, target, store);
    if (!verified) return null;
    return await prisma.$transaction(tx => ensureCustomerEndpoint(tx, { channel: target.channel, subscriberId: target.peer,
      accountId: verified.accountId, accountExternalId: target.accountExternalId }));
  } catch (error) {
    console.error("[customer-issuer] routing initialization unavailable", error instanceof Error ? error.name : "unknown");
    return null;
  }
}
/** Companion namespace proof; the legacy ANY-secret verifier remains unchanged.
 * Explicit account secret NEVER falls back to another app's key. With no own
 * secret, EXACTLY ONE relevant configured global key must verify the request
 * (several may be configured: the signature picks the issuing app); a request
 * signed by none of them stays closed for actions/receipt reuse. No secret is stored
 * in the runtime evidence. Called only on the same verified request/frame. */
export async function verifyAndRegisterMetaCustomerIssuer(request: object & { rawBody?: Buffer; get(name: string): string | undefined },
  target: { channel: "INSTAGRAM" | "FACEBOOK" | "WHATSAPP"; accountId: string | null; accountExternalId?: string },
  store: CustomerMetaIssuerStore = issuerStore): Promise<boolean> {
  try {
  if (requestProvenance.get(request) !== "meta_signature" || !request.rawBody || !target.accountExternalId) return false;
  const header = request.get("x-hub-signature-256"); if (!header) return false;
  const rows = await store.readTarget(target.channel, target.accountExternalId);
  if (target.accountId === null) {
    // Do not cross from an existing installed account to the singleton fallback.
    if (rows.length !== 0 || (target.channel !== "WHATSAPP" && target.channel !== "FACEBOOK")) return false;
    const installed = await store.readInstalledTarget?.(target.channel, target.accountExternalId);
    if (!installed?.signingSecret || !installed.endpointScopeId || installed.scopeRevision === null || installed.policyRevision === null ||
        !exactSignature(request.rawBody, header, installed.signingSecret)) return false;
    const issuers = boundIssuers.get(request) ?? new Map<string, MetaIssuer>();
    issuers.set(JSON.stringify([target.channel, target.accountExternalId]), { protectedMetaAccountId: null, accountId: null,
      channel: target.channel, externalId: target.accountExternalId, issuerSource: "single_channel_global",
      endpointScopeId: installed.endpointScopeId, scopeRevision: installed.scopeRevision, policyRevision: installed.policyRevision,
      verifierCredential: installed.signingCredential ?? null });
    boundIssuers.set(request, issuers);
    return true;
  }
  if (rows.length !== 1 || rows[0].id !== target.accountId || !rows[0].endpointScopeId || rows[0].scopeRevision === null || rows[0].policyRevision === null) return false;
  if (await store.readInstalledTarget?.(target.channel, target.accountExternalId)) return false;
  let secret: string | null = rows[0].secret, issuerSource: MetaIssuer["issuerSource"] = "account_secret";
  let verifierCredential = rows[0].verifierCredential ?? null;
  if (!rows[0].explicitSecret) {
    const globals = await store.readGlobalSecrets();
    const relevant = [...new Set((target.channel === "INSTAGRAM" ? [globals.global, globals.instagram] : [globals.global]).filter((key): key is string => !!key))];
    // With two configured keys the request's own signature says which app issued
    // it: the proof holds when EXACTLY ONE relevant key matches (23.10.2026,
    // F02 — counting configured keys left every such account at public_envelope).
    // The credential below is that of the matched key, as for a lone key.
    const matching = relevant.filter(key => exactSignature(request.rawBody!, header, key));
    if (matching.length !== 1) return false;
    secret = matching[0]; issuerSource = "single_channel_global";
    verifierCredential = globals.global === secret ? globals.credentials?.global ?? null : globals.credentials?.instagram ?? null;
  }
  if (!secret || !exactSignature(request.rawBody, header, secret)) return false;
  const issuers = boundIssuers.get(request) ?? new Map<string, MetaIssuer>();
  issuers.set(JSON.stringify([target.channel, target.accountExternalId]), { protectedMetaAccountId: rows[0].id, accountId: rows[0].id,
    channel: target.channel, externalId: target.accountExternalId, issuerSource,
    endpointScopeId: rows[0].endpointScopeId, scopeRevision: rows[0].scopeRevision, policyRevision: rows[0].policyRevision, verifierCredential });
  boundIssuers.set(request, issuers);
  return true;
  } catch (error) {
    // New actions fail closed; legacy public ingestion keeps its previous
    // verifier. Do not log credentials/body or silently allow the namespace.
    console.error("[customer-issuer] namespace verification unavailable", error instanceof Error ? error.name : "unknown");
    return false;
  }
}
/** Explicit weaker assurance for public facts only. Current ANY-envelope key
 * plus exact installed target does NOT prove which app owns the target. This
 * proof never sets protected IDs, mints local writes or reuses contact/receipt.
 * Rechecking the current relevant keys avoids adopting a rotated old signature.
 * Caller must still perform FINAL-IN classification before canonical acceptance. */
export async function verifyAndRegisterPublicMetaCustomerIssuer(request: object & { rawBody?: Buffer; get(name: string): string | undefined },
  target: { channel: "INSTAGRAM" | "FACEBOOK" | "WHATSAPP"; accountId: string | null; accountExternalId?: string },
  store: CustomerMetaIssuerStore = issuerStore): Promise<boolean> {
  try {
    if (requestProvenance.get(request) !== "meta_signature" || !request.rawBody || !target.accountId || !target.accountExternalId) return false;
    const rawBody = request.rawBody;
    const header = request.get("x-hub-signature-256"); if (!header) return false;
    const rows = await store.readTarget(target.channel, target.accountExternalId);
    if (rows.length !== 1 || rows[0].id !== target.accountId || !rows[0].endpointScopeId || rows[0].scopeRevision === null || rows[0].policyRevision === null ||
        await store.readInstalledTarget?.(target.channel, target.accountExternalId)) return false;
    const globals = await store.readGlobalSecrets();
    const keys = [rows[0].secret, globals.global, ...(target.channel === "INSTAGRAM" ? [globals.instagram] : [])]
      .filter((key): key is string => !!key);
    const matched = keys.find(key => exactSignature(rawBody, header, key));
    if (!matched) return false;
    const verifierCredential = rows[0].secret === matched ? rows[0].verifierCredential ?? null
      : globals.global === matched ? globals.credentials?.global ?? null : globals.credentials?.instagram ?? null;
    const issuers = publicIssuers.get(request) ?? new Map<string, MetaIssuer>();
    issuers.set(JSON.stringify([target.channel, target.accountExternalId]), { protectedMetaAccountId: null, accountId: rows[0].id,
      channel: target.channel, externalId: target.accountExternalId, issuerSource: "verified_public_envelope",
      endpointScopeId: rows[0].endpointScopeId, scopeRevision: rows[0].scopeRevision, policyRevision: rows[0].policyRevision, verifierCredential });
    publicIssuers.set(request, issuers); return true;
  } catch (error) {
    console.error("[customer-issuer] public namespace verification unavailable", error instanceof Error ? error.name : "unknown");
    return false;
  }
}
/** Called on the authenticated handler's normalized event before enrichment.
 * A site application key authorizes that new public input only; it does not
 * prove browser ownership of previous session memory. */
export function captureAuthenticatedCustomerInput(request: object, raw: z.infer<typeof inputSchema>): AuthenticatedCustomerInput | null {
  const requestEvidence = authenticatedCustomerRequestEvidence(request), provenance = requestEvidence?.provenance, parsed = inputSchema.safeParse(raw);
  if (!provenance || !parsed.success || (provenance === "website_application_key") !== (parsed.data.channel === "WEBSITE") ||
      (parsed.data.channel !== "WEBSITE" && !parsed.data.accountExternalId)) return null;
  const issuerKey = JSON.stringify([parsed.data.channel, parsed.data.accountExternalId]);
  const issuer = provenance === "meta_signature" ? boundIssuers.get(request)?.get(issuerKey) ?? publicIssuers.get(request)?.get(issuerKey) : null;
  if (provenance === "meta_signature" && !issuer) return null;
  const input = Object.freeze({}) as AuthenticatedCustomerInput;
  inputs.set(input, { ...parsed.data, provenance, protectedMetaAccountId: issuer?.protectedMetaAccountId ?? null,
    protectedMetaEndpointScopeId: issuer && issuer.issuerSource !== "verified_public_envelope" ? issuer.endpointScopeId : null,
    issuerAccountId: issuer?.accountId ?? null,
    assurance: provenance === "website_application_key" ? "website_public_input"
      : issuer?.issuerSource === "verified_public_envelope" ? "public_envelope" : "protected_namespace",
    issuerSource: issuer?.issuerSource ?? "website_application_key", issuerEndpointScopeId: issuer?.endpointScopeId ?? null,
    issuerScopeRevision: issuer?.scopeRevision ?? null, issuerPolicyRevision: issuer?.policyRevision ?? null, issuedAt: requestEvidence!.issuedAt,
    verifierCredential: issuer?.verifierCredential ?? null });
  return input;
}
/** Server-only evidence. Neither a principal nor a private/client grant. */
export function inspectAuthenticatedCustomerInput(value: unknown): Readonly<InputEvidence> | null {
  const input = value && typeof value === "object" ? inputs.get(value) : undefined;
  return input && Date.now() >= input.issuedAt && Date.now() - input.issuedAt <= 15 * 60_000 ? structuredClone(input) : null;
}
/** Server adapter marks the ACTUAL resulting accepted state. Neither a tool
 * argument nor a phone/admission reference may call this on an unbranded object. */
export function bindAcceptedCustomerInput(input: AuthenticatedCustomerInput, fence: CustomerFence): boolean {
  const value = inputs.get(input);
  if (!value || (value.provenance === "meta_signature" && (value.issuerAccountId !== fence.endpoint.accountId ||
      value.issuerEndpointScopeId !== fence.endpoint.endpointScopeId || value.issuerScopeRevision !== fence.scopeRevision))) return false;
  if (value.provenance === "meta_signature" && value.issuerPolicyRevision !== fence.policyRevision) return false;
  // A repeated delivery must not silently upgrade an already captured boundary.
  if (value.acceptedFence) return authenticatedInputMatchesFence(input, fence);
  inputs.set(input, { ...value, acceptedFence: structuredClone(fence) });
  return true;
}
export function authenticatedInputMatchesFence(input: AuthenticatedCustomerInput, current: CustomerFence): boolean {
  const evidence = inspectAuthenticatedCustomerInput(input), old = evidence?.acceptedFence;
  return !!old && old.inquiryId === current.inquiryId && old.nativeId === current.nativeId && old.ownerToken === current.ownerToken &&
    old.endpoint.endpointScopeId === current.endpoint.endpointScopeId && old.endpoint.accountId === current.endpoint.accountId &&
    old.endpoint.channel === current.endpoint.channel && old.endpoint.peerId === current.endpoint.peerId && old.endpoint.threadId === current.endpoint.threadId &&
    old.bindingRevision === current.bindingRevision && old.ownershipEpoch === current.ownershipEpoch &&
    old.scopeRevision === current.scopeRevision && old.policyRevision === current.policyRevision;
}

type OriginDb = Pick<TxClient, "$queryRaw" | "$executeRaw" | "settings">;
type OriginTicketRow = { eventKey: string; order: bigint; scopeKey: string; endpointScopeId: string | null;
  conversationId: string | null; originalConversationId: string | null; tombstonedAt: Date | null;
  payloadVersion: number | null; payloadCiphertext: string | null; payloadHash: string | null; receivedAt: Date;
  senderObservationVersion: number | null; senderObservationCiphertext: string | null; senderObservedAt: Date | null;
  originVersion: number | null; originCiphertext: string | null; originCapturedAt: Date | null; inputRecordedAt: Date | null };
async function originTicket(db: OriginDb, eventKey: string, lock: boolean): Promise<OriginTicketRow | null> {
  // Keep the lock variant explicit: no raw interpolation of SQL identifiers.
  const rows = lock ? await db.$queryRaw<OriginTicketRow[]>`SELECT * FROM "CustomerPropertyIngressTicket" WHERE "eventKey"=${eventKey} FOR UPDATE`
    : await db.$queryRaw<OriginTicketRow[]>`SELECT * FROM "CustomerPropertyIngressTicket" WHERE "eventKey"=${eventKey}`;
  return rows.length === 1 ? rows[0] : null;
}
function pendingEnvelopeForTicket(row: OriginTicketRow) {
  if (row.tombstonedAt || (row.originalConversationId && row.originalConversationId !== row.conversationId) ||
      row.payloadVersion !== 1 || !row.payloadCiphertext || !row.payloadHash || !row.endpointScopeId) throw new Error("Durable input unavailable");
  return decryptCustomerIngressEnvelope({ version: 1, eventKey: row.eventKey, order: row.order.toString(), scopeKey: row.scopeKey,
    endpointScopeId: row.endpointScopeId, payloadHash: row.payloadHash }, row.payloadCiphertext);
}
function payloadForTicket(row: OriginTicketRow) {
  if (!row.conversationId || row.originalConversationId !== row.conversationId) throw new Error("Bound input unavailable");
  return pendingEnvelopeForTicket(row);
}
function unexpired(issuedAt: number): boolean { return Date.now() >= issuedAt && Date.now() - issuedAt <= 15 * 60_000; }
async function credentialCurrent(db: OriginDb, input: Pick<CustomerFinalOrigin["input"], "verifierCredential" | "provenance" | "accountExternalId" | "channel" | "issuerAccountId">): Promise<boolean> {
  const witness = input.verifierCredential;
  // Env/application-only provenance has no durable DB credential epoch.
  if (!witness || input.provenance !== "meta_signature" || !input.accountExternalId) return false;
  const store = issuerStoreFor(db), rows = await store.readTarget(input.channel, input.accountExternalId);
  if (input.issuerAccountId ? rows.length !== 1 || rows[0].id !== input.issuerAccountId : rows.length !== 0) return false;
  let current: CustomerVerifierCredential | null | undefined;
  if (witness.source === "account_app_secret") {
    if (!input.issuerAccountId || witness.sourceId !== input.issuerAccountId) return false;
    current = rows[0].verifierCredential;
  } else {
    if (witness.sourceId !== "singleton") return false;
    const globals = await store.readGlobalSecrets();
    current = witness.source === "settings_meta_app_secret" ? globals.credentials?.global : globals.credentials?.instagram;
    if (witness.source === "settings_meta_ig_app_secret" && input.channel !== "INSTAGRAM") return false;
  }
  return !!current && JSON.stringify(current) === JSON.stringify(witness);
}
/** A retry keeps the FIRST durable observation age, even when redelivery has a
 * newly verified request marker. This only shortens a genuine frame's lifetime. */
export async function bindDurableCustomerInputAgeTx(db: TxClient, input: AuthenticatedCustomerInput, ticket: CustomerPropertyAdmission): Promise<boolean> {
  if (!isActiveTransactionClient(db)) return false;
  const evidence = inspectAuthenticatedCustomerInput(input), row = await originTicket(db, ticket.eventKey, true);
  if (!evidence || !row || row.order.toString() !== ticket.order || row.conversationId !== ticket.conversationId || row.scopeKey !== ticket.scopeKey) return false;
  try {
    const { payload, verification } = payloadForTicket(row), issuedAt = row.receivedAt.getTime();
    if (!unexpired(issuedAt) || verification.issuedAt !== issuedAt || issuedAt > evidence.issuedAt ||
        payload.observations.providerEcho || payload.observations.referralOnly || payload.channel !== evidence.channel ||
        payload.peer !== evidence.peer || payload.eventId !== evidence.eventId || payload.eventKind !== evidence.eventKind ||
        payload.inputText !== evidence.inputText || payload.accountExternalId !== evidence.accountExternalId ||
        verification.accountId !== evidence.issuerAccountId || verification.assurance !== evidence.assurance ||
        verification.issuerSource !== evidence.issuerSource || verification.endpointScopeId !== evidence.issuerEndpointScopeId ||
        verification.scopeRevision !== evidence.issuerScopeRevision || verification.policyRevision !== evidence.issuerPolicyRevision ||
        JSON.stringify(verification.verifierCredential) !== JSON.stringify(evidence.verifierCredential ?? null)) return false;
    inputs.set(input, { ...evidence, issuedAt });
    return true;
  } catch { return false; }
}

declare const pendingEnvelopeBrand: unique symbol;
export type RecoveredCustomerPendingEnvelope = { readonly [pendingEnvelopeBrand]: true };
const recoveredPending = new WeakMap<object, { payload: CustomerNormalizedIngressInput; verification: CustomerPendingVerification; eventKey: string; order: string }>();
/** Restart-safe envelope evidence for a FUTURE actual classifier. Neither this
 * brand nor its inspected projection is AuthenticatedCustomerInput/FINAL. */
export async function recoverCustomerPendingEnvelope(eventKey: string, db: OriginDb = prisma): Promise<
  { status: "pending"; envelope: RecoveredCustomerPendingEnvelope } | { status: "held"; reason: string }
> {
  try {
    const row = await originTicket(db, eventKey, false);
    if (!row) return { status: "held", reason: "pending_missing" };
    const { payload, verification } = pendingEnvelopeForTicket(row);
    const [current] = await db.$queryRaw<Array<{ scopeRevision: bigint; policyRevision: bigint; accountId: string | null; channel: string }>>`
      SELECT s."scopeRevision",p."policyRevision",s."messengerAccountId" AS "accountId",s."channel"
      FROM "CustomerEndpointScope" s JOIN "CustomerRuntimePolicy" p ON p."id"='singleton'
      WHERE s."id"=${row.endpointScopeId} AND s."kind"='NORMAL'`;
    if (!unexpired(verification.issuedAt) || verification.issuedAt !== row.receivedAt.getTime() || !current ||
        current.scopeRevision.toString() !== verification.scopeRevision || current.policyRevision.toString() !== verification.policyRevision ||
        current.accountId !== verification.accountId || current.channel !== payload.channel ||
        customerPropertyScopeKey(payload.channel, payload.peer, verification.accountId, row.endpointScopeId!) !== row.scopeKey ||
        customerPropertyEventKey(row.scopeKey, payload.eventKind, payload.eventId) !== row.eventKey ||
        !await credentialCurrent(db, { ...payload, ...verification, issuerAccountId: verification.accountId })) {
      return { status: "held", reason: "pending_verifier_or_age_stale" };
    }
    const envelope = Object.freeze({}) as RecoveredCustomerPendingEnvelope;
    recoveredPending.set(envelope, { payload, verification, eventKey: row.eventKey, order: row.order.toString() });
    return { status: "pending", envelope };
  } catch { return { status: "held", reason: "pending_binding_invalid" }; }
}
export function inspectRecoveredCustomerPendingEnvelope(value: unknown) {
  const evidence = value && typeof value === "object" ? recoveredPending.get(value) : undefined;
  return evidence && unexpired(evidence.verification.issuedAt) ? structuredClone(evidence) : null;
}

type PendingEvidence = NonNullable<ReturnType<typeof inspectRecoveredCustomerPendingEnvelope>>;
const classifiedPending = new WeakMap<object, { envelope: RecoveredCustomerPendingEnvelope; eventKey: string; order: string }>();
async function currentPendingEvidence(envelope: RecoveredCustomerPendingEnvelope, db: OriginDb): Promise<PendingEvidence | null> {
  const original = recoveredPending.get(envelope);
  if (!original) return null;
  const current = await recoverCustomerPendingEnvelope(original.eventKey, db);
  const fresh = current.status === "pending" ? recoveredPending.get(current.envelope) : null;
  return fresh && JSON.stringify(fresh) === JSON.stringify(original) ? fresh : null;
}
async function senderContext(db: OriginDb, evidence: PendingEvidence): Promise<CustomerSenderObservationContext | null> {
  const { payload, verification } = evidence;
  if (payload.channel !== "INSTAGRAM" || !verification.accountId || !payload.accountExternalId || !verification.verifierCredential) return null;
  const row = await originTicket(db, evidence.eventKey, false);
  const credential = await readRecoveryInstagramCredential(db, verification.accountId, payload.accountExternalId);
  const identities = await readRecoveryOwnIdentities(db);
  if (!row?.payloadHash || row.tombstonedAt || !credential || !identities.instagramComplete) return null;
  return { version: 1, source: "instagram_username_get", eventKey: evidence.eventKey, order: evidence.order, payloadHash: row.payloadHash,
    channel: "INSTAGRAM", peer: payload.peer, accountId: verification.accountId, endpointScopeId: verification.endpointScopeId,
    scopeRevision: verification.scopeRevision, policyRevision: verification.policyRevision, receivedAt: verification.issuedAt,
    signingCredential: verification.verifierCredential, accountTokenFingerprint: credential.fingerprint, ownIdentitiesHash: identities.hash };
}
async function existingSenderObservation(db: OriginDb, evidence: PendingEvidence) {
  const row = await originTicket(db, evidence.eventKey, false);
  if (!row || row.senderObservationVersion === null && row.senderObservationCiphertext === null && row.senderObservedAt === null) return null;
  const context = await senderContext(db, evidence);
  if (!context || row.senderObservationVersion !== 1 || !row.senderObservationCiphertext || !row.senderObservedAt) throw new Error("Sender observation unavailable");
  const observation = decryptCustomerSenderObservation(context, row.senderObservationCiphertext);
  if (observation.observedAt !== row.senderObservedAt.getTime()) throw new Error("Sender observation time mismatch");
  return { username: observation.username, ownIdentitiesHash: context.ownIdentitiesHash };
}
/** Only this authority-owned path stores the genuine GET observation. It is
 * immutable and separate from the original payload, never FINAL by itself. */
async function observePendingInstagramSender(envelope: RecoveredCustomerPendingEnvelope, evidence: PendingEvidence) {
  const prior = await existingSenderObservation(prisma, evidence);
  if (prior) return prior;
  const context = await senderContext(prisma, evidence);
  const credential = evidence.verification.accountId && evidence.payload.accountExternalId
    ? await readRecoveryInstagramCredential(prisma, evidence.verification.accountId, evidence.payload.accountExternalId) : null;
  if (!context || !credential || credential.fingerprint !== context.accountTokenFingerprint) return null;
  // No locks held across the single bounded real GET. Original age is retained.
  const username = await readRecoveryInstagramUsername(evidence.payload.peer, credential.token, evidence.verification.issuedAt);
  if (!username) return null;
  const observedAt = Date.now(), ciphertext = encryptCustomerSenderObservation(context, username, observedAt);
  return prisma.$transaction(async tx => {
    const row = await originTicket(tx, evidence.eventKey, false);
    if (!row || row.tombstonedAt) throw new Error("Pending sender ticket unavailable");
    if (row.conversationId && !await lockCustomerNative(tx, { kind: "bot", id: row.conversationId })) throw new Error("Pending native unavailable");
    await tx.$queryRaw`SELECT "id" FROM "CustomerEndpointScope" WHERE "id"=${evidence.verification.endpointScopeId} FOR SHARE`;
    await tx.$queryRaw`SELECT "id" FROM "CustomerRuntimePolicy" WHERE "id"='singleton' FOR SHARE`;
    const locked = await originTicket(tx, evidence.eventKey, true);
    const fresh = await currentPendingEvidence(envelope, tx), freshContext = fresh ? await senderContext(tx, fresh) : null;
    if (!locked || !fresh || !freshContext || JSON.stringify(freshContext) !== JSON.stringify(context)) throw new Error("Sender read context changed");
    if (locked.senderObservationCiphertext) return await existingSenderObservation(tx, fresh);
    const changed = await tx.$executeRaw`UPDATE "CustomerPropertyIngressTicket" SET "senderObservationVersion"=1,
      "senderObservationCiphertext"=${ciphertext},"senderObservedAt"=${new Date(observedAt)}
      WHERE "eventKey"=${evidence.eventKey} AND "order"=${BigInt(evidence.order)} AND "tombstonedAt" IS NULL
        AND "senderObservationVersion" IS NULL AND "senderObservationCiphertext" IS NULL AND "senderObservedAt" IS NULL`;
    if (changed !== 1) throw new Error("Sender observation CAS failed");
    return { username, ownIdentitiesHash: context.ownIdentitiesHash };
  }, { maxWait: 5000, timeout: 10000 });
}

export type ClassifiedRecoveredCustomerInput =
  | { status: "classified"; input: AuthenticatedCustomerInput }
  | Exclude<CustomerPendingFrameClassification, { status: "eligible" }>
  | { status: "held"; reason: "pending_unavailable" | "sender_read_unavailable" | "classification_unavailable" };
/** Actual PENDING proof → actual classifier → private, UNACCEPTED input brand.
 * No fake request, new signature/issuer, new event/order, native or time. */
export async function classifyRecoveredCustomerPendingInput(envelope: RecoveredCustomerPendingEnvelope): Promise<ClassifiedRecoveredCustomerInput> {
  try {
    const evidence = await currentPendingEvidence(envelope, prisma);
    if (!evidence) return { status: "held", reason: "pending_unavailable" };
    let classification = await classifyCustomerPendingFrame(prisma, evidence.payload, evidence.verification);
    if (classification.status === "held" && classification.reason === "own_identity_required") {
      const sender = await observePendingInstagramSender(envelope, evidence);
      const fresh = await currentPendingEvidence(envelope, prisma);
      if (!sender || !fresh) return { status: "held", reason: "sender_read_unavailable" };
      classification = await classifyCustomerPendingFrame(prisma, fresh.payload, fresh.verification, sender);
    }
    if (classification.status !== "eligible") return classification;
    const { payload, verification: p } = evidence;
    const input = Object.freeze({}) as AuthenticatedCustomerInput;
    inputs.set(input, { channel: payload.channel, peer: payload.peer, accountExternalId: payload.accountExternalId,
      eventId: payload.eventId, eventKind: payload.eventKind, inputText: payload.inputText,
      provenance: p.provenance, assurance: p.assurance, issuerSource: p.issuerSource, issuerAccountId: p.accountId,
      protectedMetaAccountId: p.assurance === "protected_namespace" ? p.accountId : null,
      protectedMetaEndpointScopeId: p.assurance === "protected_namespace" ? p.endpointScopeId : null,
      issuerEndpointScopeId: p.endpointScopeId, issuerScopeRevision: p.scopeRevision, issuerPolicyRevision: p.policyRevision,
      issuedAt: p.issuedAt, verifierCredential: p.verifierCredential });
    classifiedPending.set(input, { envelope, eventKey: evidence.eventKey, order: evidence.order });
    return { status: "classified", input };
  } catch { return { status: "held", reason: "classification_unavailable" }; }
}

/** Re-run read-only actual checks under canonical locks before the FIRST
 * accepted_inbound transition. This never calls a provider under a DB lock. */
export async function revalidateRecoveredCustomerPendingInputTx(db: TxClient, input: AuthenticatedCustomerInput): Promise<boolean> {
  const witness = classifiedPending.get(input);
  if (!witness || !isActiveTransactionClient(db) || !inspectAuthenticatedCustomerInput(input)) return false;
  const current = await currentPendingEvidence(witness.envelope, db);
  if (!current || current.eventKey !== witness.eventKey || current.order !== witness.order) return false;
  const sender = current.payload.channel === "INSTAGRAM" ? await existingSenderObservation(db, current) : undefined;
  return (await classifyCustomerPendingFrame(db, current.payload, current.verification, sender ?? undefined)).status === "eligible";
}
async function canonicalOriginCurrent(db: OriginDb, origin: CustomerFinalOrigin): Promise<boolean> {
  const old = origin.input.acceptedFence;
  const rows = await db.$queryRaw<Array<{ scopeRevision: bigint; policyRevision: bigint; bindingRevision: bigint; ownershipEpoch: bigint;
    ownerToken: string | null; conversationId: string | null; endpointScopeId: string; peerId: string; threadId: string;
    lastAcceptedEventKey: string | null; lastAcceptedOrder: bigint | null; channel: string; accountId: string | null;
    nativeScope: string | null; nativeChannel: string; nativePeer: string; nativeAccount: string | null }>>`
    SELECT s."scopeRevision",p."policyRevision",i."bindingRevision",i."ownershipEpoch",i."ownerToken",i."conversationId",
      i."endpointScopeId",i."peerId",i."threadId",i."lastAcceptedEventKey",i."lastAcceptedOrder",s."channel",s."messengerAccountId" AS "accountId",
      c."endpointScopeId" AS "nativeScope",c."channel" AS "nativeChannel",c."subscriberId" AS "nativePeer",c."accountId" AS "nativeAccount"
    FROM "CustomerInquiry" i JOIN "CustomerEndpointScope" s ON s."id"=i."endpointScopeId"
      JOIN "CustomerRuntimePolicy" p ON p."id"='singleton' JOIN "BotConversation" c ON c."id"=i."conversationId"
    WHERE i."id"=${old.inquiryId} AND s."kind"='NORMAL'`;
  const row = rows.length === 1 ? rows[0] : null;
  return !!row && row.conversationId === old.nativeId && row.conversationId === origin.originalConversationId &&
    row.endpointScopeId === old.endpoint.endpointScopeId && row.nativeScope === row.endpointScopeId &&
    row.channel === old.endpoint.channel && row.nativeChannel === row.channel && row.accountId === old.endpoint.accountId &&
    row.nativeAccount === row.accountId && row.peerId === old.endpoint.peerId && row.nativePeer === row.peerId && row.threadId === old.endpoint.threadId &&
    row.ownerToken === old.ownerToken && row.bindingRevision.toString() === old.bindingRevision && row.ownershipEpoch.toString() === old.ownershipEpoch &&
    row.scopeRevision.toString() === old.scopeRevision && row.policyRevision.toString() === old.policyRevision &&
    row.lastAcceptedEventKey === origin.eventKey && row.lastAcceptedOrder?.toString() === origin.order;
}
/** Validates persisted server FINAL proof only. Does not mint any grant. Caller
 * holding locks must acquire native→scope→policy→Inquiry BEFORE the Ticket. */
export async function readVerifiedCustomerFinalOrigin(db: OriginDb, eventKey: string, lockTicket = false): Promise<CustomerFinalOrigin | null> {
  if (!/^[a-f0-9]{64}$/.test(eventKey) || (lockTicket && !isActiveTransactionClient(db))) return null;
  try {
    const row = await originTicket(db, eventKey, lockTicket);
    if (!row || row.originVersion !== 1 || !row.originCiphertext || !row.originCapturedAt) return null;
    const envelope = payloadForTicket(row), origin = decryptCustomerFinalOrigin(row.originCiphertext);
    const input = origin.input, payload = envelope.payload, pending = envelope.verification;
    if (origin.eventKey !== row.eventKey || origin.order !== row.order.toString() || origin.scopeKey !== row.scopeKey ||
        origin.payloadHash !== row.payloadHash || origin.originalConversationId !== row.originalConversationId ||
        input.issuedAt !== row.originCapturedAt.getTime() || input.issuedAt !== row.receivedAt.getTime() || !unexpired(input.issuedAt) ||
        input.channel !== payload.channel || input.peer !== payload.peer || input.eventId !== payload.eventId || input.eventKind !== payload.eventKind ||
        input.inputText !== payload.inputText || input.accountExternalId !== payload.accountExternalId ||
        input.issuerEndpointScopeId !== pending.endpointScopeId || input.issuerAccountId !== pending.accountId ||
        input.issuerScopeRevision !== pending.scopeRevision || input.issuerPolicyRevision !== pending.policyRevision ||
        input.assurance !== pending.assurance || input.issuerSource !== pending.issuerSource ||
        pending.issuedAt !== input.issuedAt || JSON.stringify(input.verifierCredential) !== JSON.stringify(pending.verifierCredential) ||
        customerPropertyScopeKey(input.channel, input.peer, input.issuerAccountId, row.endpointScopeId!) !== row.scopeKey ||
        customerPropertyEventKey(row.scopeKey, input.eventKind, input.eventId) !== row.eventKey ||
        !await canonicalOriginCurrent(db, origin) || !await credentialCurrent(db, input)) return null;
    return origin;
  } catch { return null; }
}
/** Called only AFTER actual FINAL-IN canonical acceptance/bind in its same TX.
 * Historical tickets remain non-recoverable; replay never upgrades their origin. */
export async function persistFinalCustomerOriginTx(db: TxClient, input: AuthenticatedCustomerInput, ticket: CustomerPropertyAdmission): Promise<void> {
  const evidence = inspectAuthenticatedCustomerInput(input);
  if (!isActiveTransactionClient(db) || !evidence?.acceptedFence) throw new Error("Accepted server input required");
  const row = await originTicket(db, ticket.eventKey, true);
  if (!row) throw new Error("Accepted ticket missing");
  // Pre-P11 historical rows have no payload; they never receive recoverable proof.
  if (row.payloadVersion === null && row.payloadCiphertext === null) return;
  if (row.order.toString() !== ticket.order || row.scopeKey !== ticket.scopeKey || row.conversationId !== ticket.conversationId) throw new Error("Accepted ticket binding mismatch");
  const { payload, verification } = payloadForTicket(row);
  if (row.originCiphertext) {
    if (!await readVerifiedCustomerFinalOrigin(db, row.eventKey)) throw new Error("Existing origin unavailable");
    return;
  }
  if (payload.observations.providerEcho || payload.observations.referralOnly || evidence.issuedAt !== row.receivedAt.getTime() || verification.issuedAt !== evidence.issuedAt ||
      payload.channel !== evidence.channel || payload.peer !== evidence.peer || payload.eventId !== evidence.eventId ||
      payload.eventKind !== evidence.eventKind || payload.inputText !== evidence.inputText || payload.accountExternalId !== evidence.accountExternalId ||
      verification.assurance !== evidence.assurance || verification.accountId !== evidence.issuerAccountId ||
      verification.endpointScopeId !== evidence.issuerEndpointScopeId || verification.scopeRevision !== evidence.issuerScopeRevision ||
      verification.policyRevision !== evidence.issuerPolicyRevision || JSON.stringify(verification.verifierCredential) !== JSON.stringify(evidence.verifierCredential ?? null)) {
    throw new Error("FINAL input differs from verified envelope");
  }
  const origin: CustomerFinalOrigin = { version: 1, classification: "FINAL_IN", verifierVersion: 1, eventKey: row.eventKey,
    order: row.order.toString(), scopeKey: row.scopeKey, payloadHash: row.payloadHash!, originalConversationId: row.originalConversationId!,
    input: { ...evidence, acceptedFence: evidence.acceptedFence, verifierCredential: evidence.verifierCredential ?? null } };
  if (!await canonicalOriginCurrent(db, origin)) throw new Error("Accepted origin stale");
  const ciphertext = encryptCustomerFinalOrigin(origin);
  const changed = await db.$executeRaw`UPDATE "CustomerPropertyIngressTicket" SET "originVersion"=1,"originCiphertext"=${ciphertext},
    "originCapturedAt"=${new Date(evidence.issuedAt)} WHERE "eventKey"=${row.eventKey} AND "originCiphertext" IS NULL AND "tombstonedAt" IS NULL`;
  if (changed !== 1) throw new Error("Origin promotion unavailable");
}
export async function recoverAuthenticatedCustomerInput(eventKey: string, db: OriginDb = prisma): Promise<
  { status: "recovered"; input: AuthenticatedCustomerInput; ticket: CustomerPropertyAdmission } | { status: "held"; reason: string }
> {
  const origin = await readVerifiedCustomerFinalOrigin(db, eventKey);
  if (!origin) return { status: "held", reason: "origin_unavailable_or_stale" };
  const row = await originTicket(db, eventKey, false);
  if (!row || row.tombstonedAt || row.conversationId !== origin.originalConversationId) return { status: "held", reason: "origin_native_changed" };
  let evidence: CustomerPropertyAdmission["evidence"];
  try { evidence = payloadForTicket(row).payload.propertyEvidence; } catch { return { status: "held", reason: "origin_payload_unavailable" }; }
  const input = Object.freeze({}) as AuthenticatedCustomerInput;
  inputs.set(input, structuredClone(origin.input));
  return { status: "recovered", input, ticket: { eventKey: origin.eventKey, order: origin.order, scopeKey: origin.scopeKey,
    conversationId: origin.originalConversationId, channel: origin.input.channel, accountId: origin.input.issuerAccountId,
    endpointScopeId: origin.input.acceptedFence.endpoint.endpointScopeId,
    evidence } };
}
