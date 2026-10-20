import type { PropertyStageState, PropertyStatus } from "@royal-home/shared";
import { dushanbeTime } from "./date";
import { plannedStatusLabel } from "./publishPlanned";
import { statusChipLabel } from "./theme2026";
import type { ChipTone } from "../components/rh2/Chip";
import type { Property } from "../types";

/**
 * ОДИН ЧИП ЭТАПА НА ОБЪЕКТ (контракт 06.10.2026, review-statuses.md, п. 3).
 *
 * Чип объекта называет ЭТАП конвейера, а не набор фактов: «На сайте» уходит из чипа
 * в тихие строки, «Принят 25 сентября» под раскрытие. Тон берётся из словаря
 * набора (`Chip`), а не из `STATUS_CHIP` старой темы: там «На монтаже» это `warn`,
 * то есть жёлтая тревога, а в контракте монтаж обычный рабочий этап и красится
 * лавандой; красным остаётся только просрочка этапа (`stage.overdue`), и это
 * единственный чип с прямым действием «сделай сейчас».
 */
const STAGE_TONE: Record<PropertyStatus, ChipTone> = {
  PENDING_REVIEW: "sky",
  AWAITING_PHOTOS: "neutral",
  AWAITING_VIDEO: "neutral",
  EDITING: "lav",
  AVAILABLE: "ok",
  RESERVED: "neutral",
  SOLD: "neutral",
  WITHDRAWN: "neutral",
};

export function propertyStageChip(
  p: Pick<Property, "status" | "pipeline" | "videoHandoffFinalPath" | "scheduledPublishAt" | "videoHandoffStatus" | "publishedChannels">,
  now: number = Date.now(),
): { tone: ChipTone; label: string } {
  const stage: PropertyStageState | null | undefined = p.pipeline;
  const label = plannedStatusLabel(p, now, dushanbeTime) ?? statusChipLabel(p.status, stage);
  return { tone: stage?.overdue === true ? "crit" : STAGE_TONE[p.status], label };
}
