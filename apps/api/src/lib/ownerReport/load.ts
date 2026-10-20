import {
  OWNER_REPORT_ALL_DAYS,
  OWNER_REPORT_WEEK_DAYS,
  type OwnerReportResponse,
} from "@royal-home/shared";
import { prisma } from "../../db.js";
import { dushanbeDayRange } from "../dushanbeTime.js";
import { loadPropertyVoice } from "../propertyVoice/loadPropertyVoice.js";
import { buildOwnerReport, type OwnerReportPeriodSource } from "./build.js";

/**
 * ЧТЕНИЕ БАЗЫ ДЛЯ «ОТЧЁТА ВЛАДЕЛЬЦУ» (03.10.2026) — вся работа с базой в одном месте,
 * счёт и тексты — в build.ts (чистая функция, проверяется без базы).
 *
 * Цифры берутся из «голоса рынка» (lib/propertyVoice/): он уже знает, что считать
 * «интересом», какие комментарии содержательны и как делить рекламу между объектами.
 * Здесь он вызывается ДВАЖДЫ — с окном 7 календарных суток по Душанбе и с окном «всё время». Права вызывающего
 * для страницы без входа нет, поэтому закрыто всё, что закрыто для агента без права:
 *  • деньги рекламы (`canSeeAdMoney: false`) — сумм нет ни в ответе, ни в диагнозе;
 *  • голос клиента после показа (`canSeeShowingFeedback: false`) — таблицы не читаются;
 *  • чужие сделки — не читаются вовсе (нужная «сделка» в отчёте не показывается).
 *
 * Выборки ограничены `take` внутри loadPropertyVoice; здесь две свои — по `take` же.
 * Готовый отчёт держит короткий кэш (cache.ts): один запрос — около полусотни обращений к базе.
 */

const DAY_MS = 24 * 3600_000;
/** Предел выборки обращений: потолок на объект, число в ответе — не страница. */
const TAKE_CONTACTS = 5_000;

/** Подставной «зритель» для loadPropertyVoice: ни сделок, ни денег, ни разбора после показа. */
const PUBLIC_VIEWER = {
  canSeeShowingFeedback: false,
  canSeeAdMoney: false,
  // Реального агента нет; такого id не существует, и сделки по нему не находятся.
  dealsOwnAgentId: "owner-report-public",
  canSeeAllDealMoney: false,
  viewerId: "owner-report-public",
} as const;

/**
 * НЕДЕЛЯ ОТЧЁТА — 7 КАЛЕНДАРНЫХ СУТОК ПО ДУШАНБЕ, включая сегодня (ревью 04.10.2026).
 * Раньше окна расходились: «голос рынка» брал скользящие 7×24 часа, обращения — с полуночи
 * Душанбе шесть дней назад, а расход рекламы по колонке-дате цеплял восьмые сутки. Теперь
 * все источники режутся по одной границе (она же передаётся в «голос рынка» как windowFrom);
 * страница так и подписана.
 */
function weekStart(now: Date): Date {
  return dushanbeDayRange(new Date(now.getTime() - (OWNER_REPORT_WEEK_DAYS - 1) * DAY_MS)).start;
}

/**
 * Сколько разных людей общались с нами по объекту: клиенты карточек CRM со звонком или
 * сообщением по этому объекту плюс диалоги бота, где объект назывался.
 *
 * ЧЕЛОВЕК СЧИТАЕТСЯ ОДИН РАЗ. Клиент, у которого есть и звонок, и диалог бота (диалог
 * привязан к его карточке: BotConversation.clientId), — один человек, а не два: карточки
 * обоих источников сводятся в одно множество, отдельно прибавляются только диалоги без
 * карточки (склеить их пока не с кем).
 *
 * НАПРАВЛЕНИЯ ЗВОНКА В ХРОНОЛОГИИ НЕТ: Interaction не хранит «входящий/исходящий», а
 * запись агента и входящий, принятый агентом, выглядят одинаково (actorKind=AGENT). Поэтому
 * вырезано то, что различимо однозначно, — безуспешная попытка агента (исход «не
 * дозвонился»): человек на связь не выходил. Пропущенные входящие исхода не несут
 * (lib/telephony/incomingCalls.ts), их человек набрал сам, и они остаются. Остальное честно
 * называется «контактов по объекту», а не «написали сами» — так подписано и на странице.
 */
async function countContacts(propertyId: string, since: Date | null): Promise<number> {
  const [interactions, botChats] = await Promise.all([
    prisma.interaction.findMany({
      where: {
        propertyId,
        type: { in: ["CALL", "MESSAGE"] },
        // Не безуспешная попытка агента (исход «не дозвонился» ставит только он сам). Записано
        // через OR, а не NOT: у Prisma NOT по необязательному полю теряет строки с NULL — а
        // у входящих исхода нет вообще.
        OR: [{ actorKind: { not: "AGENT" } }, { outcome: null }, { outcome: { not: "NO_ANSWER" } }],
        ...(since ? { createdAt: { gte: since } } : {}),
      },
      select: { clientId: true },
      distinct: ["clientId"],
      take: TAKE_CONTACTS,
    }),
    prisma.conversationProperty.findMany({
      where: { propertyId, ...(since ? { firstSeenAt: { gte: since } } : {}) },
      select: { conversation: { select: { clientId: true } } },
      take: TAKE_CONTACTS,
    }),
  ]);
  const people = new Set<string>(interactions.map((i) => i.clientId));
  let withoutCard = 0;
  for (const chat of botChats) {
    const clientId = chat.conversation.clientId;
    if (clientId) people.add(clientId);
    else withoutCard += 1;
  }
  return people.size + withoutCard;
}

/** Просмотры страницы на сайте; null — от сайта по этому объекту данных нет вовсе. */
async function siteViews(propertyId: string, sinceDay: Date | null): Promise<number | null> {
  const agg = await prisma.sitePropertyDay.aggregate({
    where: { propertyId, ...(sinceDay ? { day: { gte: sinceDay } } : {}) },
    _sum: { views: true },
    _count: { _all: true },
  });
  // Есть ли вообще данные от сайта по объекту — судим по всему времени, а не по неделе:
  // «0 просмотров за неделю» и «сайт не присылает» — разные вещи.
  if (agg._count._all > 0) return agg._sum.views ?? 0;
  if (!sinceDay) return null;
  const any = await prisma.sitePropertyDay.findFirst({ where: { propertyId }, select: { day: true } });
  return any ? 0 : null;
}

/** Статус продажи для владельца — те же слова, что у публичной ссылки клиента (routes/propertyShare.ts). */
export type OwnerReportSaleStatusFn = (status: string) => OwnerReportResponse["property"]["saleStatus"];

export async function loadOwnerReport(
  propertyId: string,
  saleStatusOf: OwnerReportSaleStatusFn,
  now: Date = new Date()
): Promise<OwnerReportResponse | null> {
  const property = await prisma.property.findUnique({
    where: { id: propertyId },
    select: {
      id: true,
      title: true,
      rooms: true,
      price: true,
      currency: true,
      status: true,
      deletedAt: true,
      createdAt: true,
      stageEnteredAt: true,
      district: { select: { name: true, city: true } },
      photos: { orderBy: { order: "asc" }, take: 1, select: { url: true, thumbUrl: true } },
    },
  });
  if (!property || property.deletedAt) return null;

  const since = weekStart(now);
  const [settings, voiceWeek, voiceAll, contactsWeek, contactsAll, viewsWeek, viewsAll] = await Promise.all([
    prisma.settings.findUnique({
      where: { id: "singleton" },
      select: { companyName: true, companySlogan: true, companyLogoUrl: true },
    }),
    // Недельному окну нужны только счётчики окна: история цены, сделки, источники диалогов и
    // последнее событие от окна не зависят и уже читаются вызовом «за всё время» ниже.
    loadPropertyVoice(propertyId, {
      ...PUBLIC_VIEWER,
      now,
      windowDays: OWNER_REPORT_WEEK_DAYS,
      windowFrom: since,
      adsSince: since,
      skipWindowIndependent: true,
    }),
    loadPropertyVoice(propertyId, { ...PUBLIC_VIEWER, now, windowDays: OWNER_REPORT_ALL_DAYS }),
    countContacts(propertyId, since),
    countContacts(propertyId, null),
    siteViews(propertyId, since),
    siteViews(propertyId, null),
  ]);
  if (!voiceWeek || !voiceAll) return null;

  const onSale = property.status === "AVAILABLE";
  const daysOnSale = onSale ? Math.max(0, Math.floor((now.getTime() - property.stageEnteredAt.getTime()) / DAY_MS)) : null;
  const photo = property.photos[0];

  const week: OwnerReportPeriodSource = { voice: voiceWeek, contacts: contactsWeek, siteViews: viewsWeek };
  const all: OwnerReportPeriodSource = { voice: voiceAll, contacts: contactsAll, siteViews: viewsAll };

  return buildOwnerReport({
    now,
    agency: {
      name: settings?.companyName ?? "Royal Home",
      slogan: settings?.companySlogan ?? "Агентство недвижимости",
      logoUrl: settings?.companyLogoUrl ?? null,
    },
    property: {
      title: property.title,
      rooms: property.rooms,
      district: property.district?.name ?? null,
      city: property.district?.city ?? null,
      price: Number(property.price),
      currency: property.currency,
      photoUrl: photo ? photo.thumbUrl || photo.url : null,
      saleStatus: saleStatusOf(property.status),
      daysOnSale,
    },
    week,
    all,
  });
}
