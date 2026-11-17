// Post-deploy automatic routine refresh of the customer core revision (05.11.2026).
//
// Why: the core runs only while the fingerprint of the INSTALLED code equals
// CustomerRuntimePolicy.activeAgentRevisionId. Every release that touches a file
// of coreHash/rendererHash/modelSchemaHash changes that fingerprint, and until
// 05.11 the core then stayed silent in every connected dialog until a director
// pressed «Обновить версию бота» (03–05.11: two days without answers).
//
// What it does: exactly the button's routine refresh, but without a signed-in
// actor and ONLY when the new revision differs from the active one in code
// hashes alone. Prompt, tool definitions, knowledge schema/source, limits and
// provider profile/policy must be byte-identical; rollout share, channels and
// capabilities are copied unchanged and re-checked inside the publication
// transaction; all idle checks, lineage and policy CAS stay in force. Anything
// else (quality, recruitment, catalog, media upgrades) stays a manual decision
// and keeps the loud alert. Never returns to a revision that was ever superseded,
// so an old process still alive during a rolling deploy cannot flip it back.
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { customerAgentRolloutConfigSchema, customerAgentOwnerStateSchema, type CustomerAgentRevision } from "@royal-home/shared";
import { prisma } from "../db.js";
import { createCustomerAgentMediaProviderSnapshot as createCustomerAgentProviderSnapshot } from "../ai/customerAgentProviderConfig.js";
import { buildCurrentCustomerAgentManifest, registerCurrentCustomerAgentRevision } from "./customerAgentRegistration.js";
import { customerAgentManifestId, decodeCustomerAgentRevision, type CustomerAgentManifest } from "./customerAgentRevision.js";
import { CustomerAgentOwnerError, CUSTOMER_AGENT_AUTO_REFRESH_ACTOR_NAME, publishCustomerAgentAutoRefresh } from "./customerAgentOwnerPolicy.js";
import { customerAgentQualityContinuityUpgradeVersion } from "./customerAgentQualityContinuityUpgrade.js";
import { reportCustomerAgentRevisionHeld, setCustomerAgentAutoRefreshPending } from "./customerAgentRevisionAlert.js";

export type CustomerAgentAutoRefreshResult =
  | { status: "inactive" | "current" | "refreshed" }
  | { status: "busy"; reason: string }
  | { status: "manual_required"; reason: string };

/** Fields that decide WHAT the bot says or may do. Any change → owner decision. */
const PINNED_FIELDS = ["promptHash", "toolSchemaHash", "knowledgeSchemaHash", "knowledgeSourceHash",
  "providerProfileHash", "providerPolicyHash", "limits"] as const;

/** Pure: why `next` is NOT an ordinary code refresh of `prior`, or null if it is. */
export function customerAgentAutoRefreshBlocker(prior: Readonly<CustomerAgentRevision>, next: CustomerAgentManifest): string | null {
  for (const field of PINNED_FIELDS) if (!isDeepStrictEqual(prior[field], next[field])) return `${field}_changed`;
  if (customerAgentQualityContinuityUpgradeVersion(prior, next) !== null) return "quality_upgrade";
  return null;
}

/** Idle/race outcomes: the next tick retries. Everything else needs the owner. */
const RETRYABLE = new Set(["core_work_requires_idle_publication", "policy_changed", "revision_advance_target_unreachable"]);
/** How long a pending automatic refresh may hold the loud alert back. */
export const AUTO_REFRESH_GRACE_MS = 15 * 60_000;

let running: Promise<CustomerAgentAutoRefreshResult> | null = null;
let busySince: number | null = null;

/** Idempotent, single-flight per process; the policy CAS serialises api+worker. */
export function autoRefreshCustomerAgentRevision(): Promise<CustomerAgentAutoRefreshResult> {
  running ??= attempt().finally(() => { running = null; });
  return running;
}

async function attempt(): Promise<CustomerAgentAutoRefreshResult> {
  // Synchronously, before the first await: a turn that meets the stale revision
  // while this attempt is deciding must not page the director for nothing.
  setCustomerAgentAutoRefreshPending(true, (busySince ?? Date.now()) + AUTO_REFRESH_GRACE_MS);
  let activeId: string | null = null;
  try {
    return await decide(id => { activeId = id; });
  } catch (error) {
    // Unexpected failure (DB blip, the idle trigger losing a race with a new
    // comment, artifact read): retried by the next tick, loud only after the
    // grace, so a transient error never spends the daily alert slot.
    console.error("[customer-agent] auto refresh failed:", error instanceof Error ? error.message : error);
    return wait(activeId, "refresh_failed", error);
  }
}

/** Retryable outcome: keep the alert held back until the grace runs out. */
async function wait(activeId: string | null, reason: string, error?: unknown): Promise<CustomerAgentAutoRefreshResult> {
  busySince ??= Date.now();
  setCustomerAgentAutoRefreshPending(true, busySince + AUTO_REFRESH_GRACE_MS);
  if (activeId && Date.now() - busySince >= AUTO_REFRESH_GRACE_MS) {
    setCustomerAgentAutoRefreshPending(false);
    await (error ? reportCustomerAgentRevisionHeld(activeId, "current_artifact_verification_unavailable", error)
      : reportCustomerAgentRevisionHeld(activeId, "current_artifact_revision_mismatch"));
  }
  return { status: "busy", reason };
}

async function decide(seen: (activeId: string) => void): Promise<CustomerAgentAutoRefreshResult> {
  const policy = await prisma.customerRuntimePolicy.findUnique({ where: { id: "singleton" } });
  if (!policy || policy.contractVersion !== "scoped" || policy.rolloutMode !== "ACTIVE" || !policy.activeAgentRevisionId) return settle({ status: "inactive" });
  const activeId = policy.activeAgentRevisionId;
  seen(activeId);
  const factory = createCustomerAgentProviderSnapshot();
  const next = await buildCurrentCustomerAgentManifest(factory);
  const nextId = customerAgentManifestId(next);
  if (nextId === activeId) return settle({ status: "current" });

  const manual = async (reason: string): Promise<CustomerAgentAutoRefreshResult> => {
    busySince = null;
    setCustomerAgentAutoRefreshPending(false);
    await reportCustomerAgentRevisionHeld(activeId, "current_artifact_revision_mismatch");
    return { status: "manual_required", reason };
  };
  const rollout = customerAgentRolloutConfigSchema.safeParse(policy.rolloutConfig);
  if (!rollout.success || rollout.data.candidateRevisionId !== activeId) return manual("policy_invalid");
  const capabilities = customerAgentOwnerStateSchema.shape.capabilities.safeParse(policy.capabilities);
  if (!capabilities.success) return manual("policy_invalid");
  const stored = await prisma.customerAgentRevision.findUnique({ where: { id: activeId } });
  if (!stored) return manual("active_revision_missing");
  const blocker = customerAgentAutoRefreshBlocker(decodeCustomerAgentRevision(stored), next);
  if (blocker) return manual(blocker);
  // The installed code is an ANCESTOR of the active revision: an old container
  // still running during a deploy must not "refresh" the policy back to itself.
  // The policy is fine, THIS process is outdated: no alert (it would spend the
  // daily slot of the healthy active revision), only the process log.
  const [ancestor] = await prisma.$queryRaw<Array<{ superseded: boolean }>>`WITH RECURSIVE later(id) AS (
      SELECT ${nextId}::text UNION SELECT e."toRevisionId" FROM "CustomerAgentRevisionAdvance" e JOIN later l ON e."fromRevisionId"=l.id)
    SELECT EXISTS(SELECT 1 FROM later WHERE id=${activeId}) AS superseded`;
  if (ancestor?.superseded) {
    console.warn(`[customer-agent] auto refresh skipped: installed code ${nextId.slice(0, 12)} was already superseded`);
    return settle({ status: "manual_required", reason: "target_superseded" });
  }

  try {
    // Register once; while waiting for idle the next ticks reuse the row.
    const existing = await prisma.customerAgentRevision.findUnique({ where: { id: nextId } });
    const registered = existing ? decodeCustomerAgentRevision(existing) : await registerCurrentCustomerAgentRevision(factory, {
      afterWrite: async (tx, value) => {
        await tx.auditLog.create({ data: { action: "CUSTOMER_AGENT_REGISTER", entityType: "CustomerAgentPolicy", entityId: value.id,
          agentId: null, agentName: CUSTOMER_AGENT_AUTO_REFRESH_ACTOR_NAME,
          meta: { configId: factory.configRevision, reason: "auto_refresh_after_deploy", authority: "system_auto_refresh" } } });
      },
    });
    if (registered.id !== nextId) return manual("artifact_changed_during_refresh");
    await publishCustomerAgentAutoRefresh({
      expectedPolicyRevision: policy.policyRevision.toString(),
      reason: `Автообновление после выката: ${activeId.slice(0, 12)} → ${nextId.slice(0, 12)} (изменился только код)`,
      rollout: { ...rollout.data, candidateRevisionId: nextId, cohortId: randomUUID() },
      capabilities: capabilities.data,
    });
    return settle({ status: "refreshed" });
  } catch (error) {
    if (error instanceof CustomerAgentOwnerError && RETRYABLE.has(error.code)) return wait(activeId, error.code);
    if (error instanceof CustomerAgentOwnerError) return manual(error.code);
    // The DB idle trigger (READ COMMITTED: a comment arrived between the code
    // check and the insert) raises a plain Postgres error, not an owner error.
    if (/requires idle|advance context changed/u.test(error instanceof Error ? error.message : String(error))) return wait(activeId, "core_work_requires_idle_publication");
    throw error;
  }
}

function settle<T extends CustomerAgentAutoRefreshResult>(result: T): T {
  busySince = null;
  setCustomerAgentAutoRefreshPending(false);
  return result;
}

/** Test seam: module state. */
export function resetCustomerAgentAutoRefreshState(): void { busySince = null; running = null; setCustomerAgentAutoRefreshPending(false); }
