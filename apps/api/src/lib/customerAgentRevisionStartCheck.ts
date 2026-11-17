import { prisma } from "../db.js";
import { decodeCustomerAgentRevision } from "./customerAgentRevision.js";
import { loadVerifiedCustomerAgentRevision } from "./customerAgentRegistration.js";
import { reportCustomerAgentRevisionHeld } from "./customerAgentRevisionAlert.js";
import { autoRefreshCustomerAgentRevision } from "./customerAgentAutoRefresh.js";

/** Boot-time guard (api and worker): first adopt an ordinary code-only release
 * automatically (customerAgentAutoRefresh.ts, same guards as the button); if
 * that is not allowed or must wait for idle, verify and say so now instead of
 * when the first customer is left without an answer. Never throws. */
export async function checkActiveCustomerAgentRevisionOnStart(): Promise<"ok" | "inactive" | "held" | "failed"> {
  let revisionId: string | null = null;
  try {
    const auto = await autoRefreshCustomerAgentRevision();
    if (auto.status === "inactive") return "inactive";
    if (auto.status === "current" || auto.status === "refreshed") return "ok";
    if (auto.status === "busy") return "held"; // the cron tick retries; alert after the grace
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
