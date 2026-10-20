import { prisma } from "../db.js";
import { dushanbeStartOfToday, dushanbeWallClock } from "./dushanbeTime.js";
import { computeRoyalScore, computeRoyalScoreBreakdown, type RoyalScoreCategoryKey } from "./scoreJournal.js";
import { DEFAULT_LEAD_ACTIVE_LIMIT, OCCUPIES_SLOT_WHERE } from "./leadLimits.js";
import { RATED_ROLES } from "@royal-home/shared";

/**
 * Кабинет Royal Score агента: текущий счёт, два места, динамика и живой
 * предпросмотр — по спецификации владельца (01.08.2026, «Личный кабинет агента»).
 *
 * РЕШЕНИЕ ВЛАДЕЛЬЦА 03.08.2026 (отменяет решение от 01.08): счёт считается ПРЯМО
 * по журналу событий Royal Score (см. scoreJournal.ts), а не взвешенной моделью
 * восьми показателей. `Agent.kpi` теперь пишется из `computeRoyalScore` ночным
 * пересчётом (kpi.ts::calculateDailyKpiForAllAgents) — здесь он просто читается
 * как кэш, ровно тот же, что видит распределение лидов и TOP AGENTS.
 *
 * «ЧТО ИЗМЕНИЛОСЬ СЕГОДНЯ» ТЕПЕРЬ — ЖУРНАЛ, А НЕ РАЗБОР ПО ПОКАЗАТЕЛЯМ. Раньше
 * здесь был расчёт восьми взвешенных метрик на лету — он показывал ПОЧЕМУ
 * изменился взвешенный балл, но не имел отношения к реальному, событийному
 * счёту, и после переключения был бы откровенно лживым («Дисциплина 20 из 20»
 * рядом со счётом, который эта цифра больше не объясняет). Объяснение теперь —
 * список самих событий (`loadScoreEvents`, подмешивается в /me/royal-score):
 * «−5, не позвонил за 15 минут» точнее любого разбора по осям.
 */

export interface RoyalScoreView {
  /** Текущий счёт — кэш Agent.kpi, обновляется ночным пересчётом. По нему же
   *  распределяются лиды и считается TOP AGENTS: то же число, что видят другие. */
  score: number;
  /**
   * Живой счёт ПРЯМО СЕЙЧАС, с учётом сегодняшних событий, которые ночной
   * пересчёт ещё не зафиксировал в `score`. Замена прежнему разбору «что
   * изменилось сегодня»: агент видит эффект своих действий сразу, а не
   * назавтра, — но одним честным числом, а не выдуманной раскладкой по осям.
   */
  liveScore: number;
  /** Место среди активных агентов и их общее число. */
  rank: number;
  totalAgents: number;
  /** Место среди ВСЕХ агентов компании (включая приостановленных/замороженных)
   *  и их общее число — второе место рейтинга, отдельное от «среди активных»
   *  (спецификация владельца: «место в компании; место среди активных агентов»). */
  companyRank: number;
  totalCompanyAgents: number;
  activeClients: number;
  /** Свободные места до лимита; null — лимит выключен. */
  freeSlots: number | null;
  /** История по дням для графика динамики (последние 30, событийный счёт). */
  history: { date: string; score: number }[];
  /** Динамика счёта за день/неделю/месяц — разница живого счёта с ближайшей
   *  записью истории на нужную глубину. null — истории ещё не набралось. */
  dynamics: { day: number | null; week: number | null; month: number | null };
  /** Шесть показателей владельца (продажи/скорость/CRM/объекты/задачи/дисциплина)
   *  — расшифровка, откуда набежал счёт за окно. Сумма событий по категории, не
   *  формула: цена события остаётся той же, что и в самом счёте. */
  categoryBreakdown: Record<RoyalScoreCategoryKey, number>;
}

export async function buildRoyalScoreView(agentId: string): Promise<RoyalScoreView | null> {
  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
    select: { id: true, kpi: true, isActive: true, role: true },
  });
  if (!agent) return null;

  const [agents, companyAgents, activeClients, settings, liveScore, categoryBreakdown, history] = await Promise.all([
    // Место считается среди агентов: у руководителя личного портфеля нет, и место
    // в рейтинге ему не принадлежит.
    prisma.agent.findMany({ where: { role: { in: [...RATED_ROLES] }, isActive: true }, select: { id: true, kpi: true } }),
    // «Место в компании» — второй срез: ВСЕ агенты, включая приостановленных
    // (agentPause) и замороженных (frozenAt). Тот, кто временно не берёт лиды,
    // из компании не исчезает — его счёт по-прежнему считается.
    prisma.agent.findMany({ where: { role: { in: [...RATED_ROLES] } }, select: { id: true, kpi: true } }),
    /**
     * СЧИТАЕМ ТЕМ ЖЕ ПРАВИЛОМ, ЧТО И САМА РАЗДАЧА (владелец 20.08.2026, разбор
     * «почему агенту не приходят лиды»).
     *
     * Здесь стояло своё условие `status in (NEW, CONTACTED, HOT)` — а раздача лидов
     * с 12.08.2026 считает занятость иначе: по `workStatus="ACTIVE"` и любому
     * не-терминальному статусу (lib/leadLimits.ts, OCCUPIES_SLOT_WHERE). Два правила
     * про одно и то же разошлись, и агент видел у себя не то число, по которому CRM
     * реально решает, давать ему лид: на проде у одного экран показывал 8 при
     * фактических 7, у другого 8 при фактических 10. У самой границы это прямая
     * ложь — «свободно 1», хотя лида не будет, и наоборот.
     *
     * Тот же урок, что записан в lib/clientPhone.ts: правило должно жить в одном
     * месте, иначе вторая его копия неизбежно начинает врать.
     */
    prisma.client.count({
      where: { assignedAgentId: agentId, deletedAt: null, ...OCCUPIES_SLOT_WHERE },
    }),
    prisma.settings.findUnique({ where: { id: "singleton" }, select: { leadActiveLimit: true } }),
    // Живой счёт считается на лету по журналу — ночной пересчёт зафиксирует его
    // в Agent.kpi только завтра, а агенту нужно видеть эффект своих действий сейчас.
    computeRoyalScore(agentId),
    computeRoyalScoreBreakdown(agentId),
    prisma.kpiDailyScore.findMany({
      where: { agentId },
      orderBy: { date: "desc" },
      take: 30,
      select: { date: true, score: true },
    }),
  ]);

  /**
   * Пустой KPI — это «ещё не считался», а не «отличный».
   *
   * Сотня по умолчанию ставила новичка, у которого нет ни одного рабочего дня, ВЫШЕ
   * всех, кто работает месяцами: ночной пересчёт заполняет поле только на следующее
   * утро, и до тех пор человек занимал первое место в собственном кабинете. Для
   * рейтинга это ложь, и особенно обидная — соседи по списку видят её же.
   *
   * В сортировке такой агент идёт последним (-1), в собственном счёте ниже
   * по-прежнему показывается 100: там это не место в рейтинге, а стартовый балл,
   * от которого счёт снижают взыскания.
   */
  const sorted = [...agents].sort((a, b) => (b.kpi ?? -1) - (a.kpi ?? -1));
  const rank = Math.max(1, sorted.findIndex((a) => a.id === agentId) + 1);
  const sortedCompany = [...companyAgents].sort((a, b) => (b.kpi ?? -1) - (a.kpi ?? -1));
  const companyRank = Math.max(1, sortedCompany.findIndex((a) => a.id === agentId) + 1);

  /**
   * Динамика за день/неделю/месяц (спецификация владельца, «Личный кабинет
   * агента»). База — самая свежая запись `history` НЕ ПОЗЖЕ нужной даты: history
   * упорядочена по убыванию даты, поэтому первое совпадение при сканировании —
   * ближайшая запись ниже цели, а не случайная. Меньше данных, чем нужно для
   * периода (агент недавно начал работать), — null, а не подмена нулём: «счёт не
   * менялся» и «истории ещё нет» это разные вещи для человека, который читает цифру.
   */
  const startOfToday = dushanbeStartOfToday();
  function scoreAsOf(daysAgo: number): number | null {
    const target = startOfToday.getTime() - daysAgo * 24 * 60 * 60 * 1000;
    const entry = history.find((h) => h.date.getTime() <= target);
    return entry ? entry.score : null;
  }
  const baselineDay = scoreAsOf(0);
  const baselineWeek = scoreAsOf(7);
  const baselineMonth = scoreAsOf(30);
  const dynamics = {
    day: baselineDay !== null ? liveScore - baselineDay : null,
    week: baselineWeek !== null ? liveScore - baselineWeek : null,
    month: baselineMonth !== null ? liveScore - baselineMonth : null,
  };

  const limit = settings?.leadActiveLimit ?? DEFAULT_LEAD_ACTIVE_LIMIT;
  return {
    score: agent.kpi ?? 100,
    liveScore,
    rank,
    totalAgents: agents.length,
    companyRank,
    totalCompanyAgents: companyAgents.length,
    activeClients,
    freeSlots: limit > 0 ? Math.max(0, limit - activeClients) : null,
    history: [...history]
      .reverse()
      // h.date — душанбинская полночь (в UTC это 19:00 ПРЕДЫДУЩЕГО дня): голый
      // toISOString().slice(0,10) отдавал вчерашнюю дату — тултип истории врал
      // на день всем и всегда (26.08.2026). Приём тот же, что в expenses.ts:369.
      .map((h) => ({ date: dushanbeWallClock(h.date).toISOString().slice(0, 10), score: h.score })),
    dynamics,
    categoryBreakdown,
  };
}
