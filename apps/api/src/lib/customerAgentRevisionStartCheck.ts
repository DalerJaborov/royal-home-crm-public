import { prisma } from "../db.js";
import { decodeCustomerAgentRevision } from "./customerAgentRevision.js";
import { loadVerifiedCustomerAgentRevision } from "./customerAgentRegistration.js";
import { reportCustomerAgentRevisionHeld } from "./customerAgentRevisionAlert.js";

/** Boot-time guard (api and worker): if the policy is ACTIVE and the active
 * revision no longer matches the installed code, say so now instead of when the
 * first customer is left without an answer. Read-only: it never refreshes the
 * revision (that stays an administrator action) and never throws. */
export async function checkActiveCustomerAgentRevisionOnStart(): Promise<"ok" | "inactive" | "held" | "failed"> {
  let revisionId: string | null = null;
  try {
    const policy = await prisma.customerRuntimePolicy.findUnique({
      where: { id: "singleton" }, select: { contractVersion: true, rolloutMode: true, activeAgentRevisionId: true } });
    if (!policy || policy.contractVersion !== "scoped" || policy.rolloutMode !== "ACTIVE" || !policy.activeAgentRevisionId) return "inactive";
    revisionId = policy.activeAgentRevisionId;
    const stored = await prisma.customerAgentRevision.findUnique({ where: { id: revisionId } });
    if (!stored) { await reportCustomerAgentRevisionHeld(revisionId, "current_artifact_verification_unavailable", new Error("active revision row is missing")); return "held"; }
    // A mismatch/verification failure is journalled inside the loader (once per revision).
    return (await loadVerifiedCustomerAgentRevision(decodeCustomerAgentRevision(stored))).status === "current" ? "ok" : "held";
  } catch (error) {
    console.error("[customer-agent] startup revision check failed:", error instanceof Error ? error.message : error);
    if (revisionId) await reportCustomerAgentRevisionHeld(revisionId, "current_artifact_verification_unavailable", error);
    return "failed";
  }
}
