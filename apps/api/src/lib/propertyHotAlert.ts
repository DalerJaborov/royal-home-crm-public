import { formatShortCode } from "@royal-home/shared";
import { prisma } from "../db.js";
import { sendPushToAgent } from "../push.js";
import {
  HOT_MIN_VIEWS,
  HOT_WINDOW_DAYS,
  detectHot,
  dushanbeDayStartDaysAgo,
  siteDaysWindow,
} from "./propertyStats.js";

/**
 * «ОБЪЕКТ ЗАГОРЕЛСЯ» — УВЕДОМЛЕНИЕ АГЕНТУ (24.09.2026, Dan 07:00: «сигнал
 * „объект загорелся“ — уведомить агента»).
 *
 * Тот же признак, что чип «Загорелся» во вкладке «Статистика» (`detectHot`):
 * за 2 последних дня на сайте не меньше HOT_MIN_VIEWS просмотров и в
 * HOT_MIN_RATIO раз больше обычного за 2 недели до них. Идёт сразу после сбора
 * статистики сайта (крон `site-stats`), то есть раз в час, но одному объекту —
 * не чаще раза в неделю (`Property.hotNotifiedAt`).
 *
 * Кому: агенту сделки, иначе принявшему объект, — тому же, кого показывает
 * колонка «Агент» каталога. Уволенным не шлём. Ночью пуш ждёт утра сам
 * (тихие часы в push.ts), строка в ленте появляется сразу.
 *
 * Защита от ложной волны: пока истории сайта меньше двух недель, «обычное»
 * посчитать не из чего, и любой объект с десятком просмотров выглядел бы
 * загоревшимся. До этого момента молчим.
 */

/** Не чаще раза в неделю на объект: вспышка длится 2–3 дня, напоминать каждый час — шум. */
export const HOT_ALERT_COOLDOWN_DAYS = 7;
/** Потолок за один сбор — страховка от волны, если что-то пошло не так. */
export const HOT_ALERT_MAX_PER_RUN = 20;

const DAY_MS = 24 * 60 * 60 * 1000;

export async function notifyHotProperties(now: Date = new Date()): Promise<number> {
  const windowStart = dushanbeDayStartDaysAgo(HOT_WINDOW_DAYS - 1, now);
  const oldestHour = await prisma.siteVisitHour.findFirst({ orderBy: { hourStart: "asc" }, select: { hourStart: true } });
  if (!oldestHour || oldestHour.hourStart > windowStart) return 0;

  // Кандидаты — объекты в продаже, набравшие за 2 последних дня хотя бы порог.
  const recentStart = dushanbeDayStartDaysAgo(1, now);
  const recent = await prisma.sitePropertyDay.groupBy({
    by: ["propertyId"],
    where: { day: { gte: recentStart } },
    _sum: { views: true },
    having: { views: { _sum: { gte: HOT_MIN_VIEWS } } },
  });
  if (recent.length === 0) return 0;

  const cooldownFrom = new Date(now.getTime() - HOT_ALERT_COOLDOWN_DAYS * DAY_MS);
  const props = await prisma.property.findMany({
    where: {
      id: { in: recent.map((r) => r.propertyId) },
      deletedAt: null,
      status: "AVAILABLE",
      OR: [{ hotNotifiedAt: null }, { hotNotifiedAt: { lt: cooldownFrom } }],
    },
    select: {
      id: true,
      shortId: true,
      title: true,
      assignedAgent: { select: { id: true, isActive: true } },
      intakeAgent: { select: { id: true, isActive: true } },
    },
  });
  if (props.length === 0) return 0;

  const rows = await prisma.sitePropertyDay.findMany({
    where: { propertyId: { in: props.map((p) => p.id) }, day: { gte: windowStart } },
    select: { propertyId: true, day: true, views: true },
  });
  const byProperty = new Map<string, { day: Date; views: number }[]>();
  for (const r of rows) {
    if (!byProperty.has(r.propertyId)) byProperty.set(r.propertyId, []);
    byProperty.get(r.propertyId)!.push(r);
  }

  const hot = props
    .map((p) => ({ p, signal: detectHot(siteDaysWindow(byProperty.get(p.id) ?? [], HOT_WINDOW_DAYS, now)) }))
    .filter((x) => x.signal.hot)
    .sort((a, b) => b.signal.recentViews - a.signal.recentViews)
    .slice(0, HOT_ALERT_MAX_PER_RUN);

  let sent = 0;
  for (const { p, signal } of hot) {
    const agent = p.assignedAgent?.isActive ? p.assignedAgent : p.intakeAgent?.isActive ? p.intakeAgent : null;
    // Отметка ставится и без адресата: иначе объект без агента проверялся бы
    // заново каждый час всю неделю вспышки.
    await prisma.property.update({ where: { id: p.id }, data: { hotNotifiedAt: now } });
    if (!agent) continue;
    const times = signal.ratio != null ? `, в ${String(signal.ratio).replace(".", ",")} раза больше обычного` : "";
    await sendPushToAgent(agent.id, {
      kind: "hot",
      title: `Объект загорелся: ${formatShortCode("ОБ", p.shortId)}`,
      body: `${p.title} — ${signal.recentViews} просмотров на сайте за 2 дня${times}. Самое время позвонить тем, кто им интересовался.`,
      url: `/properties/${p.shortId}?tab=stats`,
      tag: `property-hot:${p.id}`,
    });
    sent++;
  }
  return sent;
}
