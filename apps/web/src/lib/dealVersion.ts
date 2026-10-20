import type { Deal } from "../types";

/**
 * ЗАМОК ВЕРСИИ СДЕЛКИ НА САЙТЕ (24.09.2026, ночная проверка, круг «Сайт: кэш
 * и мутации», находка 2). Сервер умеет отвечать 409, если сделку изменили
 * без нас (`routes/deals.ts` — `updateMany({ where: { id, version } })`), но
 * условие срабатывает, только когда `version` вообще есть в теле PATCH — а
 * канбан и форма сделки (`Deals.tsx`) его не слали ни в одном из вызовов.
 * Запоздалый офлайн-PATCH («подвинуть на NEGOTIATION» из часовой давности)
 * тогда тихо перезаписывал более новое состояние сделки.
 *
 * Обе функции вынесены из `useUpdateDeal` (hooks/useDeals.ts), чтобы их можно
 * было проверить без React Query и jsdom — сборка тела запроса не зависит от
 * хука, только от уже загруженных данных.
 */

/** Ищет сделку по id среди уже закэшированных списков `["deals", …]`. */
export function findCachedDeal(cachedLists: Array<Deal[] | undefined>, id: string): Deal | undefined {
  for (const list of cachedLists) {
    const found = list?.find((d) => d.id === id);
    if (found) return found;
  }
  return undefined;
}

/**
 * Кладёт версию сделки в тело PATCH, если вызывающий сам её не передал.
 * Без версии в кэше (сделка ещё не загружена) тело уходит как раньше —
 * сервер в этом случае просто не проверяет версию (обратная совместимость).
 */
export function attachDealVersion(
  body: Record<string, unknown>,
  deal: Pick<Deal, "version"> | undefined
): Record<string, unknown> {
  if (body.version !== undefined) return body;
  if (deal?.version === undefined) return body;
  return { ...body, version: deal.version };
}
