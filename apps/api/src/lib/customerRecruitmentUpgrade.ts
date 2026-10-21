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
