import type { PriceAdviceResponse, PropertyVoiceResponse } from "@royal-home/shared";
import { prisma } from "../db.js";
import { advisePrice } from "./priceAdvice.js";
import { loadPriceWaitlist } from "./priceWaitlist.js";
import { loadPropertyHeat } from "./propertyHeat.js";
import { loadPropertyVoice } from "./propertyVoice/loadPropertyVoice.js";

const DAY_MS = 24 * 3600_000;

/**
 * СОВЕТ ПО ЦЕНЕ + ТЕМПЕРАТУРА ОДНОГО ОБЪЕКТА (03.10.2026): сборка из «голоса рынка», листа ожидания и событий интереса.
 *
 * «Голос» читается БЕЗ раздела `showingFeedback` и без денег рекламы (`canSeeShowingFeedback: false`,
 * `canSeeAdMoney: false`): советом пользуются агенты, а опросы покупателей после показа по замыслу видит только
 * директор — их цитаты не должны просочиться в `evidence` через счётчик возражений. Поэтому совет одинаков для
 * всех, кто видит карточку, и ничего не знает о деньгах компании.
 *
 * Срок в продаже — как в loadPropertyVoice: с входа в стадию «в продаже», до неё — с создания.
 */
export async function loadPriceAdvice(
  propertyId: string,
  viewer: {
    dealsOwnAgentId: string | null;
    viewerId: string;
    /** undefined — в `waitlist.visibleClients` перечислить всех (есть `clients.viewAll`), иначе только закреплённых за агентом. */
    visibleToAgentId?: string;
  },
  now: Date = new Date(),
  options: {
    /**
     * Уже посчитанный «голос рынка» ЭТОГО объекта с теми же правами (`canSeeShowingFeedback: false`,
     * `canSeeAdMoney: false`, тот же `dealsOwnAgentId`) — чтобы вызывающий, у которого он есть, не
     * считал его второй раз. Другой «голос» (с опросами или деньгами) сюда передавать нельзя: он
     * просочился бы в `evidence`. null/не задан — считаем сами.
     */
    voice?: PropertyVoiceResponse | null;
    /** Не считать лист ожидания (дорогой запрос покупателей): совет строится без него, `waitlist` в ответе — null. По умолчанию считаем. */
    skipWaitlist?: boolean;
  } = {}
): Promise<PriceAdviceResponse | null> {
  const property = await prisma.property.findUnique({
    where: { id: propertyId },
    select: { status: true, createdAt: true, stageEnteredAt: true },
  });
  if (!property) return null;
  const onSale = property.status === "AVAILABLE";
  const saleStart = onSale ? property.stageEnteredAt : property.createdAt;
  const daysOnSale = Math.max(0, Math.floor((now.getTime() - saleStart.getTime()) / DAY_MS));

  const [voice, waitlist, heat] = await Promise.all([
    options.voice
      ? Promise.resolve(options.voice)
      : loadPropertyVoice(propertyId, {
          canSeeShowingFeedback: false,
          canSeeAdMoney: false,
          dealsOwnAgentId: viewer.dealsOwnAgentId,
          canSeeAllDealMoney: false,
          viewerId: viewer.viewerId,
          now,
        }),
    // ОДИН расчёт листа ожидания на всё: совет читает из него числа, экран — лестницу и «своих клиентов».
    options.skipWaitlist ? Promise.resolve(null) : loadPriceWaitlist(propertyId, { now, visibleToAgentId: viewer.visibleToAgentId }),
    loadPropertyHeat([propertyId], now),
  ]);
  if (!voice) return null;

  return {
    propertyId,
    generatedAt: now.toISOString(),
    advice: advisePrice(voice, waitlist, { onSale, daysOnSale }),
    heat: heat.get(propertyId)!,
    // Имена клиентов здесь ещё без маски номера: роут обязан пройти `maskWaitlistClients` перед отдачей.
    waitlist,
  };
}
