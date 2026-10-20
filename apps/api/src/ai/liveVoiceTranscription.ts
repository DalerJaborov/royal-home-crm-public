import { z } from "zod";

/** Provider metadata only. Neither finished nor offsets are human consent,
 * authenticated call provenance, a stable utterance ID, or action authority. */
export interface LiveVoiceTranscriptionFragment {
  readonly text?: string;
  readonly finished?: boolean;
  readonly startOffset?: string;
  readonly endOffset?: string;
  readonly metadataValid: boolean;
}
export interface LiveVoiceTranscriptionObservation {
  readonly provider: "google";
  readonly model: string;
  readonly connectionEpoch: number;
  readonly messageOrder: number;
  readonly stream: "input" | "interim_input" | "output";
  readonly fragment: LiveVoiceTranscriptionFragment;
  // No selected-model profile has been qualified; do NOT infer FINAL from text/turnComplete.
  readonly humanFinality: "unknown";
}
const rawFragment = z.object({
  text: z.unknown().optional(), finished: z.unknown().optional(),
  startOffset: z.unknown().optional(), endOffset: z.unknown().optional(),
}).passthrough();
const text = z.string().max(64_000);
const flag = z.boolean();
const offset = z.string().regex(/^(?:0|[1-9]\d{0,7})(?:\.\d{1,9})?s$/);
function offsetNanoseconds(value: string): bigint {
  const [seconds, fraction = ""] = value.slice(0, -1).split(".");
  return BigInt(seconds) * 1_000_000_000n + BigInt(fraction.padEnd(9, "0"));
}

/** Known metadata is validated without coercion. Additional protocol fields do
 * not break legacy transcription, but malformed known fields cannot be evidence. */
export function parseLiveVoiceTranscription(raw: unknown): LiveVoiceTranscriptionFragment | undefined {
  const parsed = rawFragment.safeParse(raw);
  if (!parsed.success) return undefined;
  const value = parsed.data;
  const result: { text?: string; finished?: boolean; startOffset?: string; endOffset?: string; metadataValid: boolean } = { metadataValid: true };
  if (value.text !== undefined) {
    const field = text.safeParse(value.text);
    if (field.success) result.text = field.data;
    else result.metadataValid = false;
  }
  if (value.finished !== undefined) {
    const field = flag.safeParse(value.finished);
    if (field.success) result.finished = field.data;
    else result.metadataValid = false;
  }
  for (const key of ["startOffset", "endOffset"] as const) {
    if (value[key] === undefined) continue;
    const field = offset.safeParse(value[key]);
    if (field.success) result[key] = field.data;
    else result.metadataValid = false;
  }
  if (result.startOffset && result.endOffset &&
      offsetNanoseconds(result.endOffset) < offsetNanoseconds(result.startOffset)) result.metadataValid = false;
  if (Object.keys(result).length === 1 && result.metadataValid) return undefined;
  return Object.freeze(result);
}

export interface LiveVoiceTranscriptionFields {
  inputTranscription?: LiveVoiceTranscriptionFragment;
  interimInputTranscription?: LiveVoiceTranscriptionFragment;
  outputTranscription?: LiveVoiceTranscriptionFragment;
}
/** One ordered observation per present stream, preserving empty terminal
 * fragments. Sequence numbers are LOCAL observations, never provider dedupe IDs. */
export function liveVoiceTranscriptionObservations(fields: LiveVoiceTranscriptionFields, context: {
  model: string; connectionEpoch: number; messageOrder: number;
}): readonly LiveVoiceTranscriptionObservation[] {
  if (!context.model || !Number.isSafeInteger(context.connectionEpoch) || context.connectionEpoch <= 0 ||
      !Number.isSafeInteger(context.messageOrder) || context.messageOrder <= 0) return [];
  const result: LiveVoiceTranscriptionObservation[] = [];
  for (const [key, stream] of [
    ["interimInputTranscription", "interim_input"],
    ["inputTranscription", "input"],
    ["outputTranscription", "output"],
  ] as const) {
    const fragment = fields[key];
    if (fragment) result.push(Object.freeze({ provider: "google", ...context, stream, fragment, humanFinality: "unknown" }));
  }
  return Object.freeze(result);
}

/** Defer invocation itself, so both synchronous throws and async rejection are
 * consumed. No error object is passed to the diagnostic callback (PII boundary). */
export function invokeLiveVoiceTranscriptionObserver(
  observer: () => void | Promise<void>, isCurrent: () => boolean,
  onFailure: () => unknown | Promise<unknown>,
): Promise<void> {
  return Promise.resolve().then(() => { if (isCurrent()) return observer(); })
    .catch(() => Promise.resolve().then(() => onFailure()).then(() => undefined, () => undefined));
}
