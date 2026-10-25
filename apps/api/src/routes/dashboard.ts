import { investigationViewerRole } from "../auth/investigations.js";
import { dashboardSalesControlRouter } from "./dashboardSalesControl.js";
import { visibleInteractionWhere } from "../lib/investigationPrivacy.js";
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db.js";
import { SUPERVISOR_ASSIGN_REASON } from "../lib/leadReason.js";
import { Prisma } from "../generated/prisma/client.js";
import { ownChatClientWhere } from "../lib/chatScope.js";
import { ownBotConversationWhere } from "../lib/ownBotConversationScope.js";
import { presentProperty } from "../lib/ownerContact.js";
import { can, requireAuth, requirePermission, scopeToOwnAgent, scopeDealsToOwnAgent } from "../auth/middleware.js";
import { computeDemandCounts } from "./matching.js";
import { loadMoneyContext, roundMoney, toTjs } from "../lib/money.js";
import { COUNTED_SHOWING_WHERE, TASK_WHERE } from "../lib/tasks.js";
import { buildDashboardInsights } from "../lib/dashboardInsights.js";
import { withMaskedClient, clientNamePhoneSafe, clientPhoneFor } from "../lib/clientPhone.js";
import { presentInteractions, transcriptAccess } from "../lib/callTranscripts.js";
import { firstCallCandidateWindow, firstCallStatus } from "../leads.js";
import { DEFAULT_LEAD_ACTIVE_LIMIT, OCCUPIES_SLOT_WHERE } from "../lib/leadLimits.js";
import { AWAITING_REVIEW_WHERE } from "../lib/telephony/awaitingReview.js";
import { ownIncomingCallsOr } from "../lib/telephony/ownIncomingCalls.js";
import {
  dushanbeStartOfToday,
  dushanbeStartOfMonth,
  dushanbeWallClock,
  DUSHANBE_OFFSET_MS,
} from "../lib/dushanbeTime.js";
import { runLimited } from "../lib/concurrency.js";
import {
  HEATMAP_CHANNELS,
  HEATMAP_CHANNELS_BY_SIGNAL,
  HEATMAP_SIGNALS,
  loadChannelActivity,
  loadHeatmapCells,
  summarizeHeatmap,
} from "../lib/audienceHeatmap.js";
import { loadHeatmapAdviceSettings } from "../lib/publishScheduleRules.js";
import { logSystemError } from "../lib/systemError.js";
import { visibleNewCandidatesWhere } from "../lib/vacancyVisibility.js";
import { RATED_ROLES } from "@royal-home/shared";
import { UNASSIGNED_LEADS_LIMIT, UNASSIGNED_LEADS_WHERE } from "../lib/unassignedLeads.js";

export const dashboardRouter = Router();
dashboardRouter.use(dashboardSalesControlRouter);

/**
 * Потолок строк для месячных/недельных выборок дашборда (22.09.2026, класс
 * «Пагинация»): окна фиксированы (12 месяцев графиков, 14 дней пульса, месяц
 * сводки) и не берутся из запроса, но само число строк внутри них ничем не
 * ограничено. С большим запасом над реальным темпом этого агентства.
 */
const DASHBOARD_ROW_LIMIT = 20_000;

/**
 * Приёмка 08.09.2026: /counters и /charts гоняли Promise.all из 9 задач каждый
 * запрос (сайдбар опрашивает счётчики часто) — при нескольких одновременных
 * пользователях это одна из причин исчерпания пула соединений Prisma.
 */
const DASHBOARD_QUERY_CONCURRENCY = 4;

// ─── Красные счётчики сайдбара ──────────────────────────────────────────────
// «Новое» = записи, созданные после того, как агент последний раз открывал раздел
// (метки в Agent.sectionsSeenAt, по одной на раздел). Открытие раздела шлёт
// POST /counters/seen — значок гаснет именно у этого агента, у остальных остаётся.

type SectionKey =
  | "clients"
  | "sellers"
  | "otherInquiries"
  | "messages"
  | "comments"
  | "deals"
  | "calls"
  | "vacancies"
  | "calendar";

const SECTION_KEYS = [
  "clients",
  "sellers",
  "otherInquiries",
  "messages",
  "comments",
  "deals",
  "calls",
  "vacancies",
  "calendar",
] as const;

const sectionSeenSchema = z.object({
  section: z.enum(SECTION_KEYS),
});

/** Комментарии, где бот спасовал и позвал человека: «не знал ответа» (ESCALATED)
 *  и «не смог ответить после трёх попыток» (FAILED). Оба шлют push руководству —
 *  значок в меню обязан считать ровно то же, иначе уведомление есть, а раздел
 *  выглядит спокойным. */
const COMMENT_WAITING_STATUSES = ["ESCALATED", "FAILED"] as const;

function seenDate(seen: Record<string, unknown> | null, section: SectionKey): Date {
  const raw = seen?.[section];
  const d = typeof raw === "string" ? new Date(raw) : null;
  // Нет метки (первый запуск фичи) — не показываем всю историю как «новое»,
  // отсчитываем с последних суток.
  return d && !Number.isNaN(d.getTime()) ? d : new Date(Date.now() - 24 * 60 * 60 * 1000);
}

dashboardRouter.get("/counters", requireAuth, async (req, res) => {
  const agent = await prisma.agent.findUnique({
    where: { id: req.agent!.id },
    // sipExtension — тем же запросом, что и метки визитов: значку «Мои звонки» ниже
    // нужен внутренний номер, чтобы узнать входящие, на которые сотрудник ответил
    // сам (станция пишет в звонок номер, а не сотрудника). Отдельным findUnique это
    // был бы второй поход в ту же строку той же таблицы.
    select: { sectionsSeenAt: true, sipExtension: true },
  });
  const seen = (agent?.sectionsSeenAt as Record<string, unknown> | null) ?? null;

  /**
   * ЧЬИ КАРТОЧКИ СЧИТАЕМ — ровно тем же вызовом, каким сужает выборку сам список
   * (routes/clients/list.ts): `scopeToOwnAgent` вернёт id агенту и undefined тому,
   * у кого есть право clients.viewAll. Руководителю, как и раньше, считается всё.
   *
   * Раньше здесь стояло `OR: [{ assignedAgentId: me }, { acceptedAt: null }]` —
   * «свои плюс непринятые». Но `acceptedAt: null` — это ДВА разных множества, и оба
   * чужие агенту (их же различает `unacceptedWhere`/`queuedForWaveWhere` ниже в этом
   * файле): непринятая заявка, УЖЕ НАЗНАЧЕННАЯ ДРУГОМУ агенту, и очередь на утреннюю
   * волну, не назначенная никому. Ни та, ни другая в списке агента не появится
   * никогда — а в значке горели. Тот же перекос, что чинили у «Моих звонков» и у
   * вакансий: значок обещал больше, чем показывает открытая вкладка.
   *
   * Своя непринятая карточка из счётчика при этом НЕ пропала — она назначена
   * этому же агенту, а значит проходит по `assignedAgentId`.
   */
  const ownAgentId = scopeToOwnAgent(req);
  const agentScope = ownAgentId ? { assignedAgentId: ownAgentId } : {};

  /**
   * БЕЙДЖ «КЛИЕНТЫ N» / «ПРОДАВЦЫ N» СЧИТАЕТ НОВЫХ (18.09.2026, задание В §f
   * п.4, §c разведки 17.09: «переданный клиент значок не зажигает»). Раньше
   * условие было ровно `createdAt > lastSeenAt` — карточка, ЗАВЕДЁННАЯ до
   * последнего визита, но ПЕРЕДАННАЯ этому агенту позже (карусель, ручное
   * назначение, возврат из Неактивных), не подходила ни под одно условие: она
   * не новая по дате создания, а раздел её никогда не видел этим агентом —
   * бейдж молчал ровно там, где держатель и не подозревает о новом клиенте.
   * `assignedAt` — та же точка отсчёта, что у «Ждут принятия» (list.ts) и у
   * плитки «Мои» — используем «или», а не заменяем: смысл бейджа — «новое
   * событие в разделе с прошлого визита», не обязательно только что заведённая
   * карточка.
   */
  const [clients, sellers, otherInquiries, messages, comments, deals, calls, vacancies, calendar] = await runLimited(
    [
    () =>
    prisma.client.count({
      where: {
        kind: "BUYER",
        deletedAt: null,
        OR: [{ createdAt: { gt: seenDate(seen, "clients") } }, { assignedAt: { gt: seenDate(seen, "clients") } }],
        ...agentScope,
      },
    }),
    () =>
    prisma.client.count({
      where: {
        kind: "SELLER",
        deletedAt: null,
        OR: [{ createdAt: { gt: seenDate(seen, "sellers") } }, { assignedAt: { gt: seenDate(seen, "sellers") } }],
        ...agentScope,
      },
    }),
    // Вкладка «Прочие обращения» видна только руководству — агенту не считаем.
    () =>
    !can(req, "otherInquiries.view")
      ? Promise.resolve(0)
      : prisma.client.count({ where: { kind: "OTHER", deletedAt: null, createdAt: { gt: seenDate(seen, "otherInquiries") } } }),
    /**
     * Диалоги бота с активностью после последнего визита во вкладку «Сообщения» —
     * каналы Meta и Telegram (отдельная таблица) вместе, как и сам инбокс.
     *
     * ДВА ПРАВА, ДВА СЧЁТА (найдено адверсариальной проверкой мержа 07.09.2026).
     * Раздел открыт по messages.view ИЛИ messages.viewOwn (conversations.ts), а
     * этот счётчик до сих пор проверял только первое — у агента с чатами своих
     * клиентов значок на вкладке был мёртв навсегда, хотя раздел ему открыт.
     * Простое расширение условия было бы дырой похуже: без сужения по клиенту
     * агент увидел бы в значке число переписок ВСЕГО агентства. Условие
     * принадлежности берётся из общего `ownChatClientWhere` (lib/chatScope.ts) —
     * того же, по которому сужаются инбокс и досье собеседника: выписанное здесь
     * своими руками, оно разошлось бы с ними тихо.
     */
    () =>
    !can(req, "messages.view") && !can(req, "messages.viewOwn")
      ? Promise.resolve(0)
      : can(req, "messages.view")
        ? Promise.all([
            prisma.botConversation.count({ where: { lastMessageAt: { gt: seenDate(seen, "messages") } } }),
            prisma.telegramConversation.count({ where: { lastMessageAt: { gt: seenDate(seen, "messages") } } }),
          ]).then(([bot, tg]) => bot + tg)
        : Promise.all([
            prisma.botConversation.count({
              where: {
                lastMessageAt: { gt: seenDate(seen, "messages") },
                ...ownBotConversationWhere(req.agent!.id),
              },
            }),
            prisma.telegramConversation.count({
              where: {
                lastMessageAt: { gt: seenDate(seen, "messages") },
                client: ownChatClientWhere(req.agent!.id),
              },
            }),
          ]).then(([bot, tg]) => bot + tg),
    // Комментарии под постами: считаем не всю ленту, а только те случаи, где бот
    // спасовал и ждёт человека. Отсчёт от последнего визита в раздел — тем же
    // механизмом, что и остальные значки: у комментария нет действия «разобрано»,
    // и счётчик по всей таблице горел бы вечно, а вечный значок перестают замечать.
    // Раздел закрыт правом messages.view — без него не считаем вовсе.
    () =>
    !can(req, "messages.view")
      ? Promise.resolve(0)
      : prisma.instagramComment.count({
          where: {
            status: { in: [...COMMENT_WAITING_STATUSES] },
            // По updatedAt, а не по createdAt: бот отвечает через 1-3 минуты после
            // комментария, и по времени САМОГО комментария случай, эскалированный
            // сразу после визита в раздел, не попал бы в счётчик никогда.
            updatedAt: { gt: seenDate(seen, "comments") },
          },
        }),
    // Сделки: новые с последнего визита в раздел (агенту — свои, руководству —
    // все, тем же правилом, что список сделок отдаёт GET /deals).
    () => {
      const ownDealAgentId = scopeDealsToOwnAgent(req);
      return prisma.deal.count({
        where: {
          startedAt: { gt: seenDate(seen, "deals") },
          ...(ownDealAgentId ? { agentId: ownDealAgentId } : {}),
        },
      });
    },
    // Звонки: состоявшиеся разговоры с карточкой, которые оператор ещё не разобрал
    // (см. GET /calls — то же самое unqualifiedWhere), появившиеся после визита в
    // раздел. Право на раздел — то же, что открывает саму вкладку.
    () =>
    !can(req, "calls.transcripts") && !can(req, "calls.ownTranscripts")
      ? Promise.resolve(0)
      : prisma.incomingCall.count({
          where: {
            ...AWAITING_REVIEW_WHERE,
            startedAt: { gt: seenDate(seen, "calls") },
            /**
             * ЧЬИ ЗВОНКИ СЧИТАЕМ — то же правило, что и то, по которому вакансии
             * счётся выше в этом же файле: счётчик обязан считать ровно то, что
             * человек увидит, открыв раздел.
             *
             * Без права на чужие разговоры лента звонков (routes/calls.ts, GET /feed)
             * отдаёт агенту только то, что касается лично его, а этот счётчик считал
             * разговоры, ждущие разбора, ПО ВСЕМУ АГЕНТСТВУ. На проде это выглядело
             * так: в меню горит красная «3», агент открывает «Звонки» — пусто, все
             * три звонка чужие. Раздел выглядит сломанным, хотя сломан был значок.
             * Тот же случай, что разобрали 03.09.2026 у вакансий.
             *
             * Сужение — через AND, а не подмешиванием второго `OR` в объект:
             * AWAITING_REVIEW_WHERE уже занимает ключ `OR` («разговор без типа» или
             * «сообщение автоответчика»), и второй `OR` его бы просто перетёр —
             * счётчик молча начал бы считать совсем другое множество. Ровно этой
             * граблёй уже ловились в routes/calls.ts (см. `if (unqualifiedOnly)`).
             */
            ...(can(req, "calls.transcripts")
              ? {}
              : { AND: [{ OR: ownIncomingCallsOr(req.agent!.id, agent?.sipExtension) }] }),
          },
        }),
    // Вакансии: анкеты, собранные ботом и ещё не разобранные, с последнего визита.
    () =>
    !can(req, "vacancies.view")
      ? Promise.resolve(0)
      : prisma.jobApplication.count({
          /**
           * Счётчик обязан считать ровно то, что человек увидит, открыв раздел:
           * вкладка по умолчанию «Подходят», стадия «Новая». Условие — общее с
           * самим списком и с пультом (lib/vacancyVisibility.ts, 02.10.2026):
           * своя копия здесь уже разошлась однажды — считала анкеты с
           * нерешённым допуском, которых вкладка не показывает.
           */
          where: visibleNewCandidatesWhere({ createdAt: { gt: seenDate(seen, "vacancies") } }),
        }),
    // Календарь: ЛИЧНЫЕ задачи агента, наступившие после последнего визита в
    // раздел и ещё не выполненные. Общий «Контроль руководителя» считает overdue
    // по всей команде отдельно (dashboard/insights) — здесь только своё.
    () => {
      if (!ownAgentId) return Promise.resolve(0);
      return prisma.interaction.count({
        where: {
          ...TASK_WHERE,
          // subjectAgentId ?? agentId (П-10, тот же приём, что и у «задачи на
          // сегодня» ниже в этом файле) — задачу могла завести SYSTEM/BOT без
          // agentId (показ от бота, автонапоминание), иначе счётчик календаря
          // тихо расходится со списком, который человек видит, открыв раздел.
          OR: [{ agentId: ownAgentId }, { subjectAgentId: ownAgentId }],
          completedAt: null,
          nextActionDate: { gt: seenDate(seen, "calendar"), lte: new Date() },
        },
      });
    },
    ],
    DASHBOARD_QUERY_CONCURRENCY
  );

  res.json({
    clients,
    sellers,
    otherInquiries,
    messages,
    comments,
    deals,
    calls,
    vacancies,
    calendar,
  });
});

dashboardRouter.post("/counters/seen", requireAuth, async (req, res) => {
  const parsed = sectionSeenSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Неверные данные", details: parsed.error.flatten() });
  }
  const current = await prisma.agent.findUnique({
    where: { id: req.agent!.id },
    select: { sectionsSeenAt: true },
  });
  const seen = (current?.sectionsSeenAt as Record<string, unknown> | null) ?? {};
  await prisma.agent.update({
    where: { id: req.agent!.id },
    data: { sectionsSeenAt: { ...seen, [parsed.data.section]: new Date().toISOString() } as Record<string, string> },
  });
  res.json({ ok: true });
});

/**
 * Данные визуальных виджетов: комиссия/сделки по месяцам, источники лидов текущего
 * месяца, «пульс» активности (взаимодействия по дням за 14 дней). Общекомандные,
 * как и воронка: агенту полезно видеть картину всей компании.
 */
/** Общекомандные графики (комиссия по месяцам и т.п.) — финансово-конфиденциально,
 *  видно только руководству (админ/менеджер/директор), не рядовым агентам. */
dashboardRouter.get("/charts", requireAuth, requirePermission("dashboard.analytics"), async (req, res) => {
  // Все границы и ключи месяцев/дней — по Душанбе. Контейнер живёт в UTC, и на
  // локальных геттерах графики отставали на пять часов от чисел в сводке: сделка,
  // закрытая 1-го числа в 03:00, попадала в предыдущий месяц на графике и в
  // текущий в плитке — два числа на одном экране противоречили друг другу.
  const now = dushanbeWallClock();
  // Комиссия по месяцам — деньги компании, гейт finance.view (ночная проверка
  // 24.09.2026, №159/М4): роут открыт dashboard.analytics, которое есть и у
  // менеджера, а commissionByMonth раньше уходил всем с этим правом без
  // проверки денег вовсе — во фронтенде поле не рисуется нигде, но по сети
  // уходило всегда.
  const seesMoney = can(req, "finance.view");
  const MONTHS_BACK = 12;
  const monthStart = (y: number, m: number, d = 1) => new Date(Date.UTC(y, m, d) - DUSHANBE_OFFSET_MS);
  const from = monthStart(now.getUTCFullYear(), now.getUTCMonth() - (MONTHS_BACK - 1));
  const startOfMonth = dushanbeStartOfMonth();
  const pulseFrom = monthStart(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 13);

  const [completedDeals, monthClients, pulseInteractions, propsCreated, propsByStatus, money] = await Promise.all([
    prisma.deal.findMany({
      where: { stage: "COMPLETED", closedAt: { gte: from } },
      select: { closedAt: true, commissionAmount: true, currency: true },
      take: DASHBOARD_ROW_LIMIT,
    }),
    prisma.client.groupBy({
      by: ["source"],
      where: { createdAt: { gte: startOfMonth }, deletedAt: null },
      _count: { _all: true },
    }),
    prisma.interaction.findMany({
      where: { createdAt: { gte: pulseFrom }, type: { not: "SYSTEM" } },
      // type нужен тултипу «Пульса»: разбивка дня по звонкам/показам/встречам.
      select: { createdAt: true, type: true },
      take: DASHBOARD_ROW_LIMIT,
    }),
    // Динамика объектов: когда их заводили (по месяцам) и текущий срез по статусам.
    prisma.property.findMany({
      where: { createdAt: { gte: from }, deletedAt: null },
      select: { createdAt: true },
      take: DASHBOARD_ROW_LIMIT,
    }),
    prisma.property.groupBy({ by: ["status"], where: { deletedAt: null }, _count: { _all: true } }),
    loadMoneyContext(),
  ]);
  if (
    completedDeals.length >= DASHBOARD_ROW_LIMIT ||
    pulseInteractions.length >= DASHBOARD_ROW_LIMIT ||
    propsCreated.length >= DASHBOARD_ROW_LIMIT
  ) {
    void logSystemError("api", `Дашборд «Графики»: выборка упёрлась в потолок ${DASHBOARD_ROW_LIMIT} строк`);
  }

  const monthKey = (d: Date) => {
    const wall = dushanbeWallClock(d);
    return `${wall.getUTCFullYear()}-${String(wall.getUTCMonth() + 1).padStart(2, "0")}`;
  };
  const commissionByMonth: { month: string; commission: number | null; deals: number }[] = [];
  for (let i = MONTHS_BACK - 1; i >= 0; i--) {
    const m = monthKey(monthStart(now.getUTCFullYear(), now.getUTCMonth() - i));
    const deals = completedDeals.filter((d) => d.closedAt && monthKey(d.closedAt) === m);
    commissionByMonth.push({
      month: m,
      // В сомони: комиссия по долларовым объектам иначе занижалась примерно на порядок.
      commission: seesMoney ? roundMoney(deals.reduce((s, d) => s + toTjs(d.commissionAmount, d.currency, money), 0)) : null,
      deals: deals.length,
    });
  }

  // Локальный календарный день, а не toISOString() — тот переводит в UTC и на сервере
  // восточнее Гринвича (Душанбе, UTC+5) сдвигал бы дату на день назад (полночь по
  // местному времени попадает на предыдущие сутки в UTC), из-за чего «сегодня»
  // подписывалось неверным днём недели.
  const dayKey = (d: Date) => {
    const wall = dushanbeWallClock(d);
    return `${wall.getUTCFullYear()}-${String(wall.getUTCMonth() + 1).padStart(2, "0")}-${String(wall.getUTCDate()).padStart(2, "0")}`;
  };
  const pulse: { date: string; count: number; byType: Record<string, number> }[] = [];
  for (let i = 13; i >= 0; i--) {
    const day = monthStart(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i);
    const key = dayKey(day);
    const dayItems = pulseInteractions.filter((x) => dayKey(x.createdAt) === key);
    const byType: Record<string, number> = {};
    for (const item of dayItems) byType[item.type] = (byType[item.type] ?? 0) + 1;
    pulse.push({ date: key, count: dayItems.length, byType });
  }

  const propertiesByMonth: { month: string; added: number; sold: number }[] = [];
  for (let i = MONTHS_BACK - 1; i >= 0; i--) {
    const m = monthKey(monthStart(now.getUTCFullYear(), now.getUTCMonth() - i));
    propertiesByMonth.push({
      month: m,
      added: propsCreated.filter((p) => monthKey(p.createdAt) === m).length,
      // «Продано» за месяц — по закрытым сделкам (closedAt), это же и комиссия.
      sold: completedDeals.filter((d) => d.closedAt && monthKey(d.closedAt) === m).length,
    });
  }

  res.json({
    commissionByMonth,
    sourcesThisMonth: monthClients
      .map((g) => ({ source: g.source, count: g._count._all }))
      .sort((a, b) => b.count - a.count),
    pulse,
    propertiesByMonth,
    propertiesByStatus: propsByStatus
      .map((g) => ({ status: g.status, count: g._count._all }))
      .sort((a, b) => b.count - a.count),
  });
});

/**
 * «Команда сейчас»: живая сводка по агентам (активная нагрузка, ждут принятия,
 * принято сегодня, эскалировано) + список непринятых заявок (эскалированные —
 * первыми). Для отслеживания команды в реальном времени на дашборде.
 */
/** Живая сводка по ВСЕЙ команде (кто сколько принял/эскалировал, чужие непринятые
 *  заявки по именам) — только руководству, агенту чужие непринятые лиды видеть не нужно. */
dashboardRouter.get("/team-live", requireAuth, requirePermission("dashboard.analytics"), async (_req, res) => {
  // «Сегодня» — по Душанбе: на сервере в UTC счётчик «принято сегодня» обнулялся
  // в 05:00 утра, а не в полночь.
  const startOfDay = dushanbeStartOfToday();

  const agents = await prisma.agent.findMany({
    where: { role: { in: [...RATED_ROLES] }, isActive: true },
    select: { id: true, fullName: true, avatarUrl: true },
    // Потолок обязателен даже там, где агентов десяток — см. hallOfFame.ts.
    // Порядок — вместе с потолком: без него сотый агент отбрасывался бы Postgres произвольно.
    orderBy: { fullName: "asc" },
    take: 500,
  });
  const ids = agents.map((a) => a.id);

  // Списки ограничены двенадцатью записями — этого достаточно, чтобы показать
  // «кто именно», но не годится как счётчик: на экране «12 заявок никто не принял»
  // застывало ровно тогда, когда ситуация была хуже всего. Считаем отдельно.
  //
  // assignedAgentId: null — лид ещё копится для раздачи волной в 10:00 (leads.ts,
  // assignPendingLeads), это НЕ пропуск. Раньше unacceptedWhere не отличал это от
  // «агенту назначили, а он не принял» — руководитель видел пугающие числа по
  // лидам, которые просто ждут своего часа. Разделяем на два независимых счётчика.
  const unacceptedWhere = { acceptedAt: null, assignedAgentId: { not: null }, kind: { not: "OTHER" as const }, deletedAt: null };
  const [activeLoad, pendingAccept, acceptedToday, escalated, unaccepted, unacceptedTotal, escalatedTotal, queuedTotal] =
    await Promise.all([
    // «Активная нагрузка» — то же самое, что занятый слот в лимите лидов
    // (OCCUPIES_SLOT_WHERE, см. lib/leadLimits.ts). Здесь считалось по статусам
    // NEW/CONTACTED/HOT/COLD, в плитке «Кто перегружен» — без COLD, а в
    // «Контроле руководителя» — по слотам: три числа про одного агента на
    // соседних экранах. Определение теперь одно на всю CRM.
    prisma.client.groupBy({ by: ["assignedAgentId"], where: { assignedAgentId: { in: ids }, deletedAt: null, ...OCCUPIES_SLOT_WHERE }, _count: { _all: true } }),
    prisma.client.groupBy({ by: ["assignedAgentId"], where: { assignedAgentId: { in: ids }, acceptedAt: null, deletedAt: null }, _count: { _all: true } }),
    prisma.client.groupBy({ by: ["assignedAgentId"], where: { assignedAgentId: { in: ids }, acceptedAt: { gte: startOfDay }, deletedAt: null }, _count: { _all: true } }),
    prisma.client.groupBy({ by: ["assignedAgentId"], where: { assignedAgentId: { in: ids }, acceptedAt: null, escalatedAt: { not: null }, deletedAt: null }, _count: { _all: true } }),
    prisma.client.findMany({
      // kind=OTHER не назначается агенту и никогда не «принимается» — исключаем,
      // иначе виджет показывал бы их как вечно непринятые лиды.
      // deletedAt — удалённые заявки крон уже не крутит (см. leads.ts), но в этом
      // виджете они продолжали висеть как непринятые с растущим счётчиком минут.
      where: unacceptedWhere,
      orderBy: [{ escalatedAt: { sort: "desc", nulls: "last" } }, { assignedAt: "asc" }],
      take: 12,
      select: {
        shortId: true, fullName: true, assignedAt: true, escalatedAt: true, reassignCount: true, status: true,
        assignedAgent: { select: { fullName: true } },
      },
    }),
    prisma.client.count({ where: unacceptedWhere }),
    prisma.client.count({ where: { ...unacceptedWhere, escalatedAt: { not: null } } }),
    prisma.client.count({ where: UNASSIGNED_LEADS_WHERE }),
  ]);

  const toMap = (arr: { assignedAgentId: string | null; _count: { _all: number } }[]) => new Map(arr.map((x) => [x.assignedAgentId, x._count._all]));
  const load = toMap(activeLoad), pend = toMap(pendingAccept), acc = toMap(acceptedToday), esc = toMap(escalated);

  res.json({
    agents: agents
      .map((a) => ({
        id: a.id,
        fullName: a.fullName,
        avatarUrl: a.avatarUrl,
        activeLoad: load.get(a.id) ?? 0,
        pendingAccept: pend.get(a.id) ?? 0,
        acceptedToday: acc.get(a.id) ?? 0,
        escalated: esc.get(a.id) ?? 0,
      }))
      .sort((a, b) => b.activeLoad - a.activeLoad || b.acceptedToday - a.acceptedToday),
    unaccepted: unaccepted.map((l) => ({
      shortId: l.shortId,
      fullName: l.fullName,
      agentName: l.assignedAgent?.fullName ?? "—",
      reassignCount: l.reassignCount,
      escalated: l.escalatedAt !== null,
      // Потерянный лид больше не распределяется автоматически — отличаем его от
      // «ещё крутится по кругу», иначе руководитель не видит, что дальше ждать нечего.
      lost: l.status === "LOST",
      waitingMinutes: Math.max(0, Math.round((Date.now() - l.assignedAt.getTime()) / 60000)),
    })),
    unacceptedTotal,
    escalatedTotal,
    queuedTotal,
  });
});

/**
 * «Ждут агента» поимённо для пульта директора: ровно те клиенты, что считает
 * `queuedTotal` в /team-live (общее условие — lib/unassignedLeads.ts). Давние первыми,
 * не больше 20; `total` — сколько всего в очереди. Номер в имени маскируется по праву
 * `clients.viewPhone`, как в остальных списках.
 */
dashboardRouter.get("/unassigned-leads", requireAuth, requirePermission("clients.assign"), async (req, res) => {
  const canSeePhone = can(req, "clients.viewPhone");
  const [rows, total] = await Promise.all([
    prisma.client.findMany({
      where: UNASSIGNED_LEADS_WHERE,
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: UNASSIGNED_LEADS_LIMIT,
      select: { id: true, shortId: true, fullName: true, source: true, createdAt: true },
    }),
    prisma.client.count({ where: UNASSIGNED_LEADS_WHERE }),
  ]);
  const now = Date.now();
  res.json({
    items: rows.map((c) => ({
      id: c.id,
      shortId: c.shortId,
      fullName: clientNamePhoneSafe(c.fullName, canSeePhone),
      source: c.source,
      createdAt: c.createdAt.toISOString(),
      waitingMinutes: Math.max(0, Math.round((now - c.createdAt.getTime()) / 60000)),
    })),
    total,
  });
});

dashboardRouter.get("/summary", requireAuth, async (req, res) => {
  const ownAgentId = scopeToOwnAgent(req);
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  // Сутки и месяц — по Душанбе. На сервере в UTC «задачи на сегодня» переключались
  // в 05:00 утра, а месячные показатели теряли первые пять часов 1-го числа.
  const startOfDay = dushanbeStartOfToday();
  const startOfMonth = dushanbeStartOfMonth();

  // Агенту (ownAgentId задан) — только свои показы/лиды/сделки/активность; руководству — всей
  // компании. Комиссия — финансово-конфиденциальная, агенту не считаем и не отдаём вообще (см. ниже).
  const [
    availableCount,
    hotClientsCount,
    showingsThisWeek,
    tasksToday,
    recentInteractions,
    newLeads,
    contactedClientIds,
    showingsThisMonth,
    negotiations,
    completedDeals,
    settings,
    topProperties,
  ] = await Promise.all([
    prisma.property.count({ where: { status: "AVAILABLE", deletedAt: null } }),
    prisma.client.count({ where: { status: "HOT", deletedAt: null, ...(ownAgentId ? { assignedAgentId: ownAgentId } : {}) } }),
    prisma.interaction.count({
      // client.deletedAt — иначе показы по клиентам из Корзины продолжали
      // считаться, и воронка на дашборде расходилась с Отчётами. По той же
      // причине здесь COUNTED_SHOWING_WHERE: отменённые показы Отчёты не считают.
      where: {
        type: "SHOWING",
        ...COUNTED_SHOWING_WHERE,
        createdAt: { gte: weekAgo },
        client: { deletedAt: null },
        // subjectAgentId ?? agentId (П-10, 17.09.2026): показ, записанный ботом от
        // лица клиента (agentId: null), всё равно принадлежит держателю карточки —
        // иначе воронка теряла показ ровно в момент, когда Б1/Б2 сделали его подпись
        // честной (см. docs/archive/agent-briefs/timeline-kpi-subject-agent-18-09.md).
        ...(ownAgentId ? { OR: [{ agentId: ownAgentId }, { subjectAgentId: ownAgentId }] } : {}),
      },
    }),
    prisma.interaction.findMany({
      where: {
        // Нижняя граница обязательна: без неё в «задачи на сегодня» попадала вся
        // просрочка, и человек видел «16 задач на сегодня», где сегодняшних две.
        nextActionDate: { gte: startOfDay, lt: new Date(startOfDay.getTime() + 24 * 60 * 60 * 1000) },
        ...TASK_WHERE,
        completedAt: null,
        // subjectAgentId ?? agentId (П-10, 17.09.2026): задачу может завести
        // SYSTEM/AI без agentId (автоподбор объекта, эскалация) — её владелец
        // тогда виден только через subjectAgentId, иначе она тихо пропадала бы
        // из «задачи на сегодня» у того самого агента.
        ...(ownAgentId ? { OR: [{ agentId: ownAgentId }, { subjectAgentId: ownAgentId }] } : {}),
      },
      orderBy: { nextActionDate: "asc" },
      // id/shortId — мобильная Главная открывает карточку клиента прямо из
      // «Далее по приоритету» (see apps/web/src/components/mobile/MobileHome.tsx);
      // раньше сюда выбирались только fullName/phone, и ссылка вела на
      // /clients/undefined (маршрут — по shortId, не по uuid).
      include: {
        // status — мобильная Главная показывает тег «Горячий лид» на карточке
        // приоритета (design_handoff_royal_home_crm), как в самом клиенте.
        client: { select: { id: true, shortId: true, fullName: true, phone: true, status: true } },
        property: { select: { title: true } },
      },
      // Предел выборки (22.09.2026, класс «Пагинация»): у агента — только его
      // задачи, реалистично десятки; у руководства без ownAgentId «сегодня» —
      // задачи всей компании. Виджет «Далее по приоритету» и так не читается
      // построчно за пределы первых полусотни — самые срочные уже сверху
      // (orderBy nextActionDate asc).
      take: 100,
    }),
    prisma.interaction.findMany({
      // subjectAgentId ?? agentId (П-10, 17.09.2026): лента «последняя активность»
      // теряла записи бота/системы, сделанные от лица держателя карточки.
      where: { ...visibleInteractionWhere(investigationViewerRole(req)), ...(ownAgentId ? { OR: [{ agentId: ownAgentId }, { subjectAgentId: ownAgentId }] } : {}) },
      orderBy: { createdAt: "desc" },
      take: 5,
      include: {
        agent: { select: { id: true, fullName: true, avatarUrl: true } },
        client: { select: { id: true, shortId: true, fullName: true } },
        property: { select: { id: true, shortId: true, title: true } },
      },
    }),
    prisma.client.count({
      // deletedAt — та же цифра «Новые лиды» в Отчётах Корзину уже не считает,
      // и две воронки расходились между собой.
      where: { createdAt: { gte: startOfMonth }, deletedAt: null, ...(ownAgentId ? { assignedAgentId: ownAgentId } : {}) },
    }),
    // groupBy, а НЕ findMany({ distinct }): Prisma схлопывает distinct не в SQL,
    // а в памяти движка — то есть вычитывает ВСЕ взаимодействия за месяц (у
    // директора по всей компании) и только потом оставляет уникальных клиентов.
    // Дальше от результата берётся одна лишь длина, так что группировка в SQL
    // даёт ту же цифру без выборки в память.
    prisma.interaction.groupBy({
      by: ["clientId"],
      where: {
        type: { in: ["CALL", "MESSAGE", "MEETING"] },
        createdAt: { gte: startOfMonth },
        client: { deletedAt: null },
        // subjectAgentId ?? agentId (П-10, 17.09.2026): контакт, записанный ботом
        // от лица клиента, по-прежнему шаг воронки держателя карточки.
        ...(ownAgentId ? { OR: [{ agentId: ownAgentId }, { subjectAgentId: ownAgentId }] } : {}),
      },
    }),
    // groupBy по той же причине, что у шага «На контакте» выше: distinct у
    // Prisma схлопывается в памяти, а отсюда берётся одна лишь длина.
    prisma.interaction.groupBy({
      // Именно КЛИЕНТЫ с показом, а не количество показов: три показа одному
      // человеку — это один дошедший до шага, иначе воронка «расширялась» и
      // полоса шага упиралась в 100% ширины.
      by: ["clientId"],
      where: {
        type: "SHOWING",
        ...COUNTED_SHOWING_WHERE,
        createdAt: { gte: startOfMonth },
        client: { deletedAt: null },
        // subjectAgentId ?? agentId (П-10, 17.09.2026): см. showingsThisWeek выше.
        ...(ownAgentId ? { OR: [{ agentId: ownAgentId }, { subjectAgentId: ownAgentId }] } : {}),
      },
    }),
    // client: { deletedAt: null } (27.08.2026) — тот же шаг воронки в «Отчётах» и
    // в месячном отчёте этот фильтр уже имеет; соседние шаги здесь же починены
    // именно из-за такого расхождения (см. комментарии выше по файлу).
    prisma.deal.count({
      where: { startedAt: { gte: startOfMonth }, client: { deletedAt: null }, ...(ownAgentId ? { agentId: ownAgentId } : {}) },
    }),
    prisma.deal.findMany({
      where: {
        stage: "COMPLETED",
        closedAt: { gte: startOfMonth },
        ...(ownAgentId ? { agentId: ownAgentId } : {}),
      },
      select: { commissionAmount: true, currency: true },
      // Потолок (22.09.2026, класс «Пагинация»): для директора без ownAgentId
      // это вся компания за месяц — с большим запасом над реальным темпом.
      take: DASHBOARD_ROW_LIMIT,
    }),
    prisma.settings.findUnique({ where: { id: "singleton" } }),
    prisma.property.findMany({
      where: { status: "AVAILABLE", deletedAt: null },
      // Новые сверху — тот же порядок, что и в полном списке «Объекты», чтобы виджет
      // на дашборде и список не расходились (раньше здесь была сортировка по просмотрам).
      orderBy: { createdAt: "desc" },
      take: 4,
      include: { district: true, photos: { take: 1, orderBy: { order: "asc" } }, assignedAgent: { select: { id: true, fullName: true, avatarUrl: true } } },
    }),
  ]);

  /**
   * СРОК ПЕРВОГО ЗВОНКА НА ГЛАВНОЙ АГЕНТА (задание 17.09.2026, «клиент
   * теряется, если вовремя не позвонить»). Только у агента — у руководства
   * нет личного «Моего фокуса», а список чужих обязанностей здесь не место.
   *
   * ТА ЖЕ ФУНКЦИЯ, ЧТО У КРОНА, ОДНИМ ПАКЕТНЫМ ЗАПРОСОМ (firstCallStatus →
   * collectFirstCallFacts, один Interaction.findMany на всех кандидатов сразу,
   * не по одному на карточку) — иначе экран агента и penalizeMissedFirstCalls
   * рано или поздно разошлись бы в том, что считать «дозвонился».
   *
   * Тот же круг условий, что и у candidates в firstCall.ts: принят, не «Прочее
   * обращение» (там правила первого звонка нет), не в архивных статусах, не
   * эскалирован (эскалированный уже «требует внимания» в другом месте, а не
   * ждёт звонка от этого агента).
   */
  let firstCallDue: { id: string; shortId: number; fullName: string; phone: string; dueAt: string }[] = [];
  if (ownAgentId) {
    /**
     * ТО ЖЕ ОКНО КАНДИДАТОВ, ЧТО У КРОНА (19.09.2026, жалоба владельца: «клиент
     * 00059 стоит на дашборде, что нужно как будто срочно ему звонить, хотя не
     * должно»).
     *
     * Здесь нижней границы не было вовсе, и секция брала ВСЕ принятые карточки
     * агента, сколько бы им ни было дней. А правило первого звонка работает
     * только внутри `firstCallCandidateWindow` (firstCall.ts): карточку старше
     * этого окна крон не тронет уже никогда. То есть строка «позвоните, иначе
     * лид уйдёт» по старой карточке была неправдой — и висела она ПЕРВОЙ, потому
     * что список отсортирован по самому просроченному сроку. Одна такая карточка
     * занимала «Мой фокус» агента насовсем.
     */
    const { from: firstCallFrom } = firstCallCandidateWindow(settings, new Date());
    const dueCandidates = await prisma.client.findMany({
      where: {
        assignedAgentId: ownAgentId,
        acceptedAt: { not: null, gte: firstCallFrom },
        kind: { not: "OTHER" },
        status: { notIn: ["LOST", "DEAL_CLOSED", "ARCHIVED"] },
        deletedAt: null,
        escalatedAt: null,
      },
      select: { id: true, shortId: true, fullName: true, phone: true, assignedAgentId: true, acceptedAt: true },
      orderBy: { acceptedAt: "asc" },
      // Тот же потолок за проход, что у самого крона (firstCall.ts) — очередь у
      // одного агента реалистично не разрастётся до сотен непрозвоненных карточек.
      take: 50,
    });
    if (dueCandidates.length > 0) {
      const status = await firstCallStatus(dueCandidates, {
        leadCallMinutes: settings?.leadCallMinutes ?? null,
        leadCallMinSeconds: settings?.leadCallMinSeconds ?? null,
        asteriskAriUrl: settings?.asteriskAriUrl ?? null,
        asteriskAriUsername: settings?.asteriskAriUsername ?? null,
        asteriskAriPassword: settings?.asteriskAriPassword ?? null,
      });
      const canSeePhone = can(req, "clients.viewPhone");
      firstCallDue = dueCandidates
        .map((c) => {
          const s = status.get(c.id);
          // done=true — обязанность уже закрыта (разговор состоялся или, без
          // телефонии, записана хоть какая-то попытка): такую карточку Главная
          // агента больше не ждёт, баннер/таймер прячется вместе с ней.
          if (!s || s.done) return null;
          return {
            id: c.id,
            shortId: c.shortId,
            // Имя — через ту же проверку, что и номер: у карточек незнакомых
            // звонивших, заведённых до 20.08.2026, номер лежит В ИМЕНИ открытым
            // (см. lib/clientPhone.ts), и «Мой фокус» показывал его рядом с
            // замаскированным phone.
            fullName: clientNamePhoneSafe(c.fullName, canSeePhone),
            phone: clientPhoneFor(c.phone, canSeePhone),
            dueAt: s.dueAt.toISOString(),
          };
        })
        .filter((x): x is NonNullable<typeof x> => x !== null)
        // Самая срочная — первой (Главная агента ставит её первой строкой секции).
        .sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt));
    }
  }

  /**
   * «ВАМ НАЗНАЧИЛ РУКОВОДИТЕЛЬ» (владелец 23.09.2026). Назначенный вручную лид
   * принимается сразу (routes/clients/lifecycle.ts, /assign), поэтому в «Ждут
   * вашего принятия» его нет — а агент, пропустивший пуш, должен увидеть его в
   * самой CRM. Строка держится, пока агент не связался с клиентом после
   * назначения, и не дольше трёх суток. Кто назначил — из той же записи
   * хронологии, что пишет changeClientAgent (`[lifecycle.assign] …`).
   */
  let assignedBySupervisor: { id: string; shortId: number; fullName: string; phone: string; assignedAt: string; byName: string | null }[] = [];
  if (ownAgentId) {
    const since = new Date(Date.now() - 3 * 24 * 3600_000);
    const assigned = await prisma.client.findMany({
      where: {
        assignedAgentId: ownAgentId,
        assignReason: SUPERVISOR_ASSIGN_REASON,
        assignedAt: { gte: since },
        acceptedAt: { not: null },
        deletedAt: null,
        status: { notIn: ["LOST", "DEAL_CLOSED", "ARCHIVED"] },
      },
      select: { id: true, shortId: true, fullName: true, phone: true, assignedAt: true, lastAgentAttemptAt: true, firstContactAt: true },
      orderBy: { assignedAt: "desc" },
      take: 20,
    });
    const waiting = assigned.filter(
      (c) =>
        c.assignedAt &&
        !(c.lastAgentAttemptAt && c.lastAgentAttemptAt >= c.assignedAt) &&
        !(c.firstContactAt && c.firstContactAt >= c.assignedAt)
    );
    if (waiting.length > 0) {
      const notes = await prisma.interaction.findMany({
        where: { clientId: { in: waiting.map((c) => c.id) }, notes: { startsWith: "[lifecycle.assign]" }, agentId: { not: null } },
        select: { clientId: true, createdAt: true, agent: { select: { fullName: true } } },
        orderBy: { createdAt: "desc" },
      });
      const byClient = new Map<string, string>();
      for (const n of notes) if (n.clientId && !byClient.has(n.clientId) && n.agent) byClient.set(n.clientId, n.agent.fullName);
      const canSeePhone = can(req, "clients.viewPhone");
      assignedBySupervisor = waiting.map((c) => ({
        id: c.id,
        shortId: c.shortId,
        fullName: clientNamePhoneSafe(c.fullName, canSeePhone),
        phone: clientPhoneFor(c.phone, canSeePhone),
        assignedAt: c.assignedAt!.toISOString(),
        byName: byClient.get(c.id) ?? null,
      }));
    }
  }

  // Параллельно, не четырьмя последовательными await (26.08.2026): districtGroups
  // и money независимы, а это горячий роут — каждый показ Главной у всех ролей.
  const [districtGroups, money] = await Promise.all([
    prisma.property.groupBy({
      by: ["districtId"],
      where: { status: "AVAILABLE", deletedAt: null },
      _count: { _all: true },
    }),
    loadMoneyContext(),
  ]);
  // Закрытый объект (offSite) может остаться без района вовсе — такая группа
  // districtId: null сюда не годится справочником районов, отфильтровываем.
  const districtIdsPresent = districtGroups.map((g) => g.districtId).filter((id): id is string => id != null);
  const districts = await prisma.district.findMany({ where: { id: { in: districtIdsPresent } } });

  // Fix 2 (13.09.2026, аудит надёжности): раньше здесь была
  // prisma.property.findMany({ status: "AVAILABLE" }) БЕЗ take — вся выборка
  // (потенциально весь каталог) тянулась в Node, чтобы посчитать сумму и медиану.
  // Растущий каталог рос бы в памяти без предела; простой take: N здесь недопустим —
  // он тихо занизил бы «стоимость портфеля» (сумма по НЕ ВСЕМ объектам похожа на
  // правду, но она не правда). Считаем то же самое в БД:
  //  - tjsExpr — побитовая копия toTjs()/toCents()/fromCents() (lib/money.ts):
  //    ROUND(price*100) = toCents, второй ROUND(...*курс) = Math.round в toTjs,
  //    /100 = fromCents. Округление, как и в money.ts, происходит РОВНО ОДИН РАЗ
  //    на строку — тот самый инвариант, ради которого money.ts просит не трогать
  //    порядок операций.
  //  - SUM(tjsExpr) — стоимость портфеля, точно то же число, что раньше давал
  //    reduce() по загруженным строкам.
  //  - percentile_cont(0.5) — ровно определение медианы, которое раньше вручную
  //    считал sort()+среднее двух средних (чётное число объектов даёт то же самое:
  //    percentile_cont интерполирует строго между двумя срединными значениями).
  const tjsExpr = Prisma.sql`
    CASE WHEN "currency" = 'USD'::"Currency"
      THEN ROUND(ROUND("price" * 100) * ${money.usdToTjs}) / 100
      ELSE ROUND("price" * 100) / 100
    END
  `;
  const [portfolioRows, medianRows] = await Promise.all([
    prisma.$queryRaw<{ total: number | null }[]>`
      SELECT COALESCE(SUM(${tjsExpr}), 0)::float8 AS total
      FROM "Property"
      WHERE "status" = 'AVAILABLE'::"PropertyStatus" AND "deletedAt" IS NULL
    `,
    prisma.$queryRaw<{ districtId: string; medianPerSqm: number }[]>`
      SELECT "districtId",
             percentile_cont(0.5) WITHIN GROUP (ORDER BY ${tjsExpr} / "areaSqm")::float8 AS "medianPerSqm"
      FROM "Property"
      WHERE "status" = 'AVAILABLE'::"PropertyStatus" AND "deletedAt" IS NULL
        AND "areaSqm" > 0 AND ${tjsExpr} > 0
      GROUP BY "districtId"
    `,
  ]);
  const portfolioTotal = portfolioRows[0]?.total ?? 0;
  const medianPricePerSqm = new Map<string, number>(medianRows.map((r) => [r.districtId, Math.round(r.medianPerSqm)]));

  const districtBreakdown = districtGroups
    .map((g) => ({
      district: districts.find((d) => d.id === g.districtId)?.name ?? "—",
      count: g._count._all,
      // Медиана, а не среднее: одна вилла на 2 млн перекашивает среднее по району
      // так, что число перестаёт что-либо значить для остальных объектов.
      pricePerSqm: medianPricePerSqm.get(g.districtId ?? "") ?? null,
    }))
    .sort((a, b) => b.count - a.count);

  // Комиссия месяца и план сравниваются в одной валюте — сомони.
  const commissionMonth = roundMoney(
    completedDeals.reduce((sum, d) => sum + toTjs(d.commissionAmount, d.currency, money), 0)
  );
  const demandCounts = await computeDemandCounts(topProperties);

  // Курс нужен, потому что объекты бывают и в долларах: складывать их с сомони
  // один к одному — самая дорогая ошибка в денежном экране (money уже загружен выше).
  // Сумма теперь считается в БД (tjsExpr выше) — roundMoney остаётся защитой от
  // хвоста плавающей точки на границе Node/Postgres, как и раньше.
  const portfolioValue = roundMoney(portfolioTotal);
  // 0,5% «за приём объекта» отменены 11.09.2026: доля, которую они отводили
  // интейкеру, теперь всегда достаётся компании — прибавляем её к проценту компании.
  const companyPercent = Number(settings?.commissionCompanyPercent ?? 1) + Number(settings?.commissionIntakePercent ?? 0.5);
  const potentialCommission = roundMoney((portfolioValue * companyPercent) / 100);
  // Деньги компании — только с finance.view, а не dashboard.analytics (ночная
  // проверка 24.09.2026, №159/М4). Стоимость всего портфеля и комиссия с него —
  // это выручка агентства целиком; dashboard.analytics — общее «руководящий
  // взгляд на пульт», его держит и менеджер, а по решению владельца менеджер
  // денег не видит (то же различение уже сделано в dashboardMissionControl.ts
  // и reports.ts — там тоже finance.view отдельно от dashboard.analytics).
  const seesMoney = can(req, "finance.view");
  const interactionAccess = transcriptAccess(req.agent);
  res.json({
    kpis: {
      availableProperties: availableCount,
      // Портфель в сомони и комиссия компании с него, если всё продастся по текущим
      // ценам. Это не прогноз выручки — это масштаб того, что сейчас в работе.
      portfolioValue: seesMoney ? portfolioValue : 0,
      potentialCommission: seesMoney ? potentialCommission : 0,
      hotClients: hotClientsCount,
      showingsWeek: showingsThisWeek,
      /**
       * Комиссия — тем же правилом, что портфель и потенциальная комиссия выше.
       *
       * У рядового агента (ownAgentId задан) это ЕГО комиссия, и её он видеть
       * обязан. А вот сотруднику с правом «видеть всех клиентов», но без права на
       * аналитику, сюда попадала валовая комиссия всего агентства за месяц:
       * completedDeals сужается только по clients.viewAll, а seesMoney к этому
       * полю не применялся. Комбинация редкая — но ради таких комбинаций реестр
       * прав и вводили вместо ролей.
       */
      commissionMonth: ownAgentId || seesMoney ? commissionMonth : 0,
      commissionPlan: Number(settings?.monthlyCommissionPlan ?? 8000),
      /**
       * Чья это комиссия — своя или всего агентства.
       *
       * План месяца в CRM ОДИН, общий (Settings.monthlyCommissionPlan): личных
       * планов у агентов нет вовсе. А `commissionMonth` выше у агента — ЕГО
       * собственная. Экран делил одно на другое и подписывал «от плана месяца»:
       * у агента кольцо не могло заполниться в принципе, потому что сравнивало
       * его личный вклад с целью всего агентства.
       *
       * Числа остаются прежними — меняется подпись: агенту это «вклад в план
       * агентства», руководству — «выполнение плана».
       */
      commissionScope: ownAgentId ? ("own" as const) : ("company" as const),
    },
    funnel: [
      { key: "leads", label: "Новые лиды", count: newLeads },
      { key: "contacted", label: "На контакте", count: contactedClientIds.length },
      { key: "showings", label: "Показы", count: showingsThisMonth.length },
      { key: "negotiations", label: "Переговоры", count: negotiations },
      // Та же комиссия и то же правило, что в kpis выше: воронка не должна быть
      // вторым, незакрытым окном к деньгам агентства.
      { key: "deals", label: "Сделки", count: completedDeals.length, commission: ownAgentId || seesMoney ? commissionMonth : 0 },
    ],
    // Телефон в списке задач на сегодня приходил целиком в обход общего правила
    // (см. lib/clientPhone.ts) — главная показывала номер прямо под именем клиента.
    //
    // presentInteractions — не только withMaskedClient (глубокая проверка
    // 02.10.2026, A1): выборка идёт через `include` без `select`, и наружу
    // уходили ВСЕ скаляры записи — расшифровка, перевод, ссылка на запись,
    // заметки с номером. Звонок с «перезвонить» попадает в задачи на сегодня, а
    // лента у руководства идёт по всей компании. Тот же класс в календаре
    // закрыт 22.09.2026 (routes/calendar.ts) — общая точка выдачи записи
    // хронологии одна, lib/callTranscripts.ts.
    tasksToday: presentInteractions(tasksToday, interactionAccess).map((task) =>
      withMaskedClient(task, can(req, "clients.viewPhone"))
    ),
    // Срок первого звонка (см. вычисление выше) — секция «Мой фокус» на Главной
    // агента ставит самую срочную карточку первой строкой, пока крон не забрал
    // просроченный лид. Пусто у руководства (нет личного фокуса) и у агента без
    // непрозвоненных принятых карточек.
    firstCallDue,
    assignedBySupervisor,
    // Лента активности несёт имя клиента (телефон она не выбирает) — а номер у
    // старых карточек лежит именно в имени, см. lib/clientPhone.ts.
    // Записи хронологии — через presentInteractions, см. tasksToday выше (A1).
    recentActivity: presentInteractions(recentInteractions, interactionAccess).map((i) =>
      withMaskedClient(i, can(req, "clients.viewPhone"))
    ),
    // presentProperty: include тянет ВСЕ скаляры Property — и вектор 768 float, который
    // браузеру не нужен, и контакт собственника, который положен не каждому (22.09.2026:
    // здесь стоял один stripEmbedding, и виджет «Топ объектов» отдавал ownerContact
    // любому вошедшему, включая агента и монтажёра — право properties.viewOwners
    // проверялось только в разделе «Объекты»). См. lib/ownerContact.ts.
    topProperties: topProperties.map((p) => ({ ...presentProperty(p, req), demandCount: demandCounts.get(p.id) ?? 0 })),
    districtBreakdown,
    // «Лимит 5» (решение владельца 30.07): агенту — его текущая загрузка и лимит,
    // чтобы дашборд мог предупредить «новые лиды не придут, пока не закроете эти».
    // Руководству поле не отдаём: у него нет личного портфеля лидов.
    ...(ownAgentId
      ? {
          activeLeadLoad: {
            // Тем же правилом, что и сама раздача (lib/leadLimits.ts,
            // OCCUPIES_SLOT_WHERE) — здесь была вторая копия условия, и она
            // расходилась с реальностью: см. подробный разбор в lib/royalScore.ts.
            count: await prisma.client.count({
              where: { assignedAgentId: ownAgentId, deletedAt: null, ...OCCUPIES_SLOT_WHERE },
            }),
            limit: settings?.leadActiveLimit ?? DEFAULT_LEAD_ACTIVE_LIMIT,
          },
        }
      : {}),
  });
});

/**
 * КОГДА АУДИТОРИЯ АКТИВНА: события по дню недели и часу за последние N дней
 * (Настройки → Публикации, «за сколько дней считать карту», по умолчанию 90).
 *
 * Отвечает на вопрос, который иначе никак не увидеть: агенты на связи в рабочие
 * часы, а люди пишут вечером — и половина обращений остывает до утра. С
 * 21.09.2026 у карты появился второй потребитель — выбор часа публикации в
 * соцсетях (владелец: «в какой час публиковать»), поэтому считается не только
 * первое обращение клиента, но и вся активность: звонки, комментарии,
 * переписка. Что именно и по какому каналу — параметры `signal` и `channel`,
 * весь счёт и все оговорки живут в lib/audienceHeatmap.ts, здесь только
 * проверка ввода и права.
 *
 * `reports.view` — второе право, а не замена первого (10.09.2026, «экран
 * маркетолога» из «Логики 2.0»): карта висит блоком на /sources, а тот экран
 * целиком гейтится `reports.view`. Личных данных в ответе нет: только
 * количество событий по дню недели и часу.
 */
const heatmapQuerySchema = z.object({
  signal: z.enum(HEATMAP_SIGNALS).default("all"),
  channel: z.enum(HEATMAP_CHANNELS).default("ALL"),
});

dashboardRouter.get("/heatmap", requireAuth, requirePermission("dashboard.analytics", "reports.view"), async (req, res) => {
  const parsed = heatmapQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: "Неизвестный сигнал или канал тепловой карты" });
  }
  const { signal, channel } = parsed.data;
  // Окно и запас «за сколько часов до всплеска» — из тех же Настроек, что у
  // расстановки роликов (lib/publishScheduleRules.ts): совет под картой обязан
  // совпадать с часами, в которые ролики на самом деле выходят.
  const { days, leadHours } = await loadHeatmapAdviceSettings();
  const cells = await loadHeatmapCells({ signal, channel, days });
  res.json({
    cells,
    days,
    leadHours,
    signal,
    channel,
    // Какие каналы осмысленны для этого сигнала — чтобы экран не предлагал
    // «комментарии по телефону» и не держал вторую копию этого знания.
    channels: HEATMAP_CHANNELS_BY_SIGNAL[signal],
    ...summarizeHeatmap(cells, leadHours),
  });
});

/**
 * Каналы рядом (24.09.2026): тот же сигнал, что у карты, по каждому каналу —
 * сколько, куда движется, по часам, свой лучший час. См. loadChannelActivity.
 */
const heatmapChannelsQuerySchema = z.object({ signal: z.enum(HEATMAP_SIGNALS).default("all") });

dashboardRouter.get(
  "/heatmap/channels",
  requireAuth,
  requirePermission("dashboard.analytics", "reports.view"),
  async (req, res) => {
    const parsed = heatmapChannelsQuerySchema.safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ error: "Неизвестный сигнал тепловой карты" });
    const { signal } = parsed.data;
    const { days, leadHours } = await loadHeatmapAdviceSettings();
    try {
      const channels = await loadChannelActivity({ signal, days, leadHours });
      res.json({ signal, days, leadHours, channels });
    } catch (err) {
      void logSystemError("api", `Активность по каналам не посчиталась: ${err instanceof Error ? err.message : String(err)}`, {
        dedupKey: "heatmap-channels-failed",
      });
      res.status(500).json({ error: "Не получилось посчитать активность по каналам" });
    }
  }
);

/**
 * Четыре инсайт-виджета дашборда одним запросом (владелец 05.08.2026, кусок 3):
 * слабое звено недели / где застревают сделки / прогноз плана / нагрузка агентов.
 * Только для тех, кому открыта аналитика — те же данные, что и остальные
 * плитки этого набора (команда, показатели по компании).
 */
dashboardRouter.get("/insights", requireAuth, requirePermission("dashboard.analytics"), async (req, res) => {
  // Прогноз плана — комиссия компании: без finance.view приходит null
  // (28.09.2026, как commission в /charts выше).
  res.json(await buildDashboardInsights({ seesMoney: can(req, "finance.view") }));
});
