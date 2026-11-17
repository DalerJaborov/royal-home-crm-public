/**
 * «ГОТОВО» У МОНТАЖЁРА — ОДНА ДВЕРЬ (17.11.2026, класс «ответила — не сделала»).
 *
 * Тело `POST /properties/:id/complete-editing` жило внутри маршрута, и второй путь
 * (ИИ-помощник Шабнам) выйти из монтажа в продажу не мог: статус `EDITING → AVAILABLE`
 * через `change_property_status` намеренно закрыт (lib/propertyStatusChange.ts, ролик, сайт
 * и очередь монтажёра идут только этим путём). Живой случай 17.11: объект ОБ-000193 стоял на
 * «Монтаж» без ссылки на ролик в Instagram, помощница не знала причины и предлагала заявку
 * «сменить статус». Теперь маршрут и инструмент `complete_property_editing` зовут одну функцию.
 *
 * Спецификация владельца, Этап 7/9: «Готово» завершает подготовку объекта; ответственность
 * со всех снимается сама (роль по статусу, а не отдельное поле), место в лимите агента
 * освобождается самим фактом смены статуса (лимит считает живым запросом), объект
 * публикуется на сайте синхронно и честно: отказ сайта виден ответственному (207), а не
 * спрятан в журнале (lib/propertyPipeline.ts::publishAfterEditingComplete).
 *
 * Перевод статуса условный (`updateMany` по `status = EDITING`), как в
 * `finalizePropertyAvailability` (lib/videoHandoff.ts): два одновременных нажатия — одна
 * публикация, второе получает «уже не на монтаже» без побочных действий.
 */
import type { Request } from "express";
import { MIN_PROPERTY_PHOTOS, type PermissionId } from "@royal-home/shared";
import type { Prisma } from "../generated/prisma/client.js";
import { prisma } from "../db.js";
import { publishPropertyUpdated } from "./livePublish.js";
import { canManagePropertyAs } from "./propertyAccess.js";
import { blockersForSale, publishAfterEditingComplete, saleBlockerCodes, type PublishAuditAuthor } from "./propertyPipeline.js";
import { skipVideoHandoffOnManualPublish } from "./videoHandoff.js";
import { describeError } from "./describeError.js";
import { logSystemError } from "./systemError.js";

export interface CompleteEditingActor {
  agentId: string;
  can: (permission: PermissionId) => boolean;
}

export type CompleteEditingFailure = {
  ok: false;
  status: 403 | 404 | 409;
  code: "NOT_FOUND" | "FORBIDDEN" | "NOT_EDITING" | "NOT_READY";
  error: string;
  /** Только у NOT_READY: чего не хватает (тексты `blockersForSale`). */
  blockers?: string[];
};

const EDITING_INCLUDE = { district: true, photos: { orderBy: { order: "asc" } } } satisfies Prisma.PropertyInclude;

export type CompleteEditingOutcome =
  | {
      ok: true;
      /** Объект после публикации (то, что отдаёт `presentProperty`). */
      property: Awaited<ReturnType<typeof publishAfterEditingComplete>>["updated"];
      /** Объект уже в продаже в CRM, но сайт его не принял — ответственный должен это знать. */
      siteSyncError?: string;
    }
  | CompleteEditingFailure;

export const NOT_EDITING_MESSAGE = "Кнопка «Готово» доступна только на этапе «Монтаж»";

/** Минимум полей объекта для проверок «Готово» (без загрузки фото — только их число). */
export interface CompleteEditingCandidate {
  status: string;
  deletedAt: Date | null;
  assignedAgentId?: string | null;
  intakeAgentId?: string | null;
  createdById?: string | null;
  instagramUrl: string | null;
  photoCount: number;
}

/**
 * Проверки без записи — для превью помощника и для самой двери. Порядок ответов прежний:
 * не найден → не ваш объект → не на «Монтаже» → не готов к продаже.
 */
export function checkCompleteEditing(
  property: CompleteEditingCandidate | null,
  actor: CompleteEditingActor,
): CompleteEditingFailure | null {
  if (!property || property.deletedAt) return { ok: false, status: 404, code: "NOT_FOUND", error: "Объект не найден" };
  if (!canManagePropertyAs(actor, property)) {
    return { ok: false, status: 403, code: "FORBIDDEN", error: "Недостаточно прав" };
  }
  if (property.status !== "EDITING") return { ok: false, status: 409, code: "NOT_EDITING", error: NOT_EDITING_MESSAGE };
  const blockers = blockersForSale({ instagramUrl: property.instagramUrl, photoCount: property.photoCount });
  if (blockers.length > 0) {
    return { ok: false, status: 409, code: "NOT_READY", error: `Объект не готов: ${blockers.join(", ")}`, blockers };
  }
  return null;
}

export interface SaleBlockerAdvice {
  /** Что не так — человеческими словами. */
  problem: string;
  /** Что сделать, чтобы объект вышел в продажу. */
  fix: string;
}

/**
 * Причины, почему объект не выходит в продажу, и что делать — словами для сотрудника.
 * Условия не повторяются: коды причин отдаёт `saleBlockerCodes` (lib/propertyPipeline.ts) — тот же
 * источник, что у текстов экрана (`blockersForSale`).
 */
export function saleBlockerAdvice(property: { instagramUrl: string | null; photoCount: number }): SaleBlockerAdvice[] {
  return saleBlockerCodes(property).map((code): SaleBlockerAdvice => {
    switch (code) {
      case "PHOTOS_BELOW_MIN":
        return {
          problem: `фото меньше минимума (${property.photoCount} из ${MIN_PROPERTY_PHOTOS})`,
          fix: `Добавьте фото в карточке объекта: нужно минимум ${MIN_PROPERTY_PHOTOS}.`,
        };
      case "NO_INSTAGRAM_LINK":
        return {
          problem: "нет ссылки на видео-обзор в Instagram — ролик не опубликован в Instagram",
          fix:
            "Опубликуйте ролик в Instagram (после принятия готового ролика это делает публикация по расписанию) " +
            "или впишите ссылку на уже опубликованный ролик в карточке объекта; как только ссылка есть, объект выйдет в продажу.",
        };
      case "LINK_NOT_INSTAGRAM":
        return {
          problem: "в поле видео-обзора ссылка не на Instagram",
          fix: "Замените её в карточке на ссылку на ролик в Instagram: обзор должен быть опубликован именно там.",
        };
    }
  });
}

/**
 * Нажать «Готово»: проверки → условный перевод в AVAILABLE → публикация (журнал, пуш
 * ответственному, автоподбор, сайт) → закрытие передачи монтажёру → событие в живую ленту.
 *
 * @param audit кто записан автором в журнале: HTTP-запрос (экран CRM) либо сотрудник без запроса
 *   (ИИ-помощник; в `meta` — источник и id действия).
 */
export async function completeEditing(input: {
  propertyId: string;
  actor: CompleteEditingActor;
  audit: Request | PublishAuditAuthor;
}): Promise<CompleteEditingOutcome> {
  const property = await prisma.property.findUnique({ where: { id: input.propertyId }, include: EDITING_INCLUDE });
  const failure = checkCompleteEditing(property && { ...property, photoCount: property.photos.length }, input.actor);
  if (failure) return failure;

  // Условный перевод: выигрывает тот, кто первым сменил статус; второй выходит без публикации.
  const moved = await prisma.property.updateMany({
    where: { id: input.propertyId, deletedAt: null, status: "EDITING" },
    data: { status: "AVAILABLE", stageEnteredAt: new Date() },
  });
  if (moved.count === 0) return { ok: false, status: 409, code: "NOT_EDITING", error: NOT_EDITING_MESSAGE };
  const updated = await prisma.property.findUniqueOrThrow({
    where: { id: input.propertyId },
    include: EDITING_INCLUDE,
  });

  // Статус уже AVAILABLE: исключение публикации не должно превращаться в «ошибку» — объект в продаже.
  // Сбой уходит в журнал и в итог как siteSyncError (инструмент ответит «изменено, но не всё», маршрут — 207).
  let published: Awaited<ReturnType<typeof publishAfterEditingComplete>>["updated"] = updated;
  let siteSyncError: string | undefined;
  try {
    ({ updated: published, siteSyncError } = await publishAfterEditingComplete(input.audit, updated));
  } catch (err) {
    const reason = describeError(err);
    void logSystemError("api", `Объект ${updated.id}: публикация после «Готово» упала — ${reason}`, { url: `/properties/${updated.id}` });
    siteSyncError = "Объект уже в продаже, но публикация на сайте не прошла";
  }
  // Защита от навсегда занятого места монтажёра: ручной выход из монтажа закрывает передачу ролика.
  void skipVideoHandoffOnManualPublish(published.id).catch((err) =>
    console.error("[video-handoff] закрытие хендоффа при «Готово»:", err),
  );
  publishPropertyUpdated({
    propertyId: published.id,
    agentId: published.assignedAgentId,
    stage: published.status,
    actorId: input.actor.agentId,
  });
  return { ok: true, property: published, ...(siteSyncError ? { siteSyncError } : {}) };
}
