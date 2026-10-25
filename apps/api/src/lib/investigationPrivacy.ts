import { canViewInvestigations } from "@royal-home/shared";
import type { Prisma } from "../generated/prisma/client.js";

/** Internal investigation metadata must never ride along with ordinary client DTOs. */
export function publicClientProjection<T extends object>(client: T, role?: string | null): T {
  if (canViewInvestigations(role)) return client;
  const result = { ...client } as Record<string, unknown>;
  for (const key of ["securityReview", "securityNote", "securityReviewedAt", "securityReviewedById",
    "securityReviewer", "phoneAskFlaggedAt", "offCrmAlarmNotifiedAt", "flaggedByAgentId",
    "updatedAt", "mutationRevision", "dualIntentAnalyzedHash", "dualIntentEvidence"]) {
    delete result[key];
  }
  return result as T;
}

/** Applied before pagination/counting, not only while rendering returned rows. */
export function visibleInteractionWhere(role?: string | null): Prisma.InteractionWhereInput {
  return canViewInvestigations(role) ? {} : { investigationOnly: false };
}
