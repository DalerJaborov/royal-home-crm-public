import { prisma } from "../db.js";
import { decryptSecret } from "../crypto.js";
import { describeError } from "../lib/describeError.js";
import { resolveElevenLabsKey } from "../ai/liveVoiceProvider.js";
import { directAssistantVoice } from "./assistantVoiceDirection.js";
import { prepareAssistantReply } from "./assistantReply.js";
import { claimAssistantTtsChars } from "./assistantVoiceBudget.js";
import { sendChatAction, sendVoiceFile, sendAssistantVoiceId, TelegramApiError } from "./api.js";
import { z } from "zod";
import { cacheableAssistantSpeech, assistantVoiceCacheKey, cachedAssistantAudio, writeAssistantVoiceCache, isOggOpusAudio } from "./assistantVoiceCache.js";

/** ElevenLabs speech. Each language needs an explicitly configured voice.
 * Missing settings, unavailable budget or provider errors leave the full text response.
 */
const TTS_TIMEOUT_MS = 25_000;
const TTS_FORMAT = "opus_48000_64";
const VOICE_PROFILES = {
  ru: {
    model: "eleven_v4_turbo",
    endpoint: "https://api.elevenlabs.io/v1/text-to-speech",
    normalization: "on",
    settings: { stability: 0.45, similarity_boost: 0.75 },
  },
  tg: {
    model: "eleven_v4",
    endpoint: "https://api.elevenlabs.io/v1/text-to-dialogue",
    normalization: "off",
  },
} as const;
const sentVoiceSchema = z.object({ voice: z.object({ file_id: z.string().min(1).max(1024) }) });

interface SpeechConfig { voiceId: string; key: string | null }

async function resolveSpeechConfig(language: "ru" | "tg"): Promise<SpeechConfig | null> {
  const envVoice = (language === "tg" ? process.env.ASSISTANT_TTS_VOICE_ID_TG : process.env.ASSISTANT_TTS_VOICE_ID)?.trim();
  const saved = await prisma.assistantVoiceConfig.findUnique({ where: { id: "singleton" } });
  if (saved) {
    const voiceId = language === "tg" ? saved.voiceIdTg : saved.voiceIdRu;
    return { voiceId, key: decryptSecret(saved.encryptedKey) };
  }
  const envKey = process.env.ELEVENLABS_API_KEY?.trim();
  // One snapshot per reply: cache identity and synthesis must use the same resolved voice.
  const row = envVoice && envKey ? null : await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { elevenLabsApiKey: true, elevenLabsVoiceIdRu: true, elevenLabsVoiceIdTg: true },
  });
  const voiceId = envVoice || (language === "tg" ? row?.elevenLabsVoiceIdTg : row?.elevenLabsVoiceIdRu)?.trim();
  if (!voiceId) return null;
  return { voiceId, key: envKey || resolveElevenLabsKey(row?.elevenLabsApiKey ?? null) };
}

/** Текст ответа → то, что приятно слушать: без ссылок, смайлов, разделителей и цифр телефонов. */
export function speechTextFromReply(text: string): string {
  return prepareAssistantReply(text).speech;
}

async function synthesize(text: string, language: "ru" | "tg", config: SpeechConfig): Promise<Buffer | null> {
  const { voiceId, key } = config;
  if (!key) return null;
  if (!(await claimAssistantTtsChars(text.length))) return null;
  const profile = VOICE_PROFILES[language];
  const endpoint = language === "ru" ? `${profile.endpoint}/${encodeURIComponent(voiceId)}` : profile.endpoint;
  const input = language === "ru"
    ? { text, voice_settings: VOICE_PROFILES.ru.settings }
    : { inputs: [{ text, voice_id: voiceId }] };
  const res = await fetch(`${endpoint}?output_format=${TTS_FORMAT}`, {
    method: "POST",
    headers: { "xi-api-key": key, "content-type": "application/json" },
    body: JSON.stringify({
      ...input,
      model_id: profile.model,
      language_code: language,
      apply_text_normalization: profile.normalization,
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
    const performance = directAssistantVoice(speech);
    if (!performance) return false;
    const config = await resolveSpeechConfig(language);
    if (!config) return false;
    const render = async () => {
      const showRecording = () => void sendChatAction(chatId, undefined, "record_voice");
      showRecording();
      const indicator = setInterval(showRecording, 4_000).unref();
      try {
        return await synthesize(performance, language, config);
      } finally {
        clearInterval(indicator);
      }
    };
    if (!cacheableAssistantSpeech(speech)) {
      const audio = await render();
      if (!audio?.length) return false;
      void sendChatAction(chatId, undefined, "upload_voice");
      await sendVoiceFile(chatId, audio, replyTo);
      return true;
    }
    const { voiceId } = config;
    const { model, endpoint, normalization } = VOICE_PROFILES[language];
    const key = assistantVoiceCacheKey(performance, {
      voiceId, model, endpoint, format: TTS_FORMAT, language, normalization,
      ...(language === "ru" ? { settings: VOICE_PROFILES.ru.settings } : {}),
    });
    const entry = await cachedAssistantAudio(key, render);
    if (!entry) return false;
    if (entry.fileId) {
      void sendChatAction(chatId, undefined, "upload_voice");
      try { await sendAssistantVoiceId(chatId, entry.fileId, replyTo); return true; }
      catch (err) {
        // Re-upload only after a definite invalid-file rejection; never retry timeouts/429.
        if (!(err instanceof TelegramApiError && err.errorCode === 400 && /wrong file identifier|file_id.*invalid|file reference.*expired/i.test(err.message))) throw err;
        delete entry.fileId;
        await writeAssistantVoiceCache(key, entry);
      }
    }
    void sendChatAction(chatId, undefined, "upload_voice");
    const sent = await sendVoiceFile(chatId, Buffer.from(entry.audio, "base64"), replyTo);
    const parsed = sentVoiceSchema.safeParse(sent);
    if (parsed.success) await writeAssistantVoiceCache(key, { ...entry, fileId: parsed.data.voice.file_id });
    return true;
  } catch (err) {
    console.warn("[telegram:assistant:voice] голос не отправлен, остаётся текст:", describeError(err));
    return false;
  }
}
