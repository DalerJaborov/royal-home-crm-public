/**
 * ЕДИНАЯ ПОЛИТИКА ПОДБОРА (решение владельца 17.09.2026, docs/match-policy-plan-17-09.md).
 *
 * До этой правки допуски подбора (±10% бюджет, −10% площадь, ±1 комната, 5% снижения
 * цены, радиус 1→2→3, минимум 3 кандидата) были зашиты числами в трёх местах
 * (lib/propertyMatchFilter.ts, routes/matching.ts, lib/geoDistance.ts), а «ждущий
 * покупатель» — определён по-разному для автоподбора, счётчика спроса «N в спросе» и
 * списка «Кому подойдёт» (отсюда «33 в спросе / 0 кому подходит»). Здесь — одно место
 * чтения Настроек (как loadMoneyContext/loadMatchWeights) и одно определение «ждущего».
 *
 * Умолчания = сегодняшние зашитые значения — включение колонок в БД не двигает подбор
 * молча ни для одного агента до первого осознанного нажатия в интерфейсе.
 */
import { propertyFieldShown } from "@royal-home/shared";
import type { Prisma } from "../generated/prisma/client.js";
import { prisma } from "../db.js";
import { MATCH_MIN_CANDIDATES, MATCH_PRICE_DROP_RENOTIFY_PCT, MATCH_RADIUS_MAX_MULTIPLIER } from "./settingsConstants.js";
import { toTjs } from "./money.js";

export interface MatchPolicy {
  /** Общий рубильник автопуша «новый объект подошёл ждущему покупателю». Список «Кому
   *  подойдёт» и счётчик спроса тумблер не касается — это ручной просмотр, не рассылка. */
  autoMatchEnabled: boolean;
  /** Входит ли workStatus=INACTIVE во множество «ждущих» (waitingBuyerWhere). */
  includeInactive: boolean;
  /** Входит ли workStatus=DEFERRED во множество «ждущих». */
  includeDeferred: boolean;
  /** Пуш хозяину объекта при ручном предложении клиенту другого агента. */
  notifyPropertyOwner: boolean;
  /** Срок жизни пожелания без касания, дней. 0 = без срока. */
  requirementTtlDays: number;
  /** Порог повторного уведомления при снижении цены, доля (pct / 100). */
  priceDropRenotifyRatio: number;
  /** Допуск бюджета, доля (pct / 100) — было зашито 0.9/1.1. */
  budgetToleranceRatio: number;
  /** Допуск площади, доля (pct / 100) — было зашито ×0.9. */
  areaToleranceRatio: number;
  /** Допуск по числу комнат — было зашито ±1. */
  roomsTolerance: number;
  /** Радиус желаемого места по умолчанию для новой точки, м. */
  defaultRadiusM: number;
  /** Множитель адаптивного расширения радиуса — было зашито [1,2,3]. */
  radiusMaxMultiplier: number;
  /** Минимум кандидатов, при котором адаптивное расширение радиуса останавливается. */
  minCandidates: number;
}

/** Умолчания — те самые числа, что раньше были зашиты в код по трём файлам. Тесты и
 *  разовые вызовы, не читающие Настройки, могут использовать этот объект напрямую. */
export const DEFAULT_MATCH_POLICY: MatchPolicy = {
  autoMatchEnabled: true,
  includeInactive: true,
  includeDeferred: true,
  notifyPropertyOwner: true,
  requirementTtlDays: 60,
  priceDropRenotifyRatio: 0.05,
  budgetToleranceRatio: 0.1,
  areaToleranceRatio: 0.1,
  roomsTolerance: 1,
  defaultRadiusM: 1500,
  radiusMaxMultiplier: 3,
  minCandidates: 3,
};

/**
 * ОКНО БЮДЖЕТА С ДОПУСКОМ — ОДНО НА ВСЕ ПОДБОРЫ (10.10.2026, аудит поиска ботами P1-2,
 * docs/audit-bots-2026-10-10-search.md).
 *
 * Подбор агентам (routes/matching.ts, lib/propertyMatchFilter.ts) пускал цену до
 * бюджета +10 %, а боты (lib/propertyMatch.ts) — строго до бюджета: «трёшка до 1 млн в
 * Шохмансуре» у бота давала «ничего нет», а у агента CRM тот же запрос показывал объект
 * за 1,03 млн. Формула допуска теперь здесь, и её зовут все три места: поменяли допуск
 * в Настройках — поменялось везде одинаково.
 *
 * Суммы — уже в сомони. null — граница не названа (пусто, не ноль).
 */
export function budgetWindowTjs(
  minTjs: number | null | undefined,
  maxTjs: number | null | undefined,
  policy: Pick<MatchPolicy, "budgetToleranceRatio">
): { min: number | null; max: number | null } {
  return {
    min: minTjs != null ? minTjs * (1 - policy.budgetToleranceRatio) : null,
    max: maxTjs != null ? maxTjs * (1 + policy.budgetToleranceRatio) : null,
  };
}

/** Политика из Настроек — с откатом на умолчания для полей, которых ещё нет в строке
 *  (старая Settings-строка без миграции на новые поля), тот же приём, что и в
 *  loadMatchWeights (routes/matching.ts). Читается один раз на запрос. */
export async function loadMatchPolicy(): Promise<MatchPolicy> {
  const s = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: {
      autoMatchEnabled: true,
      matchIncludeInactive: true,
      matchIncludeDeferred: true,
      matchNotifyPropertyOwner: true,
      matchRequirementTtlDays: true,
      matchBudgetTolerancePct: true,
      matchAreaTolerancePct: true,
      matchRoomsTolerance: true,
      matchDefaultRadiusM: true,
    },
  });
  return {
    autoMatchEnabled: s?.autoMatchEnabled ?? DEFAULT_MATCH_POLICY.autoMatchEnabled,
    includeInactive: s?.matchIncludeInactive ?? DEFAULT_MATCH_POLICY.includeInactive,
    includeDeferred: s?.matchIncludeDeferred ?? DEFAULT_MATCH_POLICY.includeDeferred,
    notifyPropertyOwner: s?.matchNotifyPropertyOwner ?? DEFAULT_MATCH_POLICY.notifyPropertyOwner,
    requirementTtlDays: s?.matchRequirementTtlDays ?? DEFAULT_MATCH_POLICY.requirementTtlDays,
    // Три технических параметра алгоритма — константы с 01.11.2026 (lib/settingsConstants.ts).
    priceDropRenotifyRatio: MATCH_PRICE_DROP_RENOTIFY_PCT / 100,
    budgetToleranceRatio:
      s?.matchBudgetTolerancePct != null ? s.matchBudgetTolerancePct / 100 : DEFAULT_MATCH_POLICY.budgetToleranceRatio,
    areaToleranceRatio:
      s?.matchAreaTolerancePct != null ? s.matchAreaTolerancePct / 100 : DEFAULT_MATCH_POLICY.areaToleranceRatio,
    roomsTolerance: s?.matchRoomsTolerance ?? DEFAULT_MATCH_POLICY.roomsTolerance,
    defaultRadiusM: s?.matchDefaultRadiusM ?? DEFAULT_MATCH_POLICY.defaultRadiusM,
    radiusMaxMultiplier: MATCH_RADIUS_MAX_MULTIPLIER,
    minCandidates: MATCH_MIN_CANDIDATES,
  };
}

/**
 * ЕДИНОЕ ОПРЕДЕЛЕНИЕ «ЖДУЩЕГО ПОКУПАТЕЛЯ» — используют все три потребителя:
 * автоподбор (notifyWaitingBuyersOfNewProperty), счётчик спроса (computeDemandCounts)
 * и список «Кому подойдёт» (findMatchingClients). Раньше каждый фильтровал по-своему
 * (кто по Client.status, кто по workStatus без kind) — отсюда «33 в спросе / 0 кому
 * подходит» на одном и том же объекте.
 *
 * Client.status (воронка лида) почти не участвует — «ждущий» здесь про желание
 * купить (workStatus), а не про то, где клиент в воронке первого звонка; LOST тоже
 * ждёт (блок D6 плана 12.09). Два исключения всё же есть: DEAL_CLOSED (уже купил у
 * нас — предлагать ему объекты и считать его спросом бессмысленно) и ARCHIVED
 * (автоматика убрала за 60 дней полного молчания). Поймано 17.09 на стенде: без
 * этого в «Кому подойдёт» стояла «Зарина Холова · Сделка закрыта».
 *
 * assignedAgentId СОЗНАТЕЛЬНО не входит в where — счётчик спроса и список должны
 * видеть и неназначенных клиентов; автоподбор (единственный, кому нужен только
 * назначенный, чтобы было кого пушить) фильтрует «есть агент» сам, поверх этого where.
 */
export function confirmedBuyerWhere(): Prisma.ClientWhereInput {
  return { OR: [{ kind: "BUYER" }, { kind: "SELLER", dualIntent: true, dualIntentConfirmedAt: { not: null } }] };
}

export function waitingBuyerWhere(policy: MatchPolicy, now: Date = new Date()): Prisma.ClientWhereInput {
  const workStatuses: Array<"ACTIVE" | "INACTIVE" | "DEFERRED"> = ["ACTIVE"];
  if (policy.includeInactive) workStatuses.push("INACTIVE");
  if (policy.includeDeferred) workStatuses.push("DEFERRED");

  const and: Prisma.ClientWhereInput[] = [
    // Keep role predicates inside AND: consumers add their own geographical OR.
    confirmedBuyerWhere(),
    { OR: [{ requirementsFieldsKind: null }, { requirementsFieldsKind: "BUYER" }] },
    // buyerStage не заполнен почти никогда (появляется только ПОСЛЕ показа) —
    // `{ not: "NEGOTIATION" }` в SQL превращается в `<>`, а NULL <> значение даёт
    // NULL, не true, и WHERE такую строку молча выбрасывает. Явный `null` в OR
    // не даёт этому отсечь всех клиентов без единого проведённого показа.
    { OR: [{ buyerStage: null }, { buyerStage: { not: "NEGOTIATION" } }] },
    // Требования должны быть заполнены хоть чем-то — иначе сюда попадает любой
    // ждущий покупатель без единой заданной цифры.
    {
      OR: [
        { desiredDistrictId: { not: null } },
        { desiredType: { not: null } },
        { desiredRooms: { not: null } },
        { budgetMin: { not: null } },
        { budgetMax: { not: null } },
        { desiredPlaces: { some: {} } },
      ],
    },
  ];

  /**
   * СРОК ЖИЗНИ ПОЖЕЛАНИЯ (requirementTtlDays, 0 = без срока). ОТЛОЖЕННЫЕ (DEFERRED)
   * под срок не попадают никогда — у них свой таймер возврата (deferredUntil,
   * lib/deferredClients.ts) и своё срочное уведомление, план прямо это разделяет.
   * Для остальных — «касание» это ЛИБО последний контакт агента, ЛИБО последнее
   * сообщение клиента (что свежее из двух заполненных).
   */
  if (policy.requirementTtlDays > 0) {
    const cutoff = new Date(now.getTime() - policy.requirementTtlDays * 24 * 60 * 60 * 1000);
    and.push({
      OR: [{ workStatus: "DEFERRED" }, { lastContactAt: { gte: cutoff } }, { lastClientMessageAt: { gte: cutoff } }],
    });
  }

  return {
    deletedAt: null,
    status: { notIn: ["DEAL_CLOSED", "ARCHIVED"] },
    workStatus: { in: workStatuses },
    AND: and,
  };
}

/** Признаки объекта, по которым требования покупателя проверяются в самом запросе. */
export interface PrefilterProperty {
  type?: string | null;
  rooms: number | null;
  price: unknown;
  currency?: string | null;
  areaSqm?: unknown;
  floor?: number | null;
  totalFloors?: number | null;
}

/**
 * ТРЕБОВАНИЯ ПОКУПАТЕЛЯ К ОДНОМУ ОБЪЕКТУ — В САМОМ ЗАПРОСЕ, ДО СРЕЗА
 * (находка О4 проверки 02.10.2026). Выборки «кто ждёт этот объект» (автопуш
 * lib/propertyMatchFilter.ts, «Кому подойдёт» routes/matching.ts) брали из базы
 * всех ждущих в районе с потолком 200/300 строк и только потом отсекали бюджет
 * и площадь в JS: при частом районе подходящий покупатель за потолком не
 * подбирался вовсе, и этого никто не видел.
 *
 * Здесь — те же условия, что у точной проверки (clientMatchesProperty), с теми
 * же допусками политики, записанные со стороны клиента; пустое поле клиента или
 * объекта не отсеивает, как и там. Это ПРЕДФИЛЬТР: точная проверка остаётся на
 * месте, поэтому границы бюджета взяты с крошечным запасом на округление курса —
 * лишний кандидат отсеется в JS, а потерянный не вернётся ничем.
 */
export function clientRequirementsForPropertyWhere(
  property: PrefilterProperty,
  usdToTjs: number,
  policy: MatchPolicy,
  /**
   * Без условий по бюджету (03.10.2026, «Совет по цене», lib/priceWaitlist.ts): ждущих
   * покупателей, у которых цена объекта выше бюджета, лист ожидания ищет именно среди
   * тех, кого эта же функция по умолчанию отсеивает. Остальные условия — те же.
   */
  options: { skipBudget?: boolean } = {}
): Prisma.ClientWhereInput[] {
  const and: Prisma.ClientWhereInput[] = [];
  // Тип объекта не задан — тип в подборе не участвует (propertyTypeMatches).
  if (property.type) {
    and.push({ OR: [{ desiredType: null }, { desiredType: property.type as Prisma.ClientWhereInput["desiredType"] }] });
  }
  // Комнаты и этаж сравниваются только там, где они есть у типа: этаж старой
  // карточки дома не отсеивает покупателей с «не выше 3-го» (propertyTypeFields.ts).
  const typeKnown = property.type ?? "APARTMENT";
  if (property.rooms != null && propertyFieldShown(typeKnown, "rooms")) {
    and.push({
      OR: [
        { desiredRooms: null },
        { desiredRooms: { gte: property.rooms - policy.roomsTolerance, lte: property.rooms + policy.roomsTolerance } },
      ],
    });
  }
  if (property.areaSqm != null && Number.isFinite(Number(property.areaSqm)) && policy.areaToleranceRatio < 1) {
    // area ≥ desiredAreaMin × (1 − допуск)  ⇔  desiredAreaMin ≤ area / (1 − допуск)
    and.push({
      OR: [{ desiredAreaMin: null }, { desiredAreaMin: { lte: Number(property.areaSqm) / (1 - policy.areaToleranceRatio) + 1e-6 } }],
    });
  }
  if (property.floor != null && propertyFieldShown(typeKnown, "floor")) {
    and.push({ OR: [{ desiredFloorMin: null }, { desiredFloorMin: { lte: property.floor } }] });
    and.push({ OR: [{ desiredFloorMax: null }, { desiredFloorMax: { gte: property.floor } }] });
  }
  if (property.totalFloors != null) {
    and.push({ OR: [{ desiredTotalFloors: null }, { desiredTotalFloors: { gte: property.totalFloors } }] });
  }

  if (options.skipBudget) return and;

  const rate = usdToTjs > 0 ? usdToTjs : 1;
  // Тот же перевод, что у точной проверки (toTjs): пустая цена — ноль, как там.
  const priceTjs = toTjs(property.price, property.currency, { usdToTjs: rate });
  const slack = 1.001; // запас на округление toTjs до дирама — см. докстринг
  // priceTjs ≥ бюджетMin(TJS) × (1 − допуск)  ⇔  бюджетMin ≤ priceTjs / (1 − допуск) / курс
  if (policy.budgetToleranceRatio < 1) {
    const minTjs = (priceTjs / (1 - policy.budgetToleranceRatio)) * slack;
    and.push({
      OR: [
        { budgetMin: null },
        { currency: "TJS", budgetMin: { lte: minTjs } },
        { currency: "USD", budgetMin: { lte: minTjs / rate } },
      ],
    });
  }
  // priceTjs ≤ бюджетMax(TJS) × (1 + допуск)  ⇔  бюджетMax ≥ priceTjs / (1 + допуск) / курс
  const maxTjs = priceTjs / (1 + policy.budgetToleranceRatio) / slack;
  and.push({
    OR: [
      { budgetMax: null },
      { currency: "TJS", budgetMax: { gte: maxTjs } },
      { currency: "USD", budgetMax: { gte: maxTjs / rate } },
    ],
  });
  return and;
}
