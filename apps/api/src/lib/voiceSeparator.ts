import fs from "node:fs";

/**
 * СЕРВИС «УБРАТЬ ГОЛОС» (16.11.2026). Отдельный контейнер `voice-separator` рядом с worker
 * (apps/voice-separator, docker-compose.prod.yml): модель MDX Kim_Vocal_2 отделяет голос от
 * музыки, затем faster-whisper проверяет, не осталось ли в музыке речи. Один запрос за раз —
 * очередь держит сам сервис (однопоточный) и обход по одному объекту (lib/narrationAutoMaster.ts).
 *
 * Адрес — VOICE_SEPARATOR_URL; не задан — возможности нет, объект идёт монтажёру, как раньше.
 * Ничего не бросает: отказ возвращается кодом и текстом, журнал пишет вызывающий.
 */

/** Сторож: сколько речи распознавание может «услышать» в музыке, прежде чем мастер бракуется.
 *  Замер 16.11.2026 (журнал docs/journal/2026-11-16-narration-auto-separate.md): чистая музыка —
 *  0 слов (№143, №192), ложные срабатывания распознавания — 1–2 слова, голос не ушёл — 73 слова
 *  и 103 с речи (№197). Брак — 5 слов и больше ИЛИ 3 с речи и больше. */
export const VOICE_SEPARATOR_RESIDUAL_WORDS_MAX = 4;
export const VOICE_SEPARATOR_RESIDUAL_SPEECH_SEC_MAX = 2.9;
/** Предел ожидания: 2-минутный ролик на 12 ядрах — около двух минут, с запасом на очередь. */
export const VOICE_SEPARATOR_TIMEOUT_MS = 12 * 60_000;

export function voiceSeparatorUrl(): string | null {
  const raw = process.env.VOICE_SEPARATOR_URL?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString().replace(/\/$/, "") : null;
  } catch {
    return null;
  }
}

export type VoiceSeparation =
  | { ok: true; words: number; speechSec: number; separateMs: number; checkMs: number; text: string }
  | { ok: false; code: "OFF" | "TIMEOUT" | "FAILED"; error: string };

/** Звук ролика (WAV) → музыка без голоса в outPath (FLAC) + сколько речи распознано в музыке. */
export async function separateVoice(input: { audioPath: string; outPath: string; timeoutMs?: number }): Promise<VoiceSeparation> {
  const base = voiceSeparatorUrl();
  if (!base) return { ok: false, code: "OFF", error: "Сервис отделения голоса не подключён (VOICE_SEPARATOR_URL)." };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? VOICE_SEPARATOR_TIMEOUT_MS);
  try {
    const body = await fs.promises.readFile(input.audioPath);
    const res = await fetch(`${base}/separate`, { method: "POST", body, signal: controller.signal, headers: { "content-type": "application/octet-stream" } });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return { ok: false, code: "FAILED", error: `Сервис отделения голоса ответил ${res.status}: ${detail.slice(0, 200)}` };
    }
    await fs.promises.writeFile(input.outPath, Buffer.from(await res.arrayBuffer()));
    const num = (name: string) => {
      const n = Number(res.headers.get(name));
      return Number.isFinite(n) ? n : 0;
    };
    let text = "";
    try { text = decodeURIComponent(res.headers.get("x-speech-text") ?? ""); } catch { text = ""; }
    return { ok: true, words: num("x-speech-words"), speechSec: num("x-speech-seconds"), separateMs: num("x-separate-ms"), checkMs: num("x-check-ms"), text };
  } catch (err) {
    if (controller.signal.aborted) return { ok: false, code: "TIMEOUT", error: `Сервис отделения голоса не ответил за ${Math.round((input.timeoutMs ?? VOICE_SEPARATOR_TIMEOUT_MS) / 60_000)} мин.` };
    return { ok: false, code: "FAILED", error: `Сервис отделения голоса недоступен: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}` };
  } finally {
    clearTimeout(timer);
  }
}
