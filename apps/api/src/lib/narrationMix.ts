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
/** Допуск на хвост: тишина в конце mp3 ElevenLabs. */
const VOICE_TAIL_TOLERANCE_SEC = 0.5;

export type NarrationMixResult =
  | { ok: true; durationSec: number }
  | { ok: false; code: "NO_VIDEO" | "VOICE_LONGER" | "FFMPEG"; error: string };

function audioGraph(masterHasAudio: boolean): string {
  const delayMs = Math.round(NARRATION_VOICE_START_SEC * 1000);
  const voice = `[1:a]aformat=sample_rates=48000:channel_layouts=stereo,adelay=${delayMs}|${delayMs},apad`;
  if (!masterHasAudio) return `${voice}[aout]`;
  return [
    `${voice},asplit=2[vsc][vmix]`,
    "[0:a]aformat=sample_rates=48000:channel_layouts=stereo,volume=0.8[bg]",
    "[bg][vsc]sidechaincompress=threshold=0.03:ratio=10:attack=15:release=350[ducked]",
    "[ducked][vmix]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[aout]",
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
      error: `Озвучка (${voiceSec.toFixed(1)} с) длиннее ролика (${master.durationSec.toFixed(1)} с) — нужен ролик не короче озвучки.`,
    };
  }
  const base = ["-y", "-hide_banner", "-loglevel", "error", "-i", input.masterPath, "-i", input.voicePath,
    "-filter_complex", audioGraph(master.hasAudio), "-map", "0:v:0", "-map", "[aout]"];
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
