import { isReadOnlyRole } from "@royal-home/shared";
import { READ_ONLY_ROLE_RESPONSE } from "../../../auth/middleware.js";
import { prisma } from "../../../db.js";
import { AssistantActionError, type AssistantActionActor } from "../../../lib/assistantActions.js";
import { resolvePropertyRef } from "../../../lib/propertyRef.js";
import type { ChangeRequestActor, ChangeRequestFailure } from "../../../lib/propertyChangeRequestService.js";

/**
 * ОБЩЕЕ ДЛЯ ИНСТРУМЕНТОВ ЗАПИСИ ПО ОБЪЕКТАМ (П3, группа «prop»).
 * Прав здесь не решается — только «кто это», «о каком объекте речь» и перевод
 * отказов сервисов в ошибки брокера. Сами правила — в `lib/*`, их зовёт и REST.
 */

/**
 * Кто нажимает: деактивированный сотрудник и роль «только просмотр» (акционер)
 * не пишут — как `requireAuth` на REST. Возвращает роль (нужна для «снять из
 * соцсетей»: право по роли, как у кнопки).
 */
export async function loadWriterRole(agentId: string): Promise<string> {
  const agent = await prisma.agent.findUnique({ where: { id: agentId }, select: { role: true, isActive: true } });
  if (!agent || !agent.isActive) throw new AssistantActionError(403, "FORBIDDEN", "Сотрудник не активен");
  if (isReadOnlyRole(agent.role)) throw new AssistantActionError(403, "READ_ONLY_ROLE", READ_ONLY_ROLE_RESPONSE.error);
  return agent.role;
}

export function changeActor(actor: AssistantActionActor): ChangeRequestActor {
  return { agentId: actor.agentId, can: actor.can };
}

/** Какой объект имелся в виду. Не нашли / несколько — отказ со списком кандидатов, выбирать за человека нельзя. */
export async function resolveRefOrThrow(ref: string): Promise<{ id: string; shortId: number }> {
  const found = await resolvePropertyRef(ref);
  if (found.ok) return found;
  throw new AssistantActionError(found.reason === "AMBIGUOUS" ? 409 : 404, `REF_${found.reason}`, found.message, {
    candidates: found.candidates.map((c) => ({
      id: c.id,
      shortId: c.shortId,
      title: plainField(c.title, 80),
      address: plainField(c.address, 80),
    })),
  });
}

/** Отказ сервиса заявок → ошибка брокера (код различает «устарело» и «уже отправлена»). */
export function failureToError(failure: ChangeRequestFailure): AssistantActionError {
  if (failure.code === "STALE") return new AssistantActionError(409, "STALE", failure.error, { stale: true });
  return new AssistantActionError(failure.status, failure.code ?? "REFUSED", failure.error);
}

/**
 * Свободный текст карточки (адрес, заголовок) в превью и ответе модели: одна
 * строка, без разметки и угловых скобок — введённое агентом не должно читаться
 * моделью как инструкция. Короткий потолок: это подпись, а не содержимое.
 */
export function plainField(value: string | null | undefined, max = 120): string | null {
  if (!value) return null;
  const cleaned = value.replace(/[\r\n\t]+/g, " ").replace(/[<>`]/g, "").replace(/\s{2,}/g, " ").trim();
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned || null;
}

/** Ссылка для интерфейса (карточка заявки/объекта рисуется по `href`). */
export const propertyHref = (shortId: number, query = "") => `/properties/${shortId}${query}`;
