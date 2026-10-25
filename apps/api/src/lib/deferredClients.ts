/**
 * «ОТЛОЖЕННЫЕ» (задача G, план вечерней сессии 03-04.09.2026, решение владельца).
 *
 * ПРОБЛЕМА, КОТОРУЮ ЭТО ЗАКРЫВАЕТ (см. docs/audit-02-09-2026/20-deep-audit-03-09-night.md,
 * §7 пункт 8): «дорого» / «финансы не готовы» / «не подошли объекты» — это обычный
 * исход рынка, не отказ и не увод сделки. До этой задачи такой клиент всё равно
 * уходил в обычный путь «Без сделки» (routes/clients/lifecycle.ts::refuse):
 * следующему агенту по очереди КЛИ или в очередь руководителя — то есть кто-то
 * снова звонил человеку, который уже объяснил свою причину. Владелец прямо просил
 * это прекратить.
 *
 * РЕШЕНИЕ. Три причины (EXPENSIVE/FINANCE_ISSUE/WRONG_OBJECT — те же ключи, что и
 * REFUSAL_REASONS в packages/shared/src/schemas.ts) перехватываются ДО обычной
 * ветки refuse и ведут в новое состояние Client.workStatus="DEFERRED":
 *   - слот у агента освобождается (leadLimits.OCCUPIES_SLOT_WHERE фильтрует
 *     workStatus="ACTIVE", DEFERRED не считается) — агент может брать новых лидов;
 *   - клиент НЕ в светофоре неактивных (inactiveTrafficLight.ts отбирает по
 *     workStatus="INACTIVE" — структурно другое значение, а не флаг поверх него);
 *   - никто не звонит: ни автоматика, ни следующий агент — карточка остаётся ЗА
 *     ТЕМ ЖЕ агентом (assignedAgentId не меняется), просто «спит»;
 *   - агент НЕ штрафуется: refusalCount не растёт, Royal Score не трогается —
 *     это не эскалация и не отказ, а обычная работа рынка.
 *
 * ВОЗВРАТ. По таймеру (deferredUntil, см. runDeferredClientsReturnTick, вызывается
 * из cron.ts) — 3 месяца для EXPENSIVE/FINANCE_ISSUE, 1 месяц для WRONG_OBJECT
 * (подборка объектов меняется быстрее, чем бюджет клиента). Либо РАНЬШЕ срока —
 * если клиент сам написал/позвонил (returnDeferredClientEarly), тем же принципом,
 * что и возврат из LOST (services/leads/intake.ts::resumeExistingChannelLead,
 * lib/requestedAgent.ts::requestedAgentStillAvailable): тот же агент, без очереди,
 * без нового распределения — карточка и так его, просто «проснулась» раньше.
 */
import type { RefusalReason } from "@royal-home/shared";
import { REFUSAL_REASON_LABELS, REFUSAL_INITIATOR_LABELS, type RefusalInitiator } from "@royal-home/shared";
import { prisma } from "../db.js";
import { sendPushToAgent } from "../push.js";
import { logTimeline } from "./timeline.js";
import { TERMINAL_CLIENT_STATUSES, inactiveExitData } from "./clientContact.js";
import { publishClientUpdated } from "./livePublish.js";

/** Причины, которые ведут в «Отложенные» вместо обычного «Без сделки». */
export const DEFERRED_REFUSAL_REASONS: readonly RefusalReason[] = ["EXPENSIVE", "FINANCE_ISSUE", "WRONG_OBJECT"];

export function isDeferredReason(reason: RefusalReason): boolean {
  return DEFERRED_REFUSAL_REASONS.includes(reason);
}

/** 3 месяца для EXPENSIVE/FINANCE_ISSUE, 1 месяц для WRONG_OBJECT — решение владельца. */
function deferredDurationMonths(reason: RefusalReason): number {
  return reason === "WRONG_OBJECT" ? 1 : 3;
}

/** Прибавляет месяцы в UTC — контейнер живёт в UTC, часовой пояс Душанбе тут
 *  не участвует (это не граница суток/месяца отчёта, а простой срок «через N
 *  месяцев», см. lib/dushanbeTime.ts для того, где часовой пояс ДЕЙСТВИТЕЛЬНО
 *  важен). setUTCMonth, не setHours — правило CLAUDE.md касается setHours
 *  именно из-за локального часового сдвига суток, здесь его нет. */
function addMonthsUtc(date: Date, months: number): Date {
  const d = new Date(date.getTime());
  d.setUTCMonth(d.getUTCMonth() + months);
  return d;
}

export type DeferClientResult = { ok: true; deferredUntil: Date } | { ok: false; error: string };

/**
 * Переводит клиента в «Отложенные» — вызывается ИЗ POST /clients/:id/refuse
 * (routes/clients/lifecycle.ts) вместо обычной ветки, когда reason один из
 * DEFERRED_REFUSAL_REASONS. Гейты «был показ»/«карточка заполнена» и проверка
 * обязательного комментария на горячих клиентах уже пройдены вызывающим кодом —
 * здесь только сама отсрочка.
 *
 * НЕ трогаем: refusalCount (не эскалация), status (клиент не «отказался» и не
 * «потерян» — просто ждёт), Royal Score (агент не виноват).
 */
export async function deferClient(input: {
  clientId: string;
  agentId: string;
  reason: RefusalReason;
  initiator: RefusalInitiator;
  comment?: string;
  competitorName?: string;
  voiceNoteUrl?: string;
  voiceNoteTranscript?: string;
  now?: Date;
}): Promise<DeferClientResult> {
  const client = await prisma.client.findFirst({
    where: { id: input.clientId, deletedAt: null, assignmentCompletedAt: null, assignmentRefusedAt: null },
    select: { id: true, fullName: true, assignedAgentId: true, status: true, workStatus: true },
  });
  if (!client) return { ok: false, error: "Клиент не найден" };
  if (TERMINAL_CLIENT_STATUSES.some((status) => status === client.status))
    return { ok: false, error: "Работа с клиентом уже завершена" };
  if (client.assignedAgentId !== input.agentId) {
    return { ok: false, error: "Клиент закреплён за другим агентом" };
  }

  const now = input.now ?? new Date();
  const deferredUntil = addMonthsUtc(now, deferredDurationMonths(input.reason));
  const reasonLabel = REFUSAL_REASON_LABELS[input.reason];
  const note =
    `Клиент отложен: ${reasonLabel} (инициатор: ${REFUSAL_INITIATOR_LABELS[input.initiator]}). ` +
    `Обычный исход рынка, не отказ — карточка остаётся за вами, звонков не будет. ` +
    `Автоматический возврат в работу — ${deferredUntil.toISOString().slice(0, 10)}, или раньше, если клиент напишет/позвонит сам.` +
    (input.comment?.trim() ? ` ${input.comment.trim()}` : "");

  const written = await prisma.$transaction(async (tx) => {
    const updated = await tx.client.updateMany({
      where: { id: client.id, deletedAt: null, assignedAgentId: input.agentId,
        assignmentCompletedAt: null, assignmentRefusedAt: null,
        status: client.status, workStatus: client.workStatus },
      data: {
        ...inactiveExitData(),
        workStatus: "DEFERRED",
        deferredAt: now,
        deferredReason: input.reason,
        deferredUntil,
        // refusalReason — та же витрина, что у обычного отказа (карточка «Отложенные»
        // показывает причину тем же словарём REFUSAL_REASON_LABELS).
        refusalReason: input.reason,
      },
    });
    if (updated.count !== 1) return false;
    await logTimeline({
      clientId: client.id,
      actor: { kind: "agent", agentId: input.agentId },
      type: "SYSTEM",
      notes: note,
      voiceNoteUrl: input.voiceNoteUrl ?? null,
      voiceNoteTranscript: input.voiceNoteTranscript ?? null,
      tx,
    });
    return true;
  });
  if (!written) return { ok: false, error: "Карточка изменилась во время сохранения" };
  publishClientUpdated({ clientId: client.id, agentIds: [input.agentId], stage: "DEFERRED" });

  // Открытые требования (PendingSummary) по клиенту, за которым несколько
  // месяцев никто не будет работать, гасим — тот же приём, что у deactivateClient:
  // иначе они блокируют агенту выдачу новых лидов и штрафуют за просрочку по
  // карточке, которая сейчас нарочно «спит».
  return { ok: true, deferredUntil };
}

/**
 * Возврат в обычную работу — таймер (cron) или клиент написал/позвонил сам.
 * ТОТ ЖЕ агент, assignedAgentId не трогаем: карточка и так его, это не передача.
 */
export async function returnDeferredClientToWork(
  clientId: string,
  reason: "timer" | "early_contact" | "manual",
  /** Кто нажал «Поднять раньше срока» — только для reason="manual" (П-10:
   *  живой человек, req.agent из routes/clients/lifecycle.ts). */
  actorAgentId?: string | null
): Promise<{ ok: boolean }> {
  const client = await prisma.client.findFirst({
    where: { id: clientId, deletedAt: null, assignmentCompletedAt: null, workStatus: "DEFERRED", status: { notIn: [...TERMINAL_CLIENT_STATUSES] } },
    select: { id: true, shortId: true, fullName: true, assignedAgentId: true, deferredUntil: true },
  });
  // Отложенный клиент без агента структурно не должен встречаться (deferClient
  // требует agentId на входе) — на всякий случай отказываем явно, а не пишем
  // историю от "ничьего" имени.
  if (!client || !client.assignedAgentId) return { ok: false };
  const assignedAgentId = client.assignedAgentId;

  const note =
    reason === "timer"
      ? "Отложенный клиент возвращён в работу автоматически — срок отсрочки истёк"
      : reason === "manual"
        ? "Отложенный клиент поднят в работу раньше срока вручную"
        : "Отложенный клиент вернулся в работу раньше срока — написал/позвонил сам";

  // Автор (П-10): "timer" — крон, system; "manual" — живой человек, нажавший
  // кнопку; "early_contact" — сам клиент позвонил/написал, не агент и не система.
  const actor =
    reason === "timer"
      ? ({ kind: "system", source: "deferredClients.timer", subjectAgentId: assignedAgentId } as const)
      : reason === "manual"
        ? actorAgentId
          ? ({ kind: "agent", agentId: actorAgentId } as const)
          : ({ kind: "system", source: "deferredClients.manual", subjectAgentId: assignedAgentId } as const)
        : ({ kind: "client", source: "deferredClients.earlyContact", subjectAgentId: assignedAgentId } as const);

  const written = await prisma.$transaction(async (tx) => {
    const updated = await tx.client.updateMany({
      where: { id: client.id, workStatus: "DEFERRED", deletedAt: null,
        assignmentCompletedAt: null,
        assignedAgentId, deferredUntil: client.deferredUntil, status: { notIn: [...TERMINAL_CLIENT_STATUSES] } },
      data: { ...inactiveExitData(), returnedAt: new Date(), deferredUntil: null, deferredReason: null },
    });
    if (updated.count !== 1) return false;
    await logTimeline({ clientId: client.id, actor, type: "SYSTEM", notes: note, tx });
    return true;
  });
  if (!written) return { ok: false };
  publishClientUpdated({ clientId: client.id, agentIds: [assignedAgentId], stage: "ACTIVE" });

  void sendPushToAgent(assignedAgentId, {
    title:
      reason === "timer"
        ? "⏰ Отложенный клиент вернулся в работу"
        : reason === "manual"
          ? "↩️ Отложенный клиент поднят в работу"
          : "🙋 Отложенный клиент написал сам",
    body: `${client.fullName} — снова в вашей активной работе.`,
    url: `/clients/${client.shortId}`,
    tag: `deferred-return-${client.id}`,
  }).catch((err) => console.error("[push] возврат отложенного клиента:", err));

  return { ok: true };
}

/**
 * Ранний возврат — клиент сам написал/позвонил ДО срока (services/leads/intake.ts,
 * зеркало возврата из INACTIVE/LOST). В отличие от возврата из INACTIVE (который
 * спрашивает прежнего агента «принять/отклонить», см. reactivationOfferedToAgentId)
 * здесь решения не требуется: агент не отказывался от клиента и не переставал
 * быть за него ответственным, отсрочка — не пауза с его стороны, а факт про
 * клиента. Поэтому возврат немедленный, без предложения.
 */
export async function returnDeferredClientEarly(clientId: string): Promise<{ ok: boolean }> {
  return returnDeferredClientToWork(clientId, "early_contact");
}

/**
 * Кнопка «Поднять раньше срока» (задача G5) — агент или руководитель решает не
 * ждать таймер. POST /clients/:id/deferred/return (routes/clients/lifecycle.ts).
 */
export async function returnDeferredClientManually(clientId: string, actorAgentId: string): Promise<{ ok: boolean }> {
  return returnDeferredClientToWork(clientId, "manual", actorAgentId);
}

const DEFERRED_RETURN_BATCH = 200;

/**
 * КРОН-ТИК — та же капа/приём выборки, что у соседних тиков (см.
 * lib/pendingSummaries.ts, lib/inactiveTrafficLight.ts): потолок, а не выборка
 * без границ, чтобы при росте базы тик оставался дешёвым. Индекс
 * [workStatus, deferredUntil] (schema.prisma) делает запрос точечным.
 */
export async function runDeferredClientsReturnTick(now: Date = new Date()): Promise<{ returned: number }> {
  const due = await prisma.client.findMany({
    where: { workStatus: "DEFERRED", deletedAt: null, assignmentCompletedAt: null, deferredUntil: { lte: now }, status: { notIn: [...TERMINAL_CLIENT_STATUSES] } },
    orderBy: { deferredUntil: "asc" },
    take: DEFERRED_RETURN_BATCH,
    select: { id: true },
  });
  let returned = 0;
  for (const c of due) {
    try {
      const result = await returnDeferredClientToWork(c.id, "timer");
      if (result.ok) returned++;
    } catch (err) {
      console.error("[cron] Возврат отложенного клиента:", err instanceof Error ? err.message : err);
    }
  }
  return { returned };
}
