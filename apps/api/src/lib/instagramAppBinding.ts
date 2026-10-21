import { parsePermissionOverrides, resolvePermissions, type InstagramAppBindingInput, type InstagramAppBindingStatus } from "@royal-home/shared";
import { z } from "zod";
import { prisma } from "../db.js";
import { decryptSecretSafe, encryptSecret } from "../crypto.js";
import { resetAccountsCache } from "../messengers/accounts.js";
import { InstagramAppBindingError, INSTAGRAM_BINDING_PROOF_TTL_MS, proveInstagramAppBinding } from "./instagramAppBindingProof.js";
import { instagramAccountFingerprint as fingerprint, instagramBindingAccountSelect as accountSelect,
  instagramBindingSettingsSelect, instagramConfigurationVersion, instagramObservationDigest,
  readInstagramBindingScope, readInstagramSignerObservations } from "./instagramSignerObservation.js";

function readAccount(id: string) { return prisma.messengerAccount.findUnique({ where: { id }, select: accountSelect }); }
const action = "INSTAGRAM_SIGNER_OWNER_CONFIGURED";
const proofAuditSchema = z.object({ mode: z.literal("owner_selected_observed_signer"), appId: z.string().regex(/^\d{1,64}$/),
  configuredAt: z.string().datetime(), accountFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  requestDigest: z.string().regex(/^[a-f0-9]{64}$/) });
const settingsField = (source: InstagramAppBindingInput["secretSource"]) => source === "settings_instagram"
  ? "metaIgAppSecret" as const : "metaAppSecret" as const;

export async function readInstagramAppBindingStatus(accountId: string): Promise<InstagramAppBindingStatus> {
  const account = await readAccount(accountId);
  if (!account || account.channel !== "INSTAGRAM") throw new InstagramAppBindingError("account_unavailable", 404);
  const settings = await prisma.settings.findUniqueOrThrow({ where: { id: "singleton" }, select: instagramBindingSettingsSelect });
  const scope = await readInstagramBindingScope(prisma, accountId);
  const observations = await readInstagramSignerObservations(prisma, account, scope, settings, Date.now());
  const audit = await prisma.auditLog.findFirst({ where: { action, entityType: "MessengerAccount", entityId: accountId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { meta: true } });
  const proof = proofAuditSchema.safeParse(audit?.meta);
  const current = proof.success && account.enabled && proof.data.accountFingerprint === fingerprint(account) ? proof.data : null;
  return { accountId, hasAppSecret: Boolean(account.appSecret), configurationVersion: instagramConfigurationVersion(account, scope),
    candidates: observations.candidates, configuredAppId: current?.appId ?? null, configuredAt: current?.configuredAt ?? null,
    authority: current?.mode ?? null, freshSignatureObservedAt: current ? observations.freshAccountSignatures.find(value => value > current.configuredAt) ?? null : null };
}

/** Provider checks never hold database locks. The final CAS and audit are one transaction. */
export async function bindInstagramAppForAccount(actorId: string, accountId: string, input: InstagramAppBindingInput,
  options: { now?: () => number } = {}): Promise<InstagramAppBindingStatus & { configurationChanged: boolean }> {
  const now = options.now ?? Date.now;
  const authorised = async (db: Pick<typeof prisma, "agent">) => {
    const actor = await db.agent.findUnique({ where: { id: actorId }, select: { isActive: true, role: true, permissions: true, fullName: true } });
    if (!actor?.isActive || !["ADMIN", "DIRECTOR"].includes(actor.role) ||
        !resolvePermissions(actor.role, parsePermissionOverrides(actor.permissions)).has("settings.manage")) {
      throw new InstagramAppBindingError("account_unavailable", 403);
    }
    return actor;
  };
  await authorised(prisma);
  const account = await readAccount(accountId);
  if (!account?.enabled || account.channel !== "INSTAGRAM") throw new InstagramAppBindingError("account_unavailable", 404);
  const field = settingsField(input.secretSource);
  const settings = await prisma.settings.findUniqueOrThrow({ where: { id: "singleton" }, select: instagramBindingSettingsSelect });
  const persistedSource = settings[field];
  const secret = decryptSecretSafe(persistedSource);
  const token = decryptSecretSafe(account.token);
  if (!secret || !token) throw new InstagramAppBindingError("invalid_credentials");
  const previous = await prisma.auditLog.findFirst({ where: { action, entityType: "MessengerAccount", entityId: accountId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { meta: true, agentId: true } });
  const previousProof = proofAuditSchema.safeParse(previous?.meta), requestDigest = instagramObservationDigest(input);
  if (previous?.agentId === actorId && previousProof.success && previousProof.data.requestDigest === requestDigest &&
      previousProof.data.accountFingerprint === fingerprint(account)) {
    return { ...await readInstagramAppBindingStatus(accountId), configurationChanged: false };
  }
  const scope = await readInstagramBindingScope(prisma, accountId);
  if (!scope || instagramConfigurationVersion(account, scope) !== input.configurationVersion) throw new InstagramAppBindingError("account_changed");
  const observations = await readInstagramSignerObservations(prisma, account, scope, settings, now());
  const selected = observations.candidates.find(value => value.secretSource === input.secretSource &&
    value.observationId === input.observationId && value.observationVersion === input.observationVersion);
  if (!selected) throw new InstagramAppBindingError("observation_unavailable");
  const proof = await proveInstagramAppBinding({ account, token, appId: input.appId }, { now });
  const assertFresh = () => {
    const age = now() - proof.verifiedAtMs;
    if (age < 0 || age > INSTAGRAM_BINDING_PROOF_TTL_MS) throw new InstagramAppBindingError("proof_expired");
  };
  const configurationChanged = decryptSecretSafe(account.appSecret) !== secret;
  const nextSecret = configurationChanged ? encryptSecret(secret) : account.appSecret!;
  await prisma.$transaction(async tx => {
    // Match the owner publication's credential-before-scope order; the existing
    // account UPDATE trigger performs native/scope locks and revision rotation.
    await tx.$queryRaw`SELECT "id" FROM "Agent" WHERE "id"=${actorId} FOR SHARE`;
    const actor = await authorised(tx);
    await tx.$queryRaw`SELECT "id" FROM "Settings" WHERE "id"='singleton' FOR SHARE`;
    const current = await tx.settings.findUnique({ where: { id: "singleton" }, select: instagramBindingSettingsSelect });
    if (current?.[field] !== persistedSource) throw new InstagramAppBindingError("account_changed");
    assertFresh();
    const changed = await tx.messengerAccount.updateMany({ where: { id: account.id, channel: account.channel, enabled: account.enabled,
      externalId: account.externalId, messagingId: account.messagingId, extraExternalIds: { equals: account.extraExternalIds },
      token: account.token, appSecret: account.appSecret }, data: { appSecret: nextSecret } });
    if (changed.count !== 1) throw new InstagramAppBindingError("account_changed");
    // The UPDATE may have waited. Recheck proof age and exact scope rotation.
    assertFresh();
    const currentScope = await readInstagramBindingScope(tx, accountId);
    if (!currentScope || currentScope.id !== scope.id || currentScope.scopeRevision !== scope.scopeRevision + (configurationChanged ? 1n : 0n)) {
      throw new InstagramAppBindingError("account_changed");
    }
    // The existing account trigger has taken the native/scope locks. Pin the
    // exact diagnostic row afterwards, without ever promoting its authority.
    await tx.$queryRaw`SELECT "eventKey" FROM "CustomerPropertyIngressTicket" WHERE "eventKey"=${input.observationId} FOR SHARE`;
    const observedAgain = await readInstagramSignerObservations(tx, account, scope, settings, now());
    if (!observedAgain.candidates.some(value => value.secretSource === input.secretSource &&
        value.observationId === input.observationId && value.observationVersion === input.observationVersion)) {
      throw new InstagramAppBindingError("observation_unavailable");
    }
    if (configurationChanged) {
      // Match the established managed-publication drain checks. Never rotate a
      // namespace underneath admitted inbox work, a send or an open model call.
      const [work] = await tx.$queryRaw<Array<{ busy: boolean }>>`SELECT
        EXISTS(SELECT 1 FROM "CustomerPropertyIngressTicket" WHERE "intakeAgentRevisionId" IS NOT NULL AND "processingState" IN ('RECEIVED','CLAIMED')) OR
        EXISTS(SELECT 1 FROM "InstagramComment" WHERE "publicOriginCiphertext" IS NOT NULL AND "status" IN ('PENDING','WORKING','WORKING_STAFF','ERROR')) OR
        EXISTS(SELECT 1 FROM "TelegramGroupComment" WHERE "publicOriginCiphertext" IS NOT NULL AND "status" IN ('PENDING','WORKING','WORKING_STAFF','ERROR')) OR
        customer_agent_delivery_requires_idle() OR
        EXISTS(SELECT 1 FROM "CustomerPublicEffect" WHERE "status"='IN_FLIGHT' AND "createdAt">clock_timestamp()-interval '5 minutes') OR
        EXISTS(SELECT 1 FROM "AiProviderOperation" WHERE "policyKey"='royal-customer-gemini' AND "reservedUsd">0
          AND "status"='OPEN' AND "deadlineAt">clock_timestamp()) AS busy`;
      if (work?.busy) throw new InstagramAppBindingError("account_busy");
    }
    await tx.auditLog.create({ data: { action, entityType: "MessengerAccount", entityId: accountId,
      agentId: actorId, agentName: actor.fullName, meta: { mode: input.mode, appId: proof.appId,
        configuredAt: new Date(now()).toISOString(), accountFingerprint: fingerprint({ ...account, appSecret: nextSecret }),
        requestDigest, secretSource: input.secretSource, observationId: input.observationId, observationVersion: input.observationVersion } } });
    assertFresh();
  }, { timeout: 5_000 });
  resetAccountsCache();
  return { ...await readInstagramAppBindingStatus(accountId), configurationChanged };
}
