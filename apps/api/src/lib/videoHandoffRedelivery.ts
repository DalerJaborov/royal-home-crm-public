import { prisma } from "../db.js";
import { logSystemError } from "./systemError.js";
import { shouldAlert } from "./notifications.js";
import {
  dispatchToEditor,
  releaseQueueIfClear,
  EDITOR_HOLDER_WHERE,
  rearmPublishSkippedDuringManualWait,
  nextInQueue,
  sendGiveUpFallbackLinks,
} from "./videoHandoff.js";
import { alertMontageStuck } from "./videoHandoffStaleAlarm.js";
import { describeError } from "./describeError.js";

/**
 * СТОРОЖ ДОСТАВКИ ИСХОДНИКОВ МОНТАЖЁРУ (22.09.2026, объект №121).
 *
 * Очередь хендоффа «строго по одному» держится на одном факте: объект в
 * SENT_TO_EDITOR занимает место монтажёра. Но занять место и доставить файл —
 * два разных шага, и между ними процесс может умереть: 21.09 в 21:12:22 №121
 * занял место, в 21:12:30 ядро убило api по OOM (480-МБ .mov в памяти дважды),
 * монтажёр не получил ничего, в журнале ни строки, а №117 простоял в QUEUED
 * до ручной отмены №121 в 06:47. Стоп-сигнал на 24 ч (videoHandoffStaleAlarm)
 * такое ловит только через сутки и не чинит.
 *
 * Раз в 5 минут:
 *  1. SENT_TO_EDITOR без `videoHandoffDeliveredAt` дольше паузы — досылаем
 *     заново (пауза растёт 10 мин → 20 → 40 … до 6 ч). После MAX_ATTEMPTS
 *     перестаём слать и раз в сутки пишем тревогу в журнал ошибок.
 *  2. Место свободно, а в QUEUED кто-то ждёт (процесс умер между закрытием
 *     прошлой передачи и выдачей следующей) — выдаём следующего.
 *  3. Ручное ожидание готового ролика (videoHandoffManualSince), брошенное
 *     дольше суток, снимаем — объект не должен висеть «у монтажёра».
 *
 * ГРОМКО, А НЕ В ЖУРНАЛ (23.09.2026, жалоба владельца: объект «у монтажёра»,
 * монтажёр ничего не получил, очередь стояла, пока объект не сняли руками).
 * До этой правки сторож сдавался молча: шесть попыток — это около пяти часов,
 * и всё это время о том, что очередь стоит, знал только журнал ошибок, а
 * руководитель узнавал через сутки от стоп-сигнала. Теперь со второй неудачной
 * попытки (около получаса) директор и админ получают тревогу в CRM и пуш,
 * наблюдатели монтажа — сообщение в Telegram, с числом объектов, которые стоят
 * за этим. Повтор — раз в шесть часов на объект, пока не дойдёт.
 *
 * Отметка доставки ПРОШЛОГО круга (перемонтаж) доставкой не считается:
 * `videoHandoffDeliveredAt` раньше `videoHandoffSentAt` = не доставлено.
 *
 * Захват строки — условным updateMany по старому videoHandoffSentAt: два тика
 * (или тик и живая отправка из api) не пошлют один объект дважды.
 */
export const REDELIVERY_BASE_DELAY_MS = 10 * 60 * 1000;
const REDELIVERY_MAX_DELAY_MS = 6 * 60 * 60 * 1000;
export const REDELIVERY_MAX_ATTEMPTS = 6;
/** С какой неудачной попытки кричать руководителю, а не только досылать. */
export const REDELIVERY_LOUD_AFTER_ATTEMPTS = 2;
const ALARM_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** Сколько ждёт ручная загрузка готового ролика, прежде чем её снимут. */
export const MANUAL_WAIT_MAX_MS = 24 * 60 * 60 * 1000;
/**
 * ГОНКА СТОРОЖА С ЖИВОЙ ОТПРАВКОЙ (24.09.2026, задание E). Большая передача
 * (15+ роликов по сотне МБ) идёт минутами — дольше первой паузы сторожа
 * (10 мин). `videoHandoffDispatchStartedAt` (Property) гасится dispatchToEditor
 * в finally сразу по завершении; отметка младше этого порога значит «отправка
 * идёт прямо сейчас, не трогать». Отметка старше — процесс, скорее всего, умер
 * посреди отправки (та же ситуация, ради которой сторож вообще заведён,
 * объект №121), считаем её мёртвой и досылаем как раньше.
 */
export const DISPATCH_IN_PROGRESS_DEAD_AFTER_MS = 15 * 60 * 1000;

/** Держит место, а до монтажёра исходники этого круга не дошли. */
function isUndelivered(p: { videoHandoffDeliveredAt: Date | null; videoHandoffSentAt: Date | null }): boolean {
  if (!p.videoHandoffDeliveredAt) return true;
  return !!p.videoHandoffSentAt && p.videoHandoffDeliveredAt < p.videoHandoffSentAt;
}

/** Живая отправка прямо сейчас — сторож её не трогает (задание E). */
function dispatchLikelyInProgress(startedAt: Date | null, now: Date): boolean {
  return !!startedAt && now.getTime() - startedAt.getTime() < DISPATCH_IN_PROGRESS_DEAD_AFTER_MS;
}

export function redeliveryDelayMs(attempts: number): number {
  const exp = Math.max(0, attempts - 1);
  return Math.min(REDELIVERY_BASE_DELAY_MS * 2 ** exp, REDELIVERY_MAX_DELAY_MS);
}

export async function runVideoHandoffRedeliveryTick(
  now: Date = new Date()
): Promise<{ redelivered: number; gaveUp: number; released: boolean; alerted: number; manualExpired: number }> {
  const settings = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { videoHandoffEnabled: true, videoMontajerAgentId: true },
  });
  if (!settings?.videoHandoffEnabled || !settings.videoMontajerAgentId) {
    return { redelivered: 0, gaveUp: 0, released: false, alerted: 0, manualExpired: 0 };
  }

  const manualExpired = await expireAbandonedManualWaits(now);

  const holders = await prisma.property.findMany({
    where: EDITOR_HOLDER_WHERE,
    select: {
      id: true,
      shortId: true,
      videoHandoffSentAt: true,
      videoHandoffDeliveredAt: true,
      videoHandoffDispatchAttempts: true,
      videoHandoffDispatchStartedAt: true,
    },
    take: 20,
  });
  const undelivered = holders.filter(isUndelivered);
  const queuedCount =
    undelivered.length > 0 ? await prisma.property.count({ where: { videoHandoffStatus: "QUEUED", deletedAt: null } }) : 0;

  let redelivered = 0;
  let gaveUp = 0;
  let alerted = 0;
  for (const p of undelivered) {
    // ЗАДАНИЕ E: живая отправка идёт прямо сейчас — не трогаем вовсе (ни
    // тревога, ни повторный захват), пока отметка не устареет.
    if (dispatchLikelyInProgress(p.videoHandoffDispatchStartedAt, now)) continue;

    if (p.videoHandoffDispatchAttempts >= REDELIVERY_LOUD_AFTER_ATTEMPTS) {
      const exhausted = p.videoHandoffDispatchAttempts >= REDELIVERY_MAX_ATTEMPTS;
      const queueNote = queuedCount > 0 ? ` За ним стоят ещё ${queuedCount} объект(ов) — они не уйдут, пока этот не решится.` : "";
      const sent = await alertMontageStuck({
        shortId: p.shortId,
        title: `🎬 Монтажёр не получил объект №${p.shortId}`,
        body:
          `Исходники не дошли до монтажёра после ${p.videoHandoffDispatchAttempts} попыток` +
          (exhausted ? ", больше не досылаю." : ", продолжаю досылать.") +
          `${queueNote} Проверьте Telegram монтажёра и файл видео, затем «Прислать заново» или снимите объект с монтажа.`,
        tag: `video-handoff-undelivered-${p.id}`,
        minIntervalMs: ALARM_INTERVAL_MS,
        now,
      });
      if (sent) alerted++;
    }

    const sentAt = p.videoHandoffSentAt ?? new Date(0);
    if (now.getTime() - sentAt.getTime() < redeliveryDelayMs(p.videoHandoffDispatchAttempts)) continue;

    if (p.videoHandoffDispatchAttempts >= REDELIVERY_MAX_ATTEMPTS) {
      gaveUp++;
      if (await shouldAlert(`video-handoff-undelivered-log-${p.id}`, 24 * 60 * 60 * 1000, now)) {
        void logSystemError(
          "video-handoff",
          `Объект №${p.shortId}: исходники так и не дошли до монтажёра после ${p.videoHandoffDispatchAttempts} попыток — очередь монтажа стоит. Проверьте Telegram монтажёра и файл видео, затем «Прислать заново» или снимите объект с монтажа.`
        );
        // ЗАДАНИЕ D: ссылка — последний резерв, только когда попытки сторожа
        // исчерпаны, и не чаще той же тревоги (раз в сутки на объект).
        await sendGiveUpFallbackLinks(p.id, p.shortId, settings.videoMontajerAgentId).catch((err) =>
          logSystemError("video-handoff", `Объект №${p.shortId}: запасные ссылки не отправились: ${describeError(err)}`)
        );
      }
      continue;
    }

    // Захват: только если с момента чтения никто не трогал попытку.
    const claimed = await prisma.property.updateMany({
      where: {
        id: p.id,
        ...EDITOR_HOLDER_WHERE,
        videoHandoffDeliveredAt: p.videoHandoffDeliveredAt,
        videoHandoffSentAt: p.videoHandoffSentAt,
      },
      data: { videoHandoffSentAt: now },
    });
    if (claimed.count !== 1) continue;

    void logSystemError(
      "video-handoff",
      `Объект №${p.shortId}: исходники не дошли до монтажёра (попытка ${p.videoHandoffDispatchAttempts}) — досылаю заново`
    );
    try {
      if (await dispatchToEditor(p.id, settings.videoMontajerAgentId)) redelivered++;
    } catch (err) {
      void logSystemError(
        "video-handoff",
        `Повторная отправка объекта №${p.shortId} монтажёру упала: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  // Место свободно, а очередь стоит — выдаём следующего. Кроме паузы
  // (24.09.2026): там очередь стоит НАМЕРЕННО, и выдавать, и писать в журнал
  // «очередь стояла» каждый тик было бы неправдой. Досылка уже выданному
  // держателю выше паузой не держится — он у монтажёра.
  let released = false;
  const [holder, waiting, pauseRow] = await Promise.all([
    prisma.property.findFirst({ where: EDITOR_HOLDER_WHERE, select: { id: true } }),
    nextInQueue(),
    prisma.settings.findUnique({ where: { id: "singleton" }, select: { videoHandoffQueuePaused: true } }),
  ]);
  if (!holder && waiting && !pauseRow?.videoHandoffQueuePaused) {
    void logSystemError("video-handoff", "Место монтажёра свободно, а очередь стояла — выдаю следующий объект");
    await releaseQueueIfClear("");
    released = true;
  }

  return { redelivered, gaveUp, released, alerted, manualExpired };
}

/**
 * Брошенная ручная загрузка готового ролика (openForManualFinalVideo): объект
 * открыт, файла нет уже сутки. Место монтажёра он не держит, но в CRM висит
 * «у монтажёра», и приём файла на него по-прежнему открыт. Возвращаем туда,
 * где объект был бы без ожидания: RECEIVED, если готовый ролик уже был, иначе
 * NONE. Условие на ту же отметку — если файл пришёл в последний момент, не трогаем.
 */
async function expireAbandonedManualWaits(now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - MANUAL_WAIT_MAX_MS);
  const abandoned = await prisma.property.findMany({
    where: { videoHandoffStatus: "SENT_TO_EDITOR", videoHandoffManualSince: { lt: cutoff } },
    select: { id: true, shortId: true, videoHandoffManualSince: true, videoHandoffFinalPath: true },
    take: 50,
  });
  let expired = 0;
  for (const p of abandoned) {
    const done = await prisma.property.updateMany({
      where: { id: p.id, videoHandoffStatus: "SENT_TO_EDITOR", videoHandoffManualSince: p.videoHandoffManualSince },
      data: {
        videoHandoffStatus: p.videoHandoffFinalPath ? "RECEIVED" : "NONE",
        videoHandoffManualSince: null,
        videoHandoffSentAt: null,
      },
    });
    if (done.count !== 1) continue;
    expired++;
    // Прежний ролик ждал своего часа, пока объект стоял открытым под замену, —
    // задание в свой час его пропустило. Ставим заново (24.09.2026).
    if (p.videoHandoffFinalPath && p.videoHandoffManualSince) {
      await rearmPublishSkippedDuringManualWait(p.id, p.videoHandoffManualSince).catch((err) =>
        logSystemError("video-handoff", `Объект №${p.shortId}: не удалось заново поставить публикацию прежнего ролика: ${err instanceof Error ? err.message : String(err)}`)
      );
    }
    void logSystemError(
      "video-handoff",
      `Объект №${p.shortId}: готовый ролик вручную так и не загрузили за сутки — ожидание снято. Загрузите файл заново из карточки объекта.`
    );
  }
  return expired;
}
