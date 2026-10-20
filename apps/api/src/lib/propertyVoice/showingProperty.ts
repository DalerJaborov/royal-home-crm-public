import { prisma } from "../../db.js";
import { conductedShowingWhere } from "../conductedShowing.js";
import { describeError } from "../describeError.js";
import { logSystemError } from "../systemError.js";

/**
 * ОБЪЕКТ ПОСЛЕДНЕГО ПРОВЕДЁННОГО ПОКАЗА («голос рынка», 03.10.2026).
 *
 * Отказ клиента («Завершить сделку») оформляется формой по КАРТОЧКЕ клиента, а не
 * по объекту, и запись в хронологии писалась без `propertyId`: «клиент отказался
 * после показа» нельзя было отнести к квартире, которую только что показывали.
 * Окна «Итог показа» убраны 14.09.2026, поэтому отказ — основное место, где
 * покупатель говорит «нет» словами причины.
 *
 * Берётся ПОСЛЕДНИЙ проведённый показ клиента, и только если он свежий (окно
 * `SHOWING_REFUSAL_WINDOW_DAYS`): отказ через полгода после показа к той
 * квартире не относится. Если у последнего показа объекта нет — null: брать
 * объект ПРЕДЫДУЩЕГО показа значило бы приписать отказ наугад.
 */
export const SHOWING_REFUSAL_WINDOW_DAYS = 30;

/** Чистая часть окна: дата, раньше которой показ уже не считается «только что». */
export function refusalWindowStart(now: Date): Date {
  return new Date(now.getTime() - SHOWING_REFUSAL_WINDOW_DAYS * 24 * 3600_000);
}

/** Никогда не бросает: вызывается из оформления отказа, и сбой этого шага его не рушит. */
export async function lastConductedShowingPropertyId(clientId: string, now: Date = new Date()): Promise<string | null> {
  try {
    const since = refusalWindowStart(now);
    const row = await prisma.interaction.findFirst({
      where: {
        ...conductedShowingWhere(clientId, now),
        // Время показа — назначенное (nextActionDate), а у записанного задним числом
        // его нет — тогда момент записи.
        AND: [{ OR: [{ nextActionDate: { gte: since } }, { nextActionDate: null, createdAt: { gte: since } }] }],
      },
      orderBy: { createdAt: "desc" },
      select: { propertyId: true },
    });
    return row?.propertyId ?? null;
  } catch (err) {
    void logSystemError("api", `Объект последнего показа для отказа не определён: ${describeError(err)}`, {
      dedupKey: "property-voice-refusal-showing",
    });
    return null;
  }
}
