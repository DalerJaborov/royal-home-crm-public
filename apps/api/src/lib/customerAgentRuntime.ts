import type { CustomerAgentRevision } from "@royal-home/shared";
import { prisma } from "../db.js";
import { createCustomerAgentModel } from "../ai/customerAgentModel.js";
import type { CustomerAgentAwaitContext } from "../ai/customerAgentCore.js";
import { callGeminiTools } from "../ai/geminiClient.js";
import { resolveGeminiRuntime } from "../ai/geminiSettings.js";
import { bindGeminiRuntimeToOperation, isGeminiRuntimeBound } from "../ai/geminiOperationRuntime.js";
import { customerAgentProviderBudgetPolicy } from "../ai/customerAgentProviderConfig.js";
import { createManagedProviderOperation, recoverManagedProviderOperation } from "../ai/providerBudget.js";
import { providerDayKey, type ProviderOperation } from "../ai/providerContract.js";
import { loadVerifiedCustomerAgentRevision } from "./customerAgentRegistration.js";
import { perceiveCustomerAgentMedia, CUSTOMER_MEDIA_EXTRACTION_TOOL_NAME, type CustomerAgentMediaPart, type CustomerAgentMediaPerception } from "../ai/customerAgentMediaPerception.js";

/** Internal provider lifecycle shared by actual channel adapters. This does
 * not issue an actor, business or outbound grant. The caller retains its real
 * source/claim/receipt guards; the model has no access to this constructor.
 * No generation/count/reservation is performed by opening a session. */
export async function openPinnedCustomerAgentRuntime(input: {
  revision: Readonly<CustomerAgentRevision>;
  providerOperationId: string;
  originalReceivedAt: number;
  providerDeadlineAt: number;
  assertCurrent(wait: CustomerAgentAwaitContext): Promise<boolean>;
}): Promise<{ status: "ready"; runtime: {
  operation: ProviderOperation;
  modelTurn: ReturnType<typeof createCustomerAgentModel>;
  mediaEnabled: boolean;
  perceiveMedia(parts: readonly CustomerAgentMediaPart[], wait: CustomerAgentAwaitContext): Promise<CustomerAgentMediaPerception>;
  stop(): void;
  close(): Promise<void>;
} } | { status: "held"; reason: string }> {
  const controller = new AbortController();
  let operation: ProviderOperation | undefined;
  try {
    const now = Date.now();
    if (!Number.isSafeInteger(input.originalReceivedAt) || !Number.isSafeInteger(input.providerDeadlineAt) ||
        input.originalReceivedAt > now || now >= input.providerDeadlineAt ||
        input.providerDeadlineAt > input.originalReceivedAt + input.revision.limits.deadlineMs ||
        providerDayKey(new Date(input.originalReceivedAt)) !== providerDayKey()) return { status: "held", reason: "original_runtime_deadline" };
    const current = async (wait: CustomerAgentAwaitContext): Promise<boolean> =>
      !wait.signal.aborted && !controller.signal.aborted && Date.now() < Math.min(wait.deadlineAt, input.providerDeadlineAt) &&
      await input.assertCurrent(wait) === true && !wait.signal.aborted && !controller.signal.aborted &&
      Date.now() < Math.min(wait.deadlineAt, input.providerDeadlineAt);
    const wait = { signal: controller.signal, deadlineAt: input.providerDeadlineAt };
    if (!await current(wait)) return { status: "held", reason: "original_runtime_context" };
    const verified = await loadVerifiedCustomerAgentRevision(input.revision);
    if (verified.status !== "current") return verified;
    // Only credentials are taken from Settings. The model, tools profile,
    // cache mode, limits and rates remain the ORIGINAL immutable revision.
    const keys = [...(await resolveGeminiRuntime()).keys];
    if (!keys.length || !await current(wait)) return { status: "held", reason: "runtime_credentials_or_context" };
    const policy = customerAgentProviderBudgetPolicy(verified.snapshot);
    const existing = await prisma.aiProviderOperation.findUnique({ where: { id: input.providerOperationId }, select: { id: true } });
    if (existing) {
      const recovered = await recoverManagedProviderOperation(policy, { operationId: input.providerOperationId,
        deadlineAt: input.providerDeadlineAt, dayKey: providerDayKey(new Date(input.originalReceivedAt)), signal: controller.signal });
      if (recovered.status !== "ready") return { status: "held", reason: `runtime_recovery_${recovered.reason}` };
      operation = recovered.operation;
    } else {
      operation = createManagedProviderOperation(policy, { operationId: input.providerOperationId,
        deadlineAt: input.providerDeadlineAt, signal: controller.signal });
    }
    if (!await current(wait)) return { status: "held", reason: "original_runtime_context" };
    bindGeminiRuntimeToOperation(operation, { profile: verified.snapshot.profile,
      expectedProfileRevision: verified.snapshot.profile.profileRevision, expectedProfileHash: input.revision.providerProfileHash,
      keys, countContext: { expectedProviderPolicyHash: input.revision.providerPolicyHash, assertCurrent: current } });
    const modelTurn = createCustomerAgentModel({ apiKey: keys[0], system: verified.system, revision: input.revision,
      assertInputBudget: ({ system, contents, tools }) => {
        // Size is an early resource guard. Exact countTokens + reserved ordinal
        // in the real wire is the token bound; chars are never a cost proof.
        if (Buffer.byteLength(JSON.stringify({ system, contents, tools }), "utf8") > verified.snapshot.wire.maxUtf8RequestBytes) {
          throw new TypeError("Customer model input too large");
        }
      },
      requirePinnedRuntime: (value, expectedProfileHash) => {
        if (value !== operation || !isGeminiRuntimeBound(value, {
          profileRevision: verified.snapshot.profile.profileRevision, profileHash: expectedProfileHash,
        })) throw new TypeError("Original provider binding required");
        return true;
      }, call: callGeminiTools });
    const original = operation;
    return { status: "ready", runtime: { operation: original, modelTurn, mediaEnabled: verified.snapshot.wire.media,
      perceiveMedia: (parts, wait) => {
        if (!verified.snapshot.wire.media) throw new Error("Pinned profile does not permit media");
        return perceiveCustomerAgentMedia({ parts, operation: original, wait, assertCurrent: current,
          call: request => callGeminiTools({ apiKey: keys[0], system: request.system, contents: request.contents,
            tools: request.tools, requiredFunctionName: CUSTOMER_MEDIA_EXTRACTION_TOOL_NAME, maxTokens: verified.snapshot.wire.maxOutputTokens,
            timeoutMs: Math.max(1, Math.min(original.remainingMs(), wait.deadlineAt - Date.now())), providerOperation: original }) });
      },
      stop: () => controller.abort(), close: () => original.close() } };
  } catch {
    controller.abort();
    // Opening has no provider I/O. If a previous operation existed, do not
    // manufacture settlement/refunds or change its durable recovery outcome.
    return { status: "held", reason: "pinned_runtime_unavailable" };
  }
}
