import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { probeDurationSec, probeMediaInfo, runFfmpeg } from "./ffmpeg.js";
import { buildOverlayFilter, drawtextAvailable, subtitleCues } from "./video/narrationOverlay.js";
import { logSystemError } from "./systemError.js";

/**
 * НАЛОЖЕНИЕ ОЗВУЧКИ НА РОЛИК БЕЗ ГОЛОСА (11.11.2026, решение владельца: «где просто меняется
 * звук и описание нам монтажёр не нужен»). ОДНО место, где CRM сама сводит звук ролика: приём
 * ролика без голоса от монтажёра (lib/videoHandoff.ts::finishReceivingVideo) и перемикс после
 * новой одобренной озвучки (lib/narrationAutoFlow.ts::remixFromMasters) зовут только его.
 *
 * Голос — поверх; музыка и звуки ролика под голосом приглушаются сами (sidechaincompress —
 * «ducking»), между фразами возвращаются. Картинка копируется как есть (-c:v copy); не
 * влезла в mp4 — один повтор с перекодированием. Длина готового ролика — длина ролика без
 * голоса (плюс стоп-кадр до 3 с при подгонке): озвучка длиннее не обрезается молча — ускорение
 * до 15 % (planNarrationFit) или отказ с понятным текстом.
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
  | { ok: true; durationSec: number; voiceSec: number; fit: NarrationFit }
  | { ok: false; code: "NO_VIDEO" | "VOICE_LONGER" | "FFMPEG"; error: string; voiceSec?: number; masterSec?: number };

/**
 * ДЛИНА ГОЛОСА = ДЛИНА РОЛИКА (16.11.2026, владелец: «ролик 25 с — аудио не может быть 35 с»).
 * Для перемикса вышедшего ролика (не для приёма от монтажёра) по порядку:
 *  SPEED  — голос длиннее до 15 %: ускоряем atempo (высота голоса та же, без «бурундука»);
 *  FREEZE — всё ещё длиннее: плюс стоп-кадр последнего кадра ролика, не больше 3 с;
 *  TOO_LONG — дальше только другой текст (короче) или монтажёр (lib/narrationAutoFlow.ts).
 * Ролик длиннее голоса — норма: музыка играет дальше.
 */
export const NARRATION_FIT = { maxTempo: 1.15, maxFreezeSec: 3 } as const;
export type NarrationFit = { tier: "PLAIN" | "SPEED" | "FREEZE" | "TOO_LONG"; tempo: number; freezeSec: number };

export function planNarrationFit(voiceSec: number, masterSec: number, opts: { allowFreeze: boolean } = { allowFreeze: true }): NarrationFit {
  // Голос (после ускорения) + задержка начала должен уместиться в ролик + допуск на хвост mp3.
  const room = (freezeSec: number) => masterSec + VOICE_TAIL_TOLERANCE_SEC + freezeSec - NARRATION_VOICE_START_SEC;
  if (!(masterSec > 0) || voiceSec <= room(0)) return { tier: "PLAIN", tempo: 1, freezeSec: 0 };
  const tempo = voiceSec / room(0);
  if (tempo <= NARRATION_FIT.maxTempo) return { tier: "SPEED", tempo: Math.ceil(tempo * 1000) / 1000, freezeSec: 0 };
  if (opts.allowFreeze) {
    const freezeSec = Math.ceil((voiceSec / NARRATION_FIT.maxTempo - room(0)) * 10) / 10;
    if (freezeSec <= NARRATION_FIT.maxFreezeSec) return { tier: "FREEZE", tempo: NARRATION_FIT.maxTempo, freezeSec };
  }
  return { tier: "TOO_LONG", tempo: 1, freezeSec: 0 };
}

/** Строка агенту в карточке: что CRM сделала с длиной (null — ничего не меняла). */
export function narrationFitNote(fit: NarrationFit): string | null {
  const pct = Math.round((fit.tempo - 1) * 100);
  if (fit.tier === "SPEED") return `Голос чуть длиннее ролика: CRM ускорила его на ${Math.max(pct, 1)}%, звучит естественно.`;
  if (fit.tier === "FREEZE") return `Голос длиннее ролика: CRM ускорила его на ${pct}% и продлила последний кадр на ${fit.freezeSec.toFixed(1).replace(".", ",")} с.`;
  return null;
}

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

export function narrationAudioGraph(masterHasAudio: boolean, fit: Pick<NarrationFit, "tempo" | "freezeSec"> = { tempo: 1, freezeSec: 0 }): string {
  const delayMs = Math.round(NARRATION_VOICE_START_SEC * 1000);
  const tempo = fit.tempo > 1 ? `atempo=${fit.tempo.toFixed(3)},` : "";
  const voice = `[1:a]${tempo}${NARRATION_MIX.voiceLoudness},aformat=sample_rates=48000:channel_layouts=stereo,adelay=${delayMs}|${delayMs},apad`;
  if (!masterHasAudio) return `${voice}[aout]`;
  // Стоп-кадр в конце: музыка ролика дотягивается тишиной на то же время (иначе amix оборвёт голос).
  const pad = fit.freezeSec > 0 ? `,apad=pad_dur=${fit.freezeSec.toFixed(2)}` : "";
  return [
    `${voice},asplit=2[vsc][vmix]`,
    `[0:a]aformat=sample_rates=48000:channel_layouts=stereo,volume=${NARRATION_MIX.musicVolume}${pad}[bg]`,
    `[bg][vsc]${NARRATION_MIX.ducking}[ducked]`,
    `[ducked][vmix]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,${NARRATION_MIX.limiter}[aout]`,
  ].join(";");
}

/** fit — подгонка длины (перемикс вышедшего ролика); без него, как на приёме от монтажёра, голос
 *  длиннее ролика — отказ VOICE_LONGER (монтажёр пришлёт ролик длиннее). */
/** textOverlay (18.11.2026) — плашка с ценой и субтитры по тексту озвучки (lib/video/narrationOverlay.ts); картинка тогда перекодируется. */
export async function mixNarrationOntoMaster(input: { masterPath: string; voicePath: string; outPath: string; fit?: { allowFreeze: boolean };
  textOverlay?: { price: string | null; script: string } }): Promise<NarrationMixResult> {
  const master = await probeMediaInfo(input.masterPath);
  if (!master?.hasVideo) return { ok: false, code: "NO_VIDEO", error: "Ролик без голоса не читается как видео." };
  const voiceSec = await probeDurationSec(input.voicePath);
  if (voiceSec === null) return { ok: false, code: "FFMPEG", error: "Файл озвучки не читается." };
  const fit = planNarrationFit(voiceSec, master.durationSec, { allowFreeze: input.fit?.allowFreeze ?? false });
  if (fit.tier === "TOO_LONG" || (!input.fit && fit.tier !== "PLAIN")) {
    return {
      ok: false, code: "VOICE_LONGER", voiceSec, masterSec: master.durationSec,
      error: `Озвучка (${voiceSec.toFixed(1)} с) ${NARRATION_VOICE_LONGER_MARK} (${master.durationSec.toFixed(1)} с) — нужен ролик не короче озвучки.`,
    };
  }
  // Текст на ролике (18.11.2026): нужен размер кадра и drawtext в ffmpeg; нет — ролик без текста и строка в журнал.
  let overlayDir: string | null = null;
  let overlay = "";
  if (input.textOverlay && master.width && master.height) {
    if (await drawtextAvailable()) {
      overlayDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "rh-overlay-"));
      const cues = subtitleCues({ script: input.textOverlay.script, voiceSec, startSec: NARRATION_VOICE_START_SEC, tempo: fit.tempo });
      overlay = buildOverlayFilter({ width: master.width, height: master.height, price: input.textOverlay.price, cues, workDir: overlayDir });
    } else {
      void logSystemError("video-handoff", "Цена и субтитры на ролике не нарисованы: в ffmpeg на сервере нет фильтра drawtext.", { dedupKey: "narration-overlay-no-drawtext" });
    }
  }
  const video = [fit.freezeSec > 0 ? `tpad=stop_mode=clone:stop_duration=${fit.freezeSec.toFixed(2)}` : "", overlay].filter(Boolean).join(",");
  const base = ["-y", "-hide_banner", "-loglevel", "error", "-i", input.masterPath, "-i", input.voicePath,
    "-filter_complex", narrationAudioGraph(master.hasAudio, fit) + (video ? `;[0:v:0]${video}[vout]` : ""), "-map", video ? "[vout]" : "0:v:0", "-map", "[aout]"];
  const tail = ["-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-movflags", "+faststart", "-shortest", input.outPath];
  const encode = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p"];
  try {
    try {
      // Стоп-кадр или текст — новая картинка, копировать нечего: сразу перекодирование.
      await runFfmpeg({ args: [...base, ...(video ? encode : ["-c:v", "copy"]), ...tail], timeoutMs: video ? 420_000 : 120_000, label: "наложение озвучки" });
    } catch (firstErr) {
      // Картинка не копируется в mp4 (кодек или контейнер) — один повтор с перекодированием.
      await fs.promises.rm(input.outPath, { force: true }).catch(() => {});
      if (video) return { ok: false, code: "FFMPEG", error: `ffmpeg не смог наложить озвучку: ${firstErr instanceof Error ? firstErr.message.slice(0, 300) : String(firstErr)}` };
      try {
        await runFfmpeg({ args: [...base, ...encode, ...tail], timeoutMs: 420_000, label: "наложение озвучки" });
      } catch (err) {
        await fs.promises.rm(input.outPath, { force: true }).catch(() => {});
        return { ok: false, code: "FFMPEG", error: `ffmpeg не смог наложить озвучку: ${err instanceof Error ? err.message.slice(0, 300) : String(err)}` };
      }
    }
  } finally {
    if (overlayDir) await fs.promises.rm(overlayDir, { recursive: true, force: true }).catch(() => {});
  }
  const out = await probeMediaInfo(input.outPath);
  if (!out?.hasVideo || !out.hasAudio) {
    await fs.promises.rm(input.outPath, { force: true }).catch(() => {});
    return { ok: false, code: "FFMPEG", error: "После наложения озвучки в ролике нет картинки или звука." };
  }
  return { ok: true, durationSec: out.durationSec, voiceSec, fit };
}
