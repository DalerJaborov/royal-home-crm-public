import { customerAgentRevisionSchema, type CustomerAgentRevision } from "@royal-home/shared";
import type { callGeminiTools, GeminiToolTurn } from "./geminiClient.js";
import type { ProviderOperation } from "./providerContract.js";
import type { CustomerAgentContent, CustomerAgentModelTurn, CustomerAgentToolDefinition, CustomerAgentAwaitContext } from "./customerAgentCore.js";

type ModelInput = { contents: readonly CustomerAgentContent[]; tools: readonly CustomerAgentToolDefinition[];
  revision: CustomerAgentRevision; operation: ProviderOperation; wait: CustomerAgentAwaitContext };
type WireCall = typeof callGeminiTools;
/** Construct only in the real server adapter after approved policy/profile
 * lookup. Keys/system are closure state, never part of the model frame/result. */
export function createCustomerAgentModel(options: {
  apiKey: string; system: string; revision: CustomerAgentRevision;
  /** Complete stable prefix/tool defs are included in the token upper bound by
   * the approved server policy. Char bounds alone are not a billing proof. */
  assertInputBudget(input: { system: string; contents: readonly CustomerAgentContent[]; tools: readonly CustomerAgentToolDefinition[] }): void;
  /** Actual server registration closure checks one-shot wire binding against
   * the pinned manifest hash and its declared operation profile key. */
  requirePinnedRuntime(operation: ProviderOperation, expectedProviderProfileHash: string): true;
  call: WireCall;
}): (input: ModelInput) => Promise<CustomerAgentModelTurn> {
  const apiKey = options.apiKey, system = options.system, expectedRevision = customerAgentRevisionSchema.parse(structuredClone(options.revision)), call = options.call;
  if (!apiKey.trim() || !system.trim()) throw new TypeError("Server model configuration required");
  return async input => {
    input.operation.check();
    if (input.wait.signal.aborted || Date.now() >= input.wait.deadlineAt || input.wait.deadlineAt > input.operation.deadlineAt) throw new Error("Original model deadline unavailable");
    if (!input.operation.managed || JSON.stringify(customerAgentRevisionSchema.parse(input.revision)) !== JSON.stringify(expectedRevision)) throw new Error("Pinned approved managed operation required");
    if (JSON.stringify({ system, contents: input.contents, tools: input.tools }).length > input.revision.limits.maxInputChars) throw new Error("Model input limit");
    options.assertInputBudget({ system, contents: input.contents, tools: input.tools });
    if (options.requirePinnedRuntime(input.operation, expectedRevision.providerProfileHash) !== true) throw new Error("Pinned runtime unavailable");
    // GeminiPart is intentionally not a shared authority-bearing protocol.
    // Preserve provider parts byte-for-byte; the real wire client performs its
    // managed part/capability checks before reservation and physical POST.
    const turn: GeminiToolTurn = await call({ apiKey, system,
      contents: structuredClone(input.contents) as Parameters<WireCall>[0]["contents"],
      tools: structuredClone(input.tools) as Parameters<WireCall>[0]["tools"],
      maxTokens: input.revision.limits.maxModelOutputTokens,
      timeoutMs: Math.max(1, Math.min(input.operation.remainingMs(), input.wait.deadlineAt - Date.now())), providerOperation: input.operation });
    input.operation.check();
    if (input.wait.signal.aborted || Date.now() >= input.wait.deadlineAt) throw new Error("Original model deadline unavailable");
    // Gemini can include narration alongside a function call. It belongs to
    // the provider transcript, never to the customer decision channel. Keep
    // signed parts intact for the next round; validate/execute calls in Core.
    return { text: turn.calls.length ? "" : turn.text, calls: structuredClone(turn.calls), modelParts: structuredClone(turn.modelParts) };
  };
}
