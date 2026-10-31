/**
 * «ВЕРНУТЬ МОНТАЖЁРУ» ОТ ИМЕНИ СОТРУДНИКА — ОДНО ТЕЛО НА REST И НА ИИ-ПОМОЩНИКА
 * (31.10.2026, П3 «prop»).
 *
 * Тело `POST /properties/:id/send-back-to-montajer` (routes/properties/videos.ts)
 * вынесено сюда без изменения поведения: те же проверки в том же порядке (404 →
 * 403 «не ваш» → 403 «после публикации — руководству» → 403 «снятие из соцсетей
 * только маркетингу»), тот же `sendBackToMontajer`, то же закрытие проверки ролика
 * у модераторов и та же запись в журнал. ИИ-помощник (инструмент `send_to_remake`)
 * зовёт ровно эту функцию, поэтому его права не могут разойтись с кнопкой в карточке.
 *
 * Тело запроса уже разобрано `sendBackToMontajerSchema` вызывающим.
 */
import type { PermissionId, SendBackToMontajerInput } from "@royal-home/shared";
import { prisma } from "../db.js";
import { logAgentAudit } from "./audit.js";
import { afterClipRejected, type ClipReviewSource } from "./clipReview.js";
import { hasMarketingRole } from "./marketingRole.js";
import { canManagePropertyAs, publishedActionDeniedReasonAs } from "./propertyAccess.js";
import { sendBackToMontajer, type SendBackResult } from "./publishedVideoFix.js";

export interface SendBackActor {
  agentId: string;
  /** Роль сотрудника: право «снять из соцсетей» — по роли, как у кнопки «Убрать из соцсетей». */
  role: string | undefined;
  can: (permission: PermissionId) => boolean;
}

export type SendBackAsResult =
  | { ok: true; result: Extract<SendBackResult, { ok: true }> }
  | { ok: false; status: 403 | 404 | 409; error: string; stale?: true };

/**
 * Права на возврат, без записи: тем же набором условий, что в обработчике. Нужна
 * помощнику на этапе превью («вам это недоступно» ДО карточки подтверждения).
 */
export function sendBackDenied(
  actor: SendBackActor,
  property: { status: string; offSite?: boolean | null; assignedAgentId?: string | null; intakeAgentId?: string | null; createdById?: string | null },
  removeFromSocial: boolean | undefined
): { status: 403; error: string } | null {
  if (!canManagePropertyAs(actor, property)) return { status: 403, error: "Недостаточно прав" };
  const published = publishedActionDeniedReasonAs(actor, property);
  if (published) return { status: 403, error: published };
  // Право на removeFromSocial:true — то же, что у кнопки «Убрать из соцсетей»
  // (requireMarketingRole): снятие вышедшего поста видно подписчикам так же, как
  // публикация, и отменить его нельзя. Молча игнорировать поле нельзя — человек
  // решил бы, что «убрали», когда не убирали.
  if (removeFromSocial && !hasMarketingRole(actor.role)) return { status: 403, error: "Недостаточно прав" };
  return null;
}

export async function sendPropertyBackToMontajerAs(input: {
  propertyId: string;
  actor: SendBackActor;
  body: SendBackToMontajerInput;
  /** Откуда нажали: уходит в журнал решения по ролику на проверке. */
  source: ClipReviewSource;
  guard?: { videoRemakeCount: number };
  /** Только проверки (права + отказы функции), без записи: для превью помощника. */
  dryRun?: boolean;
  auditSource?: Record<string, unknown>;
}): Promise<SendBackAsResult> {
  const { actor, body } = input;
  const property = await prisma.property.findUnique({ where: { id: input.propertyId } });
  if (!property) return { ok: false, status: 404, error: "Объект не найден" };
  const denied = sendBackDenied(actor, property, body.removeFromSocial);
  if (denied) return { ok: false, ...denied };

  // Замена исходника стирает старые ролики — право то же, что у DELETE
  // /:id/videos/:videoId (canManageProperty), он уже проверен выше.
  const result = await sendBackToMontajer(
    property.id,
    actor.agentId,
    body.reason,
    body.comment ?? null,
    body.replaceVideoIds ?? null,
    { removeFromSocial: body.removeFromSocial, ...(input.guard ? { guard: input.guard } : {}), ...(input.dryRun ? { dryRun: true } : {}) }
  );
  if (!result.ok) return { ok: false, status: 409, error: result.error, ...(result.stale ? { stale: true as const } : {}) };
  if (input.dryRun) return { ok: true, result };

  // Ролик ждал проверки модератора — этот возврат и есть решение по нему
  // (25.09.2026, lib/clipReview.ts): журнал и кнопки у модераторов в Telegram.
  if (result.clipReviewWasPending) {
    afterClipRejected({
      propertyId: property.id,
      shortId: property.shortId,
      byId: actor.agentId,
      source: input.source,
      reason: body.reason,
      comment: body.comment ?? null,
    });
  }
  logAgentAudit(actor.agentId, "PROPERTY_SENT_BACK_TO_MONTAJER", "Property", property.id, {
    shortId: property.shortId,
    queued: result.queued,
    reason: body.reason,
    replacedSource: !!body.replaceVideoIds?.length,
    socialRemoved: result.social?.removed ?? undefined,
    ...(input.auditSource ?? {}),
  });
  return { ok: true, result };
}
