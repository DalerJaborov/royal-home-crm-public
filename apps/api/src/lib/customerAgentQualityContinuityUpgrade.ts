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
