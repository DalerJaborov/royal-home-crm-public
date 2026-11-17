import type { CustomerAgentRevision } from "@royal-home/shared";

/** Exact, separately approved quality/continuity prompt edge. The historical
 * résumé-v2 pair remains unchanged and is not an alias for this transition. */
export const CUSTOMER_AGENT_QUALITY_CONTINUITY_UPGRADE_V1 = Object.freeze({
  fromPrompt: "eaf64976e609e5e010bb89a249740489c3acd3720b56c5359e0c6a9c4da9ba3a",
  toPrompt: "ce2c77f26c0e9250f224aed5fd2a1c201e1b100a0b1e0d52fbcb0e0db1d07da9",
  toolSchemaHash: "16dcce629b9cec908e64942333769bdc05353fbe5675726fe9c9cfd3c9ee7b67",
  // The only knowledge-group delta is the closed guide-follow delivery proof;
  // public catalog facts/tools/sources are unchanged. Pin both aggregate bytes.
  fromKnowledgeSchema: "56005627b7c733a00aac39d1e9510284a4b811498637b219aaa4f03e1c15f26f",
  toKnowledgeSchema: "9221c40f5fb41fd021bc8360f2c984db08239b0343815978f514a575c6b8b8b6",
});

type Protocol = Pick<CustomerAgentRevision, "promptHash" | "toolSchemaHash" | "knowledgeSchemaHash">;

export function isCustomerAgentQualityContinuityUpgradeV1(prior: Protocol, next: Protocol): boolean {
  const pair = CUSTOMER_AGENT_QUALITY_CONTINUITY_UPGRADE_V1;
  return prior.promptHash === pair.fromPrompt && next.promptHash === pair.toPrompt &&
    prior.toolSchemaHash === pair.toolSchemaHash && next.toolSchemaHash === pair.toolSchemaHash &&
    prior.knowledgeSchemaHash === pair.fromKnowledgeSchema && next.knowledgeSchemaHash === pair.toKnowledgeSchema;
}

/** Second separately approved quality/continuity edge (PR #41, 29.10.2026):
 * the prompt gains the public-comment addressee rule (`serverPublicState.addressee`)
 * and the shared public-state/property-context schemas carry that field. Tool
 * catalog is unchanged; V1 stays pinned as history, not an alias. */
export const CUSTOMER_AGENT_QUALITY_CONTINUITY_UPGRADE_V2 = Object.freeze({
  fromPrompt: CUSTOMER_AGENT_QUALITY_CONTINUITY_UPGRADE_V1.toPrompt,
  toPrompt: "6a58b93a8b0addc2e15f239f9ada385ad44f95663b7d2b9266d12bf6ec06f329",
  toolSchemaHash: CUSTOMER_AGENT_QUALITY_CONTINUITY_UPGRADE_V1.toolSchemaHash,
  fromKnowledgeSchema: CUSTOMER_AGENT_QUALITY_CONTINUITY_UPGRADE_V1.toKnowledgeSchema,
  toKnowledgeSchema: "f78386f9c7109595ae1350e55dcb2802e601b4f949342d58e34ec87b71b5909b",
});

export function isCustomerAgentQualityContinuityUpgradeV2(prior: Protocol, next: Protocol): boolean {
  const pair = CUSTOMER_AGENT_QUALITY_CONTINUITY_UPGRADE_V2;
  return prior.promptHash === pair.fromPrompt && next.promptHash === pair.toPrompt &&
    prior.toolSchemaHash === pair.toolSchemaHash && next.toolSchemaHash === pair.toolSchemaHash &&
    prior.knowledgeSchemaHash === pair.fromKnowledgeSchema && next.knowledgeSchemaHash === pair.toKnowledgeSchema;
}

export type CustomerAgentQualityContinuityUpgradeVersion = "v1" | "v2";

/** Exactly one pinned edge may match; a jump over an edge (V1.from → V2.to) is not an upgrade. */
export function customerAgentQualityContinuityUpgradeVersion(prior: Protocol, next: Protocol): CustomerAgentQualityContinuityUpgradeVersion | null {
  if (isCustomerAgentQualityContinuityUpgradeV1(prior, next)) return "v1";
  if (isCustomerAgentQualityContinuityUpgradeV2(prior, next)) return "v2";
  return null;
}
