import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { narrationAutoSeparate } from "@royal-home/shared";
import { prisma } from "../db.js";
import { probeMediaInfo, runFfmpeg } from "./ffmpeg.js";
import { mediaExecutionMode } from "./mediaExecution.js";
import { loadNarrationConfiguration } from "./narrationGeneration.js";
import { dropNarrationMaster, storeNarrationMaster } from "./narrationMaster.js";
import { NARRATION_CLOSED_STATUSES as CLOSED_STATUSES } from "./narrationOptOut.js";
import { logSystemError } from "./systemError.js";
import { videoHandoffFinalDiskPath } from "./videoHandoff.js";
import { separateVoice, voiceSeparatorUrl, VOICE_SEPARATOR_RESIDUAL_SPEECH_SEC_MAX, VOICE_SEPARATOR_RESIDUAL_WORDS_MAX } from "./voiceSeparator.js";

/**
 * МАСТЕР ИЗ ВЫШЕДШЕГО РОЛИКА — БЕЗ МОНТАЖЁРА (16.11.2026, решение владельца: «агент поменял цену —
 * наш ИИ берёт старый ролик, убирает старый голос, кладёт новую озвучку и всё выкладывает»).
 *
 * Новая одобренная озвучка, а у объекта нет ролика без голоса (Property.videoMasterStorageKey):
 * раньше объект уходил монтажёру. Теперь CRM сама:
 *  1. вынимает звук готового ролика (ffmpeg) → сервис voice-separator отделяет голос (MDX
 *     Kim_Vocal_2) и распознаёт речь в оставшейся музыке (lib/voiceSeparator.ts);
 *  2. СТОРОЖ: в музыке больше VOICE_SEPARATOR_RESIDUAL_WORDS_MAX слов — старый голос не ушёл,
 *     мастер бракуется, объект идёт монтажёру прежним путём, агенту понятная строка в карточке;
 *  3. картинка ролика + музыка без голоса = мастер (тем же storeNarrationMaster, отметка MACHINE);
 *  4. дальше обычный remixFromMaster: наложение новой озвучки и замена вышедших постов.
 *
 * По одному объекту за тик (задача `narration-auto-master`, cron.ts): отделение голоса — минуты
 * процессора. Замок — тот же videoMasterMixingAt, что у перемикса: два процесса не трогают один
 * ролик. Отказ на этот готовый ролик пишется (videoMasterAutoErrorFinalPath): повтора нет, пока не
 * придёт новый готовый ролик. Рубильник — autoSeparateVoice в настройках озвучки (по умолчанию вкл.).
 */

const STALE_CLAIM_MS = 15 * 60_000;

type Candidate = { id: string; shortId: number; finalPath: string; latestId: string; voicedVersionId: string | null };

/** Какая озвучка звучит в готовом ролике: последняя, отправленная монтажёру (он её вклеил). */
async function voicedVersionId(propertyId: string): Promise<string | null> {
  const row = await prisma.propertyNarrationDelivery.findFirst({ where: { propertyId, status: "SENT" }, orderBy: { deliveredAt: "desc" }, select: { versionId: true } });
  return row?.versionId ?? null;
}

/** Все условия «мастер нужен и CRM может сделать его сама»; null — не наш случай. */
async function candidate(propertyId: string): Promise<Candidate | null> {
  if (mediaExecutionMode("NARRATION") !== "LIVE" || !voiceSeparatorUrl()) return null;
  const p = await prisma.property.findUnique({ where: { id: propertyId }, select: { id: true, shortId: true, deletedAt: true, narrationOff: true, status: true,
    videoHandoffStatus: true, videoHandoffFinalPath: true, videoMasterStorageKey: true, videoMasterAutoErrorFinalPath: true, publishedChannels: true, instagramUrl: true } });
  if (!p || p.deletedAt || p.narrationOff || CLOSED_STATUSES.some((s) => s === p.status) || p.videoHandoffStatus !== "RECEIVED") return null;
  // Только ВЫШЕДШИЙ ролик (решение 16.11.2026). Новый, ещё не вышедший, озвучивает монтажёр
  // («вклейте голос»): по решению 12.11 первый голос и громкость музыки — его работа.
  // Признак «вышел» — тот же, что у «вклейте голос» (narrationAutoFlow.requestNarrationAddVoice).
  if (!((p.publishedChannels?.length ?? 0) > 0 || p.instagramUrl)) return null;
  if (!p.videoHandoffFinalPath || p.videoMasterStorageKey || p.videoMasterAutoErrorFinalPath === p.videoHandoffFinalPath) return null;
  const latest = await prisma.propertyNarrationVersion.findFirst({ where: { propertyId }, orderBy: { revision: "desc" }, select: { id: true, status: true, approvedAt: true, storageKey: true } });
  if (!latest || latest.status !== "READY" || !latest.approvedAt || !latest.storageKey) return null;
  const voiced = await voicedVersionId(propertyId);
  // В ролике уже эта озвучка (монтажёр вклеил её) — менять нечего.
  if (voiced === latest.id) return null;
  if (!narrationAutoSeparate((await loadNarrationConfiguration()).config)) return null;
  return { id: p.id, shortId: p.shortId, finalPath: p.videoHandoffFinalPath, latestId: latest.id, voicedVersionId: voiced };
}

/** Включён ли путь «старый голос убирает CRM» (сервис подключён, отправка LIVE, рубильник не выключен). */
export function machineSeparationEnabled(config: Parameters<typeof narrationAutoSeparate>[0]): boolean {
  return mediaExecutionMode("NARRATION") === "LIVE" && !!voiceSeparatorUrl() && narrationAutoSeparate(config);
}

export async function machineMasterApplies(propertyId: string): Promise<boolean> {
  return !!(await candidate(propertyId));
}

/** Строка агенту в карточке объекта (16.11.2026): что сейчас CRM делает со звуком вышедшего ролика. */
export async function narrationMixNoteFor(
  p: { id: string; videoHandoffFinalPath: string | null; videoMasterStorageKey: string | null; videoMasterNarrationVersionId: string | null; videoMasterAutoError: string | null; videoMasterAutoErrorFinalPath: string | null },
  latest: { id: string; status: string; approvedAt: Date | null; shortenedFromId: string | null; mixNote: string | null } | null,
): Promise<string | null> {
  if (!latest || latest.status !== "READY" || !latest.approvedAt) return null;
  if (latest.id === p.videoMasterNarrationVersionId) return latest.mixNote;
  if (p.videoMasterAutoError && p.videoMasterAutoErrorFinalPath && p.videoMasterAutoErrorFinalPath === p.videoHandoffFinalPath) {
    return "Убрать старый голос из ролика не получилось, звук заменит монтажёр. Руководство видит причину.";
  }
  if (latest.shortenedFromId) return "Голос был длиннее ролика: CRM озвучила тот же текст короче, ролик обновится сам.";
  if (!p.videoMasterStorageKey && await machineMasterApplies(p.id)) return "CRM убирает из ролика старый голос и наложит новый. Обычно несколько минут.";
  return null;
}

export type MachineMasterOutcome = "REMIXED" | "MADE" | "SKIPPED" | "FAILED";
/** Шаги потока озвучки (lib/narrationAutoFlow.ts) — параметрами, без цикла импортов. */
export type MachineMasterDeps = {
  remix: (propertyId: string) => Promise<string>;
  toMontajer: (propertyId: string, versionId: string) => Promise<unknown>;
};

export async function makeMachineMaster(propertyId: string, deps: MachineMasterDeps, now: Date = new Date()): Promise<MachineMasterOutcome> {
  if (!(await candidate(propertyId))) return "SKIPPED";
  const claimedAt = now;
  const claim = await prisma.property.updateMany({
    where: { id: propertyId, OR: [{ videoMasterMixingAt: null }, { videoMasterMixingAt: { lt: new Date(now.getTime() - STALE_CLAIM_MS) } }] },
    data: { videoMasterMixingAt: claimedAt },
  });
  if (!claim.count) return "SKIPPED";
  let made: "MADE" | "SKIPPED" | "FAILED";
  try {
    made = await makeClaimed(propertyId, deps);
  } finally {
    await prisma.property.updateMany({ where: { id: propertyId, videoMasterMixingAt: claimedAt }, data: { videoMasterMixingAt: null } }).catch(() => {});
  }
  if (made !== "MADE") return made;
  // Мастер готов — новая озвучка ложится сразу, не ждём следующего обхода.
  return (await deps.remix(propertyId)) === "REMIXED" ? "REMIXED" : "MADE";
}

async function makeClaimed(propertyId: string, deps: MachineMasterDeps): Promise<"MADE" | "SKIPPED" | "FAILED"> {
  const c = await candidate(propertyId);
  if (!c) return "SKIPPED";
  const finalDisk = videoHandoffFinalDiskPath(c.finalPath);
  const work = path.join(os.tmpdir(), `rh-separate-${randomUUID()}`);
  const started = Date.now();
  try {
    if (!finalDisk || !fs.existsSync(finalDisk)) return await fail(deps, c, "файл готового ролика не найден на сервере.");
    const info = await probeMediaInfo(finalDisk);
    if (!info?.hasVideo) return await fail(deps, c, "готовый ролик не читается как видео.");
    await fs.promises.mkdir(work, { recursive: true });
    const masterPath = path.join(work, "master.mp4");
    let separation = "";
    if (!info.hasAudio) {
      // Звука в ролике нет вовсе — убирать нечего, мастер = сам ролик.
      await fs.promises.copyFile(finalDisk, masterPath);
    } else {
      const wav = path.join(work, "in.wav"), music = path.join(work, "music.flac");
      await runFfmpeg({ args: ["-y", "-hide_banner", "-loglevel", "error", "-i", finalDisk, "-vn", "-ac", "2", "-ar", "44100", "-c:a", "pcm_s16le", wav], timeoutMs: 120_000, label: "звук ролика для отделения голоса" });
      const sep = await separateVoice({ audioPath: wav, outPath: music });
      if (!sep.ok) return await fail(deps, c, sep.error);
      // Сторож: распознавание слышит речь в музыке — старый голос остался, такой мастер не годится.
      if (sep.words > VOICE_SEPARATOR_RESIDUAL_WORDS_MAX || sep.speechSec > VOICE_SEPARATOR_RESIDUAL_SPEECH_SEC_MAX) {
        return await fail(deps, c, `в музыке после отделения остался голос (${sep.words} слов${sep.text ? `: «${sep.text.slice(0, 80)}»` : ""}).`, "VOICE_LEFT");
      }
      separation = ` Отделение ${Math.round(sep.separateMs / 1000)} с, проверка ${Math.round(sep.checkMs / 1000)} с, слов в музыке ${sep.words}.`;
      await runFfmpeg({ args: ["-y", "-hide_banner", "-loglevel", "error", "-i", finalDisk, "-i", music, "-map", "0:v:0", "-map", "1:a:0",
        "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-movflags", "+faststart", "-shortest", masterPath], timeoutMs: 180_000, label: "мастер без голоса" });
    }
    const key = await storeNarrationMaster(c.id, masterPath);
    const written = await prisma.property.updateMany({
      where: { id: c.id, deletedAt: null, videoHandoffStatus: "RECEIVED", videoHandoffFinalPath: c.finalPath, videoMasterStorageKey: null },
      data: { videoMasterStorageKey: key, videoMasterSource: "MACHINE", videoMasterNarrationVersionId: c.voicedVersionId,
        videoMasterMixError: null, videoMasterMixErrorVersionId: null, videoMasterAutoError: null, videoMasterAutoErrorFinalPath: null },
    });
    if (!written.count) {
      // Пока шло отделение, пришёл новый ролик или мастер от монтажёра — этот уже не нужен.
      await dropNarrationMaster(key);
      return "SKIPPED";
    }
    console.log(`[narration-auto-master] №${c.shortId}: мастер без голоса готов за ${Math.round((Date.now() - started) / 1000)} с.${separation}`);
    return "MADE";
  } catch (err) {
    return await fail(deps, c, err instanceof Error ? err.message.slice(0, 300) : String(err));
  } finally {
    await fs.promises.rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

/** Отказ: отметка на этом готовом ролике (повтора нет), журнал руководству, объект — монтажёру по-старому. */
async function fail(deps: MachineMasterDeps, c: Candidate, reason: string, kind: "VOICE_LEFT" | "ERROR" = "ERROR"): Promise<"FAILED"> {
  await prisma.property.updateMany({ where: { id: c.id, videoHandoffFinalPath: c.finalPath },
    data: { videoMasterAutoError: `${kind === "VOICE_LEFT" ? "Старый голос не убрался" : "Старый голос убрать не получилось"}: ${reason}`.slice(0, 500), videoMasterAutoErrorFinalPath: c.finalPath } });
  void logSystemError("video-handoff", `Объект №${c.shortId}: старый голос из ролика не убран — ${reason} Объект уходит монтажёру заменить звук.`, { dedupKey: `narration-auto-master:${c.id}:${c.latestId}` });
  await deps.toMontajer(c.id, c.latestId).catch((err) =>
    logSystemError("video-handoff", `Объект №${c.shortId}: возврат монтажёру после отказа отделения голоса не поставлен: ${err instanceof Error ? err.message : String(err)}`, { dedupKey: `narration-auto-master-fallback:${c.latestId}` }));
  return "FAILED";
}

/** Задача `narration-auto-master`: ОДИН объект за тик (минуты процессора), остальные ждут. */
export async function runMachineMasters(deps: MachineMasterDeps, now: Date = new Date()): Promise<MachineMasterOutcome | "IDLE"> {
  if (mediaExecutionMode("NARRATION") !== "LIVE" || !voiceSeparatorUrl()) return "IDLE";
  const rows = await prisma.property.findMany({
    where: { deletedAt: null, narrationOff: false, status: { notIn: [...CLOSED_STATUSES] }, videoHandoffStatus: "RECEIVED", videoHandoffFinalPath: { not: null },
      videoMasterStorageKey: null, narrationVersions: { some: { status: "READY", approvedAt: { not: null } } } },
    select: { id: true }, orderBy: { videoHandoffReceivedAt: "asc" }, take: 50,
  });
  for (const row of rows) {
    if (!(await candidate(row.id))) continue;
    return makeMachineMaster(row.id, deps, now);
  }
  return "IDLE";
}
