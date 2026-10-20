import { prisma } from "../../src/db.js";
import { recoverManagedProviderOperation, type ProviderBudgetPolicy } from "../../src/ai/providerBudget.js";
import type { ProviderAttemptSpec } from "../../src/ai/providerContract.js";

// Synthetic normal-PG subprocess only. No provider I/O.
const fixture = JSON.parse(process.argv[2] ?? "{}") as {
  policy: ProviderBudgetPolicy; original: { operationId: string; deadlineAt: number; dayKey: string }; spec: ProviderAttemptSpec;
};
try {
  const recovered = await recoverManagedProviderOperation(fixture.policy, fixture.original);
  if (recovered.status !== "ready") throw new Error("Synthetic usage recovery held");
  const attempt = await recovered.operation.begin(fixture.spec, 5000);
  attempt.reportUsage({ promptTokenCount: 100, candidatesTokenCount: 20, totalTokenCount: 120 });
  await attempt.finish("success");
  console.log("RH_USAGE_RECOVERY " + JSON.stringify({ id: recovered.operation.id,
    deadlineAt: recovered.operation.deadlineAt, attemptNo: attempt.attemptNo }));
} finally { await prisma.$disconnect(); }
