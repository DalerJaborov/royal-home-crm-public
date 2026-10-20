import { isDeepStrictEqual } from "node:util";
import type { CustomerAgentRevision } from "@royal-home/shared";
import { prisma, type TxClient } from "../db.js";
import { isActiveTransactionClient } from "./transactionScope.js";
import { decodeCustomerAgentProviderSnapshot, loadCustomerAgentProviderSnapshot, customerAgentProviderIdentities,
  type CustomerAgentProviderSnapshot } from "../ai/customerAgentProviderConfig.js";

interface ArchiveRow { id: string; snapshotJson: unknown; providerProfileHash: string; providerPolicyHash: string }
/** Internal registration primitive. Caller must independently validate the
 * exact compiled manifest/prompt/tools/knowledge and server authorization.
 * This stores configuration only; no active reference/policy/rights change. */
export async function archiveCustomerAgentRuntimeTx(tx: TxClient, raw: unknown): Promise<Readonly<CustomerAgentProviderSnapshot>> {
  if (!isActiveTransactionClient(tx)) throw new TypeError("Active runtime registration transaction required");
  const snapshot = decodeCustomerAgentProviderSnapshot(raw), identity = customerAgentProviderIdentities(snapshot);
  await tx.$executeRaw`INSERT INTO "CustomerAgentRuntimeSnapshot" ("id","snapshotJson","providerProfileHash","providerPolicyHash","createdAt")
    VALUES (${identity.snapshotHash},${JSON.stringify(snapshot)}::jsonb,${identity.providerProfileHash},${identity.providerPolicyHash},now())
    ON CONFLICT ("providerProfileHash","providerPolicyHash") DO NOTHING`;
  const [stored] = await tx.$queryRaw<ArchiveRow[]>`SELECT "id","snapshotJson","providerProfileHash","providerPolicyHash"
    FROM "CustomerAgentRuntimeSnapshot" WHERE "providerProfileHash"=${identity.providerProfileHash} AND "providerPolicyHash"=${identity.providerPolicyHash}`;
  if (!stored || stored.id !== identity.snapshotHash || !isDeepStrictEqual(stored.snapshotJson, snapshot)) {
    throw new TypeError("Immutable runtime archive collision");
  }
  return snapshot;
}

/** Pinned lookup only: never reads activeAgentRevisionId or current model
 * settings. Missing/expired archive cannot silently fall back to new config. */
export async function loadPinnedCustomerAgentRuntime(revision: Readonly<CustomerAgentRevision>, db: Pick<TxClient, "$queryRaw"> = prisma): Promise<
  { status: "current"; snapshot: Readonly<CustomerAgentProviderSnapshot> } | { status: "held"; reason: string }
> {
  try {
    const [row] = await db.$queryRaw<ArchiveRow[]>`SELECT "id","snapshotJson","providerProfileHash","providerPolicyHash"
      FROM "CustomerAgentRuntimeSnapshot" WHERE "providerProfileHash"=${revision.providerProfileHash} AND "providerPolicyHash"=${revision.providerPolicyHash}`;
    if (!row) return { status: "held", reason: "runtime_archive_missing" };
    const snapshot = loadCustomerAgentProviderSnapshot(row.snapshotJson, { snapshotHash: row.id,
      providerProfileHash: revision.providerProfileHash, providerPolicyHash: revision.providerPolicyHash, nowMs: Date.now() });
    if (row.providerProfileHash !== revision.providerProfileHash || row.providerPolicyHash !== revision.providerPolicyHash ||
        !isDeepStrictEqual(revision.limits, { ...snapshot.turn, maxModelOutputTokens: snapshot.wire.maxOutputTokens })) {
      return { status: "held", reason: "runtime_manifest_limits_mismatch" };
    }
    return { status: "current", snapshot };
  } catch {
    return { status: "held", reason: "runtime_archive_unavailable" };
  }
}
