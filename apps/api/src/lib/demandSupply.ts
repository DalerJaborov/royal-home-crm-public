import {
  DEMAND_SUPPLY_MIN_SAMPLE,
  DEMAND_SUPPLY_ROOM_KEYS,
  DEMAND_SUPPLY_SHORTAGE_RATIO,
  DEMAND_SUPPLY_SURPLUS_MIN_SUPPLY,
  DEMAND_SUPPLY_SURPLUS_RATIO,
  type DemandSupplyCell,
  type DemandSupplyDistrictRow,
  type DemandSupplyResponse,
  type DemandSupplyRoomKey,
  type DemandSupplyVerdict,
  type UnsoughtProperty,
} from "@royal-home/shared";
import { prisma } from "../db.js";
import { loadMoneyContext, roundMoney, toTjs } from "./money.js";
import { loadMatchPolicy, waitingBuyerWhere } from "./matchPolicy.js";
import { computeDemandCounts } from "../routes/matching.js";
import { logSystemError } from "./systemError.js";

/**
 * СПРОС ПРОТИВ ПРЕДЛОЖЕНИЯ (владелец, 03.10.2026): «где искать новые объекты».
 *
 * Спрос — ждущие покупатели (то же множество, что у автоподбора и счётчика «Ждут N
 * покупателей»: waitingBuyerWhere), предложение — квартиры в продаже. Ячейка —
 * «район × число комнат». Клиент без района или без числа комнат в матрицу не
 * попадает (его некуда поставить без догадки) и считается отдельно в totals.
 *
 * Файл разделён на ЧИСТУЮ свёртку (foldDemandSupply, без базы — под тест) и
 * загрузчик (loadDemandSupply). Только факты из базы: вывод делается лишь там, где
 * ищущих клиентов не меньше DEMAND_SUPPLY_MIN_SAMPLE.
 */

/** Потолки выборок: ответ отчётный, но роут не должен вычитывать таблицы целиком. */
export const DEMAND_CLIENTS_LIMIT = 5000;
export const SUPPLY_PROPERTIES_LIMIT = 5000;
/** Сколько объектов проверяем на «никто не ищет»: computeDemandCounts сверяет каждый с тысячей клиентов. */
export const UNSOUGHT_CHECK_LIMIT = 300;
const TOP_CELLS = 5;

export interface DemandClientInput {
  districtId: string | null;
  rooms: number | null;
  /** Бюджет в сомони (верхняя граница, а если её нет — нижняя); null — не назван. */
  budgetTjs: number | null;
}

export interface SupplyPropertyInput {
  districtId: string | null;
  rooms: number | null;
  priceTjs: number;
}

/** Число комнат → столбец матрицы; null — комнат нет или они некорректны. */
export function roomsKey(rooms: number | null | undefined): DemandSupplyRoomKey | null {
  if (rooms == null || !Number.isFinite(rooms) || rooms < 1) return null;
  return rooms >= 4 ? "4+" : (String(Math.floor(rooms)) as DemandSupplyRoomKey);
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Вывод по ячейке. Меньше порога ищущих — «мало данных», без выводов о дефиците; ЕДИНСТВЕННОЕ
 * исключение — склад: квартир не меньше DEMAND_SUPPLY_SURPLUS_MIN_SUPPLY при малом спросе —
 * «избыток» с пометкой `lowDemand` (почему — см. константу в shared).
 */
export function cellVerdict(
  demand: number,
  supply: number
): { verdict: DemandSupplyVerdict; ratio: number | null; lowDemand: boolean } {
  if (demand < DEMAND_SUPPLY_MIN_SAMPLE) {
    if (supply >= DEMAND_SUPPLY_SURPLUS_MIN_SUPPLY) {
      return { verdict: "surplus", ratio: Math.round((demand / supply) * 100) / 100, lowDemand: true };
    }
    return { verdict: "low-data", ratio: null, lowDemand: false };
  }
  // Предложения нет вовсе, а ищут трое и больше — деления на ноль не будет, это самый острый дефицит.
  if (supply === 0) return { verdict: "shortage", ratio: null, lowDemand: false };
  const ratio = demand / supply;
  const rounded = Math.round(ratio * 100) / 100;
  if (ratio >= DEMAND_SUPPLY_SHORTAGE_RATIO) return { verdict: "shortage", ratio: rounded, lowDemand: false };
  if (ratio <= DEMAND_SUPPLY_SURPLUS_RATIO) return { verdict: "surplus", ratio: rounded, lowDemand: false };
  return { verdict: "balanced", ratio: rounded, lowDemand: false };
}

/** Острота дефицита для сортировки: «нет предложения» острее любого коэффициента. */
function shortageSeverity(c: DemandSupplyCell): number {
  return c.ratio ?? Number.MAX_SAFE_INTEGER;
}

export interface FoldResult {
  districts: DemandSupplyDistrictRow[];
  cells: DemandSupplyCell[];
  shortage: DemandSupplyCell[];
  surplus: DemandSupplyCell[];
  totals: DemandSupplyResponse["totals"];
}

/**
 * Чистая свёртка: списки желаний и объектов → ячейки матрицы.
 * `districtNames` — id района → название; район без названия в карте берётся как «Без названия».
 */
export function foldDemandSupply(
  clients: DemandClientInput[],
  properties: SupplyPropertyInput[],
  districtNames: Map<string, string>
): FoldResult {
  interface Acc {
    budgets: number[];
    demand: number;
    prices: number[];
    supply: number;
  }
  const grid = new Map<string, Acc & { districtId: string; rooms: DemandSupplyRoomKey }>();
  const slot = (districtId: string, rooms: DemandSupplyRoomKey) => {
    const key = `${districtId}|${rooms}`;
    let acc = grid.get(key);
    if (!acc) {
      acc = { districtId, rooms, budgets: [], demand: 0, prices: [], supply: 0 };
      grid.set(key, acc);
    }
    return acc;
  };

  let demandPlaced = 0;
  let demandUnplaced = 0;
  for (const c of clients) {
    const rk = roomsKey(c.rooms);
    if (!c.districtId || !rk) {
      demandUnplaced += 1;
      continue;
    }
    const acc = slot(c.districtId, rk);
    acc.demand += 1;
    if (c.budgetTjs != null && c.budgetTjs > 0) acc.budgets.push(c.budgetTjs);
    demandPlaced += 1;
  }

  let supplyPlaced = 0;
  let supplyUnplaced = 0;
  for (const p of properties) {
    const rk = roomsKey(p.rooms);
    if (!p.districtId || !rk) {
      supplyUnplaced += 1;
      continue;
    }
    const acc = slot(p.districtId, rk);
    acc.supply += 1;
    if (p.priceTjs > 0) acc.prices.push(p.priceTjs);
    supplyPlaced += 1;
  }

  const nameOf = (id: string) => districtNames.get(id) ?? "Без названия";
  const cells: DemandSupplyCell[] = [...grid.values()].map((acc) => {
    const { verdict, ratio, lowDemand } = cellVerdict(acc.demand, acc.supply);
    const dMed = median(acc.budgets);
    const sMed = median(acc.prices);
    return {
      districtId: acc.districtId,
      districtName: nameOf(acc.districtId),
      rooms: acc.rooms,
      demand: acc.demand,
      supply: acc.supply,
      ratio,
      demandMedianBudget: dMed == null ? null : roundMoney(dMed),
      supplyMedianPrice: sMed == null ? null : roundMoney(sMed),
      verdict,
      lowDemand,
    };
  });

  const byDistrict = new Map<string, DemandSupplyDistrictRow>();
  for (const c of cells) {
    const row = byDistrict.get(c.districtId) ?? {
      districtId: c.districtId,
      districtName: c.districtName,
      demand: 0,
      supply: 0,
    };
    row.demand += c.demand;
    row.supply += c.supply;
    byDistrict.set(c.districtId, row);
  }
  const districts = [...byDistrict.values()].sort(
    (a, b) => b.demand - a.demand || b.supply - a.supply || a.districtName.localeCompare(b.districtName, "ru")
  );
  const order = new Map(districts.map((d, i) => [d.districtId, i]));
  const roomOrder = new Map(DEMAND_SUPPLY_ROOM_KEYS.map((k, i) => [k, i]));
  cells.sort(
    (a, b) =>
      (order.get(a.districtId) ?? 0) - (order.get(b.districtId) ?? 0) ||
      (roomOrder.get(a.rooms) ?? 0) - (roomOrder.get(b.rooms) ?? 0)
  );

  const shortage = cells
    .filter((c) => c.verdict === "shortage")
    .sort((a, b) => shortageSeverity(b) - shortageSeverity(a) || b.demand - a.demand)
    .slice(0, TOP_CELLS);
  // Самый тяжёлый избыток — где объектов больше всего сверх спроса.
  const surplus = cells
    .filter((c) => c.verdict === "surplus")
    .sort((a, b) => b.supply - b.demand - (a.supply - a.demand) || (a.ratio ?? 0) - (b.ratio ?? 0))
    .slice(0, TOP_CELLS);

  return {
    districts,
    cells,
    shortage,
    surplus,
    totals: { demandPlaced, demandUnplaced, supplyPlaced, supplyUnplaced },
  };
}

/** Сколько полных дней объект в продаже (от создания карточки). */
function daysSince(date: Date, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - date.getTime()) / 86_400_000));
}

export async function loadDemandSupply(unsoughtLimit: number): Promise<DemandSupplyResponse> {
  const now = new Date();
  const [policy, money] = await Promise.all([loadMatchPolicy(), loadMoneyContext()]);

  const [clientRows, propertyRows, districtRows] = await Promise.all([
    prisma.client.findMany({
      where: {
        ...waitingBuyerWhere(policy, now),
        // Матрица про квартиры: тот, кто ищет дом, участок или коммерцию, в неё не попадает.
        OR: [{ desiredType: null }, { desiredType: "APARTMENT" }],
      },
      select: { desiredDistrictId: true, desiredRooms: true, budgetMin: true, budgetMax: true, currency: true },
      orderBy: { createdAt: "desc" },
      take: DEMAND_CLIENTS_LIMIT + 1,
    }),
    prisma.property.findMany({
      where: { deletedAt: null, status: "AVAILABLE", type: "APARTMENT" },
      select: { districtId: true, rooms: true, price: true, currency: true },
      orderBy: { createdAt: "desc" },
      take: SUPPLY_PROPERTIES_LIMIT + 1,
    }),
    prisma.district.findMany({ select: { id: true, name: true } }),
  ]);

  const truncated = clientRows.length > DEMAND_CLIENTS_LIMIT || propertyRows.length > SUPPLY_PROPERTIES_LIMIT;
  const clients: DemandClientInput[] = clientRows.slice(0, DEMAND_CLIENTS_LIMIT).map((c) => {
    const budget = c.budgetMax ?? c.budgetMin;
    return {
      districtId: c.desiredDistrictId,
      rooms: c.desiredRooms,
      budgetTjs: budget == null ? null : toTjs(budget, c.currency, money),
    };
  });
  const properties: SupplyPropertyInput[] = propertyRows.slice(0, SUPPLY_PROPERTIES_LIMIT).map((p) => ({
    districtId: p.districtId,
    rooms: p.rooms,
    priceTjs: toTjs(p.price, p.currency, money),
  }));

  const fold = foldDemandSupply(clients, properties, new Map(districtRows.map((d) => [d.id, d.name])));

  // Список «никто не ищет» — дополнение: его отказ не должен оставить без матрицы.
  const unsought = unsoughtLimit > 0 ? await loadUnsought(unsoughtLimit, new Map(districtRows.map((d) => [d.id, d.name])), money, now) : null;

  return {
    generatedAt: now.toISOString(),
    rooms: [...DEMAND_SUPPLY_ROOM_KEYS],
    districts: fold.districts,
    cells: fold.cells,
    shortage: fold.shortage,
    surplus: fold.surplus,
    totals: fold.totals,
    truncated,
    unsought,
  };
}

/**
 * Объекты в продаже, под которые не подходит ни один ждущий покупатель — то же
 * определение, что у метрики «В продаже, но их никто не ищет» в разборе проблем
 * (lib/problemReport.ts): computeDemandCounts. Проверяем самые старые в продаже —
 * им решение нужно раньше всего.
 */
async function loadUnsought(
  limit: number,
  districtNames: Map<string, string>,
  money: Awaited<ReturnType<typeof loadMoneyContext>>,
  now: Date
): Promise<DemandSupplyResponse["unsought"]> {
  try {
    const props = await prisma.property.findMany({
      where: { deletedAt: null, status: "AVAILABLE" },
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
        lat: true,
        lng: true,
        createdAt: true,
      },
      orderBy: { createdAt: "asc" },
      take: UNSOUGHT_CHECK_LIMIT,
    });
    const demand = await computeDemandCounts(props);
    const none = props.filter((p) => (demand.get(p.id) ?? 0) === 0);
    const items: UnsoughtProperty[] = none.slice(0, limit).map((p) => ({
      propertyId: p.id,
      shortId: p.shortId,
      title: p.title,
      districtName: p.districtId ? (districtNames.get(p.districtId) ?? null) : null,
      rooms: p.rooms,
      priceTjs: toTjs(p.price, p.currency, money),
      daysOnSale: daysSince(p.createdAt, now),
    }));
    return { total: none.length, checked: props.length, items };
  } catch (err) {
    console.error("[спрос и предложение] список «никто не ищет»:", err instanceof Error ? err.message : err);
    void logSystemError("api", `Отчёт «Спрос и предложение»: список объектов без спроса не посчитан — ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
