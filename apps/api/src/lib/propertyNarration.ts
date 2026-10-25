import { createHash } from "node:crypto";
import type { NarrationConfig, NarrationFacts } from "@royal-home/shared";
export { suggestedNarration } from "@royal-home/shared";

export function narrationFacts(p: { type: string; rooms: number | null; areaSqm: { toString(): string }; floor: number | null; totalFloors: number | null; district: { name: string } | null }): NarrationFacts {
  // Deliberate allowlist: no price, owner's identity, phone, free-form title/description.
  return { type: p.type, rooms: p.rooms, areaSqm: p.areaSqm.toString(), floor: p.floor, totalFloors: p.totalFloors, district: p.district?.name ?? null };
}
export function narrationHash(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
export function narrationScriptError(text: string): string | null {
  if (text.length > 5000) return "Текст длиннее 5000 символов — сократите его перед подтверждением.";
  // Quantities (area, rooms, floors) stay valid; monetary amounts must stay in the caption.
  if (/(?:\d[\d\s.,]*\s*(?:сомони|доллар\p{L}*|рубл\p{L}*|евро|tjs|usd|rub|eur)|(?:тысяч|миллион)\p{L}*\s+(?:сомони|доллар\p{L}*|рубл\p{L}*|евро)|[$€₽]|(?:цена|стоимость|нарх)\s*[:—–-]?\s*(?:\d|один|два|три|четыре|пять|шесть|семь|восемь|девять|сто|тысяч|миллион))/iu.test(text)) return "Уберите цену из озвучки. Цена остаётся в описании.";
  return null;
}
export type NarrationAudioResult = { status: "READY"; audio: Buffer; requestId: string | null } | { status: "FAILED" | "UNKNOWN"; errorCode: string };
/** Official POST /v1/text-to-speech/:voice_id. One attempt only: a timeout may have incurred cost. */
export async function generateNarrationAudio(input: { script: string; voiceId: string; config: NarrationConfig; apiKey: string }, fetcher: typeof fetch = fetch): Promise<NarrationAudioResult> {
  if (!input.config.modelId || !input.config.voices.some((v) => v.id === input.voiceId)) return { status: "FAILED", errorCode: "VOICE_NOT_CONFIGURED" };
  if (narrationScriptError(input.script)) return { status: "FAILED", errorCode: "INVALID_SCRIPT" };
  try {
    const base = (process.env.ELEVENLABS_API_BASE?.trim() || "https://api.elevenlabs.io").replace(/\/+$/, "");
    const response = await fetcher(`${base}/v1/text-to-speech/${encodeURIComponent(input.voiceId)}?output_format=mp3_44100_128`, {
      method: "POST", headers: { "xi-api-key": input.apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ text: input.script, model_id: input.config.modelId }), signal: AbortSignal.timeout(60_000), redirect: "error",
    });
    if (!response.ok) return { status: response.status >= 500 ? "UNKNOWN" : "FAILED", errorCode: `PROVIDER_HTTP_${response.status}` };
    if (!response.headers.get("content-type")?.startsWith("audio/")) return { status: "UNKNOWN", errorCode: "INVALID_AUDIO_RESPONSE" };
    const audio = Buffer.from(await response.arrayBuffer());
    if (!audio.length || audio.length > 25 * 1024 * 1024) return { status: "UNKNOWN", errorCode: "INVALID_AUDIO_SIZE" };
    return { status: "READY", audio, requestId: response.headers.get("request-id") };
  } catch { return { status: "UNKNOWN", errorCode: "PROVIDER_OUTCOME_UNKNOWN" }; }
}

export function publicationPreview(channels: string[]): Array<{ channel: string; operation: string; status: string; reason: string }> {
  return [...new Set(channels)].flatMap((channel) => ["CAPTION", "COVER"].map((operation) => {
    const supported = operation === "CAPTION" ? ["FACEBOOK", "TELEGRAM", "YOUTUBE"].includes(channel) : ["FACEBOOK", "YOUTUBE"].includes(channel);
    return { channel, operation, status: supported ? "PREVIEW" : "MANUAL_REQUIRED", reason: supported ? "Предварительный просмотр. Изменения ещё не отправлены." : "Автоматическая замена не подтверждена для этой площадки. Нужна ручная проверка." };
  }));
}
