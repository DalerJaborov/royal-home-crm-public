import type { PropertyHeat, PropertyHeatLabel } from "@royal-home/shared";
import { prisma } from "../db.js";
import { INTEREST_WEIGHT } from "./propertyInterest.js";

/**
 * ТЕМПЕРАТУРА ОБЪЕКТА (03.10.2026) — одно число 0–100 и слово «холодный / тёплый / горячий».
 *
 * ФОРМУЛА (чистая функция computePropertyHeat, ничего не читает из базы):
 *
 *   очки = Σ вес(вид события) × число событий за последние 7 дней
 *        + Σ вес(вид события) × число событий за дни 8–30 × 0,4        ← свежесть: старое весит меньше
 *        + 6 × число раз, когда клиент САМ прислал объект (30 дней)    ← самый сильный сигнал спроса
 *        + 4, если клиент сам присылал ≥ 3 раз и это ≥ 30 % всех отправок  ← устойчивость, а не случайность
 *   число = 100 × (1 − e^(−очки / 30))
 *
 * ВЕСА ВИДОВ — те же, что в «чем интересуются сейчас» (propertyInterest.ts, INTEREST_WEIGHT):
 * отправка 1, открытие ссылки клиентом 3, показ 5, комментарий 2. Второй шкалы нет.
 *
 * ПОЧЕМУ ТАК.
 *  • Насыщающая кривая, а не сумма: 100 очков не должны быть «в пять раз горячее» двадцати —
 *    объект либо в моде, либо нет. Кривая отвечает «насколько близко к потолку», и шкала не
 *    привязана к тому, сколько работают агенты.
 *  • Окно 30 дней и спад ×0,4 после недели: температура — про «сейчас», старый интерес не греет.
 *  • Пороги по формуле 100 × (1 − e^(−очки/30)): 20 — это ≈ 6,7 очка, 55 — ≈ 24 очка. < 20 холодный,
 *    < 55 тёплый, дальше горячий. Очки зависят от свежести: событие за последние 7 дней весит полностью,
 *    а старше недели — ×0,4. Пример: 13 очков старых событий дают 13 × 0,4 = 5,2 — ещё «холодный», а те же
 *    13 очков за последнюю неделю — уже «тёплый» (≈ 35 из 100). Один показ недельной давности даёт 5 × 0,4 = 2 очка,
 *    показ и открытие ссылки за неделю (5 + 3 = 8) — уже «тёплый». «Горячий» — порядка пяти свежих показов
 *    или эквивалент за последний месяц.
 *  • Это описание накала, а не прогноз продажи, и в тексте нигде не обещается результат.
 */

export const HEAT_RECENT_DAYS = 7;
export const HEAT_WINDOW_DAYS = 30;
/** Старый интерес (дни 8–30) весит 40 % от свежего. */
export const HEAT_OLD_FACTOR = 0.4;
/** Очки за каждый случай «клиент сам прислал объект» — вес выше показа: человек сам принёс объект в разговор. */
export const HEAT_CLIENT_SHARED_POINTS = 6;
/** Устойчивая «самоприсылка»: от трёх раз и от трети отправок. Пороги те же, что у диагноза STRONG_DEMAND. */
export const HEAT_CLIENT_SHARED_MIN = 3;
export const HEAT_CLIENT_SHARED_SHARE = 0.3;
export const HEAT_CLIENT_SHARED_BONUS = 4;
/** Очков, при которых число доходит до 63 из 100 (1 − 1/e). */
export const HEAT_SCALE = 30;
export const HEAT_WARM_FROM = 20;
export const HEAT_HOT_FROM = 55;

export const HEAT_WORDS: Record<PropertyHeatLabel, string> = { cold: "холодный", warm: "тёплый", hot: "горячий" };

export interface HeatInput {
  /** События интереса за последние 7 дней по видам. */
  recent: Record<string, number>;
  /** События интереса за последние 30 дней по видам (включая последние 7). */
  window: Record<string, number>;
  /** Сколько раз клиент сам прислал объект за 30 дней и сколько всего отправок объекта за это время. */
  clientShared: number;
  exposures: number;
}

const weightOf = (kind: string): number => (INTEREST_WEIGHT as Record<string, number>)[kind] ?? 1;

export function computePropertyHeat(input: HeatInput): PropertyHeat {
  let recentPoints = 0;
  let oldPoints = 0;
  let recentEvents = 0;
  let windowEvents = 0;
  const kinds = new Set([...Object.keys(input.window), ...Object.keys(input.recent)]);
  for (const kind of kinds) {
    // Окно 30 дней включает последние 7: «старые» — это разность, не меньше нуля.
    const recent = input.recent[kind] ?? 0;
    const inWindow = Math.max(input.window[kind] ?? 0, recent);
    recentPoints += weightOf(kind) * recent;
    oldPoints += weightOf(kind) * (inWindow - recent) * HEAT_OLD_FACTOR;
    recentEvents += recent;
    windowEvents += inWindow;
  }
  const sharedShare = input.exposures > 0 ? input.clientShared / input.exposures : 0;
  const sharedBonus = input.clientShared >= HEAT_CLIENT_SHARED_MIN && sharedShare >= HEAT_CLIENT_SHARED_SHARE ? HEAT_CLIENT_SHARED_BONUS : 0;
  const points = recentPoints + oldPoints + HEAT_CLIENT_SHARED_POINTS * input.clientShared + sharedBonus;

  const score = Math.min(100, Math.max(0, Math.round(100 * (1 - Math.exp(-points / HEAT_SCALE)))));
  const label: PropertyHeatLabel = score >= HEAT_HOT_FROM ? "hot" : score >= HEAT_WARM_FROM ? "warm" : "cold";

  const reasons: string[] = [];
  if (windowEvents === 0 && input.clientShared === 0) reasons.push(`За ${HEAT_WINDOW_DAYS} дней касаний к объекту не было`);
  else {
    reasons.push(`За ${HEAT_RECENT_DAYS} дней событий интереса: ${recentEvents}`);
    reasons.push(`За ${HEAT_WINDOW_DAYS} дней: ${windowEvents}`);
    if (input.clientShared > 0) reasons.push(`Клиенты сами прислали объект: ${input.clientShared} раз`);
  }
  return { score, label, word: HEAT_WORDS[label], reasons };
}

/**
 * Температура пачки объектов — три группировки на всю пачку, без запросов в цикле.
 * Подходит и для одной карточки (пачка из одного), и для списка: список пока не использует —
 * поле списка не менялось, чтобы не удорожать его запрос; когда понадобится, это вызов с id страницы.
 */
export async function loadPropertyHeat(propertyIds: string[], now: Date = new Date()): Promise<Map<string, PropertyHeat>> {
  const result = new Map<string, PropertyHeat>();
  if (propertyIds.length === 0) return result;
  const windowFrom = new Date(now.getTime() - HEAT_WINDOW_DAYS * 86_400_000);
  const recentFrom = new Date(now.getTime() - HEAT_RECENT_DAYS * 86_400_000);

  const [windowRows, recentRows, exposureRows] = await Promise.all([
    prisma.propertyInterestEvent.groupBy({
      by: ["propertyId", "kind"],
      where: { propertyId: { in: propertyIds }, createdAt: { gte: windowFrom } },
      _count: { _all: true },
    }),
    prisma.propertyInterestEvent.groupBy({
      by: ["propertyId", "kind"],
      where: { propertyId: { in: propertyIds }, createdAt: { gte: recentFrom } },
      _count: { _all: true },
    }),
    prisma.propertyExposure.groupBy({
      by: ["propertyId", "kind"],
      where: { propertyId: { in: propertyIds }, sentAt: { gte: windowFrom } },
      _count: { _all: true },
    }),
  ]);

  const inputs = new Map<string, HeatInput>(propertyIds.map((id) => [id, { recent: {}, window: {}, clientShared: 0, exposures: 0 }]));
  for (const r of windowRows) inputs.get(r.propertyId)!.window[r.kind] = r._count._all;
  for (const r of recentRows) inputs.get(r.propertyId)!.recent[r.kind] = r._count._all;
  for (const r of exposureRows) {
    if (!r.propertyId) continue;
    const input = inputs.get(r.propertyId);
    if (!input) continue;
    input.exposures += r._count._all;
    if (r.kind === "CLIENT_SHARED") input.clientShared += r._count._all;
  }
  for (const [id, input] of inputs) result.set(id, computePropertyHeat(input));
  return result;
}
