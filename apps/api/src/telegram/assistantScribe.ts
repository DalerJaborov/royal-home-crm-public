import { z } from "zod";
import { prisma } from "../db.js";
import { decryptSecret } from "../crypto.js";
import { resolveElevenLabsKey } from "../ai/liveVoiceProvider.js";
import { inspectAssistantMedia } from "../ai/assistant/mediaProbe.js";
import { groupAcknowledgment } from "./assistantGroupParticipation.js";
import { assistantElevenLabsPaused, noteAssistantElevenLabsFailure } from "./assistantElevenLabsAvailability.js";

const SCRIBE_TIMEOUT_MS = 2_500;
const SCRIBE_MAX_AUDIO_SECONDS = 15;
const scribeResult = z.object({
  language_code: z.string(),
  language_probability: z.number().min(0).max(1),
  text: z.string().trim().min(1).max(1_000),
});

/** Fast path for short native voice notes, under the same per-agent audio limit. */
export async function recognizeShortAssistantVoice(buffer: Buffer): Promise<{
  transcript: string; language: "ru" | "tg" | "other";
} | null> {
  try {
    const saved = await prisma.assistantVoiceConfig.findUnique({
      where: { id: "singleton" }, select: { encryptedKey: true },
    });
    const settings = saved || process.env.ELEVENLABS_API_KEY?.trim() ? null : await prisma.settings.findUnique({
      where: { id: "singleton" }, select: { elevenLabsApiKey: true },
    });
    const key = saved ? decryptSecret(saved.encryptedKey) : resolveElevenLabsKey(settings?.elevenLabsApiKey);
    if (!key || assistantElevenLabsPaused(key, "recognition")) return null;
    await inspectAssistantMedia(buffer, "audio/ogg", SCRIBE_MAX_AUDIO_SECONDS);
    const body = new FormData();
    body.set("file", new Blob([new Uint8Array(buffer)], { type: "audio/ogg" }), "voice.ogg");
    body.set("model_id", "scribe_v2");
    body.set("tag_audio_events", "false");
    body.set("timestamps_granularity", "none");
    const response = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
      method: "POST", headers: { "xi-api-key": key }, body, signal: AbortSignal.timeout(SCRIBE_TIMEOUT_MS),
    });
    if (!response.ok) {
      await noteAssistantElevenLabsFailure(key, "recognition", response);
      return null;
    }
    const result = scribeResult.safeParse(await response.json());
    if (!result.success || result.data.language_probability < 0.6) return null;
    const { language_code: code, text: transcript } = result.data;
    if (code === "fas" && groupAcknowledgment(transcript)) return { transcript, language: "other" };
    if ((code === "rus" || code === "tgk") && /\p{Script=Cyrillic}/u.test(transcript)) {
      return { transcript, language: code === "rus" ? "ru" : "tg" };
    }
    return null;
  } catch {
    return null;
  }
}
