import type { CustomerAgentRevision } from "@royal-home/shared";

/** Reviewed v1 protocol pair. Ordinary prompt changes remain forbidden during
 * an idle hotfix. A changed prompt or tool definition cannot match this pair.
 * The caller must still validate the actual factory, catalog acknowledgement,
 * provider/limits, same scopes/capabilities/percentage and original idle state. */
export const CUSTOMER_RECRUITMENT_UPGRADE_V1 = Object.freeze({
  fromPrompt: "7c26d6ead6c983ead318d767a731bda8cc167d551fe1ee9859c5875e58ff0721",
  toPrompt: "25d5b1cbb2633cd6289635cdb11d743e7490f29b82b992ec753d15ab3ea14a86",
  fromTools: "dfc5ffcf834b41d938361817b78c3a18462679997f65423ae6544fc6fe884755",
  toTools: "ae01757e3b8cc99248637c9b821a18e947d290cc4cf0bb267e7bd89579ea01fc",
});
type Protocol = Pick<CustomerAgentRevision, "promptHash" | "toolSchemaHash">;
export function isCustomerRecruitmentUpgradeV1(prior: Protocol, next: Protocol): boolean {
  const pair = CUSTOMER_RECRUITMENT_UPGRADE_V1;
  return prior.promptHash === pair.fromPrompt && next.promptHash === pair.toPrompt &&
    prior.toolSchemaHash === pair.fromTools && next.toolSchemaHash === pair.toTools;
}

/** Separate résumé/question protocol after the availability catalog release.
 * This exact source pair is only a qualification check, never activation or
 * permission. The owner must explicitly acknowledge v2; all existing runtime,
 * provider, policy, source-lane and idle-publication guards still apply. */
export const CUSTOMER_RECRUITMENT_RESUME_UPGRADE_V2 = Object.freeze({
  fromPrompt: "25d5b1cbb2633cd6289635cdb11d743e7490f29b82b992ec753d15ab3ea14a86",
  toPrompt: "eaf64976e609e5e010bb89a249740489c3acd3720b56c5359e0c6a9c4da9ba3a",
  fromTools: "16dcce629b9cec908e64942333769bdc05353fbe5675726fe9c9cfd3c9ee7b67",
  toTools: "16dcce629b9cec908e64942333769bdc05353fbe5675726fe9c9cfd3c9ee7b67",
});
export function isCustomerRecruitmentResumeUpgradeV2(prior: Protocol, next: Protocol): boolean {
  const pair = CUSTOMER_RECRUITMENT_RESUME_UPGRADE_V2;
  return prior.promptHash === pair.fromPrompt && next.promptHash === pair.toPrompt &&
    prior.toolSchemaHash === pair.fromTools && next.toolSchemaHash === pair.toTools;
}
