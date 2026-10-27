import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { CustomerAgentRevision } from "@royal-home/shared";
import { customerAgentRolloutConfigSchema, customerAgentOwnerStateSchema } from "@royal-home/shared";
import type { TxClient } from "../db.js";
import { customerAgentManifestId, decodeCustomerAgentRevision, type CustomerAgentManifest } from "./customerAgentRevision.js";
import { decodeCustomerOutboxPayload, decodeCustomerOutboxPublicData } from "./customerOutboxCodec.js";
import { readCustomerAgentRecoveryCoreAttestation } from "./customerAgentRegistration.js";
import { CUSTOMER_AGENT_RECOVERY_C_MATERIAL_HASH, CUSTOMER_AGENT_RECOVERY_C_MODEL_SCHEMA_HASH } from "./customerAgentRecoveryPins.js";

/** The compiled, cloud-accepted quality release B. These are public artifact
 * fingerprints, not keys, accounts, permissions, or a caller-selected target. */
export const CUSTOMER_AGENT_QUALITY_RECOVERY_SOURCE = Object.freeze({
  coreHash: "baf6e73e67b69e4705175a5a81b1510e90d60e4a6d924dfb8096ad1d1c65dbc8",
  rendererHash: "321d8d7f889fbaaec0440214e107d85d57c1066a852dc2c657749ed11f92b6b2",
  modelSchemaHash: "eb3f8741dd2b675e34c3872a121ef1d3d09f20e42f2225bf3641172958aeee92",
  knowledgeSchemaHash: "9221c40f5fb41fd021bc8360f2c984db08239b0343815978f514a575c6b8b8b6",
  toolSchemaHash: "16dcce629b9cec908e64942333769bdc05353fbe5675726fe9c9cfd3c9ee7b67",
  knowledgeSourceHash: "f6ed6bfce552ff88f5d7069241dca6017b3f68d02de0f905319d0c43cbbd06b4",
  promptHash: "ce2c77f26c0e9250f224aed5fd2a1c201e1b100a0b1e0d52fbcb0e0db1d07da9",
  providerProfileHash: "8161ba020db52df40d1f16c5f2d6b6b069c4323295179b48710d41b25b277645",
  providerPolicyHash: "e877dcc36e76a70083d81ecbba501e1b434801b047f40bd0357f5a956904298f",
  limits: Object.freeze({ maxRounds: 3, maxToolCalls: 4, maxInputChars: 64000, maxOutputChars: 3000, deadlineMs: 120000, maxModelOutputTokens: 2048 }),
});
export const CUSTOMER_AGENT_QUALITY_RECOVERY_TARGET = Object.freeze({
  promptHash: "eaf64976e609e5e010bb89a249740489c3acd3720b56c5359e0c6a9c4da9ba3a",
  knowledgeSchemaHash: "56005627b7c733a00aac39d1e9510284a4b811498637b219aaa4f03e1c15f26f",
  rendererHash: "333eeaa7c0f55a68590e4511d4d5ab55da9a11c9243b0bb7edf3f4e573aa22bf",
});
/** Exact prior A at the approved A-to-B quality edge, distinct from compiled C. */
export const CUSTOMER_AGENT_QUALITY_RECOVERY_PRIOR_A = Object.freeze({
  ...CUSTOMER_AGENT_QUALITY_RECOVERY_SOURCE,
  ...CUSTOMER_AGENT_QUALITY_RECOVERY_TARGET,
  coreHash: "c1fd64280bd5efab67007ed22d8f215711b32d8c83b3a0fda353dd1805bb202a",
  modelSchemaHash: "d9af3d50f8ab9ca10b358b0a13e07db4db0990ee379f5b69c53ebeaeaa244e76",
});
export const customerAgentQualityRecoveryPriorAId = "a79e7e44d69a6963bbb32e5a44d95b814278882a31d2090fa1674101ae5f21c2";
export const customerAgentQualityRecoverySourceId = customerAgentManifestId(CUSTOMER_AGENT_QUALITY_RECOVERY_SOURCE);
export type CustomerQualityRecoveryPolicy = { policyRevision: bigint; contractVersion: string; rolloutMode: string;
  activeAgentRevisionId: string | null; rolloutConfig: unknown; capabilities: unknown };

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}`;
  return JSON.stringify(value);
}
export function customerQualityRecoveryHash(value: unknown): string { return createHash("sha256").update(canonical(value)).digest("hex"); }
export function isCustomerQualityRecoverySource(value: CustomerAgentManifest | Readonly<CustomerAgentRevision>): boolean {
  const { id: _id, ...manifest } = value as Readonly<CustomerAgentRevision>;
  return isDeepStrictEqual(manifest, CUSTOMER_AGENT_QUALITY_RECOVERY_SOURCE);
}
export function isCustomerQualityRecoveryPriorA(value: CustomerAgentManifest | Readonly<CustomerAgentRevision>): boolean {
  const { id: _id, ...manifest } = value as Readonly<CustomerAgentRevision>;
  return isDeepStrictEqual(manifest, CUSTOMER_AGENT_QUALITY_RECOVERY_PRIOR_A) &&
    customerAgentManifestId(manifest) === customerAgentQualityRecoveryPriorAId;
}
export function isCustomerQualityRecoveryTargetWithAttestation(value: CustomerAgentManifest | Readonly<CustomerAgentRevision>,
  attestation: Readonly<{ coreHash: string; materialHash: string }>): boolean {
  const from = CUSTOMER_AGENT_QUALITY_RECOVERY_SOURCE, to = CUSTOMER_AGENT_QUALITY_RECOVERY_TARGET;
  const { id: _id, ...manifest } = value as Readonly<CustomerAgentRevision>;
  if (value.promptHash !== to.promptHash || value.rendererHash !== to.rendererHash || value.knowledgeSchemaHash !== to.knowledgeSchemaHash ||
    value.modelSchemaHash !== CUSTOMER_AGENT_RECOVERY_C_MODEL_SCHEMA_HASH ||
    value.toolSchemaHash !== from.toolSchemaHash || value.knowledgeSourceHash !== from.knowledgeSourceHash ||
    value.providerProfileHash !== from.providerProfileHash || value.providerPolicyHash !== from.providerPolicyHash ||
    !isDeepStrictEqual(value.limits, from.limits) || customerAgentManifestId(manifest) === customerAgentQualityRecoverySourceId) return false;
  return attestation.materialHash === CUSTOMER_AGENT_RECOVERY_C_MATERIAL_HASH && value.coreHash === attestation.coreHash;
}
export async function isCustomerQualityRecoveryTarget(value: CustomerAgentManifest | Readonly<CustomerAgentRevision>): Promise<boolean> {
  try { return isCustomerQualityRecoveryTargetWithAttestation(value, await readCustomerAgentRecoveryCoreAttestation()); }
  catch { return false; }
}

/** Read-only qualification; no decryption fallback, provider I/O, mutation or
 * execution grant. The publisher repeats it under its existing policy lock. */
export async function customerQualityRecoveryBlockedReason(tx: TxClient, current: CustomerQualityRecoveryPolicy,
  target: CustomerAgentManifest | Readonly<CustomerAgentRevision>): Promise<string | null> {
  if (!await isCustomerQualityRecoveryTarget(target)) return "recovery_artifact_not_qualified";
  if ([process.env.CUSTOMER_AGENT_MEDIA_EXECUTION_MODE, process.env.CUSTOMER_PROPERTY_MEDIA_EXECUTION_MODE]
    .some(mode => mode !== undefined && mode !== "OFF")) return "recovery_media_must_be_off";
  if (current.contractVersion !== "scoped" || !["ACTIVE", "OFF"].includes(current.rolloutMode)) return "recovery_policy_not_supported";
  const rollout = customerAgentRolloutConfigSchema.safeParse(current.rolloutConfig);
  if (!rollout.success || current.activeAgentRevisionId !== customerAgentQualityRecoverySourceId ||
      rollout.data.candidateRevisionId !== customerAgentQualityRecoverySourceId) return "recovery_source_not_qualified";
  if (rollout.data.percentBasisPoints !== 10000 || !customerAgentOwnerStateSchema.shape.capabilities.safeParse(current.capabilities).success) return "recovery_configuration_changed";
  const source = await tx.customerAgentRevision.findUnique({ where: { id: customerAgentQualityRecoverySourceId } });
  if (!source || !isCustomerQualityRecoverySource(decodeCustomerAgentRevision(source))) return "recovery_source_not_qualified";
  const edges = await tx.$queryRaw<Array<{ fromRevisionId: string; fromCohortId: string; policyRevision: bigint }>>`SELECT "fromRevisionId","fromCohortId","policyRevision"
    FROM "CustomerAgentRevisionAdvance" WHERE "toRevisionId"=${customerAgentQualityRecoverySourceId} AND "toCohortId"=${rollout.data.cohortId}
    AND "policyRevision"<=${current.policyRevision} ORDER BY "policyRevision" DESC LIMIT 2`;
  if (edges.length !== 1) return "recovery_quality_edge_missing";
  const prior = await tx.customerAgentRevision.findUnique({ where: { id: edges[0].fromRevisionId } });
  if (!prior || !isCustomerQualityRecoveryPriorA(decodeCustomerAgentRevision(prior))) return "recovery_quality_edge_not_qualified";
  const [proof] = await tx.$queryRaw<Array<{ valid: boolean }>>`SELECT EXISTS(SELECT 1 FROM "AuditLog"
    WHERE "action"='CUSTOMER_AGENT_PUBLISH' AND "entityType"='CustomerAgentPolicy' AND "entityId"='singleton'
      AND "meta"->>'candidate'=${customerAgentQualityRecoverySourceId} AND "meta"->>'cohort'=${rollout.data.cohortId}
      AND "meta"->>'newRevision'=${edges[0].policyRevision.toString()} AND "meta"->>'qualityContinuityUpgradeVersion'='v1'
      AND "meta"->>'idleRevisionAdvanced'='true' AND "meta"->>'percentBasisPoints'='10000'
      AND "meta"->'scopes' @> ${JSON.stringify(rollout.data.allowed.map(value => value.endpointScopeId))}::jsonb
      AND CASE WHEN jsonb_typeof("meta"->'scopes')='array' THEN jsonb_array_length("meta"->'scopes') ELSE -1 END=${rollout.data.allowed.length}) AS valid`;
  if (!proof?.valid) return "recovery_quality_publication_missing";
  const [outgoing] = await tx.$queryRaw<Array<{ exists: boolean }>>`SELECT EXISTS(SELECT 1 FROM "CustomerAgentRevisionAdvance"
    WHERE "fromRevisionId"=${customerAgentQualityRecoverySourceId} AND "fromCohortId"=${rollout.data.cohortId}) AS exists`;
  if (outgoing?.exists) return "recovery_source_already_advanced";
  // The old codec must be able to read every retained part, including history.
  // A witnessed B attachment, v2 text, corruption, or an unbounded inventory
  // blocks recovery; none is silently dropped, rewritten, or replayed.
  const parts = await tx.$queryRaw<Array<{ payloadVersion: number; payloadEncrypted: string; payloadHash: string; approvedAssetPurpose: string | null }>>`
    SELECT "payloadVersion","payloadEncrypted","payloadHash","approvedAssetPurpose" FROM "CustomerOutboxPart" ORDER BY "id" LIMIT 10001`;
  if (parts.length > 10000) return "recovery_history_unbounded";
  for (const part of parts) {
    try {
      if (part.approvedAssetPurpose !== null) return "recovery_incompatible_delivery_history";
      decodeCustomerOutboxPayload(part); decodeCustomerOutboxPublicData(part);
    } catch { return "recovery_incompatible_delivery_history"; }
  }
  return null;
}
