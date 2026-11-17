import fs from "node:fs";
import { probeDurationSec, probeMediaInfo, runFfmpeg } from "./ffmpeg.js";

/**
 * НАЛОЖЕНИЕ ОЗВУЧКИ НА РОЛИК БЕЗ ГОЛОСА (11.11.2026, решение владельца: «где просто меняется
 * звук и описание нам монтажёр не нужен»). ОДНО место, где CRM сама сводит звук ролика: приём
 * ролика без голоса от монтажёра (lib/videoHandoff.ts::finishReceivingVideo) и перемикс после
 * новой одобренной озвучки (lib/narrationAutoFlow.ts::remixFromMasters) зовут только его.
 *
 * Голос — поверх; музыка и звуки ролика под голосом приглушаются сами (sidechaincompress —
 * «ducking»), между фразами возвращаются. Картинка копируется как есть (-c:v copy); не
 * влезла в mp4 — один повтор с перекодированием. Длина готового ролика — длина ролика без
 * голоса: озвучка длиннее ролика не обрезается молча, а отказ с понятным текстом.
 *
 * Ничего не бросает: отказ ffmpeg возвращается текстом, вызывающий пишет logSystemError.
 */

/** Голос начинается через 0,3 с: первое слово не съедается на склейке. */
export const NARRATION_VOICE_START_SEC = 0.3;
/** Метка отказа «озвучка длиннее ролика» в тексте ошибки: по ней карточка объекта говорит агенту понятными словами. */
export const NARRATION_VOICE_LONGER_MARK = "длиннее ролика";
/** Допуск на хвост: тишина в конце mp3 ElevenLabs. */
const VOICE_TAIL_TOLERANCE_SEC = 0.5;

export type NarrationMixResult =
  | { ok: true; durationSec: number }
  | { ok: false; code: "NO_VIDEO" | "VOICE_LONGER" | "FFMPEG"; error: string };

/**
 * Настройки сведения подобраны ЗАМЕРОМ 14.11.2026 (настоящий ffmpeg, громкая музыка −11 LUFS,
 * голос −17 LUFS, окна по 100 мс; журнал docs/journal/2026-11-14-narration-agent-ux.md):
 *  - голос сначала выравнивается до −16 LUFS (loudnorm). Без этого приглушение зависело от
 *    громкости mp3: голос тише на 9 дБ — и музыка под ним была ГРОМЧЕ голоса на ~8 дБ;
 *  - под голосом музыка ≈ на 18 дБ тише голоса (было ≈ 8,5, а в тихих местах речи — вровень);
 *  - release 800 мс: между словами музыка не «подпрыгивает», возвращается после фразы;
 *  - после голоса музыка звучит почти как в исходном ролике (−16 против −15 дБ);
 *  - ограничитель на выходе: сумма громкой музыки и голоса не уходит в перегруз.
 */
export const NARRATION_MIX = {
  voiceLoudness: "loudnorm=I=-16:TP=-1.5:LRA=11",
  musicVolume: 0.8,
  ducking: "sidechaincompress=threshold=0.015:ratio=20:attack=10:release=800",
  limiter: "alimiter=limit=0.95:level=0",
} as const;

export function narrationAudioGraph(masterHasAudio: boolean): string {
  const delayMs = Math.round(NARRATION_VOICE_START_SEC * 1000);
  const voice = `[1:a]${NARRATION_MIX.voiceLoudness},aformat=sample_rates=48000:channel_layouts=stereo,adelay=${delayMs}|${delayMs},apad`;
  if (!masterHasAudio) return `${voice}[aout]`;
  return [
    `${voice},asplit=2[vsc][vmix]`,
    `[0:a]aformat=sample_rates=48000:channel_layouts=stereo,volume=${NARRATION_MIX.musicVolume}[bg]`,
    `[bg][vsc]${NARRATION_MIX.ducking}[ducked]`,
    `[ducked][vmix]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,${NARRATION_MIX.limiter}[aout]`,
  ].join(";");
}

export async function mixNarrationOntoMaster(input: { masterPath: string; voicePath: string; outPath: string }): Promise<NarrationMixResult> {
  const master = await probeMediaInfo(input.masterPath);
  if (!master?.hasVideo) return { ok: false, code: "NO_VIDEO", error: "Ролик без голоса не читается как видео." };
  const voiceSec = await probeDurationSec(input.voicePath);
  if (voiceSec === null) return { ok: false, code: "FFMPEG", error: "Файл озвучки не читается." };
  if (master.durationSec > 0 && voiceSec + NARRATION_VOICE_START_SEC > master.durationSec + VOICE_TAIL_TOLERANCE_SEC) {
    return {
      ok: false, code: "VOICE_LONGER",
      error: `Озвучка (${voiceSec.toFixed(1)} с) ${NARRATION_VOICE_LONGER_MARK} (${master.durationSec.toFixed(1)} с) — нужен ролик не короче озвучки.`,
    };
  }
  const base = ["-y", "-hide_banner", "-loglevel", "error", "-i", input.masterPath, "-i", input.voicePath,
    "-filter_complex", narrationAudioGraph(master.hasAudio), "-map", "0:v:0", "-map", "[aout]"];
  const tail = ["-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-movflags", "+faststart", "-shortest", input.outPath];
  try {
    await runFfmpeg({ args: [...base, "-c:v", "copy", ...tail], timeoutMs: 120_000, label: "наложение озвучки" });
  } catch {
    // Картинка не копируется в mp4 (кодек или контейнер) — один повтор с перекодированием.
    await fs.promises.rm(input.outPath, { force: true }).catch(() => {});
    try {
      await runFfmpeg({ args: [...base, "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", ...tail], timeoutMs: 420_000, label: "наложение озвучки" });
    } catch (err) {
      await fs.promises.rm(input.outPath, { force: true }).catch(() => {});
      return { ok: false, code: "FFMPEG", error: `ffmpeg не смог наложить озвучку: ${err instanceof Error ? err.message.slice(0, 300) : String(err)}` };
    }
  }
  const out = await probeMediaInfo(input.outPath);
  if (!out?.hasVideo || !out.hasAudio) {
    await fs.promises.rm(input.outPath, { force: true }).catch(() => {});
    return { ok: false, code: "FFMPEG", error: "После наложения озвучки в ролике нет картинки или звука." };
  }
  return { ok: true, durationSec: out.durationSec };
}
