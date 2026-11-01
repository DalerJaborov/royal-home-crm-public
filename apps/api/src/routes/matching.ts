import type { MatchingClient, MatchingClientsResponse } from "@royal-home/shared";
import { MATCH_SCORE_WEIGHTS, propertyFieldShown } from "@royal-home/shared";
import type { Prisma } from "../generated/prisma/client.js";
import { prisma } from "../db.js";
import { loadMoneyContext, toTjs, type MoneyContext } from "../lib/money.js";
import { propertyOwnerAgentId } from "../lib/propertyOwner.js";
import { matchingPropertySellers } from "../lib/matchingOwnership.js";
import { currentBuyerMatchingCriteria } from "../lib/clientPropertyMatching.js";
import {
  budgetWindowTjs,
  clientRequirementsForPropertyWhere,
  loadMatchPolicy,
  waitingBuyerWhere,
  DEFAULT_MATCH_POLICY,
  type MatchPolicy,
} from "../lib/matchPolicy.js";
import {
  describeNearestPlace,
  nearestDesiredPlace,
  pointBboxWhere,
  MAX_DESIRED_PLACE_RADIUS_M,
  type DesiredPlacePoint,
  type NearestPlaceMatch,
} from "../lib/geoDistance.js";
import { propertyTypeMatches, type LeadRequirements } from "../lib/propertyTypeRule.js";

interface MatchableClient {
  budgetMin: unknown;
  budgetMax: unknown;
  /** Валюта бюджета клиента — не обязана совпадать с валютой объекта. */
  currency?: string | null;
  desiredDistrictId: string | null;
  desiredRooms: number | null;
  /** Тип жилья, который ищет клиент (propertyTypeMatches). Не выбран — любой. */
  desiredType?: string | null;
  /** Что именно ищет клиент — площадь и этаж (спецификация владельца 31.07.2026).
   *  Необязательные: старые вызовы этих полей не выбирают, и подбор тогда работает
   *  как раньше, а не отсеивает всё подряд. */
  desiredAreaMin?: number | null;
  desiredFloorMin?: number | null;
  desiredFloorMax?: number | null;
  desiredTotalFloors?: number | null;
  /** Желаемые места (12.09.2026, docs/geo-match-plan-12-09.md блок D) — те же
   *  правила, что и в lib/propertyMatchFilter.ts::ClientMatchCriteria. */
  desiredPlaces?: DesiredPlacePoint[] | null;
}

export interface MatchableProperty {
  id: string;
  price: unknown;
  /** Валюта цены объекта: в Душанбе жильё регулярно указывают в долларах. */
  currency?: string | null;
  // Закрытый объект (offSite) может остаться без района вовсе (владелец
  // 14.09.2026) — район как критерий подбора для него тогда не участвует.
  districtId: string | null;
  rooms: number | null;
  /** Тип объекта; не выбран в запросе — тип в подборе не участвует. */
  type?: string | null;
  areaSqm?: unknown;
  floor?: number | null;
  totalFloors?: number | null;
  /** Точка объекта — участвует в геоподборе (D3). null — только по району (D5). */
  lat?: unknown;
  lng?: unknown;
}

/**
 * РАЙОН ИЛИ РАДИУС — ЕДИНАЯ проверка (D3/D4 плана): используется и жёстким
 * фильтром (clientMatchesProperty), и шкалой баллов (scoreClientProperty), чтобы
 * не разъехаться так же, как уже разъехались площадь и этаж между этим файлом и
 * lib/propertyMatchFilter.ts. Объект без точки (D5) — только по району, радиус
 * не рассматривается вовсе.
 */
function districtOrRadiusMatch(
  client: MatchableClient,
  property: MatchableProperty
): { ok: boolean; nearest: NearestPlaceMatch | null } {
  const districtOk = !client.desiredDistrictId || client.desiredDistrictId === property.districtId;
  let nearest: NearestPlaceMatch | null = null;
  if (property.lat != null && property.lng != null && client.desiredPlaces?.length) {
    nearest = nearestDesiredPlace(Number(property.lat), Number(property.lng), client.desiredPlaces);
  }
  return { ok: districtOk || Boolean(nearest?.withinRadius), nearest };
}

/**
 * Сравнение цены с бюджетом идёт в ЕДИНОЙ валюте (сомони). Без приведения объект
 * за $50 000 «подходил» клиенту с бюджетом 50 000 сомони и наоборот — подбор и
 * счётчик спроса на карточке объекта показывали заведомый мусор.
 */
export function clientMatchesProperty(
  client: MatchableClient,
  property: MatchableProperty,
  money: MoneyContext,
  policy: MatchPolicy = DEFAULT_MATCH_POLICY
): boolean {
  // Район ИЛИ радиус (D3): объект «по радиусу, но из соседнего района» тоже
  // проходит — иначе «свой объект — свой клиент» (services/leads/assignment.ts)
  // и передача клиента (lib/clientTransfer.ts) никогда не увидят такое совпадение.
  if (!districtOrRadiusMatch(client, property).ok) return false;
  if (!propertyTypeMatches(client.desiredType, property.type)) return false;
  if (client.desiredRooms != null && property.rooms != null) {
    if (Math.abs(client.desiredRooms - property.rooms) > policy.roomsTolerance) return false;
  }
  /**
   * ПЛОЩАДЬ И ЭТАЖ — тоже условия подбора (спецификация владельца 31.07.2026).
   *
   * Пока этих полей не было, пожелания жили в свободных заметках и подбор их не
   * видел: человеку, просившему «не первый и не последний», предлагали первый этаж.
   *
   * Границы мягкие в ту же сторону, что у бюджета: −areaToleranceRatio по площади
   * (было зашито 0.9), потому что «хотя бы 60 квадратов» и 58 — это одно и то же
   * для живого человека, а вот этаж жёстко: просьба «не первый» не терпит округления.
   */
  if (client.desiredAreaMin != null && property.areaSqm != null) {
    if (Number(property.areaSqm) < client.desiredAreaMin * (1 - policy.areaToleranceRatio)) return false;
  }
  // Этаж — только у квартиры и коммерции; у дома его нет (propertyTypeFields.ts).
  const floorCounts = propertyFieldShown(property.type, "floor");
  if (floorCounts && client.desiredFloorMin != null && property.floor != null && property.floor < client.desiredFloorMin) return false;
  if (floorCounts && client.desiredFloorMax != null && property.floor != null && property.floor > client.desiredFloorMax) return false;
  if (
    client.desiredTotalFloors != null &&
    property.totalFloors != null &&
    property.totalFloors > client.desiredTotalFloors
  ) {
    return false;
  }

  const price = toTjs(property.price, property.currency, money);
  // Допуск бюджета — общей формулой (lib/matchPolicy.ts::budgetWindowTjs), той же, что у ботов.
  const { min, max } = budgetWindowTjs(
    client.budgetMin != null ? toTjs(client.budgetMin, client.currency, money) : null,
    client.budgetMax != null ? toTjs(client.budgetMax, client.currency, money) : null,
    policy
  );
  if (min != null && price < min) return false;
  if (max != null && price > max) return false;
  return true;
}

/** Что нужно от клиента, чтобы посчитать БЛИЗОСТЬ (а не только «проходит/нет»). */
interface ScorableClient extends MatchableClient {
  status?: string;
}

/** Веса шкалы совпадения — настраиваемые в Настройках (Путь покупателя, п.5.1:
 *  «точный алгоритм и веса критериев должны быть настраиваемыми в CRM»). */
export interface MatchWeights {
  base: number;
  district: number;
  rooms: number;
  budget: number;
  hotBonus: number;
  /** Расстояние до желаемого места клиента (12.09.2026, блок D3) — ОТДЕЛЬНЫЙ вес,
   *  district не трогает: иначе порог ownPropertyMatchThreshold начал бы уводить
   *  лиды между районами (см. docstring scoreClientProperty ниже). */
  distance: number;
}

/** Веса шкалы — константа с 01.11.2026 (MATCH_SCORE_WEIGHTS в packages/shared, значения прода;
 *  они же — числа, зашитые до рефакторинга 13.08.2026, см. matching-score.test.ts).
 *  Колонки Settings.matchScore* больше не читаются. */
export const DEFAULT_MATCH_WEIGHTS: MatchWeights = { ...MATCH_SCORE_WEIGHTS };

/** Веса шкалы совпадения. Асинхронная подпись оставлена ради вызывающих. */
export async function loadMatchWeights(): Promise<MatchWeights> {
  return { ...DEFAULT_MATCH_WEIGHTS };
}

/**
 * НАСКОЛЬКО точно клиент и объект подходят друг другу — 0..100 и человеческие
 * причины к каждому баллу.
 *
 * Вынесено из findMatchingClients 11.08.2026: та же шкала понадобилась
 * распределению лидов («отдать клиента хозяину подходящего объекта»), и вторая
 * реализация той же арифметики разошлась бы с первой — как это уже случилось с
 * лимитом активных лидов, написанным трижды.
 *
 * Считать имеет смысл только для пары, уже прошедшей clientMatchesProperty:
 * база означает «фильтр пройден», а не «сорок процентов похожести».
 *
 * weights необязателен и по умолчанию берёт DEFAULT_MATCH_WEIGHTS — так прямые
 * вызовы (тесты, разовые скрипты) не обязаны знать про Настройки. Оба вызывающих
 * в этом же файле грузят актуальные веса через loadMatchWeights() сами.
 */
export function scoreClientProperty(
  client: ScorableClient,
  property: MatchableProperty,
  money: MoneyContext,
  options: { includeHotBonus?: boolean; weights?: MatchWeights } = {}
): { score: number; reasons: string[] } {
  const { includeHotBonus = true, weights = DEFAULT_MATCH_WEIGHTS } = options;
  const reasons: string[] = [];
  let score = weights.base; // База: клиент вообще прошёл фильтр совпадения.

  const price = toTjs(property.price, property.currency, money);

  // Только НАЗВАННЫЙ район (О11, 02.10.2026): null === null — это «клиент район
  // не называл» и «у объекта района нет», а не совпадение.
  if (client.desiredDistrictId != null && client.desiredDistrictId === property.districtId) {
    score += weights.district;
    reasons.push("район совпал");
  }
  // Расстояние (12.09.2026, блок D3) — ОТДЕЛЬНЫЙ вес от района, начисляется
  // независимо от того, совпал ли район: клиент мог назвать ориентир в соседнем
  // районе, и объект там для него не менее подходящий.
  const { nearest } = districtOrRadiusMatch(client, property);
  if (nearest?.withinRadius) {
    score += weights.distance;
    reasons.push(nearest.label ? `рядом с «${nearest.label}» (${describeNearestPlace(nearest)})` : describeNearestPlace(nearest));
  }
  if (client.desiredRooms != null && property.rooms != null) {
    if (client.desiredRooms === property.rooms) {
      score += weights.rooms;
      reasons.push("комнат столько же");
    } else {
      // Разница в одну комнату проходит фильтр, но это уже компромисс.
      reasons.push(`искал ${client.desiredRooms}-комн`);
    }
  }
  const max = client.budgetMax != null ? toTjs(client.budgetMax, client.currency, money) : null;
  const min = client.budgetMin != null ? toTjs(client.budgetMin, client.currency, money) : null;
  if (max != null && price <= max && (min == null || price >= min)) {
    score += weights.budget;
    reasons.push("в бюджете");
  } else if (max != null && price > max) {
    // Прошёл только за счёт десятипроцентной растяжки — агент должен это знать
    // ДО звонка, иначе разговор начнётся с неприятного сюрприза о цене.
    reasons.push("чуть выше бюджета");
  }
  // Горячий клиент выше при прочих равных: ему уже звонили и он в работе.
  //
  // ПОЧЕМУ ЭТО ОТКЛЮЧАЕМО: бонус — свойство КЛИЕНТА, а не пары. Когда шкалой
  // сортируют клиентов у одного объекта (карточка объекта), он честно поднимает
  // горячих. Когда по той же шкале ищут ОБЪЕКТЫ под одного клиента, он одинаково
  // прибавляется всем кандидатам: порядок не меняет, а абсолютный балл сдвигает —
  // и порог «85 из 100» означал бы для горячего клиента совсем не то же, что для
  // обычного. Там его выключают.
  if (includeHotBonus && client.status === "HOT") score += weights.hotBonus;

  return { score: Math.min(100, score), reasons };
}

/** Считает, сколько ждущих клиентов ищут каждый объект (по desired-параметрам).
 *
 * 17.09.2026: раньше фильтровал по Client.status (воронка лида) — другое множество,
 * чем у автоподбора (workStatus) и списка «Кому подойдёт», отсюда «33 в спросе / 0
 * кому подходит» на одном и том же объекте. Теперь — то же waitingBuyerWhere, что и
 * у остальных двух потребителей (lib/matchPolicy.ts). */
export async function computeDemandCounts(properties: MatchableProperty[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (properties.length === 0) return counts;
  const sellers = await matchingPropertySellers(properties.map((property) => property.id));

  // Сужаем выборку до районов, реально представленных на этой странице объектов:
  // раньше на КАЖДУЮ отрисовку списка поднимались все активные клиенты компании,
  // хотя клиент из другого района не может дать совпадение ни по одному объекту.
  // Клиенты без указанного района подходят под любой — их берём всегда.
  const districtIds = [...new Set(properties.map((p) => p.districtId).filter((id): id is string => id != null))];
  // Гео-предфильтр (12.09.2026, блок D2): точки объектов этой страницы, у которых
  // они есть — грубый bbox с потолком MAX_DESIRED_PLACE_RADIUS_M вместо точного
  // радиуса каждого места (тот загрузится ниже вместе с самим клиентом).
  const propertyPoints = properties.filter((p) => p.lat != null && p.lng != null);

  const [policy, money] = await Promise.all([loadMatchPolicy(), loadMoneyContext()]);
  const waiting = waitingBuyerWhere(policy);
  const candidateClients = await prisma.client.findMany({
    where: {
      ...waiting,
      // Гео/район-предфильтр — объединяем через AND с условиями waitingBuyerWhere
      // (не top-level OR: тот уже занят бы был, реши waitingBuyerWhere когда-нибудь
      // его использовать, — безопаснее не полагаться на то, что он этого не делает).
      AND: [
        ...(Array.isArray(waiting.AND) ? waiting.AND : []),
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
    select: {
      id: true,
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
      desiredPlaces: { select: { lat: true, lng: true, radiusM: true, label: true } },
    },
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

/**
 * КТО именно ищет этот объект — и насколько точно он подходит.
 *
 * Счётчик спроса на карточке отвечал «трое ищут» и на этом заканчивался: чтобы
 * узнать, кто эти трое, агент шёл в список клиентов и перебирал фильтры руками. То
 * есть самая ценная подсказка системы требовала ручной работы ровно там, где её
 * пытались убрать.
 *
 * БЛИЗОСТЬ СЧИТАЕТСЯ, А НЕ ВЫДУМЫВАЕТСЯ. Три понятных признака, каждый из которых
 * агент проверил бы сам: район назван и совпал, комнаты названы и совпали точно,
 * цена попала внутрь бюджета без растяжки на 10%. Совпадение «в пределах допуска»
 * тоже совпадение — но оно слабее, и агент должен видеть разницу, а не гадать,
 * почему клиент с бюджетом «до 400 000» показан у объекта за 440 000.
 */
// Описан один раз в @royal-home/shared: его же читает карточка объекта.
export type { MatchingClient, MatchingClientsResponse };

/**
 * 17.09.2026: возвращает `{ items, total }`, а не голый массив (контракт для веба,
 * docs/match-policy-plan-17-09.md раздел 4) — `total` считает ВСЁ множество ждущих,
 * прошедших clientMatchesProperty, ДО среза `limit`; `items` — первые `limit` по
 * баллу. Раньше total и длина списка расходились с тем, что видел счётчик спроса
 * (computeDemandCounts), потому что оба фильтровали по-разному — теперь оба читают
 * waitingBuyerWhere(policy), и число должно совпасть на одном и том же наборе.
 */
export async function findMatchingClients(propertyId: string, limit = 10): Promise<MatchingClientsResponse> {
  const property = await prisma.property.findFirst({
    where: { id: propertyId, deletedAt: null },
    select: {
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
    },
  });
  if (!property) return { items: [], total: 0 };
  return findMatchingClientsForProperty(property, limit);
}

/**
 * То же, что findMatchingClients, но по признакам объекта, которого в базе ещё нет
 * (24.09.2026): собственник выложил объявление под нашим постом, и бот в первом же
 * письме говорит ему, сколько у нас покупателей ищут именно такое. Фильтр ровно
 * тот же, что у «Кому подойдёт» на карточке объекта, — второй копии правила нет.
 */
export async function findMatchingClientsForProperty(
  property: MatchableProperty,
  limit = 10
): Promise<MatchingClientsResponse> {
  const sellerClientId = (await matchingPropertySellers([property.id])).get(property.id);
  // Гео-предфильтр (блок D2): та же bbox-логика, что в notifyWaitingBuyersOfNewProperty
  // — грубый потолок MAX_DESIRED_PLACE_RADIUS_M, точный радиус каждого места
  // клиента уточняет nearestDesiredPlace в JS уже после выборки.
  const districtOrRadiusOr: Prisma.ClientWhereInput[] = [{ desiredDistrictId: property.districtId }, { desiredDistrictId: null }];
  if (property.lat != null && property.lng != null) {
    districtOrRadiusOr.push({
      desiredPlaces: { some: pointBboxWhere(Number(property.lat), Number(property.lng), MAX_DESIRED_PLACE_RADIUS_M) },
    });
  }

  const [policy, money, weights] = await Promise.all([loadMatchPolicy(), loadMoneyContext(), loadMatchWeights()]);
  const waiting = waitingBuyerWhere(policy);
  const clients = await prisma.client.findMany({
    where: {
      ...waiting,
      ...(sellerClientId ? { id: { not: sellerClientId } } : {}),
      AND: [
        ...(Array.isArray(waiting.AND) ? waiting.AND : []),
        { OR: districtOrRadiusOr },
        // Требования клиента к объекту — в запросе, ДО среза take ниже (О4,
        // 02.10.2026): точная проверка clientMatchesProperty остаётся, но срез
        // получает только тех, кто может подойти, а не первых попавшихся.
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
      // Имя агента (17.09.2026, план раздел 6, «Одна функция «Подбор»») — панель
      // подбора на карточке объекта показывает его в строке кандидата без
      // второго запроса; select узкий, тянем только fullName.
      assignedAgent: { select: { fullName: true } },
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
      desiredPlaces: { select: { lat: true, lng: true, radiusM: true, label: true } },
    },
    // Потолок выборки: активных покупателей у агентства сотни, а показать нужно
    // единицы. Берём с запасом и режем ПОСЛЕ сортировки по близости (D2) —
    // orderBy ниже не даёт срезу отдать произвольные N строк вместо лучших.
    orderBy: { createdAt: "desc" },
    take: 300,
  });

  const matched = clients
    .filter((c) => clientMatchesProperty(c, property, money, policy))
    .map((c) => {
      const { score, reasons } = scoreClientProperty(c, property, money, { weights });
      return {
        id: c.id,
        shortId: c.shortId,
        fullName: c.fullName,
        status: c.status,
        workStatus: c.workStatus,
        inactiveLevel: c.inactiveLevel,
        assignedAgentId: c.assignedAgentId,
        assignedAgentName: c.assignedAgent?.fullName ?? null,
        score,
        reasons,
      };
    })
    .sort((a, b) => b.score - a.score || a.fullName.localeCompare(b.fullName));

  return { items: matched.slice(0, limit), total: matched.length };
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
  score: number;
  reasons: string[];
}

/**
 * Какие объекты подходят этому клиенту — и чьи они.
 *
 * Обратная сторона findMatchingClients: там искали людей под объект, здесь —
 * объекты под человека. Нужна распределению лидов (решение владельца 11.08.2026:
 * «свой объект — свой клиент»), поэтому в выдаче только объекты С ХОЗЯИНОМ.
 * Хозяин — не обязательно интейкер: `propertyOwnerAgentId` (11.09.2026) считает
 * его как `intakeAgentId ?? assignedAgentId ?? createdById`, чтобы объект без
 * интейкера, но с назначенным риелтором или хотя бы с тем, кто завёл карточку,
 * тоже приносил лид своему хозяину, а не пропадал из подбора молча.
 *
 * Берём только AVAILABLE. Объект в конвейере подготовки (фото ещё не сняты,
 * видео не смонтировано) агенту принадлежит, но показать его клиенту нельзя —
 * лид, выданный под непоказываемый объект, кончился бы разговором ни о чём.
 */
export async function findMatchingPropertiesForClient(
  clientId: string,
  options: {
    take?: number;
    /**
     * ЗАПРОС, ЕЩЁ НЕ ЗАПИСАННЫЙ В КАРТОЧКУ (24.09.2026). Разбор звонка выбирает
     * агента до того, как запишет бюджет, район и комнаты: без этого подбор
     * читал пустую карточку нового звонящего, и правило «запрос совпал с
     * объектом» у звонков не срабатывало никогда. Заданные поля перекрывают
     * карточку, незаданные берутся из неё.
     */
    requirements?: LeadRequirements;
  } = {}
): Promise<MatchedProperty[]> {
  const stored = await prisma.client.findFirst({
    where: { id: clientId, deletedAt: null },
    select: {
      requirementsFieldsKind: true,
      requirementsNotes: true,
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
      desiredPlaces: { select: { lat: true, lng: true, radiusM: true, label: true } },
    },
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
    // Хозяин хоть в каком-то из трёх полей — иначе объект без интейкера, но
    // с риелтором или создателем, молча выпадал бы из подбора.
    OR: [{ intakeAgentId: { not: null } }, { assignedAgentId: { not: null } }, { createdById: { not: null } }],
  };
  /**
   * РАЙОН ИЛИ РАДИУС (блок D3): та же логика, что в buildPropertyMatchWhere и
   * notifyWaitingBuyersOfNewProperty — единый источник, не третья реализация.
   * Радиус кладём ТОЛЬКО в where.AND (D1) — вторым where.OR он затёр бы условие
   * хозяина выше. Без желаемых мест — район сужает выборку как раньше (обычное
   * поле, не OR): иначе на каждый лид поднимался бы весь фонд агентства.
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

  const [properties, money, weights, policy] = await Promise.all([
    prisma.property.findMany({
      where,
      select: {
        id: true,
        shortId: true,
        title: true,
        price: true,
        currency: true,
        districtId: true,
        rooms: true,
        type: true,
        areaSqm: true,
        floor: true,
        totalFloors: true,
        intakeAgentId: true,
        assignedAgentId: true,
        createdById: true,
        lat: true,
        lng: true,
      },
      // Тот же потолок, что у обратного подбора: выбираем с запасом и режем
      // после сортировки по близости (D2) — orderBy делает срез детерминированным
      // вместо произвольного порядка Postgres.
      orderBy: { createdAt: "desc" },
      take: options.take ?? 300,
    }),
    loadMoneyContext(),
    loadMatchWeights(),
    loadMatchPolicy(),
  ]);

  return properties
    .filter((p) => clientMatchesProperty(client, p, money, policy))
    .map((p) => {
      // Без HOT-бонуса: он про клиента, а не про пару, и одинаково поднял бы все
      // объекты разом, сместив абсолютный балл относительно порога в Настройках.
      const { score, reasons } = scoreClientProperty(client, p, money, { includeHotBonus: false, weights });
      return {
        propertyId: p.id,
        shortId: p.shortId,
        title: p.title,
        intakeAgentId: propertyOwnerAgentId(p) as string,
        score,
        reasons,
      };
    })
    .sort((a, b) => b.score - a.score || a.shortId - b.shortId);
}
