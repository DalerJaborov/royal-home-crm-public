/**
 * GET /properties/map — лёгкая выдача для новой карты объектов (12.09.2026,
 * docs/geo-match-plan-12-09.md, блок N + I). Каталог (`list.ts`) для карты не
 * годится: `pageSize = 20` там режет выдачу текущей страницей, а карте нужны
 * ВСЕ подходящие объекты сразу, чтобы построить кластеры и `fitBounds`.
 *
 * Отдаёт ровно то, что рисует карта: точку объекта, цену, цену за метр, число
 * комнат, id дома (если точка объекта попала в контур дома) — и три вида
 * агрегатов, посчитанных здесь, а не на клиенте (раздел «Данные» плана):
 *
 *  - `clusters` — по 27 микрорайонам (или по району, если ни в один
 *    микрорайон точка не попала, — так объект без промаха в полигон всё равно
 *    не выпадает из карты, старый баг именно в этом: PropertyMapView.tsx:220-221
 *    молча пропускал объект без известного имени района);
 *  - `buildings` — дома, в чей контур попала хотя бы одна точка, для тепловой
 *    заливки «доход — среднее по дому» и для 3D-заливки (`floors` — высота);
 *  - `priceScale` — терцили цены за метр по ЭТОЙ выдаче: три ступени цвета
 *    (зелёный/янтарный/коралловый), а не жёстко прибитые границы, — рынок
 *    меняется, а разработчику не приходится подбирать константы заново.
 *
 * Строка «где это» на объект (`placeDescription`) — НЕ считается здесь: это
 * `describePlace` из `lib/landmarkPick.ts` (правка владельца 12.09.2026,
 * отменяющая перечисление ориентиров в стиле Booking.com — «мы не Букинг»),
 * единственный источник этого текста для карты, карточки и уведомлений.
 *
 * `offSite`-объекты (приватные, делятся только прямой ссылкой) сюда не
 * попадают — общая карта показывает объекты всем агентам, а приватный листинг
 * не должен светить точкой на общей карте (та же причина, по которой offSite
 * исключён из «Подбора объекта», см. schema.prisma, комментарий Property.offSite).
 *
 * Предел выборки (SCAN_CAP) обязателен правилом репозитория для любого роута,
 * возвращающего массив — молча не обрезаем, упёршийся потолок пишется в
 * журнал (тот же приём, что в summary.ts).
 */
import { Router } from "express";
import type { Prisma } from "../../generated/prisma/client.js";
import { propertyQuerySchema } from "@royal-home/shared";
import { prisma } from "../../db.js";
import { can, requireAuth } from "../../auth/middleware.js";
import { loadMoneyContext, priceRangeBranches, toTjs } from "../../lib/money.js";
import { isPointInPolygon, parseWktPolygonRing } from "../../lib/geo.js";
import { describePlace, loadPlaceContext } from "../../lib/landmarkPick.js";
import { logSystemError } from "../../lib/systemError.js";
import { propertyOwnerWhere } from "../../lib/propertyOwner.js";

export const propertiesMapRouter = Router();

/** Потолок объектов на один ответ карты. Сегодня в базе десятки объектов —
 *  запас на порядки роста, не измеренная величина рынка. */
const SCAN_CAP = 1500;
/** Потолок объектов, для которых считается попадание в контур дома —
 *  один SQL-запрос собирает окно вокруг КАЖДОГО объекта разом (см. ниже),
 *  и при неограниченном числе объектов запрос разросся бы бесконтрольно. */
const BUILDING_MATCH_CAP = 800;
/** Полуширина окна поиска домов вокруг точки объекта, градусы (~160 м по
 *  широте) — контуры домов Душанбе меньше квартала, этого достаточно чтобы
 *  не пропустить нужный дом и не утащить в кандидаты весь город. */
const BUILDING_MATCH_EPS = 0.0015;
/** Потолок объектов, для которых считается строка описания места
 *  (`describePlace`, lib/landmarkPick.ts). Справочники под неё грузятся один
 *  раз на запрос (24.09.2026), но сам отбор ориентира и улицы на точку не
 *  бесплатный — окно остаётся, с тем же честным логом при превышении, что и у
 *  остальных потолков этого роута. */
const PLACE_DESCRIPTION_CAP = 300;

/** Статусы, которых карта не показывает без явного фильтра `status`. */
export const MAP_HIDDEN_STATUSES = ["SOLD", "WITHDRAWN"] as const;

const mapQuerySchema = propertyQuerySchema.pick({
  type: true,
  districtId: true,
  districtIds: true,
  priceMin: true,
  priceMax: true,
  priceCurrency: true,
  rooms: true,
  areaMin: true,
  areaMax: true,
  status: true,
  agentId: true,
});

export interface MapProperty {
  id: string;
  shortId: number;
  title: string;
  lat: number | null;
  lng: number | null;
  price: number;
  currency: string;
  /** Цена за метр в сомони — null, если площадь не заполнена. */
  pricePerSqmTjs: number | null;
  rooms: number | null;
  /** Дом, в чей контур попала точка объекта — null, если не попал ни в один
   *  (в т.ч. когда у объекта нет точки вовсе). */
  buildingId: string | null;
  clusterId: string;
  clusterName: string;
  /** Кто принял объект у продавца — для отметки «свой» в переключателе
   *  «Мои / Все» (свои видны отличимо даже в режиме «Все», решение владельца
   *  12.09.2026 к блоку N). Тот же признак, что и у `agentId` в каталоге
   *  (`usePropertyScopeToggle`, apps/web/src/hooks/useProperties.ts) —
   *  сравнение с текущим агентом делает клиент, второй копии правила «кто
   *  свой» здесь нет. */
  intakeAgentId: string | null;
  /** Одна строка вида «Сино, 400 м от ЦУМа» — ЕДИНСТВЕННЫЙ источник этого
   *  текста, `lib/landmarkPick.ts` (правка владельца 12.09.2026: без
   *  перечисления в стиле Booking.com). Пусто у объектов без точки. */
  placeDescription: string;
  /** Обложка объекта — миниатюра первой фотографии по PropertyPhoto.order,
   *  null у объектов без фото вовсе (карточка карты показывает заглушку).
   *  Добавлено 14.09.2026: список объектов слева от карты (владелец —
   *  «чтобы было как в топовых сайтах») показывает фото, не просто цвет. */
  coverPhotoUrl: string | null;
}

export interface MapCluster {
  id: string;
  kind: "microdistrict" | "district";
  name: string;
  lat: number;
  lng: number;
  count: number;
  /** В сомони — минимальная цена ПОСЛЕ конверсии, для подписи «от …». */
  minPrice: number;
  avgPricePerSqm: number | null;
}

export interface MapBuilding {
  id: string;
  lat: number;
  lng: number;
  outline: string;
  /** Этажность дома — высота 3D-заливки (этажи × 3 м, решение владельца
   *  12.09.2026 к блоку N). null, если в справочнике не заполнена (у 1 528
   *  домов из 24 325, см. докстринг Building.floors в schema.prisma) — тогда
   *  клиент рисует дом плоским контуром, а не гадает про этажность. */
  floors: number | null;
  count: number;
  avgPricePerSqm: number | null;
}

export interface PropertiesMapResponse {
  properties: MapProperty[];
  clusters: MapCluster[];
  buildings: MapBuilding[];
  priceScale: { low: number; high: number } | null;
  bounds: { minLat: number; minLng: number; maxLat: number; maxLng: number } | null;
  total: number;
  /** Сколько объектов выдачи без точки (lat/lng не заполнены): на карте их
   *  нет, в кластеры они не входят, — клиент пишет «Ещё N без точки на
   *  карте», чтобы число на карте не расходилось молча с каталогом
   *  (24.09.2026). */
  withoutPoint: number;
}

propertiesMapRouter.get("/map", requireAuth, async (req, res) => {
  const parsed = mapQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: "Неверные параметры запроса", details: parsed.error.flatten() });
  }
  const { type, districtId, districtIds, priceMin, priceMax, priceCurrency, rooms, areaMin, areaMax, status, agentId } =
    parsed.data;

  const where: Prisma.PropertyWhereInput = { deletedAt: null, offSite: false };
  // Заявка на удаление прячет объект ТОЛЬКО у её автора — то же правило и та же
  // строка, что в каталоге (routes/properties/list.ts, владелец 17.09 и
  // 19.09.2026). Без него объект, который агент попросил убрать, пропадал из
  // списка, но продолжал стоять у него на карте (24.09.2026).
  if (!can(req, "properties.delete")) {
    where.deleteRequests = { none: { status: "PENDING", requestedById: req.agent!.id } };
  }
  if (type) where.type = type;
  // Проданные и снятые — не на карте, если статус не спросили прямо (25.09.2026).
  // Карта — это «что можно показать клиенту»: проданная квартира рядом с живыми
  // выглядела предложением, а её цена сдвигала ступени цвета и «от …» кластера.
  if (status) where.status = status;
  else where.status = { notIn: [...MAP_HIDDEN_STATUSES] };
  if (rooms) where.rooms = rooms;
  // «Мои объекты» — то же правило хозяина, что в списке (lib/propertyOwner.ts).
  const andConditions: Prisma.PropertyWhereInput[] = [];
  if (agentId) andConditions.push(propertyOwnerWhere(agentId));
  const allDistricts = [...new Set([...(districtIds ?? []), ...(districtId ? [districtId] : [])])];
  if (allDistricts.length > 0) where.districtId = { in: allDistricts };
  if (areaMin !== undefined || areaMax !== undefined) {
    where.areaSqm = {
      ...(areaMin !== undefined ? { gte: areaMin } : {}),
      ...(areaMax !== undefined ? { lte: areaMax } : {}),
    };
  }
  if (priceMin !== undefined || priceMax !== undefined) {
    const money = await loadMoneyContext();
    andConditions.push({ OR: priceRangeBranches({ min: priceMin, max: priceMax, currency: priceCurrency }, money) });
  }
  if (andConditions.length > 0) where.AND = andConditions;

  const [total, rows] = await Promise.all([
    prisma.property.count({ where }),
    prisma.property.findMany({
      where,
      select: {
        id: true,
        shortId: true,
        title: true,
        lat: true,
        lng: true,
        price: true,
        currency: true,
        areaSqm: true,
        rooms: true,
        districtId: true,
        intakeAgentId: true,
        district: { select: { id: true, name: true, lat: true, lng: true } },
        // Обложка — только первое фото по порядку, не вся пачка (карте нужна
        // одна миниатюра, не альбом; полный список — на странице объекта).
        photos: { select: { thumbUrl: true }, orderBy: { order: "asc" }, take: 1 },
      },
      orderBy: { createdAt: "desc" },
      take: SCAN_CAP,
    }),
  ]);
  if (total > SCAN_CAP) {
    void logSystemError("api", `Карта объектов: подходит ${total}, отдано первых ${SCAN_CAP}`);
  }

  const money = await loadMoneyContext();

  // ---- Микрорайоны: все 27, точка-в-полигоне против каждого объекта. Дёшево
  // (27 полигонов), поэтому без bbox-предфильтра, в отличие от домов ниже. ----
  const microdistricts = await prisma.microdistrict.findMany({
    select: { id: true, name: true, lat: true, lng: true, boundary: true },
  });
  const microRings = microdistricts.map((m) => ({ m, ring: parseWktPolygonRing(m.boundary) }));

  function findMicrodistrict(lat: number, lng: number) {
    for (const { m, ring } of microRings) {
      if (ring && isPointInPolygon(lng, lat, ring)) return m;
    }
    return null;
  }

  // ---- Дома: кандидаты только в маленьком окне вокруг каждой геокодированной
  // точки — один запрос с OR по bbox, а не по одному запросу на объект (правило
  // CLAUDE.md про N+1: await внутри map/for по списку из БД запрещён). ----
  const geocoded = rows.filter((p): p is typeof rows[number] & { lat: NonNullable<typeof p.lat>; lng: NonNullable<typeof p.lng> } => p.lat != null && p.lng != null);
  const matchWindow = geocoded.slice(0, BUILDING_MATCH_CAP);
  if (geocoded.length > BUILDING_MATCH_CAP) {
    void logSystemError(
      "api",
      `Карта объектов: привязка к домам посчитана только для первых ${BUILDING_MATCH_CAP} из ${geocoded.length} геокодированных`
    );
  }
  let buildingCandidates: { id: string; lat: Prisma.Decimal; lng: Prisma.Decimal; outline: string | null; floors: number | null }[] = [];
  if (matchWindow.length > 0) {
    buildingCandidates = await prisma.building.findMany({
      where: {
        outline: { not: null },
        OR: matchWindow.map((p) => {
          const lat = Number(p.lat);
          const lng = Number(p.lng);
          return {
            lat: { gte: lat - BUILDING_MATCH_EPS, lte: lat + BUILDING_MATCH_EPS },
            lng: { gte: lng - BUILDING_MATCH_EPS, lte: lng + BUILDING_MATCH_EPS },
          };
        }),
      },
      select: { id: true, lat: true, lng: true, outline: true, floors: true },
      take: 5000,
    });
  }
  const buildingRings = buildingCandidates.map((b) => ({ b, ring: parseWktPolygonRing(b.outline!) }));

  function findBuilding(lat: number, lng: number) {
    for (const { b, ring } of buildingRings) {
      if (ring && isPointInPolygon(lng, lat, ring)) return b;
    }
    return null;
  }

  // ---- Одна строка описания места («Сино, 400 м от ЦУМа») — ЕДИНСТВЕННЫЙ
  // источник, lib/landmarkPick.ts (правка владельца 12.09.2026, отменяющая
  // перечисление в стиле Booking.com).
  //
  // Справочники (области, ориентиры, улицы) — ОДИН раз на запрос
  // (`loadPlaceContext`, 24.09.2026): раньше describePlace на каждый из ~300
  // объектов перечитывал их сам, 1500-2400 запросов на одно открытие карты.
  // И описание — украшение, а не данные карты: не собралось (справочник не
  // прочитался, одна точка упала) — у объекта пустая строка, как у объекта
  // без точки, а карта открывается; раньше один отказ давал 500 всей карте.
  // В журнал — одна запись на запрос, не по записи на объект. ----
  const descriptionWindow = geocoded.slice(0, PLACE_DESCRIPTION_CAP);
  if (geocoded.length > PLACE_DESCRIPTION_CAP) {
    void logSystemError(
      "api",
      `Карта объектов: строка описания места посчитана только для первых ${PLACE_DESCRIPTION_CAP} из ${geocoded.length} геокодированных`
    );
  }
  const descriptions = new Map<string, string>();
  if (descriptionWindow.length > 0) {
    let failed = 0;
    let firstError: unknown = null;
    try {
      const placeCtx = await loadPlaceContext();
      const settled = await Promise.allSettled(
        descriptionWindow.map((p) => describePlace(Number(p.lat), Number(p.lng), placeCtx))
      );
      settled.forEach((r, i) => {
        if (r.status === "fulfilled") descriptions.set(descriptionWindow[i].id, r.value.text);
        else {
          failed += 1;
          firstError ??= r.reason;
        }
      });
    } catch (err) {
      failed = descriptionWindow.length;
      firstError = err;
    }
    if (failed > 0) {
      void logSystemError(
        "api",
        `Карта объектов: строка описания места не собралась у ${failed} из ${descriptionWindow.length} объектов`,
        { stack: firstError instanceof Error ? firstError.stack : String(firstError) }
      );
    }
  }

  // ---- Сборка ответа ----
  const clusterAgg = new Map<string, { kind: "microdistrict" | "district"; name: string; lat: number; lng: number; prices: number[]; ppsqm: number[] }>();
  const properties: MapProperty[] = [];
  const bounds = { minLat: Infinity, maxLat: -Infinity, minLng: Infinity, maxLng: -Infinity };
  let hasBounds = false;
  let withoutPoint = 0;

  for (const p of rows) {
    // where выше — offSite: false, у такого объекта район всегда есть (обязателен
    // в схеме для всего, что не «только для своих»). Закрытый объект без района
    // сюда физически не попадает — карта его вообще не запрашивает.
    if (!p.district) continue;
    const district = p.district;
    const priceTjs = toTjs(p.price, p.currency, money);
    const areaSqm = Number(p.areaSqm);
    const pricePerSqmTjs = areaSqm > 0 ? Math.round((priceTjs / areaSqm) * 100) / 100 : null;

    let clusterId: string;
    let clusterKind: "microdistrict" | "district";
    let clusterName: string;
    let clusterLat: number | null = null;
    let clusterLng: number | null = null;
    let buildingId: string | null = null;
    let lat: number | null = null;
    let lng: number | null = null;

    if (p.lat != null && p.lng != null) {
      lat = Number(p.lat);
      lng = Number(p.lng);
      const micro = findMicrodistrict(lat, lng);
      if (micro) {
        clusterId = `microdistrict:${micro.id}`;
        clusterKind = "microdistrict";
        clusterName = micro.name;
        clusterLat = Number(micro.lat);
        clusterLng = Number(micro.lng);
      } else {
        clusterId = `district:${district.id}`;
        clusterKind = "district";
        clusterName = district.name;
        clusterLat = district.lat != null ? Number(district.lat) : lat;
        clusterLng = district.lng != null ? Number(district.lng) : lng;
      }
      const building = findBuilding(lat, lng);
      buildingId = building?.id ?? null;
      bounds.minLat = Math.min(bounds.minLat, lat);
      bounds.maxLat = Math.max(bounds.maxLat, lat);
      bounds.minLng = Math.min(bounds.minLng, lng);
      bounds.maxLng = Math.max(bounds.maxLng, lng);
      hasBounds = true;
    } else {
      // Без точки — объект числится за своим районом (clusterId/clusterName
      // для подписи), но в СЧЁТ и «от …» кластера не входит (24.09.2026):
      // клиент такой объект не рисует (PropertiesMap.tsx отбрасывает lat/lng
      // null), и кружок «12 объектов» над тремя точками врал. Вместо этого
      // их число отдаётся отдельно — `withoutPoint`.
      clusterId = `district:${district.id}`;
      clusterKind = "district";
      clusterName = district.name;
      withoutPoint += 1;
    }

    if (clusterLat != null && clusterLng != null) {
      const agg = clusterAgg.get(clusterId) ?? { kind: clusterKind, name: clusterName, lat: clusterLat, lng: clusterLng, prices: [], ppsqm: [] };
      agg.prices.push(priceTjs);
      if (pricePerSqmTjs != null) agg.ppsqm.push(pricePerSqmTjs);
      clusterAgg.set(clusterId, agg);
    }

    properties.push({
      id: p.id,
      shortId: p.shortId,
      title: p.title,
      lat,
      lng,
      price: Number(p.price),
      currency: p.currency,
      pricePerSqmTjs,
      rooms: p.rooms,
      buildingId,
      clusterId,
      clusterName,
      intakeAgentId: p.intakeAgentId,
      placeDescription: descriptions.get(p.id) ?? "",
      coverPhotoUrl: p.photos[0]?.thumbUrl ?? null,
    });
  }

  const clusters: MapCluster[] = [...clusterAgg.entries()].map(([id, agg]) => ({
    id,
    kind: agg.kind,
    name: agg.name,
    lat: agg.lat,
    lng: agg.lng,
    count: agg.prices.length,
    minPrice: Math.min(...agg.prices),
    avgPricePerSqm: agg.ppsqm.length > 0 ? Math.round(agg.ppsqm.reduce((a, b) => a + b, 0) / agg.ppsqm.length) : null,
  }));

  // ---- Дома: агрегат только по домам, в которые попал хотя бы один объект —
  // 13 501 контур целиком грузить незачем, вся выдача уже свёрнута в JS. ----
  const buildingAgg = new Map<string, { lat: number; lng: number; outline: string; floors: number | null; ppsqm: number[]; count: number }>();
  for (const p of properties) {
    if (!p.buildingId) continue;
    const b = buildingCandidates.find((c) => c.id === p.buildingId)!;
    const agg =
      buildingAgg.get(p.buildingId) ??
      { lat: Number(b.lat), lng: Number(b.lng), outline: b.outline!, floors: b.floors, ppsqm: [], count: 0 };
    agg.count += 1;
    if (p.pricePerSqmTjs != null) agg.ppsqm.push(p.pricePerSqmTjs);
    buildingAgg.set(p.buildingId, agg);
  }
  const buildings: MapBuilding[] = [...buildingAgg.entries()].map(([id, agg]) => ({
    id,
    lat: agg.lat,
    lng: agg.lng,
    outline: agg.outline,
    floors: agg.floors,
    count: agg.count,
    avgPricePerSqm: agg.ppsqm.length > 0 ? Math.round(agg.ppsqm.reduce((a, b) => a + b, 0) / agg.ppsqm.length) : null,
  }));

  // ---- Три ступени цвета — терцили по ЭТОЙ выдаче, не жёсткие константы. ----
  // Только по объектам с точкой (25.09.2026): цвет получают лишь нарисованные,
  // и объект без точки сдвигал ступени, не появляясь на карте сам.
  const allPpsqm = properties
    .filter((p) => p.lat != null && p.lng != null)
    .map((p) => p.pricePerSqmTjs).filter((v): v is number => v != null).sort((a, b) => a - b);
  const priceScale =
    allPpsqm.length > 0
      ? { low: allPpsqm[Math.floor(allPpsqm.length / 3)], high: allPpsqm[Math.floor((allPpsqm.length * 2) / 3)] }
      : null;

  const response: PropertiesMapResponse = {
    properties,
    clusters,
    buildings,
    priceScale,
    bounds: hasBounds ? bounds : null,
    total,
    withoutPoint,
  };
  res.json(response);
});
