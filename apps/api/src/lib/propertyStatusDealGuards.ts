import type { PropertyStatus } from "@royal-home/shared";
import { prisma } from "../db.js";
import { blockersForSale } from "./propertyPipeline.js";
import {
  dealStageForManualStatus,
  propertyStatusTransitionBlock,
  type TransitionBlock,
} from "./propertyStatusTransitions.js";

/**
 * ПРОВЕРКИ РУЧНОЙ СМЕНЫ СТАТУСА ОБЪЕКТА, КОТОРЫМ НУЖНА БАЗА (31.10.2026, П3 «prop»).
 *
 * Раньше сидели прямо в `PATCH /properties/:id` (routes/properties/crud.ts) —
 * между «открытая сделка» и «переходы по таблице». ИИ-помощник готовит заявку на
 * смену статуса и обязан отказывать ровно теми же словами, что и карточка, поэтому
 * тело вынесено сюда, а PATCH зовёт эту же функцию в том же месте и порядке.
 * Чистая табличная часть (без базы) по-прежнему в `propertyStatusTransitions.ts`.
 */

/**
 * «Продано»/«Снято» вручную с открытой сделкой — рассинхронизация: объект уходит из
 * продажи, а сделка остаётся висеть на CONTRACT_SIGNED/NEGOTIATION/... и никогда не
 * попадёт в завершённые/отменённые (и в комиссию). Правильный путь — завершить или
 * отменить саму сделку, она сама переставит статус объекта.
 *
 * RESERVED → AVAILABLE — тот же случай (глубокая проверка 02.10.2026, D11): резерв
 * держит живая сделка, снятый руками он выставлял объект «в продажу» второму
 * покупателю, а сделка первого висела.
 */
async function openDealBlock(
  existing: { id: string; status: PropertyStatus },
  to: PropertyStatus
): Promise<TransitionBlock | null> {
  if (to === existing.status) return null;
  if (!(["SOLD", "WITHDRAWN"].includes(to) || (existing.status === "RESERVED" && to === "AVAILABLE"))) return null;
  const activeDeal = await prisma.deal.findFirst({
    where: { propertyId: existing.id, stage: { notIn: ["COMPLETED", "CANCELLED"] } },
    select: { id: true },
  });
  if (!activeDeal) return null;
  return {
    status: 409,
    error: "У объекта есть открытая сделка — завершите или отмените её, статус объекта обновится сам",
  };
}

/**
 * Весь блок проверок смены статуса вручную в порядке карточки: открытая сделка →
 * таблица переходов (с правом маркетинга на шаг конвейера) → «Резерв»/«Продано»
 * ставит сделка, руками — только если она под этим статусом уже есть.
 */
export async function manualStatusChangeBlock(
  existing: { id: string; status: PropertyStatus },
  to: PropertyStatus,
  canModerate: boolean
): Promise<TransitionBlock | null> {
  if (to === existing.status) return null;
  const open = await openDealBlock(existing, to);
  if (open) return open;
  const block = propertyStatusTransitionBlock(existing.status, to, canModerate);
  if (block) return block;
  const dealNeeded = dealStageForManualStatus(to);
  if (dealNeeded) {
    const deal = await prisma.deal.findFirst({
      where: {
        propertyId: existing.id,
        ...(dealNeeded === "SOLD" ? { stage: "COMPLETED" } : { stage: { notIn: ["COMPLETED", "CANCELLED"] } }),
      },
      select: { id: true },
    });
    if (!deal) {
      return {
        status: 409,
        error: "Резерв и продажу оформляет сделка: заведите её, статус объекта обновится сам.",
      };
    }
  }
  return null;
}

/**
 * Обратный переход из SOLD запрещён, если по объекту уже есть ЗАКРЫТАЯ сделка.
 * Иначе объект возвращался в продажу, по нему заводилась вторая сделка, её тоже
 * закрывали — и комиссия по одному и тому же объекту попадала в отчёты дважды.
 */
export async function completedDealRevertBlock(
  existing: { id: string; status: PropertyStatus },
  to: PropertyStatus
): Promise<TransitionBlock | null> {
  if (existing.status !== "SOLD" || to === "SOLD") return null;
  const completed = await prisma.deal.count({ where: { propertyId: existing.id, stage: "COMPLETED" } });
  if (completed === 0) return null;
  return {
    status: 409,
    error:
      "Объект продан по закрытой сделке — вернуть его в продажу нельзя. " +
      "Если сделка была ошибочной, заведите объект заново или обратитесь к директору.",
  };
}

/** 403, когда шаг конвейера (в монтаж, возврат снятого в продажу) делает не маркетинг. */
export const PROPERTY_MODERATION_REQUIRED_MESSAGE =
  "Этот шаг конвейера — за маркетингом: объект двигают кнопки «Одобрить» и «Запросить новые материалы».";

/**
 * ВЫХОД В ПРОДАЖУ из подготовки или из «Снято»: нужны фото и ссылка на ролик
 * (последний шаг подготовки — видео-обзор в Instagram и ссылка на него в
 * карточке). Тело из `PATCH /properties/:id`; ссылку на ролик вызывающий может
 * передать свою (форма меняет её в том же запросе), иначе берётся та, что в базе.
 */
export async function saleReadinessBlock(
  existing: { id: string; instagramUrl: string | null },
  instagramUrl: string | null = existing.instagramUrl
): Promise<TransitionBlock | null> {
  const photoCount = await prisma.propertyPhoto.count({ where: { propertyId: existing.id } });
  const blockers = blockersForSale({ instagramUrl, photoCount });
  if (blockers.length === 0) return null;
  return {
    status: 409,
    error: `Объект не готов к продаже: ${blockers.join(", ")}. Последний шаг подготовки — видео-обзор в Instagram и ссылка на него в карточке.`,
  };
}
