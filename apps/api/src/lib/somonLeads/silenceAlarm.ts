import { prisma } from "../../db.js";
import { logSystemError } from "../systemError.js";
import { isTelegramPortalAlertsPaused } from "../telegramPortalPause.js";

/**
 * СТОРОЖ ТИШИНЫ МОНИТОРА СОБСТВЕННИКОВ SOMON (17.11.2026).
 *
 * Живой случай: 03.11 включили паузу Telegram-уведомлений площадок
 * (`Settings.telegramPortalAlertsPaused`, по умолчанию ВКЛ), монитор при паузе молча
 * выходит из тика, и с 03.11 по 17.11 агентам не ушло ни одного объявления — а крон
 * каждую минуту отчитывался «ок». Так же молча монитор стоит при остановленном источнике
 * (403 / пять сбоев подряд), без получателей с Telegram и при недоделанной разметке.
 *
 * Сторож смотрит не на причину, а на результат: монитор ВКЛЮЧЁН, а принятых
 * (ACCEPTED) отправок агентам нет дольше порога — запись в журнал ошибок с названной
 * причиной, не чаще раза в сутки. Выключенный монитор (`enabled=false`) — решение
 * владельца, тревоги нет. Пауза — тоже решение, но «временное»: о ней напоминаем
 * реже (порог длиннее), чтобы она снова не забылась на две недели.
 */
export const SOMON_SILENCE_HOURS = 24;
export const SOMON_PAUSE_REMIND_HOURS = 72;
const DAY_MS = 24 * 60 * 60 * 1000;

export type SomonSilenceInput = {
  enabled: boolean;
  portalPaused: boolean;
  sourceStopped: boolean;
  baselineDone: boolean;
  eligibleRecipients: number;
  /** Последняя принятая Telegram отправка агенту. */
  lastAcceptedAt: Date | null;
  /** Когда монитор включили: до первой отправки тишина считается отсюда. */
  activatedAt: Date | null;
  /**
   * Первое НОВОЕ (не из разметки) объявление, увиденное после последней отправки, и сколько их.
   * Нужно, чтобы снятие паузы или остановки не дало ложной тревоги по старой отметке: тишина
   * без видимой причины считается с момента, когда монитор снова начал видеть объявления.
   */
  firstObservedAt: Date | null;
  observedCount: number;
};

export type SomonSilenceAlarm = { dedupKey: string; message: string };

export function decideSomonSilenceAlarm(input: SomonSilenceInput, now: Date): SomonSilenceAlarm | null {
  if (!input.enabled) return null;
  const since = [input.lastAcceptedAt, input.activatedAt].filter((d): d is Date => d instanceof Date).sort((a, b) => b.getTime() - a.getTime())[0];
  if (!since) return null;
  const hours = Math.floor((now.getTime() - since.getTime()) / 3_600_000);
  if (input.portalPaused) {
    if (hours < SOMON_PAUSE_REMIND_HOURS) return null;
    return {
      dedupKey: "somon-owner-leads-silent-paused",
      message: `Somon: заявки собственников не уходят агентам — включена пауза Telegram-уведомлений площадок (Settings.telegramPortalAlertsPaused); тишина ${hours} ч. Пауза была временной: снять или выключить монитор`,
    };
  }
  if (hours < SOMON_SILENCE_HOURS) return null;
  const blocker = input.sourceStopped
    ? "источник Somon остановлен (403 или пять сбоев подряд) — снять остановку в Настройках"
    : input.eligibleRecipients === 0
      ? "нет получателей с привязанным Telegram"
      : !input.baselineDone
        ? "стартовая разметка объявлений не закончилась"
        : null;
  if (blocker) return { dedupKey: "somon-owner-leads-silent", message: `Somon: монитор собственников включён, но ни одной заявки агентам за ${hours} ч; ${blocker}` };
  // Без видимой причины. Монитор ещё не видел новых объявлений после тишины — значит, он только
  // что возобновился (сняли паузу/остановку) или тик падает; падение тика ловит пульс крона.
  if (!input.firstObservedAt) return null;
  const workingHours = Math.floor((now.getTime() - input.firstObservedAt.getTime()) / 3_600_000);
  if (workingHours < SOMON_SILENCE_HOURS) return null;
  return {
    dedupKey: "somon-owner-leads-silent",
    message: `Somon: монитор собственников видит новые объявления (${input.observedCount} за ${workingHours} ч), но ни одно не ушло агентам — проверить отбор продавцов и отправку в Telegram`,
  };
}

/** Раз в час из крона. Ничего не меняет, только пишет тревогу в журнал ошибок. */
export async function checkSomonOwnerLeadsSilence(now = new Date()): Promise<SomonSilenceAlarm | null> {
  const state = await prisma.somonMonitor.findUnique({ where: { id: "singleton" }, select: { enabled: true, activatedAt: true, baselineAt: true, sourceStopped: true } });
  if (!state?.enabled) return null;
  const [portalPaused, last, recipients] = await Promise.all([
    isTelegramPortalAlertsPaused(),
    prisma.somonDelivery.findFirst({ where: { status: "ACCEPTED" }, orderBy: { createdAt: "desc" }, select: { createdAt: true } }),
    prisma.somonRecipient.findMany({ where: { enabled: true }, select: { agentId: true } }),
  ]);
  // Та же точка отсчёта, что в decideSomonSilenceAlarm: позднейшая из «последняя отправка» и «включили».
  const since = new Date(Math.max(last?.createdAt.getTime() ?? 0, state.activatedAt?.getTime() ?? 0));
  const observedWhere = { baseline: false, seenAt: { gt: since } };
  const [firstObserved, observedCount] = await Promise.all([
    prisma.somonSeenAdvert.findFirst({ where: observedWhere, orderBy: { seenAt: "asc" }, select: { seenAt: true } }),
    prisma.somonSeenAdvert.count({ where: observedWhere }),
  ]);
  const eligibleRecipients = recipients.length
    ? await prisma.agent.count({ where: { id: { in: recipients.map(r => r.agentId) }, isActive: true, role: "AGENT", telegramChatId: { not: null } } })
    : 0;
  const alarm = decideSomonSilenceAlarm({
    enabled: state.enabled,
    portalPaused,
    sourceStopped: state.sourceStopped,
    baselineDone: !!state.baselineAt,
    eligibleRecipients,
    lastAcceptedAt: last?.createdAt ?? null,
    activatedAt: state.activatedAt,
    firstObservedAt: firstObserved?.seenAt ?? null,
    observedCount,
  }, now);
  if (alarm) await logSystemError("cron", alarm.message, { dedupKey: alarm.dedupKey, dedupWindowMs: DAY_MS });
  return alarm;
}
