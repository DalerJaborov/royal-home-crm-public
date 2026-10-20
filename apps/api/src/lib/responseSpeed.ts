import {
  RESPONSE_SPEED_BOUNDS_MIN,
  RESPONSE_SPEED_BUCKET_KEYS,
  RESPONSE_SPEED_BUCKET_LABELS,
  RESPONSE_SPEED_MIN_SAMPLE,
  type ResponseSpeedBucket,
  type ResponseSpeedBucketKey,
  type ResponseSpeedResponse,
} from "@royal-home/shared";
import { prisma } from "../db.js";
import { dushanbeStartOfToday } from "./dushanbeTime.js";
import { COUNTED_SHOWING_WHERE } from "./tasks.js";
import { median } from "./demandSupply.js";

/**
 * СКОРОСТЬ ПЕРВОГО ОТВЕТА ПРОТИВ ДОХОДА ДО ПОКАЗА (владелец, 03.10.2026).
 *
 * Берём только то, что уже пишется: Client.createdAt (клиент появился) и
 * Client.firstContactAt (первая работа агента — звонок или запись в хронологию;
 * тот же показатель, что в утренней сводке, lib/morningNumbers.ts). «Дошёл до
 * показа» — есть неотменённый показ (Interaction SHOWING) или сделка (Deal).
 *
 * ОГРАНИЧЕНИЕ, КОТОРОЕ ЭКРАН ОБЯЗАН НАЗВАТЬ: ответ бота и ответ в мессенджере
 * вне CRM в firstContactAt не попадают, поэтому «без ответа» — это «агент в
 * карточке ничего не сделал», а не «клиенту никто не ответил».
 */

export const RESPONSE_SPEED_ROWS_LIMIT = 20_000;
/** Обращения моложе этого срока не берём: без ответа и без показа они «по возрасту», а не по скорости. */
export const RESPONSE_SPEED_MATURE_DAYS = 3;

export interface ResponseSpeedLeadInput {
  createdAt: Date;
  firstContactAt: Date | null;
  /** Дошёл до показа или сделки. */
  reachedShowing: boolean;
}

/** Минуты до ответа → ключ корзины. Границы исключительные сверху: ровно 5 минут — уже «5–15». */
export function bucketKeyForMinutes(minutes: number): Exclude<ResponseSpeedBucketKey, "none"> {
  const [b1, b2, b3, b4] = RESPONSE_SPEED_BOUNDS_MIN;
  if (minutes < b1) return "lt1";
  if (minutes < b2) return "m1to5";
  if (minutes < b3) return "m5to15";
  if (minutes < b4) return "m15to60";
  return "gt60";
}

export interface BucketFold {
  leads: number;
  medianMinutes: number | null;
  buckets: ResponseSpeedBucket[];
  /** Ответ раньше создания карточки — не про скорость ответа, в корзины не входит. */
  excluded: number;
}

/** Чистая свёртка обращений в корзины. Пустой вход даёт нулевые корзины, а не ошибку. */
export function foldResponseSpeed(rows: ResponseSpeedLeadInput[]): BucketFold {
  const acc = new Map<ResponseSpeedBucketKey, { leads: number; reached: number; minutes: number[] }>(
    RESPONSE_SPEED_BUCKET_KEYS.map((k) => [k, { leads: 0, reached: 0, minutes: [] }])
  );
  const answered: number[] = [];
  let excluded = 0;
  let leads = 0;

  for (const r of rows) {
    let key: ResponseSpeedBucketKey = "none";
    let minutes: number | null = null;
    if (r.firstContactAt) {
      minutes = (r.firstContactAt.getTime() - r.createdAt.getTime()) / 60_000;
      if (minutes < 0) {
        excluded += 1;
        continue;
      }
      key = bucketKeyForMinutes(minutes);
      answered.push(minutes);
    }
    const slot = acc.get(key)!;
    slot.leads += 1;
    if (r.reachedShowing) slot.reached += 1;
    if (minutes != null) slot.minutes.push(minutes);
    leads += 1;
  }

  const buckets: ResponseSpeedBucket[] = RESPONSE_SPEED_BUCKET_KEYS.map((key) => {
    const s = acc.get(key)!;
    const med = median(s.minutes);
    return {
      key,
      label: RESPONSE_SPEED_BUCKET_LABELS[key],
      leads: s.leads,
      share: leads > 0 ? s.leads / leads : 0,
      reachedShowing: s.reached,
      showingRate: s.leads >= RESPONSE_SPEED_MIN_SAMPLE ? s.reached / s.leads : null,
      medianMinutes: med == null ? null : Math.round(med * 10) / 10,
    };
  });
  const overall = median(answered);
  return { leads, medianMinutes: overall == null ? null : Math.round(overall * 10) / 10, buckets, excluded };
}

export async function loadResponseSpeed(days: number): Promise<ResponseSpeedResponse> {
  const now = new Date();
  // Границы суток — по Душанбе (lib/dushanbeTime.ts), а не «минус 90×24 часа от сейчас».
  const from = new Date(dushanbeStartOfToday(now).getTime() - days * 86_400_000);
  const to = new Date(now.getTime() - RESPONSE_SPEED_MATURE_DAYS * 86_400_000);

  // Покупатели, пришедшие сами: личные лиды агент заводит сам, ответа «клиенту, который ждал» там нет.
  const cohort = { kind: "BUYER", deletedAt: null, isPersonalLead: false, createdAt: { gte: from, lte: to } } as const;

  const [rows, showingGroups, dealGroups] = await Promise.all([
    prisma.client.findMany({
      where: cohort,
      select: { id: true, createdAt: true, firstContactAt: true },
      orderBy: { createdAt: "desc" },
      take: RESPONSE_SPEED_ROWS_LIMIT + 1,
    }),
    prisma.interaction.groupBy({
      by: ["clientId"],
      where: { type: "SHOWING", ...COUNTED_SHOWING_WHERE, client: cohort },
    }),
    prisma.deal.groupBy({ by: ["clientId"], where: { client: cohort } }),
  ]);

  const truncated = rows.length > RESPONSE_SPEED_ROWS_LIMIT;
  const reached = new Set<string>([...showingGroups.map((g) => g.clientId), ...dealGroups.map((g) => g.clientId)]);
  const fold = foldResponseSpeed(
    rows.slice(0, RESPONSE_SPEED_ROWS_LIMIT).map((c) => ({
      createdAt: c.createdAt,
      firstContactAt: c.firstContactAt,
      reachedShowing: reached.has(c.id),
    }))
  );

  return {
    days,
    generatedAt: now.toISOString(),
    leads: fold.leads,
    medianMinutes: fold.medianMinutes,
    buckets: fold.buckets,
    matureAfterDays: RESPONSE_SPEED_MATURE_DAYS,
    excluded: fold.excluded,
    truncated,
  };
}
