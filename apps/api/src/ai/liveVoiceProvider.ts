import { prisma } from "../db.js";
import { decryptSecretSafe } from "../crypto.js";
import { describeError } from "../lib/describeError.js";
import { logSystemError } from "../lib/systemError.js";
import { LiveVoiceClient } from "./liveVoiceClient.js";
import { ElevenLabsVoiceClient } from "./elevenLabsVoiceClient.js";
import type { VoiceGender } from "@royal-home/shared";
import type { LiveVoiceProviderClient } from "./liveVoiceProviderTypes.js";

// Договор между мостом и поставщиком — в liveVoiceProviderTypes.ts (там и разбор
// событий); здесь только выбор поставщика по Настройкам.
export type {
  LiveVoiceConnectOptions,
  LiveVoiceLanguage,
  LiveVoiceProviderClient,
  LiveVoiceProviderName,
} from "./liveVoiceProviderTypes.js";

export type LiveVoiceProviderConfig =
  | { provider: "google" }
  | {
      provider: "elevenlabs";
      apiKey: string | null;
      agentId: string | null;
      voiceIdRu: string | null;
      voiceIdTg: string | null;
      /** Пол русского голоса — для правила рода в промте (см. liveVoiceSelfGender). */
      voiceGender: VoiceGender;
    };

/** Клиент выбранного поставщика. Чистая функция — проверяется тестом без сети. */
export function createLiveVoiceProviderClient(config: LiveVoiceProviderConfig): LiveVoiceProviderClient {
  if (config.provider === "elevenlabs") {
    return new ElevenLabsVoiceClient({
      apiKey: config.apiKey,
      agentId: config.agentId,
      voiceIdRu: config.voiceIdRu,
      voiceIdTg: config.voiceIdTg,
    });
  }
  return new LiveVoiceClient();
}

/** Ключ ElevenLabs: Настройки (зашифрован) приоритетнее ELEVENLABS_API_KEY из .env —
 *  тот же порядок, что у ключей Gemini и OpenAI. */
export function resolveElevenLabsKey(encrypted: string | null | undefined): string | null {
  return decryptSecretSafe(encrypted ?? null)?.trim() || process.env.ELEVENLABS_API_KEY?.trim() || null;
}

/**
 * Поставщик на ЭТОТ звонок — читается при подъёме сессии, как голос и промт:
 * переключатель посреди идущего разговора действует со следующего звонка.
 * База не ответила — Google, как до переключателя: звонок важнее сравнения.
 */
export async function loadLiveVoiceProviderConfig(): Promise<LiveVoiceProviderConfig> {
  try {
    const row = await prisma.settings.findUnique({
      where: { id: "singleton" },
      select: {
        liveVoiceProvider: true,
        elevenLabsApiKey: true,
        elevenLabsAgentId: true,
        elevenLabsVoiceIdRu: true,
        elevenLabsVoiceIdTg: true,
        elevenLabsVoiceGender: true,
      },
    });
    if (row?.liveVoiceProvider !== "elevenlabs") return { provider: "google" };
    return {
      provider: "elevenlabs",
      apiKey: resolveElevenLabsKey(row.elevenLabsApiKey),
      agentId: row.elevenLabsAgentId?.trim() || null,
      voiceIdRu: row.elevenLabsVoiceIdRu?.trim() || null,
      voiceIdTg: row.elevenLabsVoiceIdTg?.trim() || null,
      // Не задан — женский, как для неузнанного голоса Gemini (voiceGender).
      voiceGender: row.elevenLabsVoiceGender === "male" ? "male" : "female",
    };
  } catch (err) {
    void logSystemError(
      "telephony",
      `Живой голос: не прочитан выбор поставщика голоса (${describeError(err)}) — звонок идёт через Google.`,
      { dedupKey: "live-voice-provider-read" }
    );
    return { provider: "google" };
  }
}
