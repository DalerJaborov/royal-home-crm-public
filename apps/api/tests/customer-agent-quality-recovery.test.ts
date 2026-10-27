import { describe, expect, it } from "vitest";
import { customerAgentQualityRecoveryRequestSchema, customerAgentQualityRecoveryStateSchema } from "@royal-home/shared";
// The target is attested from compiled release bytes, not tsx source bytes.
import { CUSTOMER_AGENT_QUALITY_RECOVERY_SOURCE as source, CUSTOMER_AGENT_QUALITY_RECOVERY_TARGET as target,
  CUSTOMER_AGENT_QUALITY_RECOVERY_PRIOR_A as priorA, customerAgentQualityRecoveryPriorAId,
  customerAgentQualityRecoverySourceId, isCustomerQualityRecoverySource, isCustomerQualityRecoveryPriorA,
  isCustomerQualityRecoveryTarget, isCustomerQualityRecoveryTargetWithAttestation,
  customerQualityRecoveryHash } from "../dist/lib/customerAgentQualityRecovery.js";
import { buildCurrentCustomerAgentManifest, readCustomerAgentRecoveryCoreAttestation } from "../dist/lib/customerAgentRegistration.js";
import { createCustomerAgentMediaProviderSnapshot } from "../dist/ai/customerAgentProviderConfig.js";
import { CUSTOMER_AGENT_RECOVERY_C_MATERIAL_HASH, CUSTOMER_AGENT_RECOVERY_C_MODEL_SCHEMA_HASH } from "../dist/lib/customerAgentRecoveryPins.js";
import { customerAgentManifestId } from "../dist/lib/customerAgentRevision.js";

function changed(hash: string) { return `${hash[0] === "0" ? "1" : "0"}${hash.slice(1)}`; }
describe("closed reserve quality recovery protocol", () => {
  it("accepts only the whole frozen compiled B manifest", () => {
    expect(isCustomerQualityRecoverySource(source)).toBe(true);
    expect(customerAgentQualityRecoverySourceId).toBe(customerAgentManifestId(source));
    for (const key of Object.keys(source).filter(value => value !== "limits")) {
      expect(isCustomerQualityRecoverySource({ ...source, [key]: "e".repeat(64) })).toBe(false);
    }
    expect(isCustomerQualityRecoverySource({ ...source, limits: { ...source.limits, maxRounds: 4 } })).toBe(false);
  });
  it("qualifies the exact prior A edge independently of the new C verifier", () => {
    expect(customerAgentManifestId(priorA)).toBe(customerAgentQualityRecoveryPriorAId);
    expect(isCustomerQualityRecoveryPriorA(priorA)).toBe(true);
    for (const key of ["coreHash", "modelSchemaHash", "rendererHash", "promptHash", "knowledgeSchemaHash"] as const) {
      expect(isCustomerQualityRecoveryPriorA({ ...priorA, [key]: changed(priorA[key]) })).toBe(false);
    }
  });
  it("requires the full compiled C core/material/model and prior protocol/provider configuration", async () => {
    const candidate = await buildCurrentCustomerAgentManifest(createCustomerAgentMediaProviderSnapshot());
    const attestation = await readCustomerAgentRecoveryCoreAttestation();
    expect(candidate).toMatchObject({ ...target, coreHash: attestation.coreHash, modelSchemaHash: CUSTOMER_AGENT_RECOVERY_C_MODEL_SCHEMA_HASH });
    expect(attestation.materialHash).toBe(CUSTOMER_AGENT_RECOVERY_C_MATERIAL_HASH);
    expect(await isCustomerQualityRecoveryTarget(candidate)).toBe(true);
    expect(await isCustomerQualityRecoveryTarget({ ...candidate, id: customerAgentManifestId(candidate) })).toBe(true);
    for (const key of ["coreHash", "modelSchemaHash", "rendererHash", "promptHash", "knowledgeSchemaHash", "toolSchemaHash", "knowledgeSourceHash", "providerProfileHash", "providerPolicyHash"] as const) {
      expect(isCustomerQualityRecoveryTargetWithAttestation({ ...candidate, [key]: changed(candidate[key]) }, attestation)).toBe(false);
    }
    expect(isCustomerQualityRecoveryTargetWithAttestation(candidate, { ...attestation, materialHash: changed(attestation.materialHash) })).toBe(false);
    expect(isCustomerQualityRecoveryTargetWithAttestation({ ...candidate, limits: { ...candidate.limits, maxInputChars: 32000 } }, attestation)).toBe(false);
    expect(isCustomerQualityRecoveryTargetWithAttestation(source, attestation)).toBe(false);
  });
  it("rejects caller-selected targets and generic publication acknowledgements", () => {
    const request = { expectedPolicyRevision: "30", requestId: "11111111-1111-4111-8111-111111111111", reason: "Synthetic owner recovery", confirmQualityRecovery: true };
    expect(customerAgentQualityRecoveryRequestSchema.safeParse(request).success).toBe(true);
    for (const field of ["revisionId", "manifest", "capabilities", "rollout", "confirmCatalogFactsUpgrade", "confirmMediaProfileUpgrade", "confirmRecruitmentResumeUpgrade"]) {
      expect(customerAgentQualityRecoveryRequestSchema.safeParse({ ...request, [field]: true }).success).toBe(false);
    }
    expect(customerAgentQualityRecoveryRequestSchema.safeParse({ ...request, confirmQualityRecovery: false }).success).toBe(false);
    expect(customerQualityRecoveryHash(request)).toBe(customerQualityRecoveryHash({ ...request }));
    expect(customerQualityRecoveryHash(request)).not.toBe(customerQualityRecoveryHash({ ...request, reason: "Different request" }));
    expect(customerAgentQualityRecoveryStateSchema.safeParse({ status: "ready", reason: "quality_recovery_ready", requiresResumeFromOff: false, policyRevision: "30" }).success).toBe(true);
  });
});
