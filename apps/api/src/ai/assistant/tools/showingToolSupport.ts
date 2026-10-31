import { canViewInvestigations, isReadOnlyRole } from "@royal-home/shared";
import { loadAgentAccess } from "../../../auth/middleware.js";
import { prisma } from "../../../db.js";
import { AssistantActionError, type AssistantActionActor, type AssistantActionExecutor } from "../../../lib/assistantActions.js";
import { showingActionAccess, type TaskWriteSubject } from "../../../lib/showingAccess.js";
import { dushanbeDateTimeString, dushanbeInputToDate } from "../../../lib/dushanbeTime.js";
import { actorFromAccess, type AssistantActor } from "../actor.js";
import type { AssistantWriteToolPlugin } from "./types.js";

/**
 * ОБЩЕЕ ДЛЯ ИНСТРУМЕНТОВ ГРУППЫ «ПОКАЗЫ И ЗАМЕТКИ» (П3, 31.10.2026).
 *
 * Исполнитель действия получает от брокера урезанного актора (`agentId`, `channel`,
 * `can`) — без роли и без флагов видимости клиентов. Права на запись в карточку
 * (`assertClientWritable`) и на показ (`lib/showingAccess.ts`) считаются по полному
 * `AssistantActor`, поэтому его собирает ТА ЖЕ функция, что и для чтения —
 * `actorFromAccess` из `loadAgentAccess`, как у `requireAuth`: права перечитываются на
 * каждом шаге, а не берутся из момента показа превью. Учётка отключена или удалена —
 * отказ, как у REST (401/403).
 */
export interface ToolActor {
  actor: AssistantActor;
  agentName: string;
}

export async function loadToolActor(actionActor: AssistantActionActor): Promise<ToolActor> {
  const [access, agent] = await Promise.all([
    loadAgentAccess(actionActor.agentId),
    prisma.agent.findUnique({ where: { id: actionActor.agentId }, select: { fullName: true } }),
  ]);
  if (!access || !agent || !access.isActive) {
    throw new AssistantActionError(403, "FORBIDDEN", "Учётная запись недоступна");
  }
  // Акционер только смотрит: REST закрывает ему любую запись в requireAuth.
  if (isReadOnlyRole(access.role)) {
    throw new AssistantActionError(403, "FORBIDDEN", "Режим только для чтения: это действие вам недоступно");
  }
  return { actor: actorFromAccess(actionActor.agentId, access), agentName: agent.fullName };
}

const WALL_CLOCK = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?$/;
const WITH_OFFSET = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/i;

/**
 * Время от МОДЕЛИ → момент (UTC). Без пояса — стенные часы Душанбе (`dushanbeInputToDate`,
 * та же ловушка, что в `parseModelDate` ассистента: голый `new Date()` сдвинул бы встречу
 * на пять часов); с явным поясом (`Z`, `+05:00`) — как есть. Время ОБЯЗАТЕЛЬНО: «полдень
 * по умолчанию» годится для задачи, но не для показа.
 */
export function parseShowingInstant(raw: unknown): Date | null {
  const text = String(raw ?? "").trim();
  if (WITH_OFFSET.test(text)) {
    const at = new Date(text.replace(" ", "T"));
    return Number.isNaN(at.getTime()) ? null : at;
  }
  const m = WALL_CLOCK.exec(text);
  if (!m) return null;
  const at = dushanbeInputToDate(m[1], m[2]);
  return Number.isNaN(at.getTime()) ? null : at;
}

export const BAD_TIME_MESSAGE = "Время не распознано: укажите дату и время по Душанбе, например «2026-11-02 18:00»";

/** Разобрать время аргумента или бросить понятный отказ (брокер отдаёт его модели как есть). */
export function requireShowingInstant(raw: unknown): string {
  const at = parseShowingInstant(raw);
  if (!at) throw new AssistantActionError(400, "BAD_TIME", BAD_TIME_MESSAGE);
  return at.toISOString();
}

/** «2026-11-02 18:00 (Душанбе)» — в превью время всегда по Душанбе, не по UTC. */
export function showingTimeText(at: Date | string): string {
  return `${dushanbeDateTimeString(new Date(at))} (Душанбе)`;
}

export const TIME_PARAM_DESCRIPTION =
  "Дата и время по Душанбе в формате «ГГГГ-ММ-ДД ЧЧ:ММ», например «2026-11-02 18:00». Относительные «завтра в шесть» сначала переведи в дату сам.";

/* ──────────── Показ, над которым действует сотрудник (перенос и отмена) ──────────── */

/** Тот, кто действует, — в виде, который принимает lib/showingAccess.ts (как `taskWriteSubject` в REST). */
export function taskWriteSubjectOf(actor: AssistantActor): TaskWriteSubject {
  return {
    id: actor.id,
    role: actor.role,
    canAssignClients: actor.canAssignClients,
    canReadInvestigations: canViewInvestigations(actor.role) && (actor.permissions?.has("clients.securityReview") ?? false),
  };
}

/**
 * Показ для переноса/отмены: права — ровно как у PATCH /interactions/:id/showing/*
 * (`showingActionAccess`: свой показ правит сам, чужой — руководство), затем те же
 * условия «показ ещё живой», что в `loadEditableShowing` сервиса. Ничего не пишет.
 */
export async function loadShowingForAction(actionActor: AssistantActionActor, interactionId: string) {
  const tool = await loadToolActor(actionActor);
  const ownAgentId = tool.actor.canViewAllClients ? undefined : tool.actor.id;
  const access = await showingActionAccess(taskWriteSubjectOf(tool.actor), interactionId, ownAgentId);
  if (!access.ok) throw new AssistantActionError(access.status, access.status === 404 ? "NOT_FOUND" : "FORBIDDEN", access.error);

  const showing = await prisma.interaction.findUnique({
    where: { id: interactionId },
    select: {
      id: true,
      type: true,
      clientId: true,
      agentId: true,
      subjectAgentId: true,
      propertyId: true,
      nextAction: true,
      nextActionDate: true,
      completedAt: true,
      taskCancelledAt: true,
      property: { select: { title: true } },
      client: { select: { id: true, fullName: true } },
    },
  });
  if (!showing) throw new AssistantActionError(404, "NOT_FOUND", "Запись не найдена");
  if (showing.type !== "SHOWING" || !showing.nextActionDate || !showing.client) {
    throw new AssistantActionError(409, "NOT_SHOWING", "Это не показ с назначенным временем");
  }
  if (!showing.nextAction || showing.completedAt || showing.taskCancelledAt) {
    throw new AssistantActionError(409, "ALREADY_CLOSED", "Показ уже отменён или отмечен выполненным");
  }
  return { ...tool, showing: { ...showing, client: showing.client, nextActionDate: showing.nextActionDate } };
}

/** Состояние показа для сравнения «было» перед исполнением и откатом. */
export function showingSnapshot(showing: {
  id: string;
  clientId: string | null;
  propertyId: string | null;
  nextActionDate: Date;
  agentId: string | null;
  subjectAgentId: string | null;
}) {
  return {
    interactionId: showing.id,
    clientId: showing.clientId,
    propertyId: showing.propertyId,
    at: showing.nextActionDate.toISOString(),
    agentId: showing.subjectAgentId ?? showing.agentId,
  };
}

/** Исход сервиса `*ShowingById` → ответ помощника (тексты и коды — как SHOWING_ERRORS в REST). */
export function showingByIdError(reason: string): AssistantActionError {
  switch (reason) {
    case "not_found":
      return new AssistantActionError(404, "NOT_FOUND", "Запись не найдена");
    case "not_showing":
      return new AssistantActionError(409, "NOT_SHOWING", "Это не показ с назначенным временем");
    case "already_cancelled":
    case "no_showing":
      return new AssistantActionError(409, "STALE", "Показ уже отменён или отмечен выполненным");
    case "past":
      return new AssistantActionError(400, "PAST", "Перенести показ можно только на будущее время");
    case "no_client":
      return new AssistantActionError(404, "NOT_FOUND", "Клиент не найден");
    default:
      return new AssistantActionError(409, "FAILED", "Не получилось выполнить действие с показом");
  }
}

/** Условная запись сервиса не нашла показ таким, каким его видел человек, — 409 STALE. */
export function staleShowingError(): AssistantActionError {
  return new AssistantActionError(409, "STALE", "Показ изменился после превью — проверьте ещё раз");
}

/**
 * Тип плагина (`types.ts`) держит исполнителя как `AssistantActionExecutor<never>`: реестр
 * хранит исполнителей разных инструментов вместе, и общий тип аргументов у них один — «никакой».
 * Сужение сделано здесь одним местом, а не приведением в каждом файле.
 */
export function asPluginExecutor<A>(executor: AssistantActionExecutor<A>): AssistantWriteToolPlugin["executor"] {
  return executor as unknown as AssistantWriteToolPlugin["executor"];
}
