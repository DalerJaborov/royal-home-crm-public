/**
 * Общий SQL-фильтр «объект подходит клиенту» — бюджет/район/тип/комнаты.
 *
 * Вынесено из routes/clients/matching.ts (GET /:id/match), где раньше было
 * зашито прямо в роуте. Второе место использования — реверс-подбор «объект
 * появился, кому из ждущих покупателей он подходит»
 * (см. docs/auto-match-alert-plan-31-08-2026.md) — фильтр должен быть ровно
 * тем же самым, иначе агент увидит расхождение между «Подбором» на карточке
 * клиента и автопушем на новый объект.
 */
import { propertyTypesWithoutField } from "@royal-home/shared";
import type { Prisma } from "../generated/prisma/client.js";
import { prisma } from "../db.js";
import { recordInterest } from "./propertyInterest.js";
import { loadMoneyContext, type MoneyContext } from "./money.js";
import { sendPushToAgent } from "../push.js";
import { dushanbeEndOfDay } from "./dushanbeTime.js";
import {
  budgetWindowTjs,
  clientRequirementsForPropertyWhere,
  loadMatchPolicy,
  waitingBuyerWhere,
  DEFAULT_MATCH_POLICY,
  type MatchPolicy,
} from "./matchPolicy.js";
import { logTimeline } from "./timeline.js";
import { logSystemError } from "./systemError.js";
import {
  describeNearestPlace,
  nearestDesiredPlace,
  pointBboxWhere,
  MAX_DESIRED_PLACE_RADIUS_M,
  type DesiredPlacePoint,
} from "./geoDistance.js";

/** Подмножество полей Client, от которых зависит фильтр — те же, что читает /:id/match. */
export interface ClientMatchCriteria {
  budgetMin: Prisma.Decimal | number | null;
  budgetMax: Prisma.Decimal | number | null;
  currency: string;
  desiredDistrictId: string | null;
  desiredType: string | null;
  desiredRooms: number | null;
  /**
   * ПЛОЩАДЬ И ЭТАЖ (владелец 09.09.2026: подбор идёт по району, адресу, этажности,
   * площади и цене).
   *
   * Поля в схеме есть с 31.07.2026, и обратный подбор («объект → кому подходит»,
   * routes/matching.ts, clientMatchesProperty) их учитывал. А ЭТОТ фильтр — прямой
   * («клиент → какие объекты подходят»), тот самый, что стоит за «Подбором» на
   * карточке и за автопушем на новый объект, — не учитывал. Ровно то расхождение,
   * от которого этот модуль и заводили: человеку, просившему «не первый и не
   * последний», подбор предлагал первый этаж.
   *
   * Необязательные: старые вызовы этих полей не выбирают, и подбор тогда работает
   * как раньше, а не отсекает всё подряд.
   */
  desiredAreaMin?: number | null;
  desiredFloorMin?: number | null;
  desiredFloorMax?: number | null;
  desiredTotalFloors?: number | null;
  /**
   * ЖЕЛАЕМЫЕ МЕСТА (12.09.2026, docs/geo-match-plan-12-09.md блок D) — координата
   * + радиус, ClientDesiredPlace. Необязательное: старые вызовы (тесты, разовые
   * скрипты) его не передают, и радиус в подборе просто не участвует — район
   * остаётся единственным гео-критерием, как раньше.
   */
  desiredPlaces?: DesiredPlacePoint[] | null;
}

/**
 * where-условие для Property, подходящих под требования клиента.
 *
 * money — передаётся снаружи (не грузится внутри), чтобы реверс-подбор по
 * многим клиентам на один новый объект не тянул курс из настроек в каждой
 * итерации — тот же приём, что и с deadlines в propertyPipeline.ts.
 */
export function buildPropertyMatchWhere(
  client: ClientMatchCriteria,
  money: MoneyContext,
  policy: MatchPolicy = DEFAULT_MATCH_POLICY
): Prisma.PropertyWhereInput {
  /**
   * ОБЪЕКТ «ТОЛЬКО В CRM» ТЕПЕРЬ УЧАСТВУЕТ В ПОДБОРЕ (владелец 09.09.2026) — это
   * отмена части правила от 18.08.2026. Такой объект и раньше лежал в разделе
   * «Объекты», был виден всем агентам и отправлялся клиенту приватной ссылкой; из
   * подбора он исключался, и агент должен был вспомнить про него сам. Инвариант
   * «на сайт никогда» при этом остаётся в силе (lib/siteSync.ts).
   *
   * Порог материалов такому объекту теперь тоже обязателен: он проходит этап
   * «ожидает фото» (routes/properties/crud.ts), поэтому в AVAILABLE попадает
   * только с шестью снимками — пустых карточек подбор не предложит.
   */
  const where: Prisma.PropertyWhereInput = { status: "AVAILABLE", deletedAt: null };
  const and: Prisma.PropertyWhereInput[] = [];

  if (client.budgetMin || client.budgetMax) {
    // Бюджет клиента и цена объекта бывают в разных валютах — границы пересчитываем
    // ОТДЕЛЬНО для каждой валюты и объединяем через OR (см. комментарий в
    // routes/clients/matching.ts — тот же расчёт, цифры должны сходиться).
    const bounds = (rate: number) => {
      const range: Prisma.DecimalFilter = {};
      if (client.budgetMin) range.gte = (Number(client.budgetMin) * (1 - policy.budgetToleranceRatio)) / rate;
      if (client.budgetMax) range.lte = (Number(client.budgetMax) * (1 + policy.budgetToleranceRatio)) / rate;
      return range;
    };
    const clientRate = client.currency === "USD" ? money.usdToTjs : 1;
    // ВНИМАНИЕ (docs/geo-match-plan-12-09.md, блок D1): where.OR уже занят бюджетом.
    // Радиус ниже поэтому кладётся ТОЛЬКО в where.AND — вторым where.OR он молча
    // затёр бы этот фильтр, и подбор начал бы предлагать объекты любой цены.
    where.OR = [
      { currency: "TJS", price: bounds(1 / clientRate) },
      { currency: "USD", price: bounds(money.usdToTjs / clientRate) },
    ];
  }
  // Тип жилья — строго, без соседних значений (человеку с участком квартира не нужна).
  // То же правило в памяти — lib/propertyTypeRule.ts (подбор для раздачи).
  if (client.desiredType) where.type = client.desiredType as Prisma.PropertyWhereInput["type"];
  if (client.desiredRooms) {
    where.rooms = { gte: client.desiredRooms - policy.roomsTolerance, lte: client.desiredRooms + policy.roomsTolerance };
  }

  /**
   * РАЙОН И РАДИУС — РАЗНЫЕ ПУТИ К СОВПАДЕНИЮ (12.09.2026, блок D3 плана), не
   * ужесточение друг друга. Клиент мог назвать ориентир («у ЦУМа»), а объект
   * рядом встать в СОСЕДНЕМ районе — до этой правки он не проходил фильтр вовсе,
   * хотя по факту то самое совпадение, ради которого модель ClientDesiredPlace и
   * заводилась. Поэтому: нет желаемых мест — район работает как раньше, простым
   * равенством; есть места — район ИЛИ попадание в радиус любого места.
   *
   * Объект без координат (D5): в радиусный путь не попадает никогда — только по
   * району, если он назван. bbox здесь — грубый SQL-предфильтр (боевой пример
   * D2), точное расстояние досчитывает nearestDesiredPlace в JS у каждого
   * вызывающего, где оно нужно для сортировки/подписи.
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
    and.push({ OR: districtOrRadius });
  } else if (client.desiredDistrictId) {
    where.districtId = client.desiredDistrictId;
  }

  /**
   * Границы ровно те же, что в обратном подборе (routes/matching.ts,
   * clientMatchesProperty) — иначе два места опять разъедутся: площадь мягко,
   * −10% («хотя бы 60 квадратов» и 58 — для живого человека одно и то же), этаж
   * жёстко (просьба «не первый» округления не терпит).
   *
   * ОБЪЕКТЫ С НЕЗАПОЛНЕННЫМ ПОЛЕМ ОСТАЮТСЯ В ВЫДАЧЕ. floor и totalFloors в схеме
   * необязательны, и `{ gte: N }` в SQL молча выбрасывает строки с NULL. Дом без
   * указанной этажности — это пробел в карточке объекта, а не отказ клиенту:
   * прятать его от подбора значит наказывать покупателя за чужую недозаполненную
   * карточку. Поэтому каждое условие — OR с `null`.
   */
  if (client.desiredAreaMin != null) {
    and.push({ areaSqm: { gte: client.desiredAreaMin * (1 - policy.areaToleranceRatio) } });
  }
  // У дома и участка этажа нет (propertyTypeFields.ts): этаж старой карточки
  // дома не должен прятать его от покупателя с «не выше 3-го».
  const noFloorTypes = propertyTypesWithoutField("floor") as Prisma.PropertyWhereInput["type"][];
  if (client.desiredFloorMin != null) {
    and.push({ OR: [{ floor: null }, { type: { in: noFloorTypes as never } }, { floor: { gte: client.desiredFloorMin } }] });
  }
  if (client.desiredFloorMax != null) {
    and.push({ OR: [{ floor: null }, { type: { in: noFloorTypes as never } }, { floor: { lte: client.desiredFloorMax } }] });
  }
  if (client.desiredTotalFloors != null) {
    and.push({ OR: [{ totalFloors: null }, { totalFloors: { lte: client.desiredTotalFloors } }] });
  }
  if (and.length > 0) where.AND = and;

  return where;
}

/** Ближайшее желаемое место клиента к точке объекта — экспортируется, чтобы
 *  вызывающий (GET /:id/match) мог досчитать точное расстояние и отсортировать
 *  bbox-предфильтрованную выборку ПЕРЕД срезом (D2), а не после. */
export function nearestClientPlace(
  property: { lat: Prisma.Decimal | number | null; lng: Prisma.Decimal | number | null },
  client: Pick<ClientMatchCriteria, "desiredPlaces">
) {
  if (property.lat == null || property.lng == null) return null;
  const places = client.desiredPlaces ?? [];
  if (places.length === 0) return null;
  return nearestDesiredPlace(Number(property.lat), Number(property.lng), places);
}

export { describeNearestPlace };

export { loadMoneyContext };

/**
 * АВТОУВЕДОМЛЕНИЕ АГЕНТА: новый/вернувшийся в продажу объект подошёл ждущему покупателю
 * (docs/auto-match-alert-plan-31-08-2026.md). Вызывается ПОСЛЕ того, как Property реально
 * встал в status=AVAILABLE — сама эта функция статус не проверяет и не меняет.
 *
 * КОГО СЧИТАЕМ «ЖДУЩИМ» (владелец не зафиксировал точный список условий, см. открытый
 * вопрос №1 плана) — временное решение: BUYER, workStatus ACTIVE/INACTIVE/DEFERRED
 * (расширено 12.09.2026, см. следующий абзац), не в «Переговорах» (там уже занят
 * другим объектом) и с ЗАПОЛНЕННЫМ хоть одним требованием, включая желаемое место
 * (иначе под фильтр попадает вообще любой ждущий покупатель без единой заданной
 * цифры). Поправить здесь, если после первого запуска в проде владелец уточнит
 * список иначе.
 *
 * ПОТЕРЯННЫЕ, НЕАКТИВНЫЕ, ОТЛОЖЕННЫЕ (12.09.2026, docs/geo-match-plan-12-09.md
 * блок D6) — ИМЕННО РАДИ НИХ функция и затевалась (владелец: клиент искал у ЦУМа,
 * объекта тогда не было, месяц спустя другой агент завёл подходящий — агенту-
 * владельцу клиента должно прилететь напоминание позвонить). workStatus
 * расширен с ACTIVE на ACTIVE/INACTIVE/DEFERRED. ОТЛОЖЕННЫЕ (DEFERRED) идут не
 * обычным групповым пушем ниже, а собственным срочным сигналом — задачей
 * «перезвонить сегодня» плюс отдельным (не сгруппированным) пушем: план прямо
 * требует «звонок в тот же день, а не по таймеру», и общий список группового
 * уведомления наравне с рядовыми совпадениями этого не даёт (агент видит
 * дальше третьего имени как «и ещё N» — отложенный клиент не имеет права
 * потеряться в этом хвосте).
 *
 * ДЕДУП — БЕЗ ОТДЕЛЬНОЙ ТАБЛИЦЫ (открытый вопрос №2 плана): проверяем, нет ли уже
 * SYSTEM-записи с этим маркером для пары клиент+объект в хронологии клиента. Дешевле
 * миграции и достаточно: повторно уведомлять о той же паре не нужно, а сам объект
 * возвращается в AVAILABLE не бесконечно часто. К workStatus клиента дедуп не
 * привязан — подходит для отложенных без переделки.
 *
 * СНИЖЕНИЕ ЦЕНЫ — ИСКЛЮЧЕНИЕ ИЗ ДЕДУПА (решение владельца 12.09.2026, «все да» п.5,
 * см. docs/archive/handoff-geo-12-09.md): дедуп по паре клиент+объект не абсолютный — цена
 * автоподбора запоминается в Interaction.matchNotifiedPriceTjs, и если объект с тех
 * пор подешевел на PRICE_DROP_RENOTIFY_RATIO и больше, клиента уведомляем заново.
 * Сравниваем с ПОСЛЕДНЕЙ записью на пару (а не с первой) — иначе второе падение цены
 * подряд не пересекло бы порог от уже устаревшей цифры.
 */
const AUTO_MATCH_MARKER = "Автоподбор:";

/** `lastPriceTjs` — цена (в сомони) последнего автоподбора этому клиенту по этому
 *  объекту; `null` означает запись до миграции (цена не сохранена) — в этом случае
 *  падение недоказуемо, дедуп молчит, как и раньше. ratio — policy.priceDropRenotifyRatio
 *  (17.09.2026: было зашито PRICE_DROP_RENOTIFY_RATIO=0.05, теперь настраивается). */
function isPriceDropRenotify(lastPriceTjs: number | null, currentPriceTjs: number, ratio: number): boolean {
  if (lastPriceTjs === null || lastPriceTjs <= 0) return false;
  return (lastPriceTjs - currentPriceTjs) / lastPriceTjs >= ratio;
}

export interface NewlyAvailableProperty {
  id: string;
  shortId: number;
  title: string;
  // Закрытый объект (offSite) может остаться без района вовсе (владелец
  // 14.09.2026) — тогда OR ниже ищет только клиентов без предпочтения по
  // району/радиусу вокруг точки, район как критерий просто не участвует.
  districtId: string | null;
  type: string;
  rooms: number | null;
  price: Prisma.Decimal | number;
  currency: string;
  /** Площадь и этаж — те же условия, что в прямом подборе (см. ClientMatchCriteria). */
  areaSqm?: Prisma.Decimal | number | null;
  floor?: number | null;
  totalFloors?: number | null;
  /** Точка объекта (12.09.2026, блок D) — участвует в РАСШИРЕНИИ фильтра района
   *  радиусом. null — объект без координат участвует ТОЛЬКО по району (D5). */
  lat?: Prisma.Decimal | number | null;
  lng?: Prisma.Decimal | number | null;
}

export async function notifyWaitingBuyersOfNewProperty(property: NewlyAvailableProperty): Promise<void> {
  const policy = await loadMatchPolicy();
  // Общий рубильник (17.09.2026, Настройки → «Подбор объектов»): выключен — автопуш
  // молчит целиком, список «Кому подойдёт» и счётчик спроса он не затрагивает (это
  // ручной просмотр, не рассылка).
  if (!policy.autoMatchEnabled) return;
  const money = await loadMoneyContext();
  const hasPoint = property.lat != null && property.lng != null;
  const propertyLat = hasPoint ? Number(property.lat) : null;
  const propertyLng = hasPoint ? Number(property.lng) : null;


  /**
   * РАЙОН ИЛИ РАДИУС (блок D3/D4 — та же логика, что в buildPropertyMatchWhere,
   * НЕ вторая реализация: там где.AND строится по клиенту, здесь по объекту, но
   * правило одно и то же: «объект по радиусу, но из соседнего района» тоже
   * должен пройти). bbox по точке объекта — грубый SQL-предфильтр c потолком
   * MAX_DESIRED_PLACE_RADIUS_M (точный радиус каждого места клиента здесь ещё не
   * загружен — уточняет nearestDesiredPlace в JS ниже, после выборки).
   */
  const districtOrRadiusOr: Prisma.ClientWhereInput[] = [
    { desiredDistrictId: null },
    { desiredDistrictId: property.districtId },
  ];
  if (hasPoint) {
    districtOrRadiusOr.push({
      desiredPlaces: { some: pointBboxWhere(propertyLat!, propertyLng!, MAX_DESIRED_PLACE_RADIUS_M) },
    });
  }

  /**
   * ЕДИНОЕ ОПРЕДЕЛЕНИЕ «ЖДУЩЕГО» (17.09.2026, lib/matchPolicy.ts::waitingBuyerWhere) —
   * kind/deletedAt/workStatus/buyerStage/срок жизни/«хоть одно требование заполнено»
   * теперь читаются оттуда же, откуда их читают computeDemandCounts и
   * findMatchingClients: одна и та же строка на всех трёх потребителей вместо трёх
   * подряд разошедшихся копий. Здесь поверх — то, что специфично именно автопушу:
   * назначенный агент (пушить некому без него), район/радиус объекта и тип/комнаты.
   */
  const waiting = waitingBuyerWhere(policy);
  const candidates = await prisma.client.findMany({
    where: {
      ...waiting,
      assignedAgentId: { not: null },
      OR: districtOrRadiusOr,
      AND: [
        ...(Array.isArray(waiting.AND) ? waiting.AND : []),
        // Тип, комнаты, площадь, этаж и бюджет — в запросе, ДО среза take ниже
        // (О4, 02.10.2026), с допусками политики, а не числами в коде.
        ...clientRequirementsForPropertyWhere(property, money.usdToTjs, policy),
      ],
    },
    select: {
      id: true,
      shortId: true,
      fullName: true,
      assignedAgentId: true,
      workStatus: true,
      desiredDistrictId: true,
      budgetMin: true,
      budgetMax: true,
      currency: true,
      desiredAreaMin: true,
      desiredFloorMin: true,
      desiredFloorMax: true,
      desiredTotalFloors: true,
      desiredPlaces: { select: { lat: true, lng: true, radiusM: true, label: true } },
    },
    // orderBy + предупреждение о срезе (18.09.2026, docs/match-geo-analysis-18-09.md
    // п.4.5) — раньше `take: 200` был без сортировки: при широком фильтре (частый
    // район+тип+комнаты) часть ждущих клиентов молча выпадала бы из уведомления, и
    // это никак не было видно. Сортировка не решает переполнение, но делает его
    // детерминированным и заметным.
    orderBy: { createdAt: "asc" },
    take: 200,
  });
  if (candidates.length === 200) {
    void logSystemError(
      "matching",
      `Автоподбор объекта №${property.shortId}: кандидатов-клиентов ≥200, список обрезан лимитом`
    );
  }
  if (candidates.length === 0) return;

  // Бюджет — в JS, не в SQL: значений мало (фильтр выше уже сузил список), а конверсия
  // валюты клиента и валюты объекта в TJS с допуском политики — та же формула, что и в
  // buildPropertyMatchWhere, только записанная в обратную сторону (там границы объекта
  // считались от бюджета клиента, здесь — цена объекта проверяется против бюджета).
  const priceTjs = property.currency === "USD" ? Number(property.price) * money.usdToTjs : Number(property.price);
  const area = property.areaSqm != null ? Number(property.areaSqm) : null;
  const withDistance: Array<(typeof candidates)[number] & { nearestPlace: ReturnType<typeof nearestDesiredPlace> }> = [];
  for (const c of candidates) {
    // Те же границы, что в buildPropertyMatchWhere: пустое поле объекта не отсеивает.
    if (c.desiredAreaMin != null && area != null && area < c.desiredAreaMin * (1 - policy.areaToleranceRatio)) continue;
    if (c.desiredFloorMin != null && property.floor != null && property.floor < c.desiredFloorMin) continue;
    if (c.desiredFloorMax != null && property.floor != null && property.floor > c.desiredFloorMax) continue;
    if (c.desiredTotalFloors != null && property.totalFloors != null && property.totalFloors > c.desiredTotalFloors) {
      continue;
    }
    const bMinTjs = c.budgetMin ? (c.currency === "USD" ? Number(c.budgetMin) * money.usdToTjs : Number(c.budgetMin)) : null;
    const bMaxTjs = c.budgetMax ? (c.currency === "USD" ? Number(c.budgetMax) * money.usdToTjs : Number(c.budgetMax)) : null;
    // Допуск — общей формулой (lib/matchPolicy.ts::budgetWindowTjs), той же, что у ботов.
    const window = budgetWindowTjs(bMinTjs, bMaxTjs, policy);
    if (window.min !== null && window.min > priceTjs) continue;
    if (window.max !== null && window.max < priceTjs) continue;

    // РАЙОН ИЛИ РАДИУС — точная проверка (SQL выше был грубым предфильтром).
    // Объект без точки (D5): радиус не рассматриваем вовсе, только район.
    const districtOk = c.desiredDistrictId == null || c.desiredDistrictId === property.districtId;
    let nearestPlace: ReturnType<typeof nearestDesiredPlace> = null;
    if (hasPoint && c.desiredPlaces.length > 0) {
      nearestPlace = nearestDesiredPlace(propertyLat!, propertyLng!, c.desiredPlaces);
    }
    if (!districtOk && !nearestPlace?.withinRadius) continue;

    withDistance.push({ ...c, nearestPlace });
  }
  if (withDistance.length === 0) return;

  // desc: первая запись на клиента в Map ниже — самая свежая (см. докстрока про
  // «сравниваем с последней записью»).
  //
  // ДЕДУП БЕЗ ПАРСИНГА ТЕКСТА (17.09.2026, решение владельца) — раньше пара
  // клиент+объект узнавалась ТОЛЬКО по префиксу заметки (`notes.startsWith`),
  // то есть парсингом текста хронологии. Теперь основной путь — данные:
  // `matchNotifiedPriceTjs IS NOT NULL` (это поле пишет только автоподбор, см.
  // create ниже). Префикс оставлен ВТОРЫМ условием через OR исключительно ради
  // записей ДО миграции 14.09.2026 (`matchNotifiedPriceTjs` тогда ещё не было) —
  // без него старые записи перестали бы гасить повтор и агенты получили бы
  // задвоенные уведомления по уже виденным объектам.
  //
  // ГОНКА ДЕДУПА (18.09.2026, docs/match-geo-analysis-18-09.md п.4.1) — эту функцию
  // зовут из пяти независимых мест (propertyPipeline/dealReservation/deals/crud) плюс
  // ночной sweep на тот же объект. Раньше проверка «уже уведомляли» (SELECT) и запись
  // маркера (INSERT через logTimeline) не были атомарны: два почти одновременных
  // вызова на ОДИН объект могли оба пройти проверку до того, как любой успел вставить
  // строку, и агент получал дубль пуша. pg_advisory_xact_lock по propertyId
  // сериализует конкурентные вызовы ровно на этот объект (разные объекты продолжают
  // обрабатываться параллельно), держится только на время транзакции и снимается сам
  // при коммите/откате — безопасно с пулом соединений Prisma, в отличие от
  // pg_advisory_lock/unlock вне транзакции (там лок и снятие лока рискуют попасть на
  // разные соединения пула).
  // Транзакция целиком обёрнута в try/catch (а не .catch на каждой вставке, как
  // раньше): при ошибке где-то в середине партии откат должен быть всей партии —
  // частичная запись (часть клиентов уведомлена, часть нет из-за сбоя) хуже, чем
  // отложить всех до следующего вызова (событие/ночной sweep повторят попытку).
  // Как и раньше, ошибка не пробрасывается наверх — вызывающие зовут эту функцию
  // fire-and-forget (`void notifyWaitingBuyersOfNewProperty(...)`).
  let toNotify: Array<
    (typeof withDistance)[number] & { isPriceDrop: boolean }
  >;
  try {
    toNotify = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${property.id}))`;

    const already = await tx.interaction.findMany({
      where: {
        propertyId: property.id,
        clientId: { in: withDistance.map((c) => c.id) },
        type: "SYSTEM",
        OR: [{ matchNotifiedPriceTjs: { not: null } }, { notes: { startsWith: AUTO_MATCH_MARKER } }],
      },
      select: { clientId: true, matchNotifiedPriceTjs: true },
      orderBy: { createdAt: "desc" },
    });
    const lastNotifiedPriceTjs = new Map<string, number | null>();
    for (const a of already) {
      if (!lastNotifiedPriceTjs.has(a.clientId)) {
        lastNotifiedPriceTjs.set(a.clientId, a.matchNotifiedPriceTjs != null ? Number(a.matchNotifiedPriceTjs) : null);
      }
    }
    const toNotifyList = withDistance
      .filter(
        (c) =>
          !lastNotifiedPriceTjs.has(c.id) ||
          isPriceDropRenotify(lastNotifiedPriceTjs.get(c.id)!, priceTjs, policy.priceDropRenotifyRatio)
      )
      .map((c) => ({ ...c, isPriceDrop: lastNotifiedPriceTjs.has(c.id) }));
    if (toNotifyList.length === 0) return toNotifyList;

    // Запись в хронологию — ОДНА НА КЛИЕНТА, как и раньше: агент должен видеть у
    // каждого конкретного клиента, что объект ему подходил, независимо от того, как
    // сгруппирован пуш ниже. Расстояние — в тексте (блок E0), когда оно есть.
    // Внутри лока: та же транзакция, что и дедуп-проверка выше, — вставка и есть тот
    // самый маркер, чью гонку с параллельным вызовом мы устраняем.
    for (const client of toNotifyList) {
      const distanceSuffix = client.nearestPlace ? ` — ${describeNearestPlace(client.nearestPlace)}` : "";
      const note = client.isPriceDrop
        ? `${AUTO_MATCH_MARKER} снижена цена на подходящем объекте №${property.shortId} — ${property.title} — для клиента №${client.shortId}${distanceSuffix}`
        : `${AUTO_MATCH_MARKER} появился подходящий объект №${property.shortId} — ${property.title} — для клиента №${client.shortId}${distanceSuffix}`;
      // Автоподбор — это алгоритм, не решение агента: раньше запись подписывалась
      // ответственным (client.assignedAgentId), хотя он к подбору не притрагивался
      // (П-10, 17.09.2026). subjectAgentId сохраняет задачу видимой в его работе.
      await logTimeline({
        clientId: client.id,
        actor: { kind: "ai", source: "property-match-filter", subjectAgentId: client.assignedAgentId ?? null },
        type: "SYSTEM",
        propertyId: property.id,
        notes: note,
        matchNotifiedPriceTjs: priceTjs,
        // ОТЛОЖЕННЫЙ клиент — задача «перезвонить сегодня» (план: «звонок в тот
        // же день, а не по таймеру»), а не молчаливая строка в хронологии.
        ...(client.workStatus === "DEFERRED"
          ? {
              nextAction: `Позвонить — появился подходящий объект №${property.shortId}`,
              nextActionDate: dushanbeEndOfDay(new Date()),
            }
          : {}),
        tx,
      });
    }
    return toNotifyList;
    });
  } catch (err) {
    console.error("[автоподбор] дедуп/запись хронологии:", err instanceof Error ? err.message : err);
    void logSystemError(
      "matching",
      `Автоподбор объекта №${property.shortId}: транзакция дедупа упала — ${err instanceof Error ? err.message : String(err)}`
    );
    return;
  }
  if (toNotify.length === 0) return;

  // Сигнал интереса — вне транзакции: не часть дедупа, ошибка здесь не должна
  // откатывать уже подтверждённую запись маркера.
  for (const client of toNotify) {
    /**
     * Самый слабый из сигналов интереса (вес 1, см. lib/propertyInterest.ts):
     * подошёл под фильтр — ещё не значит, что человек посмотрел. Но он показывает
     * ГЛУБИНУ рынка под объект: сколько ждущих покупателей вообще на него есть.
     */
    void recordInterest(property.id, "MATCH_SENT", client.id);
  }

  // ОТЛОЖЕННЫЕ — собственный срочный пуш, НЕ в общей группировке ниже (см.
  // докстрока функции): агент не должен искать отложенного клиента в хвосте
  // «и ещё N» обычного группового уведомления.
  const deferred = toNotify.filter((c) => c.workStatus === "DEFERRED");
  for (const client of deferred) {
    const distanceSuffix = client.nearestPlace ? ` — ${describeNearestPlace(client.nearestPlace)}` : "";
    void sendPushToAgent(client.assignedAgentId!, {
      title: client.isPriceDrop ? "📍 Отложенному клиенту — снижена цена" : "📍 Отложенному клиенту — подходящий объект",
      body: `№${property.shortId} — ${property.title} — подходит клиенту №${client.shortId} ${client.fullName}${distanceSuffix}. Позвоните сегодня.`,
      url: `/clients/${client.shortId}`,
      tag: `match-alert-deferred-${client.id}-${property.id}`,
      kind: "look",
    }).catch((err) => {
      // 18.09.2026 (docs/match-geo-analysis-18-09.md п.4.2): маркер дедупа в
      // хронологии уже записан ВЫШЕ, до отправки пуша, — если пуш не дойдёт,
      // клиент по этому объекту больше не уведомится (кроме будущего падения
      // цены). Раньше это терялось в console.error без следа в журнале/утреннем
      // отчёте; logSystemError делает потерю видимой агенту вручную.
      console.error("[push] автоподбор нового объекта (отложенный):", err);
      void logSystemError(
        "matching",
        `Пуш отложенному клиенту №${client.shortId} по объекту №${property.shortId} не доставлен: ${err instanceof Error ? err.message : String(err)}`
      );
    });
  }

  /**
   * Обычным (не отложенным) клиентам пуш «🏠 Подходящий объект появился» /
   * «… — сразу N клиентам» / «Снижена цена на подходящем объекте» УБРАН по решению
   * владельца 02.10.2026. Совпадение остаётся в хронологии клиента (маркер дедупа
   * записан выше, поэтому тик не срабатывает повторно) и в сводках.
   */
}

