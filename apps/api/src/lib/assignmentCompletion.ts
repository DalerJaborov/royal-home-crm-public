/** Operational completion is independent of private investigation state. */
export const COMPLETED_ASSIGNMENT_MESSAGE = "Работа по этому назначению завершена. Дальнейшее решение принимает руководитель";

export function assignmentWriteDenied(
  client: { assignmentCompletedAt?: Date | string | null },
  role: string | null | undefined,
): string | null {
  return client.assignmentCompletedAt && role !== "ADMIN" && role !== "DIRECTOR"
    ? COMPLETED_ASSIGNMENT_MESSAGE : null;
}

export function refusalNeedsManagementDecision(client: { dualIntent?: boolean }, hasOpenDeal: boolean): boolean {
  // Even an unconfirmed second intent must not be silently discarded by a refusal.
  return client.dualIntent === true || hasOpenDeal;
}

export function assignmentRefusalReset(source: string, actorId: string | null | undefined, before: string | null, after: string | null) {
  return after !== null && (before !== after || (source === "lifecycle.assign" && actorId != null))
    ? { assignmentRefusedAt: null, assignmentRefusedByAgentId: null, assignmentCompletedAt: null } : {};
}
