import { createHash } from "node:crypto";
import { chatVoiceReplyFitsTtsInputLimit, synthesizeChatVoiceReply, type TtsResult } from "../ai/tts.js";
import { customerOwnUnquotedText } from "../ai/customerAgentConversationPolicy.js";

export type CustomerVoiceReplyPreference = "voice" | "text" | "unspecified";

const voiceTextOnlyPreference = /(?:^|[^\p{L}\p{N}])(?:не\s+(?:надо|нужно|хочу|просите|отвечайте|отвечай|отвечать|говорите|говори|говорить|присылайте|присылай|пришлите|пришли|отправляйте|отправляй|отправьте|отправь|записывайте|записывай|запишите|запиши)\s+(?:(?:мне|нам)\s+)?(?:голосом|голосов\p{L}*|аудио|voice(?:\s+(?:reply|message|note))?)|не\s+(?:надо|нужно)\s+(?:голос\p{L}*|аудио|voice(?:\s+(?:reply|message|note))?)|без\s+(?:голоса|голосов\p{L}*|аудио|voice(?:\s+(?:reply|message|note))?)|(?:отвечайте|отвечай|ответьте|ответь|reply|answer)\s+(?:мне\s+)?только\s+текстом|только\s+текстом|text\s+only|only\s+text|(?:do\s+not|don't|dont)\s+(?:send|reply|answer|respond|use)\s+(?:(?:me|us)\s+)?(?:a\s+)?(?:voice(?:\s+(?:reply|message|note))?|audio)|no\s+audio|(?:бо\s+овоз(?:ӣ)?|овозӣ|овоз)\s+(?:ҷавоб\s+)?на(?:диҳед|диҳ|кунед)|аудио\s+нафирист(?:ед)?|танҳо\s+(?:(?:бо\s+)?матн(?:ӣ)?)(?:\s+ҷавоб)?)(?=$|[^\p{L}\p{N}])/iu;

const voiceRequestPrefix = /^(?:(?:пожалуйста|лутфан|please|kindly)\s+)*(?:ответ(?:ь|ьте)|отвечай(?:те)?|пришл(?:и|ите)|отправь(?:те)?|запиши(?:те)?|скажи(?:те)?|говори(?:те)?)(?:\s+(?:мне|нам))?\s+(?:(?:ответ|реплику)\s+)?(?:голосом|голосов\p{L}*|аудио)(?=$|[^\p{L}\p{N}])/u;
const voiceRequestEnglish = /^(?:(?:please|kindly)\s+)*(?:(?:send|reply|respond|answer)(?:\s+(?:me|us))?\s+(?:(?:a|the)\s+)?(?:voice(?:\s+(?:reply|message|note))?|audio(?:\s+(?:reply|message|note))?)|(?:reply|respond|answer)(?:\s+to\s+me)?\s+(?:by|with)\s+voice)(?=$|[^\p{L}\p{N}])/u;
const voiceRequestTajik = /^(?:(?:лутфан)\s+)*(?:(?:бо\s+овоз(?:ӣ)?\s+)?(?:овозӣ\s+)?ҷавоб\s+(?:диҳед|деҳ|бидеҳ|гӯед)|(?:овозӣ|бо\s+овоз)\s+ҷавоб\s+(?:диҳед|деҳ|бидеҳ))(?=$|[^\p{L}\p{N}])/u;

/** Classify only the customer's current own words. Explicit text-only intent
 * wins over a simultaneous inbound voice attachment; mentions, quotes, and
 * content read from files have no authority to request audio. */
export function customerVoiceReplyPreference(input: string): CustomerVoiceReplyPreference {
  if (typeof input !== "string" || input.length > 8_000) return "unspecified";
  const originalOwn = customerOwnUnquotedText(input).normalize("NFKC").toLowerCase().replace(/ё/gu, "е");
  const normalize = (text: string) => text.replace(/[!?？！.,;:]+/gu, " ").replace(/\s+/gu, " ").trim();
  const own = normalize(originalOwn);
  if (!own) return "unspecified";
  if (voiceTextOnlyPreference.test(own)) return "text";
  // A direct imperative can follow the customer's actual question. Preserve
  // sentence boundaries before normalizing punctuation, so a reported phrase
  // in the middle of a sentence still cannot become an instruction.
  if (originalOwn.split(/[.!?？！]+(?:\s+|$)/u).map(normalize).some(sentence =>
    voiceRequestPrefix.test(sentence) || voiceRequestEnglish.test(sentence) || voiceRequestTajik.test(sentence))) return "voice";
  return "unspecified";
}

/** Maximum decoded PCM retained by this optional sidecar. This is a defensive
 * memory/asset bound, not a provider quota or a change to the existing TTS cap. */
export const MAX_CUSTOMER_VOICE_PCM_BYTES = 16 * 1024 * 1024;

export type CustomerVoiceTrigger =
  | { kind: "inbound_voice"; messageId: string; attachmentId: string }
  | { kind: "explicit_request"; messageId: string };

/** Immutable authority facts captured from the authenticated current turn. */
export interface CustomerVoiceReplyAuthority {
  voiceReplies: boolean;
  voiceTrigger: CustomerVoiceTrigger | null;
  channel: string;
  endpointScopeId: string;
  accountId: string | null;
  transportKey: string;
  scopeRevision: string;
  peer: string;
  agentRevisionId: string;
  eventKey: string;
  scopeKey: string;
  turnKey: string;
}

export interface PrepareCustomerVoiceReplyInput {
  /** Exact final server-rendered reply. Raw model text is not accepted by this boundary. */
  sealedText: string;
  /** Digest issued with the sealed renderer result; checked before any await. */
  sealedTextSha256: string;
  authority: CustomerVoiceReplyAuthority;
  /** Original operation deadline, in Unix milliseconds; synthesis never extends it. */
  deadlineAtMs: number;
  /** Optional earlier cutoff that reserves time for mandatory text planning. */
  preparationDeadlineAtMs?: number;
  /** Rechecks current settings, current-agent/policy fences and execution state. */
  stillCurrent: () => Promise<boolean>;
}

export type CustomerVoiceReplySkipReason =
  | "capability_off"
  | "no_voice_trigger"
  | "invalid_authority"
  | "empty_text"
  | "sealed_text_hash_mismatch"
  | "text_too_long"
  | "deadline_expired_before_synthesis"
  | "synthesis_wait_expired"
  | "stale_before_synthesis"
  | "deadline_expired_after_synthesis"
  | "stale_after_synthesis"
  | "tts_unavailable"
  | "invalid_tts_audio"
  | "audio_too_large";

export type CustomerVoiceReplyResult =
  | { status: "prepared"; synthesizer: "gemini_tts"; pcm: Buffer; sampleRateHz: number; sealedTextSha256: string;
      authoritySnapshot: Readonly<CustomerVoiceReplyAuthority>; deadlineAtMs: number }
  | { status: "skipped"; reason: CustomerVoiceReplySkipReason };

type PreparedCustomerVoiceReply = Extract<CustomerVoiceReplyResult, { status: "prepared" }>;
interface IssuedPreparedVoice {
  authoritySnapshot: Readonly<CustomerVoiceReplyAuthority>;
  pcm: Buffer;
  pcmSha256: string;
  sampleRateHz: number;
  sealedTextSha256: string;
  deadlineAtMs: number;
}

const issuedPreparedVoices = new WeakMap<object, IssuedPreparedVoice>();

function sameAuthority(a: CustomerVoiceReplyAuthority, b: CustomerVoiceReplyAuthority): boolean {
  if (a.voiceReplies !== b.voiceReplies || a.channel !== b.channel || a.endpointScopeId !== b.endpointScopeId ||
      a.accountId !== b.accountId || a.transportKey !== b.transportKey || a.scopeRevision !== b.scopeRevision ||
      a.peer !== b.peer || a.agentRevisionId !== b.agentRevisionId || a.eventKey !== b.eventKey ||
      a.scopeKey !== b.scopeKey || a.turnKey !== b.turnKey) return false;
  if (a.voiceTrigger === null || b.voiceTrigger === null) return a.voiceTrigger === b.voiceTrigger;
  return a.voiceTrigger.kind === b.voiceTrigger.kind && a.voiceTrigger.messageId === b.voiceTrigger.messageId &&
    (a.voiceTrigger.kind !== "inbound_voice" || b.voiceTrigger.kind === "inbound_voice" &&
      a.voiceTrigger.attachmentId === b.voiceTrigger.attachmentId);
}

/** Verify that audio is the unchanged output of this helper for the same
 * authenticated authority and sealed renderer text. Spreads/clones are not issued. */
export function customerVoiceReplyIssuedBy(
  result: CustomerVoiceReplyResult,
  authority: CustomerVoiceReplyAuthority,
  expectedSealedTextHash?: string,
): result is PreparedCustomerVoiceReply {
  if (!result || typeof result !== "object" || result.status !== "prepared") return false;
  const issued = issuedPreparedVoices.get(result);
  if (!issued || result.authoritySnapshot !== issued.authoritySnapshot || result.pcm !== issued.pcm ||
      !sameAuthority(authority, issued.authoritySnapshot) || result.deadlineAtMs !== issued.deadlineAtMs ||
      result.sampleRateHz !== issued.sampleRateHz || result.sealedTextSha256 !== issued.sealedTextSha256 ||
      expectedSealedTextHash !== undefined && expectedSealedTextHash !== issued.sealedTextSha256 ||
      !Buffer.isBuffer(result.pcm)) return false;
  return createHash("sha256").update(result.pcm).digest("hex") === issued.pcmSha256;
}

export interface CustomerVoiceReplyDependencies {
  synthesize?: (text: string) => Promise<TtsResult | null>;
  now?: () => number;
}

function snapshotAuthority(authority: CustomerVoiceReplyAuthority): Readonly<CustomerVoiceReplyAuthority> {
  const voiceTrigger = authority.voiceTrigger ? Object.freeze({ ...authority.voiceTrigger }) : null;
  return Object.freeze({ ...authority, voiceTrigger });
}

function hasIdentity(authority: CustomerVoiceReplyAuthority): boolean {
  const required = [authority.channel, authority.endpointScopeId, authority.transportKey, authority.scopeRevision,
    authority.peer, authority.eventKey, authority.scopeKey, authority.turnKey];
  return required.every(value => typeof value === "string" && value.trim().length > 0) &&
    (authority.accountId === null || typeof authority.accountId === "string" && authority.accountId.trim().length > 0) &&
    /^[a-f0-9]{64}$/.test(authority.agentRevisionId) &&
    (authority.voiceTrigger === null || authority.voiceTrigger.kind === "inbound_voice" &&
      !!authority.voiceTrigger.messageId.trim() && !!authority.voiceTrigger.attachmentId.trim() ||
      authority.voiceTrigger?.kind === "explicit_request" && !!authority.voiceTrigger.messageId.trim());
}

function decodePcm(audioBase64: string): Buffer | null {
  if (!audioBase64 || audioBase64.length > Math.ceil(MAX_CUSTOMER_VOICE_PCM_BYTES / 3) * 4 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(audioBase64) || audioBase64.length % 4 === 1) return null;
  const pcm = Buffer.from(audioBase64, "base64");
  const canonical = pcm.toString("base64").replace(/=+$/, "");
  if (!pcm.length || pcm.length % 2 !== 0 || pcm.length > MAX_CUSTOMER_VOICE_PCM_BYTES ||
      canonical !== audioBase64.replace(/=+$/, "")) return null;
  return pcm;
}

async function current(input: PrepareCustomerVoiceReplyInput): Promise<boolean> {
  try { return await input.stillCurrent(); } catch { return false; }
}

/**
 * Prepare audio only for an explicitly authorized voice turn. No persistence,
 * send, retry, or fallback is performed here. The caller must recheck its
 * current execution/outbox fence again immediately before sending the asset.
 */
export async function prepareCustomerVoiceReply(
  input: PrepareCustomerVoiceReplyInput,
  deps: CustomerVoiceReplyDependencies = {},
): Promise<CustomerVoiceReplyResult> {
  const now = deps.now ?? Date.now;
  const synthesize = deps.synthesize ?? synthesizeChatVoiceReply;
  // Snapshot before callbacks or provider awaits; strings are immutable, nested
  // authority is copied so a later caller mutation cannot change the witness.
  const text = input.sealedText;
  const textSha256 = createHash("sha256").update(text).digest("hex");
  const authoritySnapshot = snapshotAuthority(input.authority);
  const skip = (reason: CustomerVoiceReplySkipReason): CustomerVoiceReplyResult => ({ status: "skipped", reason });

  if (!authoritySnapshot.voiceReplies) return skip("capability_off");
  if (!authoritySnapshot.voiceTrigger) return skip("no_voice_trigger");
  if (!hasIdentity(authoritySnapshot)) return skip("invalid_authority");
  if (!text.trim()) return skip("empty_text");
  if (!/^[a-f0-9]{64}$/.test(input.sealedTextSha256) || input.sealedTextSha256 !== textSha256) {
    return skip("sealed_text_hash_mismatch");
  }
  if (!chatVoiceReplyFitsTtsInputLimit(text)) return skip("text_too_long");
  if (!Number.isFinite(input.deadlineAtMs) || now() >= input.deadlineAtMs) return skip("deadline_expired_before_synthesis");
  if (input.preparationDeadlineAtMs !== undefined && !Number.isFinite(input.preparationDeadlineAtMs)) {
    return skip("invalid_authority");
  }
  const synthesisDeadlineAtMs = Math.min(input.deadlineAtMs, input.preparationDeadlineAtMs ?? input.deadlineAtMs);
  if (now() >= synthesisDeadlineAtMs) {
    return skip(synthesisDeadlineAtMs < input.deadlineAtMs ? "synthesis_wait_expired" : "deadline_expired_before_synthesis");
  }
  if (!await current(input)) return skip("stale_before_synthesis");
  if (now() >= synthesisDeadlineAtMs) {
    return skip(synthesisDeadlineAtMs < input.deadlineAtMs ? "synthesis_wait_expired" : "deadline_expired_before_synthesis");
  }

  let encoded: unknown;
  let sampleRateHz: unknown;
  let ttsFailed = false;
  let synthesisWaitExpired = false;
  try {
    // Pass the exact sealed string. The existing TTS wrapper adds its own style;
    // there is no model-generated or translated speech text here.
    // Keep rejection handling attached even after timeout: the existing provider
    // call may finish (and be accounted for) in the background, but its result
    // must never be adopted after the caller's preparation window closes.
    const ttsWork: Promise<{ kind: "settled"; value: TtsResult | null } | { kind: "failed" }> =
      Promise.resolve().then(() => synthesize(text)).then(
        value => ({ kind: "settled" as const, value }),
        () => ({ kind: "failed" as const }),
      );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<{ kind: "timeout" }>(resolve => {
      timer = setTimeout(() => resolve({ kind: "timeout" }), Math.max(0, synthesisDeadlineAtMs - now()));
    });
    const outcome = await Promise.race([ttsWork, timeout]);
    if (timer !== undefined) clearTimeout(timer);
    if (outcome.kind === "timeout") {
      synthesisWaitExpired = true;
    }
    const tts = outcome.kind === "settled" ? outcome.value : null;
    if (tts) {
      // Copy primitive fields before the asynchronous currentness check so an
      // injected/provider-owned object cannot mutate the prepared witness.
      encoded = tts.audioBase64;
      sampleRateHz = tts.sampleRateHz;
    }
  } catch {
    ttsFailed = true;
  }

  // Always recheck after the asynchronous TTS attempt. A stale or expired turn
  // discards the paid result; this helper cannot enqueue or send it afterward.
  const isStillCurrent = await current(input);
  if (!isStillCurrent) return skip("stale_after_synthesis");
  if (synthesisWaitExpired) return skip("synthesis_wait_expired");
  if (now() >= input.deadlineAtMs) return skip("deadline_expired_after_synthesis");
  if (ttsFailed || encoded === undefined || sampleRateHz === undefined) return skip("tts_unavailable");

  // Validate the provider result only after the post-await fences pass.
  if (typeof sampleRateHz !== "number") return skip("invalid_tts_audio");
  if (typeof encoded !== "string") return skip("invalid_tts_audio");
  if (!Number.isInteger(sampleRateHz) || sampleRateHz < 8_000 || sampleRateHz > 48_000) {
    return skip("invalid_tts_audio");
  }
  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
  if (Math.floor(encoded.length * 3 / 4) - padding > MAX_CUSTOMER_VOICE_PCM_BYTES) return skip("audio_too_large");
  const pcm = decodePcm(encoded);
  if (!pcm) return skip("invalid_tts_audio");
  const prepared: PreparedCustomerVoiceReply = Object.freeze({ status: "prepared", synthesizer: "gemini_tts",
    pcm: Buffer.from(pcm), sampleRateHz, sealedTextSha256: textSha256, authoritySnapshot, deadlineAtMs: input.deadlineAtMs });
  issuedPreparedVoices.set(prepared, { authoritySnapshot, pcm: prepared.pcm,
    pcmSha256: createHash("sha256").update(prepared.pcm).digest("hex"), sampleRateHz,
    sealedTextSha256: textSha256, deadlineAtMs: input.deadlineAtMs });
  return prepared;
}
