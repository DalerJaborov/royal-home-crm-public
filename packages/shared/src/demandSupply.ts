import { z } from "zod";

/**
 * СПРОС ПРОТИВ ПРЕДЛОЖЕНИЯ — форма ответа GET /reports/demand-supply.
 *
 * Вопрос владельца: «где искать новые объекты, а где их уже слишком много».
 * Спрос — это желания ждущих покупателей (район, комнаты, бюджет), предложение —
 * объекты в продаже. Ячейка матрицы — пара «район × число комнат».
 *
 * Описано один раз здесь: сервер (lib/demandSupply.ts) и экран читают одну форму,
 * а пороги вердикта живут рядом с типом — второй копии чисел на экране нет.
 */

/** Ключи столбцов матрицы: «1», «2», «3», «4+» комнат. */
export const DEMAND_SUPPLY_ROOM_KEYS = ["1", "2", "3", "4+"] as const;
export type DemandSupplyRoomKey = (typeof DEMAND_SUPPLY_ROOM_KEYS)[number];

export const DEMAND_SUPPLY_ROOM_LABELS: Record<DemandSupplyRoomKey, string> = {
  "1": "1 комн.",
  "2": "2 комн.",
  "3": "3 комн.",
  "4+": "4+ комн.",
};

/** Меньше стольких ищущих клиентов в ячейке — вывода не делаем, пишем «мало данных». */
export const DEMAND_SUPPLY_MIN_SAMPLE = 3;
/** Спрос / предложение не ниже этого — «не хватает объектов». */
export const DEMAND_SUPPLY_SHORTAGE_RATIO = 1.5;
/** Спрос / предложение не выше этого — «много предложения, мало спроса». */
export const DEMAND_SUPPLY_SURPLUS_RATIO = 0.67;

/**
 * Предложение от стольких квартир в ячейке при малом спросе всё равно считается избытком.
 * Почему: «ищут 0–2, в продаже 12» — это как раз склад, который не движется, а вердикт «мало
 * данных» прятал его от списка «слишком много предложения». Пять — потому что от одной-двух
 * квартир ячейка пустовать может по любой причине, а пять уже накопление. Такой избыток
 * помечается `lowDemand`: спрос мал, и коэффициент — подсказка, а не твёрдый вывод.
 */
export const DEMAND_SUPPLY_SURPLUS_MIN_SUPPLY = 5;

export const DEMAND_SUPPLY_VERDICTS = ["shortage", "surplus", "balanced", "low-data"] as const;
export type DemandSupplyVerdict = (typeof DEMAND_SUPPLY_VERDICTS)[number];

export const DEMAND_SUPPLY_VERDICT_LABELS: Record<DemandSupplyVerdict, string> = {
  shortage: "Не хватает объектов",
  surplus: "Много предложения, мало спроса",
  balanced: "Примерно поровну",
  "low-data": "Мало данных",
};

export interface DemandSupplyCell {
  districtId: string;
  districtName: string;
  rooms: DemandSupplyRoomKey;
  /** Сколько ждущих покупателей ищут именно такой район и число комнат. */
  demand: number;
  /** Сколько квартир в продаже в этом районе с таким числом комнат. */
  supply: number;
  /** demand / supply; null — предложения нет вовсе или спроса слишком мало для вывода (кроме `lowDemand`-избытка: там коэффициент есть). */
  ratio: number | null;
  /** Медиана бюджета спроса, сомони; null — бюджет не назвал никто. */
  demandMedianBudget: number | null;
  /** Медиана цены предложения, сомони. */
  supplyMedianPrice: number | null;
  verdict: DemandSupplyVerdict;
  /**
   * true — избыток признан при малом спросе (ищут меньше DEMAND_SUPPLY_MIN_SAMPLE, а квартир не
   * меньше DEMAND_SUPPLY_SURPLUS_MIN_SUPPLY): вывод слабее обычного, экран это пишет.
   */
  lowDemand: boolean;
}

export interface DemandSupplyDistrictRow {
  districtId: string;
  districtName: string;
  demand: number;
  supply: number;
}

/** Объект в продаже, под который не подходит ни один ждущий покупатель. */
export interface UnsoughtProperty {
  propertyId: string;
  shortId: number;
  title: string;
  districtName: string | null;
  rooms: number | null;
  /** Цена в сомони. */
  priceTjs: number;
  /** Сколько дней объект в продаже (с создания карточки). */
  daysOnSale: number;
}

export interface DemandSupplyResponse {
  generatedAt: string;
  rooms: DemandSupplyRoomKey[];
  /** Районы по строкам матрицы: сначала с самым большим спросом. */
  districts: DemandSupplyDistrictRow[];
  /** Только непустые ячейки (есть и спрос, и/или предложение). */
  cells: DemandSupplyCell[];
  /** Ячейки с дефицитом — сначала самые острые (до 5). */
  shortage: DemandSupplyCell[];
  /** Ячейки с избытком предложения — сначала самые тяжёлые (до 5). */
  surplus: DemandSupplyCell[];
  totals: {
    /** Ждущих покупателей учтено в матрице. */
    demandPlaced: number;
    /** Ждущих покупателей, не назвавших район или комнаты — в матрицу не вошли. */
    demandUnplaced: number;
    /** Квартир в продаже учтено в матрице. */
    supplyPlaced: number;
    /** Квартир в продаже без района или числа комнат — в матрицу не вошли. */
    supplyUnplaced: number;
  };
  /** Выборка упёрлась в потолок — цифры занижены. */
  truncated: boolean;
  unsought: {
    /** Сколько объектов в продаже никто не ищет (из проверенных). */
    total: number;
    /** Сколько объектов проверено (потолок выборки). */
    checked: number;
    items: UnsoughtProperty[];
  } | null;
}

export const demandSupplyQuerySchema = z.object({
  /** Сколько строк в списке «Объекты, которых никто не ищет». */
  unsoughtLimit: z.coerce.number().int().min(0).max(50).default(10),
});
export type DemandSupplyQuery = z.infer<typeof demandSupplyQuerySchema>;
