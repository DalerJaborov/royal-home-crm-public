import { prisma } from "../db.js";
import { dushanbeStartOfMonth } from "./dushanbeTime.js";

/**
 * ИНТЕРЕС К ОБЪЕКТАМ (владелец 09.09.2026).
 *
 * Дословно: «я хочу видеть, каким объектом интересуются на данный момент больше
 * всего, чтобы запустить его на таргетинг» и «в отчётах на каждый месяц — какими
 * объектами чаще всего интересуются, чтобы делать упор именно на такие объекты, на
 * такие районы».
 *
 * ЭТО ДВА РАЗНЫХ ВОПРОСА, И ОТВЕЧАТЬ НА НИХ НАДО ПО-РАЗНОМУ:
 *   «прямо сейчас» — короткое окно (по умолчанию 7 дней), решение про деньги на
 *   рекламу принимается сегодня и по свежему спросу;
 *   «за месяц» — срез по РАЙОНАМ и характеристикам, решение про то, какие объекты
 *   вообще брать в работу.
 *
 * ПОЧЕМУ НЕ СЧЁТЧИК `Property.viewsCount`. Он существует, но считает ПОКАЗЫ, и у
 * него нет времени: по нему нельзя ответить ни на один из двух вопросов выше.
 * Интерес — это поток событий, и хранить его надо потоком.
 *
 * КАЖДОЕ СОБЫТИЕ — СЛЕД РЕАЛЬНОГО ЧЕЛОВЕКА, А НЕ ДОГАДКА СИСТЕМЫ. Поэтому сюда не
 * попадают, например, «объект подошёл под фильтр» или «агент пролистал список»:
 * такие сигналы раздули бы цифру и сделали её бесполезной для решения про рекламу.
 */

export const INTEREST_KINDS = ["SHARE_SENT", "SHARE_OPENED", "SHOWING", "COMMENT", "MATCH_SENT"] as const;
export type InterestKind = (typeof INTEREST_KINDS)[number];

/**
 * ВЕС СИГНАЛА. Открытая клиентом ссылка и назначенный показ говорят о спросе
 * несравнимо больше, чем отправленная ссылка: отправить может и агент, который
 * рассылает всё подряд. Без весов топ возглавили бы объекты самого активного
 * агента, а не самые нужные людям.
 */
const WEIGHT: Record<InterestKind, number> = {
  SHARE_SENT: 1,
  SHARE_OPENED: 3,
  SHOWING: 5,
  COMMENT: 2,
  MATCH_SENT: 1,
};

/**
 * Идентичность в канале (author psid/igsid комментария Instagram), когда настоящего
 * Client ещё нет — тот же мост "канал раньше карточки", что recipientId у
 * PropertyExposure. Передаётся вместо clientId, никогда вместе с ним.
 */
export interface ExternalInterestAuthor {
  id: string;
  name?: string | null;
}

/** Записать сигнал. Никогда не бросает: интерес — статистика, а не работа. */
export async function recordInterest(
  propertyId: string,
  kind: InterestKind,
  clientId?: string | null,
  externalAuthor?: ExternalInterestAuthor | null
): Promise<void> {
  try {
    await prisma.propertyInterestEvent.create({
      data: {
        propertyId,
        kind,
        clientId: clientId ?? null,
        externalAuthorId: externalAuthor?.id ?? null,
        externalAuthorName: externalAuthor?.name ?? null,
      },
    });
  } catch (err) {
    console.error("[интерес] сигнал не записан:", err instanceof Error ? err.message : err);
  }
}

export interface HotProperty {
  propertyId: string;
  shortId: number;
  title: string;
  districtName: string | null;
  price: number;
  /** Сумма весов сигналов за окно. */
  score: number;
  events: number;
  /** Сколько РАЗНЫХ людей проявили интерес — важнее общего числа событий. */
  people: number;
}

/**
 * Чем интересуются прямо сейчас. Только объекты В ПРОДАЖЕ: запускать рекламу на
 * проданное или снятое незачем.
 */
export async function hotPropertiesNow(days = 7, limit = 10): Promise<HotProperty[]> {
  const since = new Date(Date.now() - days * 24 * 3600_000);
  const events = await prisma.propertyInterestEvent.findMany({
    where: { createdAt: { gte: since }, property: { status: { in: ["AVAILABLE", "RESERVED"] }, deletedAt: null } },
    select: {
      propertyId: true,
      kind: true,
      clientId: true,
      property: { select: { shortId: true, title: true, price: true, district: { select: { name: true } } } },
    },
    // Потолок обязателен: без него один активный месяц вернул бы десятки тысяч строк.
    take: 5000,
    orderBy: { createdAt: "desc" },
  });

  const byProperty = new Map<string, HotProperty & { peopleSet: Set<string> }>();
  for (const e of events) {
    let row = byProperty.get(e.propertyId);
    if (!row) {
      row = {
        propertyId: e.propertyId,
        shortId: e.property.shortId,
        title: e.property.title,
        districtName: e.property.district?.name ?? null,
        price: Number(e.property.price),
        score: 0,
        events: 0,
        people: 0,
        peopleSet: new Set<string>(),
      };
      byProperty.set(e.propertyId, row);
    }
    row.score += WEIGHT[e.kind as InterestKind] ?? 1;
    row.events += 1;
    if (e.clientId) row.peopleSet.add(e.clientId);
  }

  return [...byProperty.values()]
    .map(({ peopleSet, ...rest }) => ({ ...rest, people: peopleSet.size }))
    .sort((a, b) => b.score - a.score || b.people - a.people)
    .slice(0, limit);
}

export interface DistrictDemand {
  districtName: string;
  score: number;
  events: number;
  properties: number;
}

/**
 * Месячный срез по районам — на какие районы делать упор. Считается по тем же
 * событиям, но группировка другая: владельцу здесь нужен не конкретный объект, а
 * куда вообще смотрит спрос.
 */
export async function districtDemandForMonth(periodStart: Date): Promise<DistrictDemand[]> {
  const from = dushanbeStartOfMonth(periodStart);
  const to = dushanbeStartOfMonth(new Date(from.getTime() + 40 * 24 * 3600_000));

  const events = await prisma.propertyInterestEvent.findMany({
    where: { createdAt: { gte: from, lt: to } },
    select: { kind: true, propertyId: true, property: { select: { district: { select: { name: true } } } } },
    take: 20000,
  });

  const byDistrict = new Map<string, { score: number; events: number; props: Set<string> }>();
  for (const e of events) {
    const name = e.property.district?.name ?? "Без района";
    const row = byDistrict.get(name) ?? { score: 0, events: 0, props: new Set<string>() };
    row.score += WEIGHT[e.kind as InterestKind] ?? 1;
    row.events += 1;
    row.props.add(e.propertyId);
    byDistrict.set(name, row);
  }

  return [...byDistrict.entries()]
    .map(([districtName, v]) => ({ districtName, score: v.score, events: v.events, properties: v.props.size }))
    .sort((a, b) => b.score - a.score);
}

/** Веса сигналов для расчётов, читающих те же события (температура объекта, lib/propertyHeat.ts). */
export { WEIGHT as INTEREST_WEIGHT };
