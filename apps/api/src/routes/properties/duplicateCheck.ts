/**
 * GET /properties/duplicate-check — «этот адрес уже заведён» на шаге «Где»
 * мастера объекта (docs/pult/theme-2026/artifact-wizard-property-15-09.html,
 * блок `.dup`/`dupNear()`; владелец 15.09.2026: «добавь такую функцию» — «Один
 * объект от двух агентов — самая частая грязь в базе»).
 *
 * УТОЧНЕНИЕ ВЛАДЕЛЬЦА 15.09.2026 — «пусть механизм будет быстрым и правильным,
 * чтобы от себя не придумывал, что это дубль»: НИКАКОЙ похожести на глаз
 * (ни ILIKE-подстроки, ни триграмм — тот приём остался в lib/fuzzySearch.ts для
 * поиска, здесь другая задача). Совпадением считается только ПОЛНЫЙ набор:
 *
 *   1. тот же район (districtId, точное равенство);
 *   2. равный КАНОННЫЙ адрес (Property.canonicalAddress — см. комментарий у
 *      normalizePropertyAddress, routes/properties/shared.ts) — точное
 *      равенство строк, не подстрока и не расстояние Левенштейна;
 *   3. площадь в пределах ±1 м² (PROPERTY_DUPLICATE_AREA_TOLERANCE) — округление
 *      разных агентов при замере одного и того же помещения;
 *   4. если у ОБОИХ объектов заданы этаж и этажность — они обязаны совпасть
 *      тоже (усиливает совпадение, как и просило задание; когда хотя бы у
 *      одной стороны эти поля не заполнены, они не участвуют в сравнении —
 *      мастер вызывает этот запрос уже на шаге «Где», раньше шага «Параметры»,
 *      где этаж/этажность заполняются).
 *
 * ДОПОЛНЕНИЕ 02.10.2026 (владелец: «подсказка-дубль по точке, но не только
 * адрес — полностью, чтобы все параметры были проверены»): два источника
 * кандидатов — канонный адрес (как выше) И точка (активные объекты в радиусе
 * DUPLICATE_POINT_RADIUS_M, точное расстояние distanceMeters; один дом, записанный
 * разными адресами, адресом не ловится). Сверка параметров ОДИНАКОВА для обоих
 * источников: площадь ±допуск, комнаты, этаж, этажность, тип объекта, новостройка/
 * вторичка — параметр участвует, только если задан у ОБЕИХ сторон; совпадение =
 * все участвующие равны (площадь есть всегда). По точке проданные и снятые
 * (SOLD/WITHDRAWN) не кандидаты — соседняя квартира того же метража в доме
 * бывает. По адресу — как и прежде, любой неудалённый: тот же адрес и метраж
 * проданного объекта, заведённый заново, — это он же. В ответе — matchedBy, расстояние и список сверенных параметров.
 *
 * Не совпало хоть что-то — сервер молчит (пустой список), а не предполагает.
 * Ответ — факт, а не оценка: «этот адрес уже заведён», не «похоже на дубль».
 *
 * БЫСТРО — ПО ИНДЕКСУ: canonicalAddress посчитан ОДИН РАЗ при создании/правке
 * объекта и хранится колонкой (миграция 20260915120000_property_canonical_
 * address), запрос ниже — точное равенство по индексу [districtId,
 * canonicalAddress], а не полный перебор с канонизацией на лету — этот роут
 * дёргается на каждый ввод адреса в мастере.
 *
 * Право — то же, что у создания объекта (POST /, routes/properties/crud.ts):
 * requireAuth без дополнительного permission — предупреждение полезно ЛЮБОМУ
 * агенту, который может завести объект, включая находку чужого объекта другого
 * агента (в этом и смысл проверки). Поля ответа — адрес/площадь/статус/id, без
 * контакта продавца и без владельца объекта — сравнение адресов не должно
 * протекать данными, которые роль иначе не увидела бы.
 */
import { Router } from "express";
import {
  propertyDuplicateCheckQuerySchema,
  PROPERTY_DUPLICATE_AREA_TOLERANCE,
  PROPERTY_DUPLICATE_MATCH_LIMIT,
  PROPERTY_DUPLICATE_POINT_CANDIDATE_LIMIT,
  PROPERTY_DUPLICATE_LAND_TOLERANCE,
  DUPLICATE_POINT_RADIUS_M,
  distanceMeters,
  type PropertyDuplicateMatch,
} from "@royal-home/shared";
import { prisma } from "../../db.js";
import { requireAuth } from "../../auth/middleware.js";
import { propertyAddressKeys } from "./shared.js";

export const propertyDuplicateCheckRouter = Router();

const SELECT = {
  id: true,
  shortId: true,
  address: true,
  areaSqm: true,
  rooms: true,
  floor: true,
  totalFloors: true,
  type: true,
  marketType: true,
  windowCount: true,
  landAreaSotka: true,
  lat: true,
  lng: true,
  status: true,
} as const;

/** Кандидаты по точке: проданный/снятый объект поблизости — не кандидат. */
const ACTIVE_FILTER = { deletedAt: null, status: { notIn: ["SOLD", "WITHDRAWN"] as ("SOLD" | "WITHDRAWN")[] } };

const MATCHED_ORDER = { both: 0, point: 1, address: 2 } as const;

propertyDuplicateCheckRouter.get("/duplicate-check", requireAuth, async (req, res) => {
  const parsed = propertyDuplicateCheckQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: "Неверные данные", details: parsed.error.flatten() });
  }
  const {
    districtId,
    address,
    areaSqm,
    floor,
    totalFloors,
    rooms,
    type,
    marketType,
    windowCount,
    landAreaSotka,
    lat,
    lng,
    excludePropertyId,
  } = parsed.data;
  const point = lat !== undefined && lng !== undefined ? { lat, lng } : null;
  const exclude = excludePropertyId ? { id: { not: excludePropertyId } } : {};

  // Оба ключа — новый и прежний (29.09.2026): сохранённые ключи старых объектов
  // посчитаны прежним правилом, пока их не пересчитал разовый скрипт.
  const addressKeys = propertyAddressKeys(address);

  // Источник 1: точное равенство по индексу [districtId, canonicalAddress].
  const byAddressPromise =
    addressKeys.length === 0
      ? Promise.resolve([])
      : prisma.property.findMany({
          where: { deletedAt: null, districtId, canonicalAddress: { in: addressKeys }, ...exclude },
          select: SELECT,
          // Сверка параметров идёт ниже, в Node, и только потом список режется до
          // PROPERTY_DUPLICATE_MATCH_LIMIT: с пределом 5 уже здесь пять объектов
          // того же дома с другой площадью выталкивали настоящий дубль.
          take: PROPERTY_DUPLICATE_POINT_CANDIDATE_LIMIT,
        });

  // Источник 2: прямоугольник вокруг точки в SQL, точное расстояние — в Node.
  let byPointPromise: Promise<Awaited<typeof byAddressPromise>> = Promise.resolve([]);
  if (point) {
    const dLat = DUPLICATE_POINT_RADIUS_M / 111_320;
    const dLng = DUPLICATE_POINT_RADIUS_M / (111_320 * Math.max(Math.cos((point.lat * Math.PI) / 180), 0.01));
    byPointPromise = prisma.property.findMany({
      where: {
        ...ACTIVE_FILTER,
        lat: { gte: point.lat - dLat, lte: point.lat + dLat },
        lng: { gte: point.lng - dLng, lte: point.lng + dLng },
        ...exclude,
      },
      select: SELECT,
      take: PROPERTY_DUPLICATE_POINT_CANDIDATE_LIMIT,
    });
  }

  const [byAddress, byPoint] = await Promise.all([byAddressPromise, byPointPromise]);

  type Row = (typeof byAddress)[number];
  const found = new Map<string, { row: Row; viaAddress: boolean; viaPoint: boolean; distanceM: number | null }>();
  const distanceOf = (p: Row) =>
    point && p.lat !== null && p.lng !== null
      ? distanceMeters(point.lat, point.lng, Number(p.lat), Number(p.lng))
      : null;
  for (const row of byAddress) {
    found.set(row.id, { row, viaAddress: true, viaPoint: false, distanceM: distanceOf(row) });
  }
  for (const row of byPoint) {
    const d = distanceOf(row);
    if (d === null || d > DUPLICATE_POINT_RADIUS_M) continue;
    const prev = found.get(row.id);
    if (prev) prev.viaPoint = true;
    else found.set(row.id, { row, viaAddress: false, viaPoint: true, distanceM: d });
  }

  const matches: PropertyDuplicateMatch[] = [];
  for (const { row: p, viaAddress, viaPoint, distanceM } of found.values()) {
    // Сверка одинакова для обоих источников. Площадь есть у обеих сторон всегда,
    // остальное — только когда задано и у нас, и у них.
    const checks: PropertyDuplicateMatch["checks"] = [
      {
        field: "areaSqm",
        ours: areaSqm,
        theirs: Number(p.areaSqm),
        equal: Math.abs(Number(p.areaSqm) - areaSqm) <= PROPERTY_DUPLICATE_AREA_TOLERANCE,
      },
    ];
    const add = (field: PropertyDuplicateMatch["checks"][number]["field"], ours: number | string | undefined, theirs: number | string | null) => {
      if (ours === undefined || theirs === null) return;
      checks.push({ field, ours, theirs, equal: ours === theirs });
    };
    add("rooms", rooms, p.rooms);
    add("floor", floor, p.floor);
    add("totalFloors", totalFloors, p.totalFloors);
    add("type", type, p.type);
    add("marketType", marketType, p.marketType);
    add("windowCount", windowCount, p.windowCount);
    if (landAreaSotka !== undefined && p.landAreaSotka !== null) {
      checks.push({
        field: "landAreaSotka",
        ours: landAreaSotka,
        theirs: Number(p.landAreaSotka),
        equal: Math.abs(Number(p.landAreaSotka) - landAreaSotka) <= PROPERTY_DUPLICATE_LAND_TOLERANCE,
      });
    }
    if (!checks.every((c) => c.equal)) continue;

    matches.push({
      id: p.id,
      shortId: p.shortId,
      address: p.address ?? "",
      areaSqm: Number(p.areaSqm),
      rooms: p.rooms,
      floor: p.floor,
      totalFloors: p.totalFloors,
      status: p.status,
      matchedBy: viaAddress && viaPoint ? "both" : viaPoint ? "point" : "address",
      distanceM: distanceM === null ? null : Math.round(distanceM),
      checks,
    });
  }

  matches.sort(
    (a, b) =>
      MATCHED_ORDER[a.matchedBy] - MATCHED_ORDER[b.matchedBy] ||
      (a.distanceM ?? Infinity) - (b.distanceM ?? Infinity),
  );

  res.json({ matches: matches.slice(0, PROPERTY_DUPLICATE_MATCH_LIMIT) });
});
