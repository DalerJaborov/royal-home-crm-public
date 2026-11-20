import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runFfmpeg } from "./ffmpeg.js";
import { logSystemError } from "./systemError.js";

/**
 * ГРОМКОСТЬ ОЗВУЧКИ — ОДНО МЕСТО (21.11.2026, владелец: «тихо»).
 *
 * Замер 21.11.2026 (ffmpeg loudnorm/ebur128, журнал docs/journal/2026-11-21-narration-price-tjs.md):
 *  - mp3 от ElevenLabs — −24,4 LUFS: на 8–10 дБ тише обычного ролика в ленте. Монтажёр вклеивает этот
 *    файл сам (рубильник «голос накладывает CRM» выключен), и голос под его музыкой тонет;
 *  - пробный перемонтаж CRM (объект 183) — −17,3 LUFS целиком: голос не тише музыки (музыка под голосом
 *    на ~21 дБ ниже), но весь ролик на ~3 дБ тише привычных −14 LUFS соцсетей, а YouTube и Instagram
 *    тихие ролики не поднимают — только громкие опускают.
 * Поэтому: голос сразу после озвучки выравнивается до VOICE_I (его же получает монтажёр), а сведение CRM
 * держит голос на VOICE_I и музыку на MUSIC_I — разница 2 дБ та же, что была, приглушение не меняется.
 */
export const NARRATION_LOUDNESS = {
  /** Голос: −14 LUFS, пики не выше −1,5 dBTP. */
  voice: "loudnorm=I=-14:TP=-1.5:LRA=11",
  /** Музыкальная подложка до приглушения: на 2 дБ ниже голоса, как и раньше (−16 против −18). */
  music: "loudnorm=I=-16:TP=-2:LRA=11",
} as const;

/**
 * mp3 озвучки → тот же mp3, выровненный по громкости. Сбой ffmpeg не теряет озвучку: возвращается
 * исходный файл, а в журнал — запись (иначе монтажёр молча получил бы тихий голос).
 */
/** Похоже на mp3: тег ID3 или синхрослово кадра MPEG. Не mp3 — не трогаем (и не тратим ffmpeg). */
export function looksLikeMp3(audio: Buffer): boolean {
  if (audio.length < 4) return false;
  if (audio.subarray(0, 3).toString("latin1") === "ID3") return true;
  return audio[0] === 0xff && (audio[1]! & 0xe0) === 0xe0;
}
export async function normalizeNarrationVoice(audio: Buffer, label: string): Promise<Buffer> {
  if (!looksLikeMp3(audio)) return audio;
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "narration-loud-"));
  const input = path.join(dir, `${randomUUID()}-in.mp3`);
  const output = path.join(dir, `${randomUUID()}-out.mp3`);
  try {
    await fs.promises.writeFile(input, audio);
    await runFfmpeg({ args: ["-y", "-hide_banner", "-loglevel", "error", "-i", input, "-af", NARRATION_LOUDNESS.voice, "-ar", "44100", "-c:a", "libmp3lame", "-b:a", "192k", output],
      timeoutMs: 90_000, label: "громкость озвучки" });
    const out = await fs.promises.readFile(output);
    return out.length ? out : audio;
  } catch (err) {
    void logSystemError("api", `Озвучка ${label}: громкость не выровнена, монтажёр получит исходный (тихий) голос. ${err instanceof Error ? err.message.slice(0, 300) : String(err)}`,
      { dedupKey: "narration-loudness-failed", dedupWindowMs: 6 * 60 * 60_000 });
    return audio;
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
