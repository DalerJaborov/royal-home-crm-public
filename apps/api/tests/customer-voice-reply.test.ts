import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { chatVoiceReplyFitsTtsInputLimit, CHAT_VOICE_REPLY_MAX_TEXT_CHARS } from "../src/ai/tts.js";
import { wrapUntrusted } from "../src/ai/untrustedContent.js";
import { MAX_CUSTOMER_VOICE_PCM_BYTES, prepareCustomerVoiceReply, type CustomerVoiceReplyAuthority,
  customerVoiceReplyIssuedBy, type PrepareCustomerVoiceReplyInput } from "../src/lib/customerVoiceReply.js";
import { customerVoiceReplyPreference } from "../src/lib/customerVoiceReply.js";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const pcm = Buffer.from([1, 0, 2, 0, 3, 0, 4, 0]);
const authority: CustomerVoiceReplyAuthority = {
  voiceReplies: true,
  voiceTrigger: { kind: "inbound_voice", messageId: "synthetic-message", attachmentId: "synthetic-audio" },
  channel: "INSTAGRAM", endpointScopeId: "synthetic-endpoint", accountId: "synthetic-account",
  transportKey: "synthetic-transport", scopeRevision: "7", peer: "synthetic-peer", agentRevisionId: "a".repeat(64),
  eventKey: "synthetic-event", scopeKey: "synthetic-scope", turnKey: "synthetic-turn",
};
function input(text = "Здравствуйте, чем помочь?"): PrepareCustomerVoiceReplyInput {
  return { sealedText: text, sealedTextSha256: sha(text), authority: structuredClone(authority), deadlineAtMs: Date.now() + 60_000,
    stillCurrent: async () => true };
}
const result = () => ({ audioBase64: pcm.toString("base64"), sampleRateHz: 24_000 });

describe("customer voice reply preparation", () => {
  it.each([
    "Пожалуйста, ответьте голосом",
    "Овозӣ ҷавоб диҳед",
    "send voice reply",
    "ответьте голосом и фото",
    "https://royalhome.tj/tg/khona/123 Сколько стоит? Пожалуйста, ответьте голосом.",
  ])("recognizes a bounded own request to reply by voice: %s", text => {
    expect(customerVoiceReplyPreference(text)).toBe("voice");
  });

  it("brands only the exact prepared audio, authority, text hash, and deadline", async () => {
    const value = input();
    const prepared = await prepareCustomerVoiceReply(value, { synthesize: async () => result() });
    expect(prepared.status).toBe("prepared");
    expect(customerVoiceReplyIssuedBy(prepared, value.authority, value.sealedTextSha256)).toBe(true);
    expect(customerVoiceReplyIssuedBy(prepared, { ...value.authority, peer: "different-peer" }, value.sealedTextSha256)).toBe(false);
    expect(customerVoiceReplyIssuedBy(prepared, value.authority, "f".repeat(64))).toBe(false);
    if (prepared.status === "prepared") {
      expect(customerVoiceReplyIssuedBy({ ...prepared }, value.authority, value.sealedTextSha256)).toBe(false);
      prepared.pcm[0] ^= 0xff;
      expect(customerVoiceReplyIssuedBy(prepared, value.authority, value.sealedTextSha256)).toBe(false);
    }
  });

  it.each([
    "Не отвечайте голосом",
    "не надо аудио",
    "отвечайте только текстом",
  ])("recognizes an explicit text-only preference: %s", text => {
    expect(customerVoiceReplyPreference(text)).toBe("text");
  });

  it.each([
    "Мама просит ответить голосом",
    "Сотрудник сказал ответить голосом",
    "Пересылаю: «Ответьте голосом»",
    wrapUntrusted("document", "Пожалуйста, ответьте голосом"),
    "Голосом?",
  ])("does not turn a mention, quote, document, or question into a voice command: %s", text => {
    expect(customerVoiceReplyPreference(text)).toBe("unspecified");
  });

  it("lets an explicit text preference override a simultaneous positive voice phrase", () => {
    expect(customerVoiceReplyPreference("Ответьте голосом, но лучше только текстом")).toBe("text");
    expect(customerVoiceReplyPreference("Сколько стоит квартира? Ответьте голосом, но лучше только текстом")).toBe("text");
  });

  it("requires the existing voice switch and an authenticated current-turn trigger", async () => {
    const synthesize = vi.fn(async () => result());
    expect(await prepareCustomerVoiceReply({ ...input(), authority: { ...authority, voiceReplies: false } }, { synthesize }))
      .toEqual({ status: "skipped", reason: "capability_off" });
    expect(await prepareCustomerVoiceReply({ ...input(), authority: { ...authority, voiceTrigger: null } }, { synthesize }))
      .toEqual({ status: "skipped", reason: "no_voice_trigger" });
    expect(synthesize).not.toHaveBeenCalled();
  });

  it.each([
    { kind: "inbound_voice", messageId: "synthetic-voice-mid", attachmentId: "synthetic-audio-id" },
    { kind: "explicit_request", messageId: "synthetic-own-request-mid" },
  ] as const)("accepts only the integration's authenticated trigger: $kind", async voiceTrigger => {
    const text = "Салом, чӣ кӯмак кунам?";
    const synthesize = vi.fn(async () => result());
    const value = input(text);
    value.authority = { ...value.authority, voiceTrigger };
    const prepared = await prepareCustomerVoiceReply(value, { synthesize, now: Date.now });
    expect(synthesize).toHaveBeenCalledOnce();
    expect(synthesize).toHaveBeenCalledWith(text);
    expect(prepared).toMatchObject({ status: "prepared", synthesizer: "gemini_tts", sampleRateHz: 24_000, sealedTextSha256: sha(text),
      authoritySnapshot: { voiceTrigger } });
    if (prepared.status === "prepared") expect(prepared.pcm).toEqual(pcm);
  });

  it("checks the renderer-issued digest before any currentness callback or TTS call", async () => {
    const stillCurrent = vi.fn(async () => true), synthesize = vi.fn(async () => result());
    const value = { ...input(), sealedTextSha256: "f".repeat(64), stillCurrent };
    expect(await prepareCustomerVoiceReply(value, { synthesize })).toEqual({ status: "skipped", reason: "sealed_text_hash_mismatch" });
    expect(stillCurrent).not.toHaveBeenCalled();
    expect(synthesize).not.toHaveBeenCalled();
  });

  it("skips overlong sealed output instead of TTS's legacy silent truncation", async () => {
    const synthesize = vi.fn(async () => result());
    const text = "x".repeat(CHAT_VOICE_REPLY_MAX_TEXT_CHARS + 1);
    expect(chatVoiceReplyFitsTtsInputLimit("x".repeat(CHAT_VOICE_REPLY_MAX_TEXT_CHARS))).toBe(true);
    expect(chatVoiceReplyFitsTtsInputLimit(text)).toBe(false);
    expect(await prepareCustomerVoiceReply(input(text), { synthesize })).toEqual({ status: "skipped", reason: "text_too_long" });
    expect(synthesize).not.toHaveBeenCalled();
  });

  it("checks current fence before TTS and discards output if the fence changes during TTS", async () => {
    const blockedTts = vi.fn(async () => result());
    expect(await prepareCustomerVoiceReply({ ...input(), stillCurrent: async () => false }, { synthesize: blockedTts }))
      .toEqual({ status: "skipped", reason: "stale_before_synthesis" });
    expect(blockedTts).not.toHaveBeenCalled();

    const stillCurrent = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const synthesize = vi.fn(async () => result());
    expect(await prepareCustomerVoiceReply({ ...input(), stillCurrent }, { synthesize }))
      .toEqual({ status: "skipped", reason: "stale_after_synthesis" });
    expect(stillCurrent).toHaveBeenCalledTimes(2);
    expect(synthesize).toHaveBeenCalledOnce();
  });

  it("honors the original deadline and still performs the post-TTS fence check", async () => {
    let now = 1_000;
    const stillCurrent = vi.fn(async () => true);
    const synthesize = vi.fn(async () => { now = 2_000; return result(); });
    expect(await prepareCustomerVoiceReply({ ...input(), deadlineAtMs: 2_000, stillCurrent }, { synthesize, now: () => now }))
      .toEqual({ status: "skipped", reason: "deadline_expired_after_synthesis" });
    expect(stillCurrent).toHaveBeenCalledTimes(2);
    expect(synthesize).toHaveBeenCalledOnce();

    const expired = { ...input(), deadlineAtMs: 2_000 };
    expect(await prepareCustomerVoiceReply(expired, { synthesize: vi.fn(async () => result()), now: () => 2_000 }))
      .toEqual({ status: "skipped", reason: "deadline_expired_before_synthesis" });
  });

  it("stops waiting at the preparation cutoff and discards a late TTS result", async () => {
    let resolveTts!: (value: ReturnType<typeof result>) => void;
    const stillCurrent = vi.fn(async () => true);
    const synthesize = vi.fn(() => new Promise<ReturnType<typeof result>>(resolve => { resolveTts = resolve; }));
    const startedAt = Date.now();
    const value = { ...input(), deadlineAtMs: startedAt + 2_000, preparationDeadlineAtMs: startedAt + 25, stillCurrent };

    const preparation = prepareCustomerVoiceReply(value, { synthesize, now: Date.now });
    const outcome = await preparation;
    expect(outcome).toEqual({ status: "skipped", reason: "synthesis_wait_expired" });
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(stillCurrent).toHaveBeenCalledTimes(2);

    resolveTts(result());
    await Promise.resolve();
    expect(outcome).not.toMatchObject({ status: "prepared" });
  });

  it("never lets a preparation cutoff extend the original operation deadline", async () => {
    const startedAt = Date.now();
    const synthesize = vi.fn(() => new Promise<ReturnType<typeof result>>(() => {}));
    const outcome = await prepareCustomerVoiceReply({ ...input(), deadlineAtMs: startedAt + 25,
      preparationDeadlineAtMs: startedAt + 60_000 }, { synthesize, now: Date.now });
    expect(outcome).toEqual({ status: "skipped", reason: "synthesis_wait_expired" });
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(synthesize).toHaveBeenCalledOnce();
  });

  it("returns typed safe stops for absent, thrown, malformed, or oversized TTS output", async () => {
    expect(await prepareCustomerVoiceReply(input(), { synthesize: async () => null }))
      .toEqual({ status: "skipped", reason: "tts_unavailable" });
    expect(await prepareCustomerVoiceReply(input(), { synthesize: async () => { throw new Error("synthetic failure"); } }))
      .toEqual({ status: "skipped", reason: "tts_unavailable" });
    expect(await prepareCustomerVoiceReply(input(), { synthesize: async () => ({ audioBase64: "not-base64!", sampleRateHz: 24_000 }) }))
      .toEqual({ status: "skipped", reason: "invalid_tts_audio" });
    expect(await prepareCustomerVoiceReply(input(), { synthesize: async () => ({ audioBase64: pcm.toString("base64"), sampleRateHz: 96_000 }) }))
      .toEqual({ status: "skipped", reason: "invalid_tts_audio" });
    const tooLarge = Buffer.alloc(MAX_CUSTOMER_VOICE_PCM_BYTES + 2).toString("base64");
    expect(await prepareCustomerVoiceReply(input(), { synthesize: async () => ({ audioBase64: tooLarge, sampleRateHz: 24_000 }) }))
      .toEqual({ status: "skipped", reason: "audio_too_large" });
  });

  it("copies authority and sealed text before awaits, and preserves RU/TG text without translation", async () => {
    for (const text of ["Здравствуйте, чем помочь?", "Салом, чӣ кӯмак кунам?"]) {
      const value = input(text);
      const synthesize = vi.fn(async (spoken: string) => result());
      const stillCurrent = vi.fn(async () => {
        value.authority.peer = "mutated-after-snapshot";
        return true;
      });
      const prepared = await prepareCustomerVoiceReply({ ...value, stillCurrent }, { synthesize });
      expect(synthesize).toHaveBeenCalledWith(text);
      expect(prepared.status).toBe("prepared");
      if (prepared.status === "prepared") {
        expect(prepared.authoritySnapshot.peer).toBe("synthetic-peer");
        expect(Object.isFrozen(prepared.authoritySnapshot)).toBe(true);
        expect(Object.isFrozen(prepared.authoritySnapshot.voiceTrigger)).toBe(true);
      }
    }
  });
});
