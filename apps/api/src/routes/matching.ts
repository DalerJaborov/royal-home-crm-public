import type { MatchingClient, MatchingClientsResponse } from "@royal-home/shared";
import type { Prisma } from "../generated/prisma/client.js";
import type { PropertyType } from "../generated/prisma/enums.js";
import { prisma } from "../db.js";
import { loadMoneyContext, type MoneyContext } from "../lib/money.js";
import { propertyOwnerAgentId } from "../lib/propertyOwner.js";
import { matchingPropertySellers } from "../lib/matchingOwnership.js";
import type { MatchLang } from "@royal-home/shared";
import {
  clientPropertyEligible,
  compareMatches,
  currentBuyerMatchingCriteria,
  matchClientProperty,
  type MatchingBuyerCriteria,
  type MatchingPropertyFacts,
} from "../lib/clientPropertyMatching.js";
import {
  clientRequirementsForPropertyWhere,
  loadMatchPolicy,
  waitingBuyerWhere,
  DEFAULT_MATCH_POLICY,
  type MatchPolicy,
} from "../lib/matchPolicy.js";
import { pointBboxWhere, MAX_DESIRED_PLACE_RADIUS_M } from "../lib/geoDistance.js";
import type { LeadRequirements } from "../lib/propertyTypeRule.js";

/**
 * Клиент и объект для подбора — те же поля, что у единой модели
 * (lib/clientPropertyMatching.ts::matchClientProperty). Отдельного правила
 * «подходит/не подходит» в этом файле больше нет (подбор 2.0, 10.11.2026): было
 * две модели одного отношения, и они расходились в фильтре и в причинах.
 */
export type MatchableClient = MatchingBuyerCriteria;
export type MatchableProperty = MatchingPropertyFacts;

/**
 * Проходит ли пара. Сравнение цены с бюджетом — в сомони по курсу (lib/money.ts):
 * без приведения объект за $50 000 «подходил» клиенту с бюджетом 50 000 сомони.
 * Тонкая обёртка ради прежних вызывающих (счётчик спроса, лист ожидания по цене,
 * распределение заявок) — правило одно, в matchClientProperty.
 */
export function clientMatchesProperty(
  client: MatchableClient,
  property: MatchableProperty,
  money: MoneyContext,
  policy: MatchPolicy = DEFAULT_MATCH_POLICY
): boolean {
  return clientPropertyEligible(client, property, money, policy);
}

/** Поля клиента, которые читает единая модель. */
const clientMatchSelect = {
  budgetMin: true,
  budgetMax: true,
  currency: true,
  desiredDistrictId: true,
  desiredRooms: true,
  desiredType: true,
  desiredAreaMin: true,
  desiredFloorMin: true,
  desiredFloorMax: true,
  desiredTotalFloors: true,
  requirementsNotes: true,
  desiredPlaces: { select: { lat: true, lng: true, radiusM: true, label: true } },
} satisfies Prisma.ClientSelect;

/** Поля объекта, которые читает единая модель (без них пожелания станут «уточнить»). */
export const propertyMatchSelect = {
  id: true,
  price: true,
  currency: true,
  districtId: true,
  rooms: true,
  type: true,
  areaSqm: true,
  floor: true,
  totalFloors: true,
  lat: true,
  lng: true,
  condition: true,
  marketType: true,
  amenities: true,
  details: true,
  description: true,
  documents: true,
} satisfies Prisma.PropertySelect;

/** Считает, сколько ждущих клиентов ищут каждый объект (по desired-параметрам).
 *
 * 17.09.2026: раньше фильтровал по Client.status (воронка лида) — другое множество,
 * чем у автоподбора (workStatus) и списка «Кому подойдёт», отсюда «33 в спросе / 0
 * кому подходит» на одном и том же объекте. Теперь — то же waitingBuyerWhere, что и
 * у остальных двух потребителей (lib/matchPolicy.ts), и та же проверка пары. */
export async function computeDemandCounts(properties: MatchableProperty[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (properties.length === 0) return counts;
  const sellers = await matchingPropertySellers(properties.map((property) => property.id));

  // Сужаем выборку до районов, реально представленных на этой странице объектов:
  // клиент из другого района не может дать совпадение ни по одному объекту.
  // Клиенты без указанного района подходят под любой — их берём всегда.
  const districtIds = [...new Set(properties.map((p) => p.districtId).filter((id): id is string => id != null))];
  // Гео-предфильтр (12.09.2026, блок D2): грубый bbox с потолком радиуса.
  const propertyPoints = properties.filter((p) => p.lat != null && p.lng != null);
  // Тип — тоже в запросе (ревью 10.11): клиент, ищущий дом, не подходит странице из
  // одних квартир. Объект без типа подходит любому — тогда тип не сужаем.
  const propertyTypes = properties.some((p) => !p.type) ? null : [...new Set(properties.map((p) => p.type as string))];

  const [policy, money] = await Promise.all([loadMatchPolicy(), loadMoneyContext()]);
  const waiting = waitingBuyerWhere(policy);
  const candidateClients = await prisma.client.findMany({
    where: {
      ...waiting,
      AND: [
        ...(Array.isArray(waiting.AND) ? waiting.AND : []),
        ...(propertyTypes
          ? [{ OR: [{ desiredType: null }, { desiredType: { in: propertyTypes as PropertyType[] } }] } as Prisma.ClientWhereInput]
          : []),
        {
          OR: [
            { desiredDistrictId: { in: districtIds } },
            { desiredDistrictId: null },
            ...(propertyPoints.length > 0
              ? [
                  {
                    desiredPlaces: {
                      some: { OR: propertyPoints.map((p) => pointBboxWhere(Number(p.lat), Number(p.lng), MAX_DESIRED_PLACE_RADIUS_M)) },
                    },
                  } satisfies Prisma.ClientWhereInput,
                ]
              : []),
          ],
        },
      ],
    },
    select: { id: true, ...clientMatchSelect },
    // Предел выборки обязателен по стандарту проекта: счётчик спроса и так
    // оценочный, а функция дёргается на каждую отрисовку списка объектов.
    take: 1000,
  });

  for (const property of properties) {
    const count = candidateClients.filter((c) => c.id !== sellers.get(property.id) && clientMatchesProperty(c, property, money, policy)).length;
    if (count > 0) counts.set(property.id, count);
  }
  return counts;
}

// Описан один раз в @royal-home/shared: его же читает карточка объекта.
export type { MatchingClient, MatchingClientsResponse };

/** Сужение выборки без смены правил подбора: только клиенты агента или один клиент
 *  (мастер объекта в Telegram, 10.11.2026). */
export interface MatchingScope {
  assignedAgentId?: string;
  clientId?: string;
  /** Язык причин (помощница пишет на языке собеседника). */
  lang?: MatchLang;
}

/**
 * КТО именно ищет этот объект — и что именно у них совпало.
 *
 * 17.09.2026: возвращает `{ items, total }` — `total` считает ВСЁ множество ждущих,
 * прошедших проверку пары, ДО среза `limit` (то же число, что у счётчика спроса).
 * С 10.11.2026 у каждого клиента — уровень, причины, уступки и «уже отправляли»
 * (история PropertyExposure), а не процент: процент был завышен базой 40 и смешан
 * с теплотой клиента (+10 «горячему»).
 */
export async function findMatchingClients(propertyId: string, limit = 10, scope: MatchingScope = {}): Promise<MatchingClientsResponse> {
  const property = await prisma.property.findFirst({
    where: { id: propertyId, deletedAt: null },
    select: propertyMatchSelect,
  });
  if (!property) return { items: [], total: 0 };
  return findMatchingClientsForProperty(property, limit, scope);
}

/**
 * То же, что findMatchingClients, но по признакам объекта, которого в базе может
 * ещё не быть (24.09.2026): собственник выложил объявление под нашим постом, и бот
 * в первом же письме говорит, сколько покупателей ищут такое. Правило то же.
 */
export async function findMatchingClientsForProperty(
  property: MatchableProperty,
  limit = 10,
  scope: MatchingScope = {}
): Promise<MatchingClientsResponse> {
  const sellerClientId = (await matchingPropertySellers([property.id])).get(property.id);
  // Гео-предфильтр (блок D2): грубый потолок MAX_DESIRED_PLACE_RADIUS_M, точный
  // радиус каждого места клиента уточняет единая модель уже после выборки.
  const districtOrRadiusOr: Prisma.ClientWhereInput[] = [{ desiredDistrictId: property.districtId }, { desiredDistrictId: null }];
  if (property.lat != null && property.lng != null) {
    districtOrRadiusOr.push({
      desiredPlaces: { some: pointBboxWhere(Number(property.lat), Number(property.lng), MAX_DESIRED_PLACE_RADIUS_M) },
    });
  }

  const [policy, money] = await Promise.all([loadMatchPolicy(), loadMoneyContext()]);
  const waiting = waitingBuyerWhere(policy);
  const clients = await prisma.client.findMany({
    where: {
      ...waiting,
      ...(sellerClientId ? { id: { not: sellerClientId } } : {}),
      ...(scope.assignedAgentId ? { assignedAgentId: scope.assignedAgentId } : {}),
      AND: [
        ...(scope.clientId ? [{ id: scope.clientId }] : []),
        ...(Array.isArray(waiting.AND) ? waiting.AND : []),
        { OR: districtOrRadiusOr },
        // Требования клиента к объекту — в запросе, ДО среза take ниже (О4,
        // 02.10.2026): точная проверка остаётся, но срез получает только тех, кто
        // может подойти, а не первых попавшихся.
        ...clientRequirementsForPropertyWhere(property, money.usdToTjs, policy),
      ],
    },
    select: {
      id: true,
      shortId: true,
      fullName: true,
      status: true,
      workStatus: true,
      inactiveLevel: true,
      assignedAgentId: true,
      assignedAgent: { select: { fullName: true } },
      ...clientMatchSelect,
    },
    orderBy: { createdAt: "desc" },
    take: 300,
  });

  // Быстрый путь «да/нет» отсекает лишних, причины строим только прошедшим.
  const matched = clients.flatMap((c) => {
    if (!clientPropertyEligible(c, property, money, policy)) return [];
    const match = matchClientProperty(c, property, money, policy, scope.lang);
    return match ? [{ client: c, match }] : [];
  });
  // Порядок: уровень и причины пары; «горячий» — только при прочих равных.
  matched.sort(
    (a, b) =>
      compareMatches(a.match, b.match) ||
      Number(b.client.status === "HOT") - Number(a.client.status === "HOT") ||
      a.client.fullName.localeCompare(b.client.fullName)
  );
  const page = matched.slice(0, limit);
  // «Уже отправляли N дней назад» — только для объекта из базы (у объявления
  // собственника, которого ещё нет в CRM, истории отправок нет).
  const sends = page.length
    ? await prisma.propertyExposure.groupBy({
        by: ["clientId"],
        where: { propertyId: property.id, clientId: { in: page.map((item) => item.client.id) } },
        _max: { sentAt: true },
        _count: { _all: true },
      })
    : [];
  const sentBy = new Map(sends.map((row) => [row.clientId, row]));

  return {
    total: matched.length,
    items: page.map(({ client: c, match }) => {
      const sent = sentBy.get(c.id);
      const { distanceM: _distance, points: _points, ...evidence } = match;
      return {
        id: c.id,
        shortId: c.shortId,
        fullName: c.fullName,
        status: c.status,
        workStatus: c.workStatus,
        inactiveLevel: c.inactiveLevel,
        assignedAgentId: c.assignedAgentId,
        assignedAgentName: c.assignedAgent?.fullName ?? null,
        match: { ...evidence, lastSentAt: sent?._max.sentAt?.toISOString() ?? null, sentCount: sent?._count._all ?? 0 },
      };
    }),
  };
}

/** Объект, подходящий клиенту, — вместе с тем, кто его принёс. */
export interface MatchedProperty {
  propertyId: string;
  shortId: number;
  title: string;
  /** Хозяин объекта — `propertyOwnerAgentId`: интейкер, а если его нет — риелтор
   *  сделки или тот, кто завёл карточку. Именно ему причитается лид. Название
   *  поля оставлено прежним ради совместимости вызывающих. */
  intakeAgentId: string;
  /** Шкала порога «свой объект — свой клиент» (Настройки → ownPropertyMatchThreshold),
   *  та же арифметика, что до подбора 2.0 — порог не поменял смысл. Не процент. */
  score: number;
  /** Что совпало — те же причины, что видит агент в «Подборе». */
  reasons: string[];
}

/**
 * Какие объекты подходят этому клиенту — и чьи они.
 *
 * Нужна распределению лидов (решение владельца 11.08.2026: «свой объект — свой
 * клиент»), поэтому в выдаче только объекты С ХОЗЯИНОМ (`propertyOwnerAgentId`).
 * Берём только AVAILABLE: лид под непоказываемый объект кончился бы разговором ни о чём.
 */
export async function findMatchingPropertiesForClient(
  clientId: string,
  options: {
    take?: number;
    /**
     * ЗАПРОС, ЕЩЁ НЕ ЗАПИСАННЫЙ В КАРТОЧКУ (24.09.2026). Разбор звонка выбирает
     * агента до того, как запишет бюджет, район и комнаты. Заданные поля
     * перекрывают карточку, незаданные берутся из неё.
     */
    requirements?: LeadRequirements;
  } = {}
): Promise<MatchedProperty[]> {
  const stored = await prisma.client.findFirst({
    where: { id: clientId, deletedAt: null },
    select: { requirementsFieldsKind: true, ...clientMatchSelect },
  });
  if (!stored) return [];
  const overrides = Object.fromEntries(
    Object.entries(options.requirements ?? {}).filter(([, v]) => v !== undefined && v !== null)
  ) as unknown as Partial<typeof stored>;
  if (stored.requirementsFieldsKind != null && stored.requirementsFieldsKind !== "BUYER" && Object.keys(overrides).length === 0) return [];
  const client = { ...currentBuyerMatchingCriteria(stored), ...overrides };

  const where: Prisma.PropertyWhereInput = {
    status: "AVAILABLE",
    deletedAt: null,
    AND: [{ OR: [{ sellerClientId: null }, { sellerClientId: { not: clientId } }] }],
    OR: [{ intakeAgentId: { not: null } }, { assignedAgentId: { not: null } }, { createdById: { not: null } }],
  };
  /**
   * РАЙОН ИЛИ РАДИУС (блок D3): радиус кладём ТОЛЬКО в where.AND (D1) — вторым
   * where.OR он затёр бы условие хозяина выше. Без желаемых мест — район сужает
   * выборку как обычное поле.
   */
  const desiredPlaces = client.desiredPlaces ?? [];
  if (desiredPlaces.length > 0) {
    const districtOrRadius: Prisma.PropertyWhereInput[] = [];
    if (client.desiredDistrictId) districtOrRadius.push({ districtId: client.desiredDistrictId });
    districtOrRadius.push({
      lat: { not: null },
      lng: { not: null },
      OR: desiredPlaces.map((p) => pointBboxWhere(Number(p.lat), Number(p.lng), p.radiusM)),
    });
    where.AND = [...(Array.isArray(where.AND) ? where.AND : []), { OR: districtOrRadius }];
  } else if (client.desiredDistrictId) {
    where.districtId = client.desiredDistrictId;
  }

  const [properties, money, policy] = await Promise.all([
    prisma.property.findMany({
      where,
      select: { ...propertyMatchSelect, shortId: true, title: true, intakeAgentId: true, assignedAgentId: true, createdById: true },
      orderBy: { createdAt: "desc" },
      take: options.take ?? 300,
    }),
    loadMoneyContext(),
    loadMatchPolicy(),
  ]);

  return properties
    .flatMap((p) => {
      if (!clientPropertyEligible(client, p, money, policy)) return [];
      const match = matchClientProperty(client, p, money, policy);
      if (!match) return [];
      return [{
        propertyId: p.id,
        shortId: p.shortId,
        title: p.title,
        intakeAgentId: propertyOwnerAgentId(p) as string,
        score: match.points,
        reasons: match.reasons,
      }];
    })
    // Порядок и порог — по прежней шкале: распределение заявок сравнивает её с
    // порогом из Настроек, и подбор 2.0 не должен двигать его молча.
    .sort((a, b) => b.score - a.score || a.shortId - b.shortId);
}
