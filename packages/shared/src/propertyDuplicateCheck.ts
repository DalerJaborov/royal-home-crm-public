import { z } from "zod";
import { MARKET_TYPES, PROPERTY_TYPES } from "./enums.js";

/**
 * «Этот адрес уже заведён» — шаг «Где» мастера объекта (docs/pult/theme-2026/
 * artifact-wizard-property-15-09.html, блок `.dup`/`dupNear()`; уточнение
 * владельца 15.09.2026: «пусть механизм будет быстрым и правильным, чтобы от
 * себя не придумывал, что это дубль»).
 *
 * НИКАКОЙ ПОХОЖЕСТИ «НА ГЛАЗ» — сервер (routes/properties/duplicateCheck.ts)
 * ищет ТОЧНОЕ совпадение канонного адреса (Property.canonicalAddress) внутри
 * того же района, с площадью в пределах ±1 м² (округление при замере), и если
 * у обоих объектов заданы этаж/этажность — они обязаны совпасть тоже. Не
 * совпало хоть что-то — сервер молчит, а не предполагает.
 */
export const propertyDuplicateCheckQuerySchema = z.object({
  districtId: z.guid(),
  address: z.string().trim().min(1).max(500),
  areaSqm: z.coerce.number().positive().max(100000),
  floor: z.coerce.number().int().optional(),
  totalFloors: z.coerce.number().int().optional(),
  /** Остальные параметры сверки (02.10.2026): участвуют, только если заданы у
   *  ОБЕИХ сторон, как этаж/этажность. */
  rooms: z.coerce.number().int().optional(),
  type: z.enum(PROPERTY_TYPES).optional(),
  marketType: z.enum(MARKET_TYPES).optional(),
  /** Число окон и участок — тоже параметры объекта (владелец 02.10.2026: «все
   *  параметры»); участвуют, только если заданы у обеих сторон. */
  windowCount: z.coerce.number().int().optional(),
  landAreaSotka: z.coerce.number().positive().max(100000).optional(),
  /** Точка объекта (02.10.2026, владелец: «подсказка-дубль по точке, но не только
   *  адрес»). Второй источник кандидатов: активные объекты в радиусе
   *  DUPLICATE_POINT_RADIUS_M — ловит один дом, записанный разными адресами. */
  lat: z.coerce.number().min(-90).max(90).optional(),
  lng: z.coerce.number().min(-180).max(180).optional(),
  /** Правка уже существующего объекта — сам объект не должен находить себя. */
  excludePropertyId: z.guid().optional(),
});
export type PropertyDuplicateCheckQuery = z.infer<typeof propertyDuplicateCheckQuerySchema>;

/** Строки для показа в баннере `.dup` и для перехода в карточку — без телефона/
 *  контактов владельца, они здесь не нужны и не должны утекать сравнением адресов. */
export const propertyDuplicateMatchSchema = z.object({
  id: z.guid(),
  shortId: z.number().int(),
  address: z.string(),
  areaSqm: z.number(),
  rooms: z.number().int().nullable(),
  floor: z.number().int().nullable(),
  totalFloors: z.number().int().nullable(),
  status: z.string(),
  /** Чем найден: адрес (канонный), точка (в радиусе) или оба сразу. */
  matchedBy: z.enum(["address", "point", "both"]),
  /** Расстояние до нашей точки, м (округлено), если точка есть у обоих. */
  distanceM: z.number().nullable(),
  /** Все сверенные параметры — только заданные у обеих сторон. Совпадением
   *  объект стал, лишь когда `equal` у каждого. */
  checks: z.array(
    z.object({
      field: z.enum(["areaSqm", "rooms", "floor", "totalFloors", "type", "marketType", "windowCount", "landAreaSotka"]),
      ours: z.union([z.number(), z.string()]),
      theirs: z.union([z.number(), z.string()]),
      equal: z.boolean(),
    }),
  ),
});
export type PropertyDuplicateMatch = z.infer<typeof propertyDuplicateMatchSchema>;

export const propertyDuplicateCheckResponseSchema = z.object({
  matches: z.array(propertyDuplicateMatchSchema),
});
export type PropertyDuplicateCheckResponse = z.infer<typeof propertyDuplicateCheckResponseSchema>;

/** Допуск площади (±1 м², округление разных агентов при замере) — сужено с
 *  черновых ±2 м² по прямому решению владельца 15.09.2026: чем ближе к
 *  «точному» сравнению, тем меньше шанс ложной тревоги на разных, но похожих
 *  по метражу квартирах в одном доме. */
export const PROPERTY_DUPLICATE_AREA_TOLERANCE = 1;

/** Предел выборки — запрос уходит на каждый ввод адреса в мастере, растущий
 *  каталог не должен превращать его в полный перебор без потолка. */
export const PROPERTY_DUPLICATE_MATCH_LIMIT = 5;

/** Радиус «тот же дом» по точке, м (владелец 02.10.2026). Точка в мастере ставится
 *  по карте/фото с разбросом в десятки метров, но соседний дом обычно дальше. */
export const DUPLICATE_POINT_RADIUS_M = 40;

/** Сколько объектов в прямоугольнике вокруг точки берём из базы до точной проверки
 *  расстоянием и сверки параметров. */
export const PROPERTY_DUPLICATE_POINT_CANDIDATE_LIMIT = 50;

/** Допуск площади участка, сотки — тот же смысл, что ±1 м² у площади. */
export const PROPERTY_DUPLICATE_LAND_TOLERANCE = 1;
