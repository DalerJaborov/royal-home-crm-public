import { prisma } from "../db.js";
import { describeError } from "../lib/describeError.js";
import { resolveElevenLabsKey } from "../ai/liveVoiceProvider.js";
import { prepareAssistantReply } from "./assistantReply.js";
import { claimAssistantTtsChars } from "./assistantVoiceBudget.js";
import { sendVoiceFile, sendAssistantVoiceId, TelegramApiError } from "./api.js";
import { z } from "zod";
import { cacheableAssistantSpeech, assistantVoiceCacheKey, cachedAssistantAudio, writeAssistantVoiceCache, isOggOpusAudio } from "./assistantVoiceCache.js";

/** ElevenLabs REST TTS only. Tajik needs a separately configured, reviewed voice.
 * Missing settings, unavailable budget or provider errors leave the full text response.
 */
const TTS_TIMEOUT_MS = 25_000;
// v4 Turbo uses the Text-to-Dialogue WebSocket; v3 supports this REST TTS endpoint.
const TTS_MODEL = "eleven_v3";
const TTS_FORMAT = "opus_48000_64";
const VOICE_SETTINGS = { stability: 0.5, similarity_boost: 0.75, style: 0.3, speed: 1.12, use_speaker_boost: true };
const sentVoiceSchema = z.object({ voice: z.object({ file_id: z.string().min(1).max(1024) }) });

async function elevenLabsKey(): Promise<string | null> {
  const env = process.env.ELEVENLABS_API_KEY?.trim();
  if (env) return env;
  const row = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { elevenLabsApiKey: true } });
  return resolveElevenLabsKey(row?.elevenLabsApiKey ?? null);
}

/** Текст ответа → то, что приятно слушать: без ссылок, смайлов, разделителей и цифр телефонов. */
export function speechTextFromReply(text: string): string {
  return prepareAssistantReply(text).speech;
}

function voiceIdFor(language: "ru" | "tg"): string | undefined {
  return (language === "tg" ? process.env.ASSISTANT_TTS_VOICE_ID_TG : process.env.ASSISTANT_TTS_VOICE_ID)?.trim();
}

async function synthesize(text: string, language: "ru" | "tg"): Promise<Buffer | null> {
  const voiceId = voiceIdFor(language);
  if (!voiceId) return null;
  const key = await elevenLabsKey();
  if (!key) return null;
  if (!(await claimAssistantTtsChars(text.length))) return null;
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=${TTS_FORMAT}`, {
    method: "POST",
    headers: { "xi-api-key": key, "content-type": "application/json" },
    body: JSON.stringify({
      text,
      model_id: TTS_MODEL,
      language_code: language,
      apply_text_normalization: "on",
      voice_settings: VOICE_SETTINGS,
    }),
    signal: AbortSignal.timeout(TTS_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`ElevenLabs HTTP ${res.status}`);
  const audio = Buffer.from(await res.arrayBuffer());
  if (!isOggOpusAudio(audio)) throw new Error("ElevenLabs returned invalid Ogg/Opus audio");
  return audio;
}

/** Озвучивает ответ и шлёт голосовым. Никогда не бросает. */
export async function sendAssistantVoiceReply(chatId: string, replyText: string, replyTo?: number): Promise<boolean> {
  try {
    const plan = prepareAssistantReply(replyText);
    if (plan.language === "text-only") return false;
    const language = plan.language;
    const speech = plan.speech;
    if (speech.length < 3) return false;
    if (!cacheableAssistantSpeech(speech)) {
      const audio = await synthesize(speech, language);
      if (!audio?.length) return false;
      await sendVoiceFile(chatId, audio, replyTo);
      return true;
    }
    const voiceId = voiceIdFor(language);
    if (!voiceId) return false;
    const key = assistantVoiceCacheKey(speech, { voiceId, model: TTS_MODEL, format: TTS_FORMAT, language, normalization: "on", settings: VOICE_SETTINGS });
    const entry = await cachedAssistantAudio(key, () => synthesize(speech, language));
    if (!entry) return false;
    if (entry.fileId) {
      try { await sendAssistantVoiceId(chatId, entry.fileId, replyTo); return true; }
      catch (err) {
        // Re-upload only after a definite invalid-file rejection; never retry timeouts/429.
        if (!(err instanceof TelegramApiError && err.errorCode === 400 && /wrong file identifier|file_id.*invalid|file reference.*expired/i.test(err.message))) throw err;
        delete entry.fileId;
        await writeAssistantVoiceCache(key, entry);
      }
    }
    const sent = await sendVoiceFile(chatId, Buffer.from(entry.audio, "base64"), replyTo);
    const parsed = sentVoiceSchema.safeParse(sent);
    if (parsed.success) await writeAssistantVoiceCache(key, { ...entry, fileId: parsed.data.voice.file_id });
    return true;
  } catch (err) {
    console.warn("[telegram:assistant:voice] голос не отправлен, остаётся текст:", describeError(err));
    return false;
  }
}
