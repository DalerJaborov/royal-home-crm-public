import { Router } from "express";
import { prisma } from "../db.js";
import { requireAuth } from "../auth/middleware.js";
import { dushanbeWallClock, dushanbeStartOfMonth, DUSHANBE_OFFSET_MS } from "../lib/dushanbeTime.js";
import { COUNTED_SHOWING_WHERE } from "../lib/tasks.js";
import { visibleInteractionWhere } from "../lib/investigationPrivacy.js";
import { royalScoreEnabled } from "../lib/royalScoreSwitch.js";
import { RATED_ROLES } from "@royal-home/shared";

export const hallOfFameRouter = Router();

/** Число сделок/показов наружу не отдаём — доска почёта видна всем сотрудникам,
 * а точные результаты коллег — чувствительная статистика (её видит руководство
 * в разделе «Команда»). Наружу — только места. */
interface Nominee {
  id: string;
  fullName: string;
  avatarUrl: string | null;
}

function top3(byAgent: Map<string, number>, agents: Map<string, { fullName: string; avatarUrl: string | null }>): Nominee[] {
  return [...byAgent.entries()]
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([id]) => ({ id, fullName: agents.get(id)?.fullName ?? "—", avatarUrl: agents.get(id)?.avatarUrl ?? null }));
}

/**
 * GET /hall-of-fame — доска почёта за текущий месяц, видна всем сотрудникам.
 * Три номинации: лучший продажник (закрытые сделки), лидер по показам,
 * лидер по добавленным объектам. Только агенты — руководители не соревнуются.
 */
hallOfFameRouter.get("/", requireAuth, async (req, res) => {
  // Начало месяца по Душанбе (сервер на VPS живёт в UTC — без сдвига граница
  // месяца уехала бы на 5 часов).
  const wall = dushanbeWallClock();
  const startOfMonth = new Date(Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), 1) - DUSHANBE_OFFSET_MS);

  const [agentList, deals, showings, showingsBySubject, properties] = await Promise.all([
    prisma.agent.findMany({
      where: { role: { in: [...RATED_ROLES] }, isActive: true },
      select: { id: true, fullName: true, avatarUrl: true, lastSeenAt: true },
      // Потолок обязателен даже там, где агентов десяток — см. /top-agents ниже.
      orderBy: { fullName: "asc" },
      take: 500,
    }),
    // Все три номинации считаются группировкой в базе: наружу приезжает по
    // строке на агента, а не по строке на сделку, показ и объект. Раньше сделки
    // и объекты тянулись целиком за месяц только чтобы сосчитать их в Node —
    // с ростом базы это единственное место доски почёта, которое росло бы.
    prisma.deal.groupBy({
      by: ["agentId"],
      where: { stage: "COMPLETED", closedAt: { gte: startOfMonth } },
      _count: { _all: true },
    }),
    prisma.interaction.groupBy({
      by: ["agentId"],
      // «Лидер по показам» — про проведённые встречи, а не про назначенные:
      // отменённый показ давал бы место на доске почёта за поездку, которой не было.
      // client: { deletedAt: null } (27.08.2026) — соседние номинации (объекты
      // строкой ниже, лиды и активные клиенты в /top-agents) этот фильтр уже
      // имели, показы оставались единственной номинацией без него.
      where: { ...visibleInteractionWhere(req.agent?.role), type: "SHOWING", ...COUNTED_SHOWING_WHERE, createdAt: { gte: startOfMonth }, client: { deletedAt: null } },
      _count: { _all: true },
    }),
    // subjectAgentId (П-10, 17.09.2026): показ, записанный ботом/системой от лица
    // клиента (agentId: null), groupBy(["agentId"]) выше отбрасывает вовсе — он
    // группируется в null и теряется. Держатель карточки лежит в subjectAgentId,
    // считаем отдельной группировкой и складываем с основной ниже (fromGroups).
    prisma.interaction.groupBy({
      by: ["subjectAgentId"],
      where: {
        type: "SHOWING",
        ...visibleInteractionWhere(req.agent?.role),
        ...COUNTED_SHOWING_WHERE,
        createdAt: { gte: startOfMonth },
        client: { deletedAt: null },
        agentId: null,
        subjectAgentId: { not: null },
      },
      _count: { _all: true },
    }),
    prisma.property.groupBy({
      by: ["createdById"],
      where: { createdAt: { gte: startOfMonth }, deletedAt: null },
      _count: { _all: true },
    }),
  ]);

  const agents = new Map(agentList.map((a) => [a.id, { fullName: a.fullName, avatarUrl: a.avatarUrl }]));

  /**
   * Все три номинации приходят сгруппированными: по строке на агента с готовым
   * _count. Считать в них вхождения строк нельзя — каждый получил бы ровно 1, и
   * «лидером по показам» становился случайный человек, а агент с 40 показами
   * оказывался внизу. Так это однажды и сломалось; берём число из _count.
   */
  const fromGroups = (groups: { agentId: string | null; _count: { _all: number } }[], extra?: Map<string, number>) => {
    const map = new Map<string, number>();
    for (const g of groups) {
      if (g.agentId && agents.has(g.agentId)) map.set(g.agentId, g._count._all);
    }
    if (extra) for (const [id, count] of extra) map.set(id, (map.get(id) ?? 0) + count);
    return map;
  };

  // subjectAgentId-группа (показы бота/системы) — отдельным Map, складывается с
  // основной группой в fromGroups(showings, showingsBySubjectMap).
  const showingsBySubjectMap = new Map<string, number>();
  for (const g of showingsBySubject) {
    if (g.subjectAgentId && agents.has(g.subjectAgentId)) {
      showingsBySubjectMap.set(g.subjectAgentId, (g._count as { _all: number })._all);
    }
  }

  const ONLINE_WINDOW_MS = 3 * 60 * 1000;
  const nowMs = Date.now();
  res.json({
    month: startOfMonth.toISOString(),
    // Вся команда агентов (для секции «вся команда» под доской почёта) —
    // только имя/фото/онлайн, без коммерческих показателей.
    team: agentList.map((a) => ({
      id: a.id,
      fullName: a.fullName,
      avatarUrl: a.avatarUrl,
      online: !!a.lastSeenAt && nowMs - a.lastSeenAt.getTime() < ONLINE_WINDOW_MS,
    })),
    nominations: [
      {
        key: "sales",
        title: "Лучший продажник",
        unit: "сделок",
        hint: "Закрытые сделки за месяц",
        nominees: top3(fromGroups(deals), agents),
      },
      {
        key: "showings",
        title: "Лидер по показам",
        unit: "показов",
        hint: "Проведённые показы за месяц",
        nominees: top3(fromGroups(showings, showingsBySubjectMap), agents),
      },
      {
        key: "listings",
        title: "Лидер по добавленным объектам",
        unit: "объектов",
        hint: "Объекты, которые агент сам завёл в CRM за месяц",
        // «Добавил» = создал запись в CRM (createdById). Раньше считали по
        // intakeAgentId — интейкер часто проставляется руководством за агента
        // (в т.ч. автоподстановкой из карточки клиента), и «лидером по
        // добавленным» становился тот, кто ничего не добавлял.
        nominees: top3(fromGroups(properties.map((p) => ({ agentId: p.createdById, _count: p._count }))), agents),
      },
    ],
  });
});

/**
 * TOP AGENTS — публичный рейтинг по Royal Score.
 *
 * Виден всем сотрудникам: в этом и смысл рейтинга. Наружу идут место, имя, счёт
 * и — по спецификации владельца (часть про «Личный кабинет» и «TOP AGENTS»,
 * дословно: «место, имя, Royal Score, количество сделок, конверсия, количество
 * активных клиентов») — три коммерческих числа за текущий месяц. Это НЕ разбор
 * по восьми показателям (откуда именно набежал счёт остаётся личным делом
 * агента) — конкретно эти три поля спецификация требует видимыми всем.
 *
 * Замороженные (frozenAt) остаются в списке с последним счётом: заморозка — это
 * остановка работы, а не удаление человека из рейтинга, и вычёркивать его значило
 * бы наказывать местом за то, что ему запретили работать. Приостановившие приём
 * лидов тем более остаются: у них KPI идёт как обычно.
 */
hallOfFameRouter.get("/top-agents", requireAuth, async (req, res) => {
  // Это рейтинг именно по Royal Score (Agent.kpi — его кэш, см. lib/royalScore.ts) —
  // рубильник модуля гасит и его, иначе выключенный владельцем счёт продолжал бы
  // жить в публичном рейтинге, который видят все сотрудники.
  if (!(await royalScoreEnabled())) return res.json({ agents: [] });
  const startOfMonth = dushanbeStartOfMonth();

  const [agents, deals, leadsThisMonth, activeClients] = await Promise.all([
    prisma.agent.findMany({
      where: { role: { in: [...RATED_ROLES] }, isActive: true },
      select: { id: true, fullName: true, avatarUrl: true, kpi: true, frozenAt: true },
      // Потолок обязателен даже там, где агентов десяток: маршрут, возвращающий
      // массив, без предела однажды вернёт всё.
      //
      // ПОРЯДОК ОБЯЗАТЕЛЕН ВМЕСТЕ С ПОТОЛКОМ. Сортировка ниже идёт уже по готовому
      // списку, и без порядка в самом запросе сто первый агент отбрасывался бы
      // Postgres произвольно — то есть при штате больше сотни ЛУЧШИЙ агент мог
      // просто не попасть в «TOP AGENTS». nulls: "last" повторяет правило
      // сортировки ниже: KPI ещё не считался — новичок идёт последним, а не
      // первым (найдено 11.08.2026 на тестовой базе с полутора сотнями учёток).
      orderBy: [{ kpi: { sort: "desc", nulls: "last" } }, { id: "asc" }],
      take: 100,
    }),
    // Сделки и лиды — сгруппированные суммы за месяц, тот же приём, что и в
    // /hall-of-fame выше: по строке на агента, а не по строке на сделку/клиента.
    prisma.deal.groupBy({
      by: ["agentId"],
      where: { stage: "COMPLETED", closedAt: { gte: startOfMonth } },
      _count: { _all: true },
    }),
    // Знаменатель конверсии — тот же, что в /team (лиды, назначенные ЗА МЕСЯЦ),
    // а не «все клиенты агента за всё время»: иначе конверсия ветерана с сотнями
    // старых клиентов и нулём сделок в этом месяце совпадала бы с новичком.
    prisma.client.groupBy({
      by: ["assignedAgentId"],
      where: { assignedAt: { gte: startOfMonth }, deletedAt: null },
      _count: { _all: true },
    }),
    // Активные клиенты — то же определение, что в кабинете агента (royalScore.ts):
    // назначен, не удалён, статус ещё не закрыт и не потерян.
    prisma.client.groupBy({
      by: ["assignedAgentId"],
      where: { deletedAt: null, status: { in: ["NEW", "CONTACTED", "HOT"] } },
      _count: { _all: true },
    }),
  ]);

  const dealsByAgent = new Map(deals.map((d) => [d.agentId, d._count._all]));
  const leadsByAgent = new Map(
    leadsThisMonth.filter((c) => c.assignedAgentId).map((c) => [c.assignedAgentId as string, c._count._all])
  );
  const activeByAgent = new Map(
    activeClients.filter((c) => c.assignedAgentId).map((c) => [c.assignedAgentId as string, c._count._all])
  );

  // null KPI = ещё не считался (новичок) — в рейтинге он идёт последним, а не
  // первым: сотня по умолчанию поставила бы человека без единого дня работы
  // выше всех, и рейтинг перестал бы что-либо значить.
  const ranked = [...agents]
    .sort((a, b) => (b.kpi ?? -1) - (a.kpi ?? -1))
    .map((a, i) => {
      const dealsCount = dealsByAgent.get(a.id) ?? 0;
      const leads = leadsByAgent.get(a.id) ?? 0;
      return {
        place: i + 1,
        id: a.id,
        fullName: a.fullName,
        avatarUrl: a.avatarUrl,
        score: a.kpi,
        frozen: a.frozenAt !== null,
        dealsCount,
        conversion: leads > 0 ? Math.round((dealsCount / leads) * 100) : null,
        activeClients: activeByAgent.get(a.id) ?? 0,
      };
    });

  // Полный список — только директору (штурм 2.7, layer-3-plan §5 C4.1: «место N
  // из 8 только директору»); остальные роли видят в ответе одну свою строку, без
  // сравнения с коллегами по позиции — ровно то, что уже делает фронтенд
  // (TopAgentsBoard в HallOfFame.tsx), только теперь и на сервере: без этой
  // проверки достаточно было вызвать маршрут напрямую, минуя фильтрацию в React.
  if (!req.agent) return res.status(401).json({ error: "Требуется авторизация" });
  // Акционер видит рейтинг целиком, как директор (спека ролей §2.4).
  const isDirector = req.agent.role === "DIRECTOR" || req.agent.role === "SHAREHOLDER";
  const visible = isDirector ? ranked : ranked.filter((a) => a.id === req.agent!.id);

  res.json({ agents: visible });
});
