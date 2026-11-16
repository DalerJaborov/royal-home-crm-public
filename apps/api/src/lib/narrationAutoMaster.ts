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
 * Новая одобренная озвучка, а у вышедшего ролика нет версии без голоса (Property.videoMasterStorageKey):
 * раньше объект уходил монтажёру. Теперь CRM сама:
 *  1. вынимает звук готового ролика (ffmpeg) → сервис voice-separator отделяет голос (MDX
 *     Kim_Vocal_2) и распознаёт речь в оставшейся музыке (lib/voiceSeparator.ts);
 *  2. СТОРОЖ: речь в музыке выше порога — старый голос не ушёл, мастер бракуется, объект идёт
 *     монтажёру прежним путём, агенту понятная строка в карточке;
 *  3. картинка ролика + музыка без голоса = мастер (тем же storeNarrationMaster, отметка MACHINE);
 *  4. дальше обычный remixFromMaster: наложение новой озвучки и замена вышедших постов.
 *
 * По одному объекту за тик (задача `narration-auto-master`, cron.ts): отделение голоса — минуты
 * процессора. Замок — тот же videoMasterMixingAt, что у перемикса. Брак сторожа и окончательный отказ
 * пишутся на этот готовый ролик (videoMasterAutoErrorFinalPath): повтора нет, пока не придёт новый.
 * Временный сбой сервиса (не ответил, перезапускался при выкате) — до трёх попыток с паузой.
 * Рубильник — autoSeparateVoice в настройках озвучки (по умолчанию вкл.). Шаги потока озвучки
 * (наложить, отдать монтажёру) приходят параметром deps — без цикла импортов с narrationAutoFlow.
 */

/** Замок старше этого — брошен. Больше предела тика (cron.ts, 30 мин): второй тик не начнёт ту же работу. */
const STALE_CLAIM_MS = 40 * 60_000;
const TRANSIENT_ATTEMPTS = 3;
const RETRY_PAUSE_MS = 10 * 60_000;

export type MachineMasterOutcome = "REMIXED" | "MADE" | "SKIPPED" | "FAILED" | "RETRY";
/** Шаги потока озвучки (lib/narrationAutoFlow.ts) — параметрами, без цикла импортов. */
export type MachineMasterDeps = {
  remix: (propertyId: string) => Promise<string>;
  /** Отдать монтажёру по-старому; результат — как у sendNarrationToMontajer. */
  toMontajer: (propertyId: string, versionId: string) => Promise<string>;
};

type Need = { id: string; shortId: number; finalPath: string; latestId: string; voicedVersionId: string | null; retryAt: Date | null; attempts: number };

/** Какая озвучка звучит в готовом ролике: последняя, отправленная монтажёру (он её вклеил). */
async function voicedVersionId(propertyId: string): Promise<string | null> {
  const row = await prisma.propertyNarrationDelivery.findFirst({ where: { propertyId, status: "SENT" }, orderBy: { deliveredAt: "desc" }, select: { versionId: true } });
  return row?.versionId ?? null;
}

/** Ролику нужен новый голос, а версии без голоса нет (не смотрит, включена ли машина). */
async function need(propertyId: string): Promise<Need | null> {
  const p = await prisma.property.findUnique({ where: { id: propertyId }, select: { id: true, shortId: true, deletedAt: true, narrationOff: true, status: true,
    videoHandoffStatus: true, videoHandoffFinalPath: true, videoMasterStorageKey: true, videoMasterAutoErrorFinalPath: true, publishedChannels: true, instagramUrl: true,
    videoMasterAutoAttempts: true, videoMasterAutoRetryAt: true } });
  if (!p || p.deletedAt || p.narrationOff || CLOSED_STATUSES.some((s) => s === p.status) || p.videoHandoffStatus !== "RECEIVED") return null;
  // Только ВЫШЕДШИЙ ролик (решение 16.11.2026). Новый, ещё не вышедший, озвучивает монтажёр
  // («вклейте голос»): по решению 12.11 первый голос и громкость музыки — его работа.
  // Признак «вышел» — тот же, что у «вклейте голос» (narrationAutoFlow.requestNarrationAddVoice).
  if (!publishedClip(p)) return null;
  if (!p.videoHandoffFinalPath || p.videoMasterStorageKey || p.videoMasterAutoErrorFinalPath === p.videoHandoffFinalPath) return null;
  const latest = await prisma.propertyNarrationVersion.findFirst({ where: { propertyId }, orderBy: { revision: "desc" }, select: { id: true, status: true, approvedAt: true, storageKey: true } });
  if (!latest || latest.status !== "READY" || !latest.approvedAt || !latest.storageKey) return null;
  const voiced = await voicedVersionId(propertyId);
  // В ролике уже эта озвучка (монтажёр вклеил её) — менять нечего.
  if (voiced === latest.id) return null;
  return { id: p.id, shortId: p.shortId, finalPath: p.videoHandoffFinalPath, latestId: latest.id, voicedVersionId: voiced, retryAt: p.videoMasterAutoRetryAt, attempts: p.videoMasterAutoAttempts };
}

export function publishedClip(p: { publishedChannels?: readonly string[] | null; instagramUrl?: string | null }): boolean {
  return (p.publishedChannels?.length ?? 0) > 0 || !!p.instagramUrl;
}

/** Включён ли путь «старый голос убирает CRM» (сервис подключён, отправка LIVE, рубильник не выключен). */
export function machineSeparationEnabled(config: Parameters<typeof narrationAutoSeparate>[0]): boolean {
  return mediaExecutionMode("NARRATION") === "LIVE" && !!voiceSeparatorUrl() && narrationAutoSeparate(config);
}

/** Одобрение (api или worker): объект ждёт машину, а не монтажёра. Сам сервис зовёт только worker. */
export async function machineMasterApplies(propertyId: string): Promise<boolean> {
  if (!machineSeparationEnabled((await loadNarrationConfiguration()).config)) return false;
  return !!(await need(propertyId));
}

/** Строка агенту в карточке объекта (16.11.2026): что сейчас CRM делает со звуком вышедшего ролика. */
export async function narrationMixNoteFor(
  p: { id: string; videoHandoffStatus: string | null; videoHandoffFinalPath: string | null; videoMasterStorageKey: string | null; videoMasterNarrationVersionId: string | null; videoMasterAutoError: string | null; videoMasterAutoErrorFinalPath: string | null },
  latest: { id: string; status: string; approvedAt: Date | null; shortenedFromId: string | null; mixNote: string | null } | null,
): Promise<string | null> {
  if (!latest || latest.status !== "READY" || !latest.approvedAt) return null;
  if (latest.id === p.videoMasterNarrationVersionId) return latest.mixNote;
  if (p.videoMasterAutoError && p.videoMasterAutoErrorFinalPath && p.videoMasterAutoErrorFinalPath === p.videoHandoffFinalPath) {
    // Возврат монтажёру уводит объект из RECEIVED; остался RECEIVED — монтажёру не ушло (ревью 16.11).
    return p.videoHandoffStatus === "RECEIVED"
      ? "Убрать старый голос из ролика не получилось, в соцсетях пока прежний ролик. Руководство видит причину."
      : "Убрать старый голос из ролика не получилось, звук заменит монтажёр.";
  }
  if (latest.shortenedFromId) return "Голос был длиннее ролика: CRM озвучила тот же текст короче, ролик обновится сам.";
  if (!p.videoMasterStorageKey && await machineMasterApplies(p.id)) return "CRM убирает из ролика старый голос и наложит новый. Обычно несколько минут.";
  return null;
}

export async function makeMachineMaster(propertyId: string, deps: MachineMasterDeps, now: Date = new Date()): Promise<MachineMasterOutcome> {
  if (!(await machineMasterApplies(propertyId))) return "SKIPPED";
  const claimedAt = now;
  const claim = await prisma.property.updateMany({
    where: { id: propertyId, OR: [{ videoMasterMixingAt: null }, { videoMasterMixingAt: { lt: new Date(now.getTime() - STALE_CLAIM_MS) } }] },
    data: { videoMasterMixingAt: claimedAt },
  });
  if (!claim.count) return "SKIPPED";
  let made: "MADE" | "SKIPPED" | "FAILED" | "RETRY";
  try {
    made = await makeClaimed(propertyId, deps, now);
  } finally {
    await prisma.property.updateMany({ where: { id: propertyId, videoMasterMixingAt: claimedAt }, data: { videoMasterMixingAt: null } }).catch(() => {});
  }
  if (made !== "MADE") return made;
  // Мастер готов — новая озвучка ложится сразу, не ждём следующего обхода.
  return (await deps.remix(propertyId)) === "REMIXED" ? "REMIXED" : "MADE";
}

async function makeClaimed(propertyId: string, deps: MachineMasterDeps, now: Date): Promise<"MADE" | "SKIPPED" | "FAILED" | "RETRY"> {
  const c = await need(propertyId);
  if (!c || (c.retryAt && c.retryAt > now)) return "SKIPPED";
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
      if (!sep.ok) {
        // Сервис не ответил или перезапускался (выкат) — это не приговор ролику: повтор с паузой.
        if (sep.code !== "OFF" && c.attempts + 1 < TRANSIENT_ATTEMPTS) {
          await prisma.property.updateMany({ where: { id: c.id, videoHandoffFinalPath: c.finalPath },
            data: { videoMasterAutoAttempts: { increment: 1 }, videoMasterAutoRetryAt: new Date(now.getTime() + RETRY_PAUSE_MS) } });
          void logSystemError("video-handoff", `Объект №${c.shortId}: сервис отделения голоса не справился (попытка ${c.attempts + 1} из ${TRANSIENT_ATTEMPTS}), повтор через 10 мин — ${sep.error}`, { dedupKey: `narration-auto-master-retry:${c.id}` });
          return "RETRY";
        }
        return await fail(deps, c, sep.error);
      }
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
        videoMasterMixError: null, videoMasterMixErrorVersionId: null, videoMasterAutoError: null, videoMasterAutoErrorFinalPath: null,
        videoMasterAutoAttempts: 0, videoMasterAutoRetryAt: null },
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
async function fail(deps: MachineMasterDeps, c: Pick<Need, "id" | "shortId" | "finalPath">, reason: string, kind: "VOICE_LEFT" | "ERROR" | "OFF" = "ERROR"): Promise<"FAILED"> {
  const head = kind === "VOICE_LEFT" ? "Старый голос не убрался" : kind === "OFF" ? "Машина выключена" : "Старый голос убрать не получилось";
  await prisma.property.updateMany({ where: { id: c.id, videoHandoffFinalPath: c.finalPath },
    data: { videoMasterAutoError: `${head}: ${reason}`.slice(0, 500), videoMasterAutoErrorFinalPath: c.finalPath, videoMasterAutoRetryAt: null } });
  // Версия — свежая на момент отказа (ревью 16.11): за минуты отделения могли одобрить новую.
  const latest = await prisma.propertyNarrationVersion.findFirst({ where: { propertyId: c.id }, orderBy: { revision: "desc" }, select: { id: true, status: true, approvedAt: true } });
  let sent = "WAITING_FOR_MONTAGE";
  if (latest?.status === "READY" && latest.approvedAt) {
    sent = await deps.toMontajer(c.id, latest.id).catch((err) => {
      void logSystemError("video-handoff", `Объект №${c.shortId}: возврат монтажёру после отказа отделения голоса не поставлен: ${err instanceof Error ? err.message : String(err)}`, { dedupKey: `narration-auto-master-fallback:${latest.id}` });
      return "ERROR";
    });
  }
  const toEditor = sent === "SOUND_REMAKE" || sent === "ADD_VOICE";
  void logSystemError("video-handoff", `Объект №${c.shortId}: старый голос из ролика не убран — ${reason} ${toEditor
    ? "Объект ушёл монтажёру заменить звук."
    : "Монтажёру не ушло (голос в ролике вклеен не по передаче CRM) — в соцсетях прежний ролик; решите вручную."}`, { dedupKey: `narration-auto-master:${c.id}:${latest?.id ?? "none"}` });
  return "FAILED";
}

/**
 * Курсор обхода (ревью 16.11.2026): условия «вышел, без мастера, без отказа на этот ролик» — в
 * запросе, остальное (озвучка уже вклеена и т.п.) проверяется по строке; курсор идёт по кругу по id,
 * так что такие строки не загораживают новые объекты навсегда.
 */
let cursor: string | null = null;
export function resetMachineMasterCursorForTests(): void { cursor = null; }

/** Задача `narration-auto-master`: ОДИН объект за тик (минуты процессора), остальные ждут. */
export async function runMachineMasters(deps: MachineMasterDeps, now: Date = new Date()): Promise<MachineMasterOutcome | "IDLE"> {
  if (mediaExecutionMode("NARRATION") !== "LIVE") return "IDLE";
  const enabled = machineSeparationEnabled((await loadNarrationConfiguration()).config);
  const rows = await prisma.property.findMany({
    where: { deletedAt: null, narrationOff: false, status: { notIn: [...CLOSED_STATUSES] }, videoHandoffStatus: "RECEIVED", videoHandoffFinalPath: { not: null },
      videoMasterStorageKey: null, videoMasterAutoErrorFinalPath: null, OR: [{ publishedChannels: { isEmpty: false } }, { instagramUrl: { not: null } }],
      narrationVersions: { some: { status: "READY", approvedAt: { not: null } } }, ...(cursor ? { id: { gt: cursor } } : {}) },
    select: { id: true }, orderBy: { id: "asc" }, take: 50,
  });
  cursor = rows.length === 50 ? rows[rows.length - 1]!.id : null;
  for (const row of rows) {
    const n = await need(row.id);
    if (!n) continue;
    // Машину выключили (рубильник, нет адреса сервиса) после того, как объект ей отдали: не висеть
    // молча — монтажёру по-старому, одна отметка на этот ролик.
    if (!enabled) { await fail(deps, n, "в настройках выключено или сервис не подключён.", "OFF"); continue; }
    if (n.retryAt && n.retryAt > now) continue;
    return makeMachineMaster(row.id, deps, now);
  }
  return "IDLE";
}
