import { prisma } from "../../src/db.js";
import { recoverManagedProviderOperation, type ProviderBudgetPolicy } from "../../src/ai/providerBudget.js";
import type { ProviderAttemptSpec } from "../../src/ai/providerContract.js";

// Synthetic fixture subprocess only. It performs actual SQL, never a provider call.
const fixture = JSON.parse(process.argv[2] ?? "{}") as {
  policy: ProviderBudgetPolicy; original: { operationId: string; deadlineAt: number; dayKey: string };
  spec: ProviderAttemptSpec;
};
try {
  const loaded = await recoverManagedProviderOperation(fixture.policy, fixture.original);
  if (loaded.status !== "ready") throw new Error("Fixture recovery held: " + loaded.reason);
  const attempt = await loaded.operation.begin(fixture.spec, 5000);
  attempt.reportUsage({ promptTokenCount: 0, candidatesTokenCount: 0, thoughtsTokenCount: 0, cachedContentTokenCount: 0 });
  await attempt.finish("invalid");
  console.log("RH_PROVIDER_RECOVERY_RESULT " + JSON.stringify({
    status: "settled", attemptNo: attempt.attemptNo, id: loaded.operation.id, deadlineAt: loaded.operation.deadlineAt,
  }));
} finally { await prisma.$disconnect(); }
