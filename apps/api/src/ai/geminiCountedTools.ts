import { GEMINI_FUNCTION_DECLARATION_PROTOCOL, assertManagedGeminiFunctionWire } from "./geminiFunctionDeclarations.js";
/** Exact counted tools wire; no actor, price approval or customer grant. */
import { createHash } from "node:crypto";
import { z } from "zod";
import { customerAgentCountResponseSchema } from "./customerAgentProviderConfig.js";
import { GEMINI_MANAGED_MEDIA_USAGE_PROTOCOL, customerAgentMediaCountResponseSchema } from "./geminiManagedMedia.js";
import { boundGeminiCountContext, type BoundGeminiCountContext, type BoundGeminiCountTarget } from "./geminiOperationRuntime.js";
import { ProviderOperationError, type ProviderOperation, type ProviderAttempt } from "./providerContract.js";

export interface GeminiCountedToolsRequest {
  readonly operation: ProviderOperation; readonly attempt: ProviderAttempt;
  readonly model: string; readonly serializedBody: string;
  readonly generateUrl: string; readonly headers: Readonly<Record<string, string>>;
}
declare const witnessBrand: unique symbol;
export type GeminiCountedToolsWitness = { readonly [witnessBrand]: true };
type Witness = { operation: ProviderOperation; attempt: ProviderAttempt; operationId: string; ordinal: number; bodyDigest: string;
  model: string; profileKey: string; profileHash: string; policyHash: string; keyDigest: string;
  deadlineAt: number; countDeadlineAt: number; generateUrl: string; consumed: boolean; issued?: object };
const witnesses = new WeakMap<object, Witness>();
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const keyDigest = (headers: Readonly<Record<string, string>>) => digest(JSON.stringify(Object.entries(headers).sort(([a], [b]) => a.localeCompare(b))));
const deny = () => new ProviderOperationError("unsupported");
function current(input: GeminiCountedToolsRequest, context: Readonly<BoundGeminiCountContext>): Readonly<BoundGeminiCountTarget> {
  try {
    input.operation.check(); input.attempt.check();
    if (!input.operation.managed || input.operation.id !== context.operationId || input.operation.deadlineAt !== context.deadlineAt ||
        input.operation.profileRevision !== context.identity.profileRevision ||
        input.operation.policyHash !== context.providerPolicyHash || !Number.isSafeInteger(input.attempt.attemptNo) ||
        input.attempt.attemptNo < 1 || input.attempt.attemptNo > context.policy.maxRequests) throw deny();
    const target = context.selectTarget(input.model, input.headers["x-goog-api-key"]);
    if (!target || !context.selectedModels.includes(input.model) || input.generateUrl !== target.generateUrl ||
        keyDigest(input.headers) !== keyDigest(target.headers)) throw deny();
    return target;
  } catch (error) { throw error instanceof ProviderOperationError ? error : deny(); }
}
/** Called ONLY after original operation.begin has reserved its durable ordinal.
 * Same serialized full GenerateContentRequest: no contents-only undercount. */
export async function countGeminiToolsRequest(input: GeminiCountedToolsRequest): Promise<GeminiCountedToolsWitness> {
  // Caller-owned request objects may mutate during guards/network awaits.
  // Snapshot all values now; never reread their routing/key/body after await.
  const request = Object.freeze({ ...input, headers: Object.freeze({ ...input.headers }) });
  const context = boundGeminiCountContext(request.operation);
  if (!context) throw deny();
  const target = current(request, context);
  const { policy } = context;
  if (typeof request.serializedBody !== "string" || Buffer.byteLength(request.serializedBody, "utf8") > policy.maxUtf8RequestBytes) throw deny();
  try {
    const fullBody = JSON.parse(request.serializedBody);
    if (policy.functionDeclarationProtocol === GEMINI_FUNCTION_DECLARATION_PROTOCOL) assertManagedGeminiFunctionWire(fullBody.tools);
    z.object({ generationConfig: z.object({ maxOutputTokens: z.number().int().positive().max(policy.maxOutputTokens),
      thinkingConfig: z.object({ thinkingLevel: z.literal(policy.thinkingLevel) }).strict(),
    }).strict(), cachedContent: z.never().optional() }).passthrough().parse(fullBody);
  } catch { throw deny(); }
  const serializedCount = `{"generateContentRequest":{"model":${JSON.stringify(`models/${request.model}`)},${request.serializedBody.slice(1)}}`;
  if (Buffer.byteLength(serializedCount, "utf8") > policy.maxUtf8RequestBytes) throw deny();
  const deadlineAt = Math.min(request.operation.deadlineAt, Date.now() + policy.timeoutMs);
  const immutable: Witness = { operation: request.operation, attempt: request.attempt, operationId: request.operation.id, ordinal: request.attempt.attemptNo,
    bodyDigest: digest(request.serializedBody), model: request.model, profileKey: context.identity.profileRevision,
    profileHash: context.identity.profileHash, policyHash: context.providerPolicyHash, keyDigest: keyDigest(target.headers),
    deadlineAt: request.operation.deadlineAt, countDeadlineAt: deadlineAt, generateUrl: target.generateUrl, consumed: false };
  // This is a duplicate-call guard, NOT the durable counter: attemptNo comes
  // from the already reserved P13 ordinal, whose STARTED state blocks recovery.
  // A failed count may never be retried on the same ordinal in this process.
  if (witnesses.has(request.attempt)) throw deny();
  witnesses.set(request.attempt, immutable);
  const controller = new AbortController();
  let closed = false, timer: ReturnType<typeof setTimeout> | undefined;
  let rejectStop!: (error: ProviderOperationError) => void;
  const stop = new Promise<never>((_resolve, reject) => { rejectStop = reject; });
  const abort = () => { controller.abort(); rejectStop(new ProviderOperationError("cancelled")); };
  const check = () => {
    if (closed || controller.signal.aborted || Date.now() >= deadlineAt) throw deny();
    current(request, context);
    if (request.operation.signal?.aborted || request.attempt.signal.aborted) throw new ProviderOperationError("cancelled");
  };
  timer = setTimeout(() => { controller.abort(); rejectStop(deny()); }, Math.max(0, deadlineAt - Date.now()));
  request.attempt.signal.addEventListener("abort", abort, { once: true });
  if (request.attempt.signal.aborted) abort();
  const work = async () => {
    check();
    if (await context.assertCurrent({ signal: controller.signal, deadlineAt }) !== true) throw deny();
    check();
    const response = await fetch(target.countUrl, {
      method: "POST", headers: target.headers, body: serializedCount, signal: controller.signal, redirect: "error",
    });
    check();
    if (!response.ok || !response.body || Number(response.headers.get("content-length") ?? 0) > 16384) throw deny();
    const reader = response.body.getReader(), chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const item = await reader.read(); check();
        if (item.done) break;
        bytes += item.value.byteLength;
        if (bytes > 16384) throw deny();
        chunks.push(item.value);
      }
    } finally { if (bytes > 16384 || controller.signal.aborted) void reader.cancel().catch(() => {}); }
    const countSchema = context.usageProtocol === GEMINI_MANAGED_MEDIA_USAGE_PROTOCOL ? customerAgentMediaCountResponseSchema : customerAgentCountResponseSchema;
    const count = countSchema.safeParse(JSON.parse(Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString("utf8")));
    if (!count.success || count.data.totalTokens > policy.maxCountedInputTokens) throw deny();
    check();
    if (await context.assertCurrent({ signal: controller.signal, deadlineAt }) !== true) throw deny();
    check();
    const witness = Object.freeze({}) as GeminiCountedToolsWitness;
    immutable.issued = witness;
    witnesses.set(witness, immutable);
    return witness;
  };
  try { return await Promise.race([work(), stop]); }
  catch (error) { throw error instanceof ProviderOperationError ? error : deny(); }
  finally { closed = true; controller.abort(); clearTimeout(timer); request.attempt.signal.removeEventListener("abort", abort); }
}
/** No await between consume and physical generate fetch. This witness only
 * proves counted exact bytes, NOT customer identity, consent or an OUT grant. */
export function consumeGeminiToolsCount(witness: unknown, input: GeminiCountedToolsRequest): string {
  const stored = witness && typeof witness === "object" ? witnesses.get(witness) : null;
  if (!stored || stored.issued !== witness || stored.consumed) throw deny();
  stored.consumed = true; // Any failed use burns it; never retry a witness.
  const context = boundGeminiCountContext(input.operation);
  if (!context) throw deny();
  current(input, context);
  if (stored.operation !== input.operation || stored.attempt !== input.attempt || stored.operationId !== input.operation.id ||
      stored.ordinal !== input.attempt.attemptNo || stored.bodyDigest !== digest(input.serializedBody) || stored.model !== input.model ||
      stored.profileKey !== input.operation.profileRevision || stored.profileHash !== context.identity.profileHash ||
      stored.policyHash !== input.operation.policyHash || stored.keyDigest !== keyDigest(input.headers) ||
      stored.deadlineAt !== input.operation.deadlineAt || Date.now() >= stored.countDeadlineAt || stored.generateUrl !== input.generateUrl) throw deny();
  return input.serializedBody;
}
