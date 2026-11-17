/**
 * СМЕНА СТАТУСА ОБЪЕКТА — ОДНА ДВЕРЬ (17.11.2026, класс «ответила — не сделала»).
 *
 * Живой случай 17.11: сотрудник просит Шабнам «верни объект в продажу», инструмент подаёт
 * заявку «Другое», директор жмёт «Принять» — и CRM ставит «Принято к сведению», ничего не
 * меняя. Правила и последствия смены статуса жили только внутри `PATCH /properties/:id`
 * (routes/properties/crud.ts), и второй путь (помощник, исполнитель заявок) повторить их
 * не мог. Теперь здесь:
 *
 *  - `propertyStatusChangeBlock` — проверки ручной смены статуса в порядке карточки
 *    (открытая сделка → таблица переходов → «Резерв»/«Продано» ставит сделка → шаг
 *    маркетинга → готовность к продаже → закрытая сделка). PATCH зовёт её в том же месте;
 *  - `recordStatusRemovalInTx` — причина снятия в той же транзакции, что и запись статуса;
 *  - `runPropertyStatusEffects` — всё, что следует за сменой статуса: журнал, пуши
 *    конвейера, автоподбор, карточка продавца, монтаж, фото-посты, сайт;
 *  - `changePropertyStatus` — смена ТОЛЬКО статуса для тех, у кого нет формы карточки:
 *    ИИ-помощник (свой объект — сразу) и исполнитель заявки руководителю
 *    (routes/properties/changeRequestExecutor.ts). Права — те же, что у PATCH:
 *    `canManagePropertyAs` + проверки выше по правам того, кто нажимает.
 *
 * Чего дверь НЕ делает: выход из монтажа в продажу (EDITING → AVAILABLE) — это кнопка
 * «Готово» у монтажёра (publishAfterEditingComplete: ролик, сайт, место в очереди);
 * без неё объект ушёл бы в продажу мимо этого пути. Отказ называет кнопку.
 */
import {
  PROPERTY_DELETE_REQUEST_REASONS,
  propertyRemovalSchema,
  requiresPropertyModeration,
  type PermissionId,
  type PropertyRemovalInput,
  type PropertyStatus,
} from "@royal-home/shared";
import { z } from "zod";
import type { Prisma } from "../generated/prisma/client.js";
import { prisma, type PropertyRecord, type TxClient } from "../db.js";
import { logAgentAudit } from "./audit.js";
import { describeError } from "./describeError.js";
import { publishPropertyUpdated } from "./livePublish.js";
import { canManagePropertyAs } from "./propertyAccess.js";
import { PROPERTY_STATUS_LABEL_RU } from "./propertyAutoStatus.js";
import { closeWorkAfterLeavingSale } from "./propertyLeftSale.js";
import { notifyWaitingBuyersOfNewProperty } from "./propertyMatchFilter.js";
import {
  closeEditingPush,
  closePendingReviewPush,
  isPipelineStatus,
  notifyEditingStarted,
  notifyPendingReview,
} from "./propertyPipeline.js";
import { recordPropertyRemoval } from "./propertyRemovalEvidence.js";
import {
  PROPERTY_MODERATION_REQUIRED_MESSAGE,
  completedDealRevertBlock,
  manualStatusChangeBlock,
  saleReadinessBlock,
} from "./propertyStatusDealGuards.js";
import type { TransitionBlock } from "./propertyStatusTransitions.js";
import { runPostUpdateEffects } from "./propertyUpdateEffects.js";
import { recomputeSellerCardState } from "./sellerCardState.js";
import { syncPropertiesToSite } from "./siteSync.js";
import { logSystemError } from "./systemError.js";
import { closeVideoHandoff } from "./videoHandoff.js";

/**
 * Проверки ручной смены статуса — тело бывшего блока `PATCH /properties/:id` без
 * изменений порядка и текстов. `instagramUrl` — ссылка на ролик, если форма меняет её в
 * том же запросе (иначе берётся из базы). null — переход допустим.
 */
export async function propertyStatusChangeBlock(
  existing: { id: string; status: PropertyStatus; instagramUrl: string | null },
  to: PropertyStatus,
  opts: { canModerate: boolean; instagramUrl?: string | null },
): Promise<TransitionBlock | null> {
  if (to !== existing.status) {
    const block = await manualStatusChangeBlock(existing, to, opts.canModerate);
    if (block) return block;
  }
  if (requiresPropertyModeration(existing.status, to) && !opts.canModerate) {
    return { status: 403, error: PROPERTY_MODERATION_REQUIRED_MESSAGE };
  }
  if (to === "AVAILABLE" && (isPipelineStatus(existing.status) || existing.status === "WITHDRAWN")) {
    const instagramUrl = opts.instagramUrl === undefined ? existing.instagramUrl : opts.instagramUrl;
    const notReady = await saleReadinessBlock(existing, instagramUrl);
    if (notReady) return notReady;
  }
  return completedDealRevertBlock(existing, to);
}

/** Что значит переход для последствий (те же условия, что были в PATCH). */
export interface StatusTransitionFlags {
  changed: boolean;
  becameSold: boolean;
  becameUnsold: boolean;
  becameWithdrawn: boolean;
  becameReserved: boolean;
  enteredPipeline: boolean;
}

export function statusTransitionFlags(from: PropertyStatus, to: PropertyStatus | undefined): StatusTransitionFlags {
  return {
    changed: to !== undefined && to !== from,
    becameSold: to === "SOLD" && from !== "SOLD",
    becameUnsold: to !== undefined && to !== "SOLD" && from === "SOLD",
    becameWithdrawn: to === "WITHDRAWN" && from !== "WITHDRAWN",
    becameReserved: to === "RESERVED" && from !== "RESERVED",
    enteredPipeline: to !== undefined && isPipelineStatus(to) && from === "AVAILABLE",
  };
}

/** Причина снятия — в той же транзакции, что запись статуса (PATCH и дверь ниже). */
export async function recordStatusRemovalInTx(
  tx: TxClient,
  input: {
    propertyId: string;
    from: PropertyStatus;
    to: PropertyStatus | undefined;
    removal: PropertyRemovalInput;
    actorId: string;
  },
): Promise<void> {
  if (input.to !== "WITHDRAWN" || input.from === "WITHDRAWN") return;
  await recordPropertyRemoval(tx, { ...input.removal, propertyId: input.propertyId, actorId: input.actorId, operation: "withdraw" });
}

/**
 * Последствия смены статуса — после записи, вне транзакции. Ничего не бросает наружу,
 * кроме пересчёта карточки продавца (его PATCH ждал и раньше). Возвращает признаки
 * перехода: вызывающему они нужны, чтобы не досылать на сайт то, что досылает статус.
 */
export async function runPropertyStatusEffects(input: {
  actorId: string;
  before: PropertyRecord;
  updated: PropertyRecord;
  to: PropertyStatus | undefined;
  removalReason?: string | null;
  /** PATCH: объект вышел из монтажа путём «Готово» — автоподбор зовёт publishAfterEditingComplete. */
  autoPublished?: boolean;
  /** Добавка к записи журнала (источник: помощник, заявка). */
  auditMeta?: Record<string, unknown>;
}): Promise<StatusTransitionFlags> {
  const { before: existing, updated, to } = input;
  const flags = statusTransitionFlags(existing.status, to);
  if (!flags.changed || to === undefined) return flags;

  // ИСТОРИЯ ОБЪЕКТА: каждая смена статуса — в журнал действий (спецификация владельца).
  logAgentAudit(input.actorId, "PROPERTY_STATUS_CHANGED", "Property", existing.id, {
    was: existing.status,
    becomes: to,
    ...(input.auditMeta ?? {}),
  } as Prisma.InputJsonValue);

  // Пуш тем, кому статус адресует объект — ровно один раз за смену.
  if (to === "PENDING_REVIEW") {
    void notifyPendingReview(updated.id, updated.shortId, updated.title).catch((err) =>
      console.error("[push] объект на проверку:", err)
    );
  }
  if (to === "EDITING") {
    void notifyEditingStarted(updated.id, updated.shortId, updated.title).catch((err) =>
      console.error("[push] объект передан в монтаж:", err)
    );
  }
  // Объект ушёл из PENDING_REVIEW/EDITING не кнопками конвейера — гасим пуш остальным.
  if (existing.status === "PENDING_REVIEW") {
    void closePendingReviewPush(existing.id).catch((err) => console.error("[push] закрытие «на проверке»:", err));
  }
  if (existing.status === "EDITING") {
    void closeEditingPush(existing.id).catch((err) => console.error("[push] закрытие «в монтаже»:", err));
  }
  // Объект встал в продажу напрямую (не «Готово»: у того пути свой такой же хук).
  if (to === "AVAILABLE" && !input.autoPublished) {
    void notifyWaitingBuyersOfNewProperty(updated).catch((err) =>
      console.error("[автоподбор] объект переведён в продажу:", err instanceof Error ? err.message : err)
    );
  }

  if (flags.becameWithdrawn && updated.sellerClientId) {
    // Производные данные: сбой пересчёта не должен съесть остальное — в PATCH после этого шага
    // идут запись «было → стало» и уведомление о правке (раньше пересчёт стоял ПОСЛЕ них).
    try {
      await recomputeSellerCardState({ sellerClientId: updated.sellerClientId, lostReason: input.removalReason ?? null });
    } catch (err) {
      void logSystemError("api", `Объект ${updated.id}: пересчёт карточки продавца после снятия не удался: ${describeError(err)}`, {
        url: `/properties/${updated.id}`,
      });
    }
  }

  // Возврат из монтажа на доработку: монтажёр получает «сняли с монтажа», место освобождается.
  if (existing.status === "EDITING" && to !== "EDITING" && isPipelineStatus(to)) {
    void closeVideoHandoff(updated.id, { holdQueue: false, reason: "возвращён на доработку" }).catch((err) =>
      void logSystemError(
        "video-handoff",
        `Объект ${updated.id}: закрытие монтажа при возврате на доработку не удалось: ${describeError(err)}`
      )
    );
  }

  if (flags.becameSold || flags.becameWithdrawn || flags.becameReserved) {
    // Монтаж, фото-посты, повторы и будущие показы — одной общей функцией (lib/propertyLeftSale.ts).
    closeWorkAfterLeavingSale(updated.id, flags.becameSold ? "sold" : flags.becameWithdrawn ? "withdrawn" : "reserved");
  }

  // Сайт следует за статусом: «Продано» — бейдж, возврат — снять бейдж, снятие и
  // возврат в подготовку — объявление убирается.
  if (existing.publishedOnSite && (flags.becameSold || flags.becameUnsold || flags.becameWithdrawn || flags.enteredPipeline)) {
    const withRelations = await prisma.property.findUnique({
      where: { id: updated.id },
      include: { district: true, photos: { orderBy: { order: "asc" } } },
    });
    if (withRelations) {
      // Снятие сильнее возврата из «Продано»: SOLD → WITHDRAWN убирает объявление.
      const action = flags.becameWithdrawn || flags.enteredPipeline ? "unpublish" : flags.becameSold ? "sold" : "unsold";
      void syncPropertiesToSite([withRelations], action)
        .then((result) => {
          const problem = !result.ok ? result.error : result.results.find((r) => !r.ok)?.error;
          if (!problem) {
            // Объявления на сайте больше нет — снимаем отметку, иначе кнопка «Опубликовать на сайт»
            // не появится тому, кто вернёт объект в продажу.
            if (action === "unpublish") {
              return prisma.property
                .update({ where: { id: updated.id }, data: { publishedOnSite: false } })
                .then(() => undefined);
            }
            return;
          }
          console.error(`[siteSync] Статус объекта ${updated.id} не дошёл до сайта: ${problem}`);
          void logSystemError("site-sync", `Статус объекта ${updated.id} не дошёл до сайта: ${problem}`, {
            url: `/properties/${updated.id}`,
          });
        })
        .catch((err) => {
          const reason = err instanceof Error ? err.message : String(err);
          console.error(`[siteSync] Статус объекта ${updated.id}:`, reason);
          void logSystemError("site-sync", `Статус объекта ${updated.id} — ошибка синхронизации: ${reason}`, {
            url: `/properties/${updated.id}`,
          });
        });
    }
  }
  return flags;
}

export interface PropertyStatusActor {
  agentId: string;
  can: (permission: PermissionId) => boolean;
}

export type PropertyStatusChangeFailure = {
  ok: false;
  status: 400 | 403 | 404 | 409;
  error: string;
  code: "NOT_FOUND" | "FORBIDDEN" | "NO_CHANGE" | "BAD_ARGS" | "EDITING_USE_DONE" | "STATUS_BLOCKED" | "STALE";
};

export type PropertyStatusChangeOutcome =
  | { ok: true; before: PropertyRecord; property: PropertyRecord }
  | PropertyStatusChangeFailure;

export const EDITING_TO_SALE_MESSAGE =
  "Объект на монтаже: в продажу его выводит кнопка «Готово» в карточке (ролик, сайт и очередь монтажёра идут этим путём).";

/**
 * Проверки смены статуса без записи — для превью помощника и для самой двери.
 * Порядок ответов как у PATCH: 403 (не ваш объект) → проверки статуса.
 */
export async function checkPropertyStatusChange(
  property: PropertyRecord,
  actor: PropertyStatusActor,
  to: PropertyStatus,
  removal?: PropertyRemovalInput | null,
): Promise<PropertyStatusChangeFailure | null> {
  if (!canManagePropertyAs(actor, property)) {
    return { ok: false, status: 403, code: "FORBIDDEN", error: "Недостаточно прав: статус меняет тот, кто ведёт объект, или руководитель." };
  }
  if (property.status === to) {
    return { ok: false, status: 400, code: "NO_CHANGE", error: `Объект уже в статусе «${PROPERTY_STATUS_LABEL_RU[to]}».` };
  }
  if (property.status === "EDITING" && to === "AVAILABLE") {
    return { ok: false, status: 409, code: "EDITING_USE_DONE", error: EDITING_TO_SALE_MESSAGE };
  }
  if (removal) {
    const parsed = propertyRemovalSchema.safeParse(removal);
    if (!parsed.success) {
      return { ok: false, status: 400, code: "BAD_ARGS", error: parsed.error.issues[0]?.message ?? "Неверная причина снятия" };
    }
  }
  const block = await propertyStatusChangeBlock(property, to, { canModerate: actor.can("properties.moderate") });
  if (block) return { ok: false, status: block.status, code: "STATUS_BLOCKED", error: block.error };
  return null;
}

/**
 * Сменить статус объекта — для путей без формы карточки (помощник, исполнитель заявки).
 * Запись условна по прежнему статусу (и версии, если её видел человек): параллельная правка
 * между проверкой и записью даёт STALE, а не затирание. Последствия — те же, что у PATCH.
 */
export async function changePropertyStatus(input: {
  propertyId: string;
  actor: PropertyStatusActor;
  to: PropertyStatus;
  removal?: PropertyRemovalInput | null;
  /** Что видел человек в превью: другой статус или версия — STALE. */
  expect?: { status: string; version?: number };
  auditMeta?: Record<string, unknown>;
}): Promise<PropertyStatusChangeOutcome> {
  const existing = await prisma.property.findUnique({ where: { id: input.propertyId } });
  if (!existing || existing.deletedAt) return { ok: false, status: 404, code: "NOT_FOUND", error: "Объект не найден" };
  const stale: PropertyStatusChangeFailure = {
    ok: false,
    status: 409,
    code: "STALE",
    error: "Объект изменился после показа превью — проверьте ещё раз",
  };
  if (
    input.expect &&
    (existing.status !== input.expect.status ||
      (input.expect.version !== undefined && existing.version !== input.expect.version))
  ) {
    return stale;
  }
  const failure = await checkPropertyStatusChange(existing, input.actor, input.to, input.removal);
  if (failure) return failure;

  const removal: PropertyRemovalInput = input.removal ?? {};
  const updated = await prisma.$transaction(async (tx) => {
    const written = await tx.property.updateMany({
      where: {
        id: existing.id,
        status: existing.status,
        deletedAt: null,
        ...(input.expect?.version !== undefined ? { version: input.expect.version } : {}),
      },
      // Отметку этапа двигаем при смене статуса — как PATCH.
      data: { status: input.to, stageEnteredAt: new Date(), version: { increment: 1 } },
    });
    if (written.count === 0) return null;
    await recordStatusRemovalInTx(tx, {
      propertyId: existing.id,
      from: existing.status,
      to: input.to,
      removal,
      actorId: input.actor.agentId,
    });
    return tx.property.findUniqueOrThrow({ where: { id: existing.id } });
  });
  if (!updated) return stale;

  const flags = await runPropertyStatusEffects({
    actorId: input.actor.agentId,
    before: existing,
    updated,
    to: input.to,
    removalReason: removal.removalReason ?? null,
    auditMeta: input.auditMeta,
  });
  await runPostUpdateEffects({
    existing,
    updated,
    changedFields: ["status"],
    priceActuallyChanged: false,
    staysAvailable: input.to === "AVAILABLE",
    resyncSite:
      existing.publishedOnSite && !flags.becameSold && !flags.becameUnsold && !flags.becameWithdrawn && !flags.enteredPipeline,
    resyncReason: "смена статуса",
    awaitPriceSync: false,
  });
  publishPropertyUpdated({ propertyId: updated.id, agentId: updated.assignedAgentId, stage: updated.status, actorId: input.actor.agentId });
  return { ok: true, before: existing, property: updated };
}

/**
 * Заявка руководителю на смену статуса — поле `statusChange` в теле заявки «Другое»
 * (своего вида у статуса нет; новое значение enum в базе и в экранах заявок — риск больше).
 * Кладёт его только помощник: REST-схема заявки (`otherPayloadSchema`) лишние поля
 * отбрасывает, так что вручную такую заявку не подделать. Исполнитель заявки при «Принять»
 * зовёт `changePropertyStatus` правами того, кто принял.
 */
export const statusChangeRequestSchema = z.object({
  statusChange: z.object({
    to: z.enum(["AVAILABLE", "RESERVED", "SOLD", "WITHDRAWN"]),
    /**
     * Статус объекта на момент подачи заявки. При «Принять» объект обязан быть в нём же, иначе
     * заявка устарела (17.11.2026). У заявок, лежавших в базе до этого поля, его нет — их тоже
     * вслепую не исполняем.
     */
    from: z.string().trim().min(1).max(40).optional(),
    // Те же поля, что propertyRemovalSchema; полная проверка — в двери (checkPropertyStatusChange).
    removalReason: z.enum(PROPERTY_DELETE_REQUEST_REASONS).optional(),
    removalComment: z.string().trim().max(1000).optional(),
  }),
});
export type StatusChangeRequest = z.infer<typeof statusChangeRequestSchema>["statusChange"];

export function readStatusChangeRequest(payload: unknown): StatusChangeRequest | null {
  const parsed = statusChangeRequestSchema.safeParse(payload);
  return parsed.success ? parsed.data.statusChange : null;
}
