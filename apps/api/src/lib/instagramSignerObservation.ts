import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Prisma } from "../generated/prisma/client.js";
import type { TxClient } from "../db.js";
import { decryptSecretSafe } from "../crypto.js";
import { customerDbVerifierCredential, type CustomerVerifierCredential } from "./customerOriginCredential.js";
import { decryptCustomerFinalOrigin } from "./customerOriginPayload.js";
import { decryptCustomerIngressEnvelope } from "./customerIngressPayload.js";
import { customerPropertyEventKey, customerPropertyScopeKey } from "./customerPropertyScope.js";

export const INSTAGRAM_SIGNER_OBSERVATION_MAX_AGE_MS = 24 * 60 * 60_000;
export const instagramBindingAccountSelect = { id: true, channel: true, enabled: true, externalId: true, messagingId: true,
  extraExternalIds: true, token: true, appSecret: true } as const;
export type InstagramBindingAccount = Prisma.MessengerAccountGetPayload<{ select: typeof instagramBindingAccountSelect }>;
export const instagramBindingSettingsSelect = { metaIgAppSecret: true, metaAppSecret: true } as const;
type Settings = Prisma.SettingsGetPayload<{ select: typeof instagramBindingSettingsSelect }>;
type Db = Pick<TxClient, "customerEndpointScope" | "customerPropertyIngressTicket">;
export const instagramAccountFingerprint = (account: InstagramBindingAccount) => createHash("sha256").update(JSON.stringify([
  "instagram-owner-signer-v1", account.id, account.channel, account.enabled, account.externalId, account.messagingId,
  [...account.extraExternalIds].sort(), account.token, account.appSecret])).digest("hex");
export const instagramObservationDigest = (value: unknown) => createHash("sha256").update(JSON.stringify(value,
  (_key, item: unknown) => typeof item === "bigint" ? item.toString() : item)).digest("hex");
export async function readInstagramBindingScope(db: Db, accountId: string) {
  const scopes = await db.customerEndpointScope.findMany({ where: { messengerAccountId: accountId,
    realmKey: "royal-home", channel: "INSTAGRAM", kind: "NORMAL" }, select: { id: true, scopeRevision: true }, take: 2 });
  return scopes.length === 1 ? scopes[0] : null;
}
export type InstagramBindingScope = NonNullable<Awaited<ReturnType<typeof readInstagramBindingScope>>>;
export const instagramConfigurationVersion = (account: InstagramBindingAccount, scope: InstagramBindingScope | null) =>
  instagramObservationDigest([instagramAccountFingerprint(account), scope?.id ?? null, scope?.scopeRevision.toString() ?? null]);
export const instagramCandidateCredential = (source: "settings_instagram" | "settings_meta", settings: Settings) =>
  source === "settings_instagram"
    ? customerDbVerifierCredential("settings_meta_ig_app_secret", "singleton", settings.metaIgAppSecret, decryptSecretSafe(settings.metaIgAppSecret))
    : customerDbVerifierCredential("settings_meta_app_secret", "singleton", settings.metaAppSecret, decryptSecretSafe(settings.metaAppSecret));
const rowSelect = { eventKey: true, order: true, scopeKey: true, endpointScopeId: true, originalConversationId: true,
  conversationId: true, tombstonedAt: true, receivedAt: true, originVersion: true, originCiphertext: true, originCapturedAt: true,
  inputRecordedAt: true, payloadVersion: true, payloadHash: true, payloadCiphertext: true } as const;
type Row = Prisma.CustomerPropertyIngressTicketGetPayload<{ select: typeof rowSelect }>;

/** Diagnostic decryption only. Does not recover/brand customer input or renew its age. */
function inspect(row: Row, account: InstagramBindingAccount, scope: InstagramBindingScope, now: number) {
  if (!account.enabled || account.channel !== "INSTAGRAM" || row.endpointScopeId !== scope.id || row.tombstonedAt ||
      !row.conversationId || row.conversationId !== row.originalConversationId || row.originVersion !== 1 || !row.originCiphertext ||
      row.payloadVersion !== 1 || !row.payloadHash || !row.payloadCiphertext || !row.originCapturedAt || !row.inputRecordedAt ||
      row.receivedAt.getTime() > now || row.receivedAt.getTime() < now - INSTAGRAM_SIGNER_OBSERVATION_MAX_AGE_MS ||
      row.originCapturedAt.getTime() !== row.receivedAt.getTime() || row.inputRecordedAt.getTime() > now) return null;
  try {
    const origin = decryptCustomerFinalOrigin(row.originCiphertext), input = origin.input;
    const envelope = decryptCustomerIngressEnvelope({ version: 1, eventKey: row.eventKey, order: row.order.toString(),
      scopeKey: row.scopeKey, endpointScopeId: scope.id, payloadHash: row.payloadHash }, row.payloadCiphertext);
    const payload = envelope.payload, verification = envelope.verification;
    if (origin.eventKey !== row.eventKey || origin.order !== row.order.toString() || origin.scopeKey !== row.scopeKey ||
        origin.payloadHash !== row.payloadHash || origin.originalConversationId !== row.originalConversationId ||
        input.channel !== "INSTAGRAM" || input.provenance !== "meta_signature" || input.issuerAccountId !== account.id ||
        input.issuerEndpointScopeId !== scope.id || input.issuedAt !== row.receivedAt.getTime() || !input.accountExternalId ||
        ![account.externalId, account.messagingId, ...account.extraExternalIds].includes(input.accountExternalId) ||
        input.issuerScopeRevision !== input.acceptedFence.scopeRevision || input.issuerPolicyRevision !== input.acceptedFence.policyRevision ||
        input.acceptedFence.nativeId !== row.conversationId || input.acceptedFence.endpoint.endpointScopeId !== scope.id ||
        input.acceptedFence.endpoint.accountId !== account.id || input.acceptedFence.endpoint.peerId !== input.peer ||
        input.channel !== payload.channel || input.peer !== payload.peer || input.accountExternalId !== payload.accountExternalId ||
        input.eventId !== payload.eventId || input.eventKind !== payload.eventKind || input.inputText !== payload.inputText ||
        verification.issuedAt !== input.issuedAt || verification.accountId !== account.id || verification.endpointScopeId !== scope.id ||
        verification.provenance !== input.provenance || verification.assurance !== input.assurance || verification.issuerSource !== input.issuerSource ||
        verification.scopeRevision !== input.issuerScopeRevision || verification.policyRevision !== input.issuerPolicyRevision ||
        !isDeepStrictEqual(verification.verifierCredential, input.verifierCredential) ||
        customerPropertyScopeKey(input.channel, input.peer, account.id, scope.id) !== row.scopeKey ||
        customerPropertyEventKey(row.scopeKey, input.eventKind, input.eventId) !== row.eventKey) return null;
    return input;
  } catch { return null; }
}
export async function readInstagramSignerObservations(db: Db, account: InstagramBindingAccount, scope: InstagramBindingScope | null,
  settings: Settings, now: number) {
  if (!scope) return { candidates: [], freshAccountSignatures: [] };
  const rows = await db.customerPropertyIngressTicket.findMany({ where: { endpointScopeId: scope.id, tombstonedAt: null,
    originVersion: 1, inputRecordedAt: { not: null }, receivedAt: { gte: new Date(now - INSTAGRAM_SIGNER_OBSERVATION_MAX_AGE_MS), lte: new Date(now) } },
    select: rowSelect, orderBy: [{ receivedAt: "desc" }, { order: "desc" }], take: 80 });
  const credentials = (["settings_instagram", "settings_meta"] as const).map(secretSource => ({ secretSource,
    credential: instagramCandidateCredential(secretSource, settings) }));
  const candidates: Array<{ secretSource: "settings_instagram" | "settings_meta"; observationId: string; observationVersion: string; observedAt: string }> = [];
  const freshAccountSignatures: string[] = [];
  const accountCredential = customerDbVerifierCredential("account_app_secret", account.id, account.appSecret, decryptSecretSafe(account.appSecret));
  for (const row of rows) {
    const input = inspect(row, account, scope, now); if (!input?.verifierCredential) continue;
    if (input.assurance === "public_envelope" && input.issuerSource === "verified_public_envelope" &&
        input.protectedMetaAccountId === null && input.protectedMetaEndpointScopeId === null &&
        input.issuerScopeRevision === scope.scopeRevision.toString()) {
      for (const candidate of credentials) {
        if (!candidate.credential || !sameCredential(input.verifierCredential, candidate.credential) ||
            candidates.some(value => value.secretSource === candidate.secretSource)) continue;
        candidates.push({ secretSource: candidate.secretSource, observationId: row.eventKey,
          observationVersion: instagramObservationDigest([row, candidate.credential, instagramConfigurationVersion(account, scope)]),
          observedAt: row.receivedAt.toISOString() });
      }
    } else if (input.assurance === "protected_namespace" && input.issuerSource === "account_secret" &&
        input.protectedMetaAccountId === account.id && input.protectedMetaEndpointScopeId === scope.id &&
        input.issuerScopeRevision === scope.scopeRevision.toString() && accountCredential && sameCredential(input.verifierCredential, accountCredential)) {
      freshAccountSignatures.push(row.receivedAt.toISOString());
    }
  }
  return { candidates, freshAccountSignatures };
}
function sameCredential(a: CustomerVerifierCredential, b: CustomerVerifierCredential) { return isDeepStrictEqual(a, b); }
