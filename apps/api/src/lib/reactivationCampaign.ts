import { prisma } from "../db.js";
import type { Prisma } from "../generated/prisma/client.js";
import { dushanbeWallClock } from "./dushanbeTime.js";
import { noContactSinceWhere } from "./noContact.js";
import { enqueueBackgroundJob } from "../jobs/enqueue.js";
import { requestedAgentStillAvailable } from "./requestedAgent.js";

/**
 * РЕАКТИВАЦИЯ СТАРЫХ КЛИЕНТОВ ПАЧКОЙ (Пачка 12, 11.09.2026,
 * docs/gaps-audit-11-09.md, владелец 11.09.2026: «всё остальное делай»).
 *
 * Раз в неделю (понедельник 10:00 Душанбе, см. cron.ts) бот сам пишет
 * небольшой пачке остывших клиентов — вместо того, чтобы их «нашли» вручную
 * или они молча лежали годами в COLD/LOST/Неактивных. Отбор и постановка в
 * очередь — здесь; сама отправка и запись в карточку — jobs/clientReactivation.ts
 * (отдельным заданием на клиента, а не одним большим циклом здесь: рассылка на
 * 20 карточек — это до 20 сетевых вызовов к мессенджерам, и одно зависшее
 * сообщение не должно блокировать остальные девятнадцать ни срывать весь тик).
 *
 * ИДЕМПОТЕНТНОСТЬ. dedupeKey `reactivation:{clientId}:{weekKey}` в
 * enqueueBackgroundJob — повторный тик в ту же неделю (перезапуск процесса,
 * повторное срабатывание крона) не заводит вторую отправку тому же клиенту.
 * weekKey — дата понедельника этой недели по Душанбе, тот же приём, что у
 * lib/duplicatesWeeklyDigest.ts.
 */

export function reactivationWeekKey(at: Date): string {
  return dushanbeWallClock(at).toISOString().slice(0, 10);
}

/** `reactivation:{clientId}:{weekKey}` → части ключа. */
export function parseReactivationKey(key: string | null): { clientId: string; weekKey: string } | null {
  const m = key?.match(/^reactivation:([^:]+):(\d{4}-\d{2}-\d{2})$/);
  return m ? { clientId: m[1], weekKey: m[2] } : null;
}

export interface ReactivationTickResult {
  /** Сколько заданий реально поставлено (или уже стояло — enqueue сам решает). */
  enqueued: number;
  /** "disabled" — тумблер в Настройках выключен, тик ничего не делал. */
  skipped: "disabled" | null;
}

/**
 * КОГО ЗВАТЬ ОБРАТНО — ПО ОБЩЕМУ ПРАВИЛУ «БЕЗ КОНТАКТА» (16.11.2026).
 *
 * Раньше — статусы COLD/LOST и workStatus INACTIVE плюс lastContactAt. Этих
 * статусов больше нет (владелец: «ничего лишнего»), а lastContactAt двигают
 * заметки агента. Теперь кандидат — карточка, с которой больше `cutoff` не было
 * НАСТОЯЩЕГО контакта (ни разговора по телефону, ни сообщения самого клиента —
 * lib/noContact.ts::noContactSinceWhere) и которая сама старше этого срока
 * (свежую заявку без контакта «возвращать» рано). Закрытая сделка и Архив — не
 * зовём. Пока идёт своя реактивация к прежнему агенту
 * (reactivationOfferedToAgentId) — вторым сообщением не мешаем.
 * Тем же условием задание перепроверяет карточку перед отправкой
 * (jobs/clientReactivation.ts) — правило одно.
 */
export function reactivationCandidateWhere(cutoff: Date): Prisma.ClientWhereInput {
  return {
    AND: [
      { deletedAt: null, reactivationOfferedToAgentId: null, status: { notIn: ["DEAL_CLOSED", "ARCHIVED"] }, createdAt: { lt: cutoff } },
      noContactSinceWhere(cutoff),
    ],
  };
}

/** Срок «давно без контакта» для рассылки — из Настроек, не меньше суток. */
export function reactivationCutoff(afterDays: number | null | undefined, now: Date = new Date()): Date {
  return new Date(now.getTime() - Math.max(1, afterDays ?? 60) * 86_400_000);
}

/** Верхний предел размера пачки — щит от опечатки в Настройках (владелец
 *  однажды может вписать «2000» вместо «20»): реактивация не имеет права стать
 *  спам-рассылкой по всей базе за один тик. */
const MAX_BATCH_SIZE = 200;

export async function runReactivationCampaignTick(now: Date = new Date()): Promise<ReactivationTickResult> {
  const settings = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { reactivationEnabled: true, reactivationAfterDays: true, reactivationBatchSize: true },
  });
  if (!settings?.reactivationEnabled) return { enqueued: 0, skipped: "disabled" };

  const batchSize = Math.max(1, Math.min(MAX_BATCH_SIZE, settings.reactivationBatchSize ?? 20));
  const cutoff = reactivationCutoff(settings.reactivationAfterDays, now);
  const weekKey = reactivationWeekKey(now);

  /**
   * Кандидаты — reactivationCandidateWhere выше (общее правило «без контакта»).
   *
   * take с запасом (x2) — часть кандидатов отсеется ниже по optedOut, а тик
   * должен по возможности выбрать полную пачку, а не считать «до отсева».
   */
  /**
   * УЖЕ ПОЛУЧАВШИХ — НЕ ПОВТОРЯТЬ (аудит 23.09.2026, №49). Отправка
   * реактивации lastContactAt не трогает (это касание сотрудника, а не
   * автоматики), поэтому одни и те же ~20 самых старых карточек выбирались
   * каждую неделю, а до остальных очередь не доходила никогда. Кому ставили
   * задание за последние afterDays — пропускаем: следующая попытка им не раньше,
   * чем через тот же срок, что и первая.
   */
  // Сравниваем по дню отправки из ключа (он считается от `now` тика), а
  // createdAt — только грубый предфильтр с запасом в неделю.
  const cutoffKey = reactivationWeekKey(cutoff);
  const recentJobs = await prisma.backgroundJob.findMany({
    where: { type: "client-reactivation", createdAt: { gte: new Date(cutoff.getTime() - 7 * 86_400_000) } },
    select: { dedupeKey: true },
  });
  const recentlyOffered = [
    ...new Set(
      recentJobs
        .map((j) => parseReactivationKey(j.dedupeKey))
        .filter((k): k is { clientId: string; weekKey: string } => !!k && k.weekKey >= cutoffKey)
        .map((k) => k.clientId)
    ),
  ];

  const candidates = await prisma.client.findMany({
    where: {
      AND: [reactivationCandidateWhere(cutoff), ...(recentlyOffered.length ? [{ id: { notIn: recentlyOffered } }] : [])],
    },
    orderBy: [{ lastClientMessageAt: { sort: "asc", nulls: "first" } }, { createdAt: "asc" }],
    select: { id: true },
    take: batchSize * 2,
  });
  if (candidates.length === 0) return { enqueued: 0, skipped: null };

  // optedOut — только у диалога БОТА (BotConversation.optedOutAt): «не пишите
  // мне» относится к каналу, а не к карточке. У TelegramConversation такого
  // поля нет (см. schema.prisma) — туда реактивация писать не запрещена.
  const clientIds = candidates.map((c) => c.id);
  const optedOut = await prisma.botConversation.findMany({
    where: { clientId: { in: clientIds }, optedOutAt: { not: null } },
    select: { clientId: true },
  });
  const optedOutIds = new Set(optedOut.map((c) => c.clientId));
  const eligible = candidates.filter((c) => !optedOutIds.has(c.id)).slice(0, batchSize);
  if (eligible.length === 0) return { enqueued: 0, skipped: null };

  let enqueued = 0;
  for (const client of eligible) {
    const result = await enqueueBackgroundJob({
      type: "client-reactivation",
      payload: { clientId: client.id, weekKey },
      maxAttempts: 5,
      dedupeKey: `reactivation:${client.id}:${weekKey}`,
    });
    if (result.enqueued) enqueued += 1;
  }
  return { enqueued, skipped: null };
}

/**
 * Кому достанется задача «перезвонить» после реактивационного сообщения
 * (владелец, docs/archive/agent-briefs/ownership-security-11-09.md, Пачка 12, п.2):
 * действующему владельцу карточки, иначе прежнему — если он всё ещё реально
 * доступен (не уволен/не заморожен/не на паузе, requestedAgent.ts — тот же
 * критерий, что у возврата клиента прежнему агенту), иначе очередь
 * руководителя (первый действующий директор).
 *
 * Не меняет Client.assignedAgentId — это только адресат СЛУЖЕБНОЙ задачи
 * (Interaction.agentId), а не передача владения карточкой; правило единственной
 * точки записи (lib/changeClientAgent.ts) здесь ни при чём.
 */
export async function resolveReactivationTaskAgentId(client: {
  assignedAgentId: string | null;
  lastAgentId: string | null;
}): Promise<string | null> {
  if (client.assignedAgentId) return client.assignedAgentId;
  if (client.lastAgentId) {
    const available = await requestedAgentStillAvailable(client.lastAgentId);
    if (available) return available;
  }
  const director = await prisma.agent.findFirst({
    where: { role: "DIRECTOR", isActive: true },
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });
  return director?.id ?? null;
}

/** Подставляет плейсхолдеры {name}/{agent} в шаблон из Настроек. Отсутствие
 *  плейсхолдера в тексте — не ошибка, владелец может написать шаблон без них. */
export function fillReactivationTemplate(template: string, name: string, agentName: string): string {
  return template.replace(/\{name\}/g, name).replace(/\{agent\}/g, agentName);
}
