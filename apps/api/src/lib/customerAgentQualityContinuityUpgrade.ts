import type { CustomerAgentRevision } from "@royal-home/shared";

/** Exact, separately approved quality/continuity prompt edge. The historical
 * résumé-v2 pair remains unchanged and is not an alias for this transition. */
export const CUSTOMER_AGENT_QUALITY_CONTINUITY_UPGRADE_V1 = Object.freeze({
  fromPrompt: "eaf64976e609e5e010bb89a249740489c3acd3720b56c5359e0c6a9c4da9ba3a",
  toPrompt: "7563f4004a10ced106040c0b67fa7c07f3b631846a46775557ab0fbb0c81a8a6",
  toolSchemaHash: "16dcce629b9cec908e64942333769bdc05353fbe5675726fe9c9cfd3c9ee7b67",
});

type Protocol = Pick<CustomerAgentRevision, "promptHash" | "toolSchemaHash">;

export function isCustomerAgentQualityContinuityUpgradeV1(prior: Protocol, next: Protocol): boolean {
  const pair = CUSTOMER_AGENT_QUALITY_CONTINUITY_UPGRADE_V1;
  return prior.promptHash === pair.fromPrompt && next.promptHash === pair.toPrompt &&
    prior.toolSchemaHash === pair.toolSchemaHash && next.toolSchemaHash === pair.toolSchemaHash;
}
