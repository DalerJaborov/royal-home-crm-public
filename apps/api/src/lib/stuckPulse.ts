import { prisma } from "../db.js";
import { TASK_WHERE } from "./tasks.js";

/**
 * «ГДЕ ЛЮДИ ЗАСТРЯЛИ» — датчик, которого не хватало (владелец 27.08.2026).
 *
 * ЗАЧЕМ ЭТО ЗАВЕДЕНО. За один день владелец нашёл руками четыре вещи, которые не
 * увидел ни один аудит по коду:
 *   • лимит активных лидов стоял 6, а портфели у людей были 10-17 (сам лимит
 *     убран 16.11.2026);
 *   • обязательное окно всплывало по карточке, удалённой полчаса назад;
 *   • значок на иконке приложения горел месяцами, у части людей за сотню.
 *
 * У всех четырёх общее: КОД РАБОТАЛ ТОЧНО ТАК, КАК НАПИСАН. Ошибки в нём нет и
 * читателю кода видеть нечего. Ломается стык правила с жизнью, и виден он только
 * в данных: сколько людей упёрлось в правило, что копится и не убывает, что
 * висит дольше суток. Ровно это здесь и считается.
 *
 * ЭТО НЕ ЖУРНАЛ ОШИБОК. ErrorLog отвечает на вопрос «что сломалось»; здесь —
 * «что исправно работает и при этом мешает людям». Второй вопрос за месяц дал
 * больше находок, чем первый.
 *
 * ПРЕДЕЛЫ ВЕЗДЕ. Отчёт читается в начале каждой рабочей сессии и раз в сутки
 * кроном: он обязан быть дешёвым и не расти вместе с базой.
 */

/** Сколько дней без визита в раздел считаем поводом упомянуть его в отчёте. */
const SECTION_STALE_DAYS = 7;
/** Окно, висящее дольше этого, — уже не напоминание, а фон. */
const SUMMARY_STALE_HOURS = 24;
/** Столько непрочитанных уведомлений — признак, что человек перестал их читать. */
const UNREAD_ALARM = 20;

export interface StuckPulse {
  /** Обязательные окна, висящие дольше суток. */
  staleSummaries: { total: number; oldestDays: number; byAgent: { name: string; count: number }[] };
  /** Люди, у которых уведомления копятся непрочитанными. */
  unreadNotifications: { name: string; unread: number }[];
  /** Разделы, куда сотрудники не заходили неделю: их красные счётчики растут впустую. */
  staleSections: { name: string; section: string; days: number }[];
  /** Просроченные задачи — по живым карточкам (Корзина не считается). */
  overdueTasks: { total: number; byAgent: { name: string; count: number }[] };
}

/** Имя агента по id — одним запросом на весь отчёт, без N+1. */
async function agentNames(ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await prisma.agent.findMany({ where: { id: { in: ids } }, select: { id: true, fullName: true } });
  return new Map(rows.map((a) => [a.id, a.fullName]));
}

/** Обязательные окна, висящие дольше суток: их уже не читают, а закрывают не глядя. */
async function staleSummaries(now: Date): Promise<StuckPulse["staleSummaries"]> {
  const cutoff = new Date(now.getTime() - SUMMARY_STALE_HOURS * 3600_000);
  const rows = await prisma.pendingSummary.findMany({
    where: { doneAt: null, dismissedAt: null, dueAt: { lt: cutoff } },
    select: { agentId: true, dueAt: true },
    orderBy: { dueAt: "asc" },
    take: 500,
  });
  if (rows.length === 0) return { total: 0, oldestDays: 0, byAgent: [] };

  const names = await agentNames([...new Set(rows.map((r) => r.agentId))]);
  const perAgent = new Map<string, number>();
  for (const r of rows) perAgent.set(r.agentId, (perAgent.get(r.agentId) ?? 0) + 1);

  return {
    total: rows.length,
    oldestDays: Math.floor((now.getTime() - rows[0].dueAt.getTime()) / 86400_000),
    byAgent: [...perAgent.entries()]
      .map(([id, count]) => ({ name: names.get(id) ?? "—", count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5),
  };
}

/** У кого уведомления копятся непрочитанными — признак, что их перестали читать. */
async function unreadNotifications(): Promise<StuckPulse["unreadNotifications"]> {
  const rows = await prisma.notification.groupBy({
    by: ["agentId"],
    where: { read: false },
    _count: { _all: true },
  });
  const loud = rows.filter((r) => r._count._all >= UNREAD_ALARM);
  if (loud.length === 0) return [];

  const names = await agentNames(loud.map((r) => r.agentId));
  return loud
    .map((r) => ({ name: names.get(r.agentId) ?? "—", unread: r._count._all }))
    .sort((a, b) => b.unread - a.unread)
    .slice(0, 10);
}

/**
 * Разделы, куда сотрудник не заходил неделю.
 *
 * Красный счётчик такого раздела означает «нового с последнего визита» и растёт
 * без предела — именно из-за этого значок на иконке приложения горел месяцами.
 * Пустая метка (раздел не открывали ни разу) в отчёт не идёт: человек мог просто
 * не иметь к нему отношения.
 */
async function staleSections(now: Date): Promise<StuckPulse["staleSections"]> {
  const agents = await prisma.agent.findMany({
    where: { isActive: true },
    select: { fullName: true, sectionsSeenAt: true },
    take: 200,
  });
  const out: StuckPulse["staleSections"] = [];
  for (const a of agents) {
    const seen = (a.sectionsSeenAt as Record<string, unknown> | null) ?? null;
    if (!seen) continue;
    for (const [section, raw] of Object.entries(seen)) {
      const at = typeof raw === "string" ? new Date(raw) : null;
      if (!at || Number.isNaN(at.getTime())) continue;
      const days = Math.floor((now.getTime() - at.getTime()) / 86400_000);
      if (days >= SECTION_STALE_DAYS) out.push({ name: a.fullName, section, days });
    }
  }
  return out.sort((a, b) => b.days - a.days).slice(0, 10);
}

/** Просроченные задачи по живым карточкам. TASK_WHERE сам отсекает Корзину. */
async function overdueTasks(now: Date): Promise<StuckPulse["overdueTasks"]> {
  const rows = await prisma.interaction.groupBy({
    by: ["agentId"],
    // agentId: not null — считаем по живому агенту (П-10, 17.09.2026); задачи
    // без агента (SYSTEM/AI на subjectAgentId) в этот виджет пока не попадают,
    // см. отчёт Б1 17.09 — не в приоритете этого задания.
    where: { ...TASK_WHERE, completedAt: null, nextActionDate: { lt: now }, agentId: { not: null } },
    _count: { _all: true },
  });
  if (rows.length === 0) return { total: 0, byAgent: [] };

  const agentIds = rows.map((r) => r.agentId).filter((id): id is string => id !== null);
  const names = await agentNames(agentIds);
  return {
    total: rows.reduce((sum, r) => sum + r._count._all, 0),
    byAgent: rows
      .filter((r): r is typeof r & { agentId: string } => r.agentId !== null)
      .map((r) => ({ name: names.get(r.agentId) ?? "—", count: r._count._all }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5),
  };
}

/**
 * Весь датчик разом. Части независимы — считаем параллельно: отчёт читается в
 * начале сессии, и человек ждёт его на экране.
 */
export async function loadStuckPulse(now: Date = new Date()): Promise<StuckPulse> {
  const [stale, unread, sections, overdue] = await Promise.all([
    staleSummaries(now),
    unreadNotifications(),
    staleSections(now),
    overdueTasks(now),
  ]);
  return {
    staleSummaries: stale,
    unreadNotifications: unread,
    staleSections: sections,
    overdueTasks: overdue,
  };
}
