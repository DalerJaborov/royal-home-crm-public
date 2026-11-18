import { formatClientCode, formatClientName, isSecurityAutomationOn, SECURITY_AUTOMATION_KEY } from "@royal-home/shared";
import { prisma, type TxClient } from "../db.js";
import { enqueueDirectorAlert } from "./directorAlertQueue.js";
import { recordInvestigationSignal } from "./investigationCases.js";
import { logTimeline } from "./timeline.js";
import { trashBlocker } from "./trashClient.js";
import { describeError } from "./describeError.js";
import { logSystemError } from "./systemError.js";

/**
 * ОДНА ДВЕРЬ: «МОЖЕТ ЛИ АВТОМАТИКА СБ САМА МЕНЯТЬ КАРТОЧКУ» (владелец 18.11.2026).
 *
 * Повод: продавец ПР-000714 закрыта проверкой СБ 19.10 с вердиктом «вопросов нет»,
 * хотя её объект №170 продавался. Владелец: «Нужно чтобы таких больше не было и
 * временно выключить всю логику сб можно? Просто чтобы уведомление было
 * руководителю тоже».
 *
 * Каждый механизм, который раньше сам ставил карточку «на проверку СБ» (и тем
 * открывал дорогу к закрытию), спрашивает здесь. Выключено — он вызывает
 * reportSecuritySignal вместо своего действия: сигнал записывается в закрытую
 * хронологию и дело СБ, руководству уходит уведомление, карточка и агент не
 * меняются. Список механизмов — docs/journal/2026-11-18-security-automation-switch.md.
 *
 * Без кэша нарочно (тот же довод, что у lib/sellerSwitches.ts): api и worker —
 * разные процессы, выключение обязано действовать в обоих с ближайшего прохода.
 */
export async function securityAutomationOn(db: Pick<TxClient, "settings"> = prisma): Promise<boolean> {
  const row = await db.settings.findUnique({ where: { id: "singleton" }, select: { [SECURITY_AUTOMATION_KEY]: true } });
  return isSecurityAutomationOn(row);
}

/** Кому идёт сигнал, пока автоматика выключена: директор и РОП (владелец 18.11.2026). */
export const SECURITY_SIGNAL_RECIPIENT_ROLES = ["DIRECTOR", "HEAD_OF_SALES"] as const;

export interface SecuritySignalInput {
  clientId: string;
  /** О ком сигнал: этому агенту уведомление не уходит, даже если он РОП. */
  subjectAgentId: string | null;
  /** Кто нашёл — имя механизма (пишется в дело СБ). */
  source: string;
  /**
   * Один сигнал = одно уведомление. Повтор того же ключа (крон каждые 30 минут,
   * второй аудит того же диалога) ничего не пишет и никого не будит.
   */
  dedupeKey: string;
  /** Что найдено — человеческими словами, без «СБ решила». */
  what: string;
  propertyId?: string | null;
  /**
   * false — вызывающий уже записал закрытую запись в хронологию сам (отказ агента,
   * lib/clientRefuse.ts): второй строки «то же самое» не нужно.
   */
  writeTimeline?: boolean;
}

/**
 * СИГНАЛ СБ ПРИ ВЫКЛЮЧЕННОЙ АВТОМАТИКЕ: записать и сообщить, ничего не меняя.
 *
 * В одной транзакции под замком ключа: улика в деле СБ (recordInvestigationSignal —
 * её уникальность и есть дедуп), закрытая запись в хронологии карточки и аларм
 * руководству через общую очередь (lib/directorAlertQueue.ts: колокольчик сразу,
 * пуш — в часы алармов). Тег `security-signal-` нарочно НЕ из закрытых префиксов
 * (lib/investigationNotifications.ts): РОП не допущена к делам СБ, а владелец
 * прямо попросил, чтобы уведомление было и у неё.
 *
 * Ошибка не роняет вызывающего (отказ агента, крон, аудит диалога): она уходит в
 * журнал ошибок, а сам механизм всё равно ничего не меняет.
 */
export async function reportSecuritySignal(input: SecuritySignalInput): Promise<{ notified: boolean }> {
  const tag = `security-signal-${input.dedupeKey}`;
  try {
    return await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${tag}))`;
      const client = await tx.client.findUnique({
        where: { id: input.clientId },
        select: { id: true, shortId: true, fullName: true, kind: true, dualIntent: true, assignedAt: true, assignedAgentId: true },
      });
      if (!client) return { notified: false };
      const subjectAgentId = input.subjectAgentId ?? client.assignedAgentId;
      const origin = { sourceType: "security-automation-off", sourceId: input.dedupeKey,
        independenceKey: `system:${input.source}`, kind: input.source };
      const note = `Служба безопасности (автоматика выключена): ${input.what}. Карточку и агента не меняли — уведомлены директор и РОП.`;
      const signal = await recordInvestigationSignal({
        clientId: client.id, propertyId: input.propertyId ?? null, subjectAgentId,
        assignmentAt: client.assignedAt, ...origin, summary: note, occurredAt: new Date(),
      }, tx);
      if (!signal.inserted) return { notified: false };

      if (input.writeTimeline !== false) {
        // Та же улика (origin) — logTimeline повторно зовёт recordInvestigationSignal,
        // и тот молча видит дубль: второй строки в деле не будет.
        await logTimeline({
          clientId: client.id,
          actor: { kind: "system", source: input.source, subjectAgentId },
          type: "SYSTEM",
          investigationOnly: true,
          investigationOrigin: origin,
          propertyId: input.propertyId ?? undefined,
          notes: note,
          tx,
        });
      }

      const code = formatClientCode(client.shortId, client.kind);
      await enqueueDirectorAlert({
        title: `🛡 ${formatClientName(client)} (${code}): сигнал СБ`,
        body: `${input.what}. Автоматика СБ выключена — карточку и агента не меняли. Решите сами, нужна ли проверка.`,
        url: `/clients/${client.shortId}`,
        kind: "oversight",
        tag,
        recipientRoles: [...SECURITY_SIGNAL_RECIPIENT_ROLES],
        ...(subjectAgentId ? { excludeAgentId: subjectAgentId } : {}),
      }, tx);
      return { notified: true };
    });
  } catch (err) {
    void logSystemError("investigation", `Сигнал СБ (${input.source}, клиент ${input.clientId}) не записан: ${describeError(err)}`,
      { dedupKey: `security-signal-failed:${input.source}` });
    return { notified: false };
  }
}

/** С этого срока считаем «свежую работу агента», если момент постановки на проверку неизвестен. */
const ACTIVITY_FALLBACK_MS = 14 * 86_400_000;

/**
 * ПОЧЕМУ ВЕРДИКТ СБ НЕ ДОЛЖЕН ЗАКРЫВАТЬ ЭТУ КАРТОЧКУ (владелец 18.11.2026).
 *
 * Карточка в работе, если есть хоть одно: вторая роль клиента, открытая сделка или
 * объект продавца не снят с продажи (trashBlocker — то же правило, что у ручного
 * удаления: AVAILABLE, RESERVED, AWAITING_PHOTOS и любой другой, кроме SOLD/WITHDRAWN),
 * открытая задача агента или работа агента после постановки на проверку.
 *
 * Момент постановки: отказ агента (assignmentRefusedAt) или последняя закрытая
 * запись СБ в хронологии; ни того ни другого — последние 14 дней.
 *
 * null — закрывать можно. Иначе — причина простыми словами для хронологии.
 */
export async function securityReviewCloseBlocker(
  tx: TxClient,
  client: { id: string; dualIntent: boolean; assignmentRefusedAt: Date | null },
  now: Date = new Date()
): Promise<string | null> {
  if (client.dualIntent) return "у клиента вторая роль";
  const blocker = await trashBlocker(client.id, tx);
  if (blocker) return blocker.error;

  const openTask = await tx.interaction.findFirst({
    where: { clientId: client.id, investigationOnly: false, completedAt: null, declinedAt: null, taskCancelledAt: null,
      OR: [{ nextAction: { not: null } }, { nextActionDate: { not: null } }] },
    select: { id: true },
  });
  if (openTask) return "у агента есть открытая задача по карточке";

  const lastMark = await tx.interaction.findFirst({
    where: { clientId: client.id, investigationOnly: true, createdAt: { lte: now } },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  const candidates = [client.assignmentRefusedAt, lastMark?.createdAt].filter((d): d is Date => !!d);
  const since = candidates.length ? new Date(Math.max(...candidates.map((d) => d.getTime())))
    : new Date(now.getTime() - ACTIVITY_FALLBACK_MS);
  const agentWork = await tx.interaction.findFirst({
    where: { clientId: client.id, investigationOnly: false, agentId: { not: null }, type: { not: "SYSTEM" }, createdAt: { gt: since } },
    select: { id: true },
  });
  if (agentWork) return "агент продолжил работу с клиентом после постановки на проверку";
  return null;
}
