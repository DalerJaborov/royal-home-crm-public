import { visibleErrorLogs } from "../lib/systemErrorVisibility.js";
import { visibleCronWhere, visibleSystemErrorWhere } from "../lib/investigationOperations.js";
import { Prisma } from "../generated/prisma/client.js";
import { countVisibleBackgroundJobs } from "../lib/backgroundJobPrivacy.js";
import { Router, type Request } from "express";
import { canViewInvestigations } from "@royal-home/shared";
import { investigationCallChannelIds } from "../lib/investigationCallChannels.js";
import { listActive as activeRobotCalls } from "../lib/telephony/liveVoiceMonitor.js";
import { prisma } from "../db.js";
import { can, requireAuth, requirePermission } from "../auth/middleware.js";
import { loadMoneyContext, roundMoney, toTjs } from "../lib/money.js";
import { computePlanForecast } from "../lib/dashboardInsights.js";
import { buildFinancePulse } from "../lib/financePulse.js";
import { loadMorningNumbers } from "../lib/morningNumbers.js";
import { liveIncomingCalls } from "../lib/telephony/incomingCalls.js";
import { liveOutgoingCalls } from "../lib/telephony/callTracker.js";
import { AWAITING_REVIEW_WHERE } from "../lib/telephony/awaitingReview.js";
import { loadGuardStats } from "../ai/guardMetrics.js";
import { findSellerPropertyMissing } from "../lib/sellerPropertyMissingAntifraud.js";
import { findSilentAfterShowing } from "./oversight.js";
import { loadPendingOwnerQuestions } from "../lib/ownerQuestions.js";
import { findStaleContactRequests } from "../lib/staleContactRequests.js";
import { findImportantOtherInquiries } from "../lib/importantOtherInquiries.js";
import { loadPipelineDeadlines, stageState } from "../lib/propertyPipeline.js";
import { MARKETING_PIPELINE_SCAN_CAP } from "./marketing.js";
import { PROPERTY_PIPELINE_STATUSES, plural, type PultModuleId, RATED_ROLES } from "@royal-home/shared";
import { OCCUPIES_SLOT_WHERE } from "../lib/leadLimits.js";
import { dushanbeStartOfToday, dushanbeWallClock } from "../lib/dushanbeTime.js";
import { buildMarketingFunnel } from "../lib/marketingFunnel.js";
import { loadMissionControlTicker } from "../lib/missionControlTicker.js";
import { loadWeeklyLeaderboard } from "../lib/leaderboard.js";
import { buildAskContext } from "../lib/missionControlAsk.js";
import { answerMissionControlQuestion } from "../ai/missionControlQa.js";
import { logSystemError } from "../lib/systemError.js";
import { describeError } from "../lib/describeError.js";
import { isPultModuleEnabled, loadDisabledPultModules } from "../lib/pultModules.js";
import { cachedSection } from "../lib/missionControlCache.js";
import { clientNamePhoneSafe, phoneSafeText } from "../lib/clientPhone.js";
import {
  loadAttentionClient,
  loadBotAttention,
  loadChannelsHealth,
  loadCommission12Months,
  loadControlGaps,
  loadDeleteRequests,
  loadPropertiesExtra,
  loadPublishQueue,
  loadPulse30Days,
  loadReturnedClients,
  loadShowingsToday,
  loadTeamDay,
} from "../lib/missionControlGaps.js";
import { z } from "zod";
import { givenUpVisibleWhere } from "../lib/stuckWork.js";
import { visibleNewCandidatesWhere } from "../lib/vacancyVisibility.js";

/**
 * «Вся компания на ладони» — единый агрегирующий экран для ADMIN/DIRECTOR
 * (план `docs/dashboard-mission-control-plan-31-08-2026.md`, фаза 1: каркас +
 * «свободные победы»). Один ответ на весь экран, опрос раз в 15с с фронта —
 * см. §0 плана: отдельного WebSocket-сервера в системе нет, вебсокеты избыточны
 * при масштабе агентства.
 *
 * Гейт роута — dashboard.analytics, как и у остальных общекомандных сводок
 * (routes/dashboard.ts). Внутри — отдельный гейт денег (seesMoney), как в
 * dashboard.ts:591 — иначе MANAGER увидит суммы, на которые права нет.
 *
 * Каждая секция обёрнута отдельным try/catch: отказ одного суб-агрегата не должен
 * ронять весь экран 500-й — секция возвращается как { error: true }, фронт рисует
 * «не удалось загрузить», а не нолики (правило ux-brainstorm/02: никогда не
 * показывать демо/нулевые данные в слоте цифры).
 */
export const missionControlRouter = Router();

const ZONE_LIST_CAP = 12;
/** Дней без работы с клиентом в воронке — «завис» (карточка «Сделки в работе»). */
const STUCK_CLIENT_DAYS = 3;

type SectionResult<T> = T | { error: true };

async function section<T>(name: string, fn: () => Promise<T>): Promise<SectionResult<T>> {
  try {
    return await fn();
  } catch (err) {
    console.error(`[mission-control] секция "${name}" не построена:`, err instanceof Error ? err.message : err);
    return { error: true };
  }
}

/**
 * ДВА ТЕМПА ОПРОСА (аудит 02.09.2026 §2 п.2). Живые секции (герой-строка, первая
 * линия, звонки прямо сейчас) — /mission-control/live, кэш 15 с; зоны по сферам —
 * /mission-control/zones, кэш 60 с: портфель объектов и воронка маркетинга не
 * меняются каждые пятнадцать секунд, а стоят базе тысяч строк на каждый опрос.
 * /mission-control без суффикса отдаёт всё вместе (мобильный экран, тесты).
 */
const LIVE_TTL_MS = 15_000;
const ZONES_TTL_MS = 60_000;
const LIVE_MODULES: ReadonlySet<PultModuleId> = new Set<PultModuleId>(["firstLine", "calls"]);

interface McContext {
  now: Date;
  startOfDay: Date;
  startOfYesterday: Date;
  /** Календарная дата по Душанбе, как её пишет ai/guardMetrics.ts. */
  today: string;
  seesMoney: boolean;
  /** Право видеть телефоны клиентов (22.09.2026). Пульт открыт правом
   *  dashboard.analytics — у менеджера оно есть, а clients.viewPhone нет, и до
   *  этой правки пульт был вторым «Топ объектов»: имена карточек, вопросы бота,
   *  вырезки из переписки и имена в звонках шли сырыми, а номер у карточек
   *  незнакомых звонивших лежит именно в имени. Входит В КЛЮЧ КЭША ниже — иначе
   *  первый запрос директора наполнил бы кэш открытыми данными для менеджера. */
  canSeePhone: boolean;
  seesInvestigations: boolean;
  viewerRole?: string;
  off: ReadonlySet<PultModuleId>;
}

async function buildContext(req: Request): Promise<McContext> {
  // Гейт денег как в dashboard.ts:591 (seesMoney) — но здесь ещё точнее: сама
  // модель прав различает finance.view (комиссии/расходы) от dashboard.analytics
  // (общая аналитика), и MANAGER имеет второе без первого (permissions.ts:358,510).
  const seesMoney = can(req, "finance.view");
  const canSeePhone = can(req, "clients.viewPhone");
  const now = new Date();
  const startOfDay = dushanbeStartOfToday(now);
  const startOfYesterday = new Date(startOfDay.getTime() - 24 * 60 * 60 * 1000);
  // ai/guardMetrics.ts пишет GuardHit.day через dushanbeWallClock().toISOString()
  // (душанбинское время, представленное как «поддельный UTC»). dushanbeStartOfToday
  // возвращает НАСТОЯЩИЙ момент UTC душанбинской полуночи — .toISOString() от него
  // даёт ВЧЕРАШНЮЮ календарную дату (душанбинская полночь = 19:00 UTC предыдущего
  // дня), и «сторож сегодня» на пульте всегда показывал 0 (найдено аудитом 02.09.2026,
  // docs/audit-02-09-2026/06-dashboard.md). Формула должна совпадать с writer'ом.
  const today = dushanbeWallClock(now).toISOString().slice(0, 10);
  // Реестр модулей (аудит 02.09.2026 §4): выключенная секция НЕ СЧИТАЕТСЯ и
  // отсутствует в ответе — не null и не { error }. Фронт рисует только то, что пришло.
  const off = await loadDisabledPultModules();
  const seesInvestigations = canViewInvestigations(req.agent?.role) && can(req, "clients.securityReview");
  // All downstream investigation projections must receive effective access,
  // including charts and team counters, rather than the unqualified role.
  return { now, startOfDay, startOfYesterday, today, seesMoney, canSeePhone, seesInvestigations,
    viewerRole: seesInvestigations ? req.agent?.role : undefined, off };
}

/** Секция модуля: выключен → undefined (ключа не будет), иначе — через кэш своего темпа. */
function makeGated(ctx: McContext) {
  return <T,>(module: PultModuleId, fn: () => Promise<T>): Promise<SectionResult<T> | undefined> =>
    ctx.off.has(module)
      ? Promise.resolve(undefined)
      : cachedSection(`${module}:${ctx.seesMoney}:${ctx.canSeePhone}:${ctx.seesInvestigations}`, LIVE_MODULES.has(module) ? LIVE_TTL_MS : ZONES_TTL_MS, () =>
          section(module, fn)
        );
}

function stripUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}

function envelope(ctx: McContext, body: Record<string, unknown>) {
  return { generatedAt: ctx.now.toISOString(), seesMoney: ctx.seesMoney, modulesOff: [...ctx.off], ...body };
}

async function buildLive(ctx: McContext) {
  const { now, startOfDay, startOfYesterday, seesMoney, canSeePhone } = ctx;
  const gated = makeGated(ctx);
  const [hero, firstLine, callsZone] = await Promise.all([
    cachedSection(`hero:${seesMoney}:${ctx.canSeePhone}`, LIVE_TTL_MS, () =>
      section("hero", async () => {
      const stuckCutoff = new Date(now.getTime() - STUCK_CLIENT_DAYS * 24 * 60 * 60 * 1000);
      const [forecast, pulse, leadsToday, leadsYesterday, morning, missedToday, dealsInPipeline, dealsInPipelineItems, stuckTotal] =
        await Promise.all([
          seesMoney ? computePlanForecast() : null,
          seesMoney ? buildFinancePulse() : null,
          prisma.client.count({ where: { createdAt: { gte: startOfDay }, deletedAt: null } }),
          prisma.client.count({
            where: { createdAt: { gte: startOfYesterday, lt: startOfDay }, deletedAt: null },
          }),
          loadMorningNumbers(),
          prisma.incomingCall.count({ where: { startedAt: { gte: startOfDay }, answered: false } }),
          prisma.client.groupBy({
            by: ["status"],
            where: { deletedAt: null, ...OCCUPIES_SLOT_WHERE },
            _count: { _all: true },
          }),
          // items[]: «клиент завис» = клиент в активной воронке, с которым НЕТ работы
          // STUCK_CLIENT_DAYS+ дней. Признак движения — Client.lastContactAt (метка
          // работы сотрудника: звонок, показ, запись в хронологии; входящее сообщение
          // её намеренно не двигает — клиент, который пишет боту, но которого никто не
          // тронул, и есть «завис»). Раньше брались 5 самых НОВЫХ клиентов и
          // помечались созданные 3+ дня назад — то есть самые свежие, не самые
          // забытые. Теперь: самые давно молчащие первыми, предел 5, без N+1.
          // Ссылка — на карточку клиента (тот же маршрут, что в канбане, Deals.tsx:120).
          prisma.client.findMany({
            where: { deletedAt: null, ...OCCUPIES_SLOT_WHERE, lastContactAt: { lt: stuckCutoff } },
            orderBy: { lastContactAt: "asc" },
            take: 5,
            select: { id: true, shortId: true, fullName: true, status: true, lastContactAt: true },
          }),
          prisma.client.count({
            where: { deletedAt: null, ...OCCUPIES_SLOT_WHERE, lastContactAt: { lt: stuckCutoff } },
          }),
        ]);
      const pulseToday = pulse?.find((p) => p.period === "today") ?? null;
      return {
        commission: forecast
          ? {
              fact: forecast.commissionMonth,
              plan: forecast.plan,
              forecastEndOfMonth: forecast.forecastEndOfMonth,
              forecastPercent: forecast.forecastPercent,
              /** true — в настройках значение по умолчанию (8000): не выдавать за настоящий план. */
              planIsDefault: forecast.planIsDefault ?? false,
            }
          : null,
        profit: pulseToday
          ? {
              todayTjs: pulseToday.balanceTjs,
              previousTodayTjs: pulseToday.previousBalanceTjs,
            }
          : null,
        leadsToday: { count: leadsToday, deltaVsYesterday: leadsToday - leadsYesterday },
        firstResponse: {
          medianMinYesterday: morning.firstTouchMedianMin,
          noneCountYesterday: morning.firstTouchNoneCount,
        },
        missedCallsToday: missedToday,
        dealsInPipeline: {
          count: dealsInPipeline.reduce((s, r) => s + r._count._all, 0),
          byStage: dealsInPipeline.map((r) => ({ status: r.status, count: r._count._all })),
          /** Клиентов в работе без движения STUCK_CLIENT_DAYS+ дней (всего, не только в items). */
          stuckTotal,
          stuckDays: STUCK_CLIENT_DAYS,
          items: dealsInPipelineItems.map((c) => {
            const days = Math.floor((now.getTime() - c.lastContactAt.getTime()) / (24 * 60 * 60 * 1000));
            return {
              id: c.id,
              // Имя карточки — через право на телефон: у заведённых до 20.08.2026
              // номер лежит в имени (lib/clientPhone.ts).
              title: clientNamePhoneSafe(c.fullName, canSeePhone),
              href: `/clients/${c.shortId}`,
              tone: "warn" as const,
              hint: `Без движения ${days} ${plural(days, "день", "дня", "дней")}`,
              silentDays: days,
            };
          }),
        },
      };
    })),
    // Ярус 1 — «первая линия»: существующие сигналы, сведённые в одну ленту.
    gated("firstLine", async () => {
      const [
        sellerMissing,
        silentShowing,
        pendingApproval,
        deleteRequests,
        propertyDeleteRequests,
        reactivationOffers,
        ownerQuestions,
        staleContact,
        importantOther,
      ] = await Promise.all([
        ctx.seesInvestigations ? findSellerPropertyMissing(now) : Promise.resolve({ items: [], total: 0 }),
        findSilentAfterShowing(now),
        prisma.deal.count({ where: { stage: "PENDING_APPROVAL" } }),
        prisma.clientDeleteRequest.count({ where: { status: "PENDING" } }),
        prisma.propertyDeleteRequest.count({ where: { status: "PENDING" } }),
        // Реактивация к прежнему агенту (разбор 31.08.2026, п.12) — то же
        // «ждёт решения», что у заявок на удаление, только по другому полю:
        // отдельной таблицы под предложение нет, состояние лежит на Client.
        prisma.client.count({ where: { reactivationOfferedToAgentId: { not: null }, deletedAt: null } }),
        loadPendingOwnerQuestions(5),
        findStaleContactRequests(now),
        findImportantOtherInquiries(now),
      ]);

      const items: Array<{
        id: string;
        severity: "critical" | "warn" | "info";
        text: string;
        href: string;
      }> = [];

      for (const it of sellerMissing.items.slice(0, ZONE_LIST_CAP)) {
        items.push({
          id: `seller-missing-${it.id}`,
          severity: it.level === "CRITICAL" ? "critical" : "warn",
          text: `Приёмка от ${clientNamePhoneSafe(it.fullName, canSeePhone)} принята ${it.daysSince} дн. назад — объекта в базе нет`,
          // Продавец — это карточка клиента; экрана /sellers/<номер> нет (аудит 23.09.2026, №16).
          href: `/clients/${it.shortId}`,
        });
      }
      for (const c of silentShowing.items.slice(0, ZONE_LIST_CAP)) {
        items.push({
          id: `silent-showing-${c.id}`,
          severity: "warn",
          text: `Показ у ${clientNamePhoneSafe(c.fullName, canSeePhone)} прошёл — тишина дольше ${silentShowing.days} дн.`,
          href: `/clients/${c.shortId}`,
        });
      }
      if (pendingApproval > 0) {
        items.push({
          id: "deals-pending-approval",
          severity: "info",
          text: `${pendingApproval} сделк${pendingApproval === 1 ? "а" : "и"} ждут вашего одобрения`,
          href: "/deals?stage=PENDING_APPROVAL",
        });
      }
      if (deleteRequests > 0) {
        items.push({
          id: "delete-requests",
          severity: "info",
          text: `${deleteRequests} заявк${deleteRequests === 1 ? "а" : "и"} на удаление клиента ждут решения`,
          href: "/archive",
        });
      }
      if (propertyDeleteRequests > 0) {
        items.push({
          id: "property-delete-requests",
          severity: "info",
          text: `${propertyDeleteRequests} заявк${propertyDeleteRequests === 1 ? "а" : "и"} на удаление объекта ждут решения`,
          href: "/archive",
        });
      }
      if (reactivationOffers > 0) {
        items.push({
          id: "reactivation-offers",
          severity: "info",
          text: `${reactivationOffers} предложени${reactivationOffers === 1 ? "е" : "я"} реактивации ждут решения агента`,
          href: "/clients",
        });
      }
      for (const q of ownerQuestions.slice(0, 5)) {
        items.push({
          id: `owner-question-${q.id}`,
          severity: "warn",
          text: `Бот обещал уточнить у вас: «${canSeePhone ? q.question : phoneSafeText(q.question, false)}»`,
          href: q.clientShortId ? `/clients/${q.clientShortId}` : "/",
        });
      }
      for (const s of staleContact.items.slice(0, ZONE_LIST_CAP)) {
        items.push({
          id: s.id,
          severity: "warn",
          text: `${s.name ? clientNamePhoneSafe(s.name, canSeePhone) : "Диалог"}: попросили номер ${s.hoursSince} ч назад — тишина`,
          href: "/messages",
        });
      }
      for (const o of importantOther.items.slice(0, ZONE_LIST_CAP)) {
        items.push({
          id: `important-other-${o.id}`,
          severity: "critical",
          text: `«Прочие обращения»: ${clientNamePhoneSafe(o.fullName, canSeePhone)} — похоже на важное («${canSeePhone ? o.snippet : phoneSafeText(o.snippet, false)}»)`,
          href: `/clients/${o.shortId}`,
        });
      }

      const severityRank = { critical: 0, warn: 1, info: 2 } as const;
      items.sort((a, b) => severityRank[a.severity] - severityRank[b.severity]);

      // Ограничиваем ленту 3-7 карточками (правило плана §2 «Ярус 1») — честно
      // считаем и возвращаем сколько ещё осталось за кадром.
      const shown = items.slice(0, 7);
      return { items: shown, shownCount: shown.length, totalCount: items.length };
    }),

    // Звонки — wallboard: живые разговоры прямо сейчас (in-memory, самая
    // "живая" плитка системы), сегодняшние счётчики, неразобранная очередь.
    gated("calls", async () => {
      const privateChannels = new Set(ctx.seesInvestigations ? [] : [
        ...await investigationCallChannelIds(),
        ...activeRobotCalls().filter((call) => call.investigationOnly).map((call) => call.channelId),
      ]);
      const [incomingToday, outgoingToday, missedToday, unqualified] = await Promise.all([
        prisma.incomingCall.count({ where: { startedAt: { gte: startOfDay } } }),
        prisma.interaction.count({ where: { ...(ctx.seesInvestigations ? {} : { investigationOnly: false }), type: "CALL", createdAt: { gte: startOfDay } } }),
        prisma.incomingCall.count({ where: { startedAt: { gte: startOfDay }, answered: false } }),
        prisma.incomingCall.count({ where: { startedAt: { gte: startOfDay }, ...AWAITING_REVIEW_WHERE } }),
      ]);
      return {
        live: {
          incoming: liveIncomingCalls().filter((c) => !privateChannels.has(c.channelId)).map((c) => ({
            channelId: c.channelId,
            clientName: c.clientName ? clientNamePhoneSafe(c.clientName, canSeePhone) : null,
            clientShortId: c.clientShortId ?? null,
            answered: !!c.answeredAt,
            seconds: c.talkSeconds,
          })),
          outgoing: liveOutgoingCalls().filter((c) => !privateChannels.has(c.channelId)).map((c) => ({
            channelId: c.channelId,
            clientName: c.clientName ? clientNamePhoneSafe(c.clientName, canSeePhone) : c.clientName,
            clientShortId: c.clientShortId,
            state: c.state,
          })),
        },
        today: { incoming: incomingToday, outgoing: outgoingToday, missed: missedToday, unqualified },
      };
    }),
  ]);
  return stripUndefined({ hero, firstLine, calls: callsZone });
}

async function buildZones(ctx: McContext) {
  const { now, startOfDay, today, seesMoney, canSeePhone } = ctx;
  const gated = makeGated(ctx);
  const [team, botZone, marketingZone, videoZone, propertiesZone, systemZone, leaderboardZone, clientsZone, commission12] =
    await Promise.all([
    // Команда — та же логика, что /dashboard/team-live, плюс разбивка по kind
    // (покупатели/продавцы), которой там пока нет.
    gated("team", async () => {
      const agents = await prisma.agent.findMany({
        where: { role: { in: [...RATED_ROLES] }, isActive: true },
        // lastSeenAt — то же поле, что обновляет auth/middleware.ts на каждый
        // запрос (не чаще раза в минуту на агента) и уже отдают team.ts/hallOfFame.ts
        // как «онлайн» окном в 3 минуты (D6, tasks-theme-2026.md): точка присутствия
        // в плитке «Команда» пульта, без нового поля и без опроса «кто на звонке».
        // frozenAt/leadsPausedUntil — для takesLeads ниже (F2, 02.10.2026).
        select: { id: true, fullName: true, avatarUrl: true, lastSeenAt: true, frozenAt: true, leadsPausedUntil: true },
        orderBy: { fullName: "asc" },
        take: 500,
      });
      const ids = agents.map((a) => a.id);
      // OCCUPIES_SLOT_WHERE (lib/leadLimits.ts) фиксирует kind:"BUYER" внутри
      // себя — это устоявшееся определение «активной нагрузки» (лимит лидов
      // считается только по покупателям). Для разбивки ПК/ПР по агенту нужен
      // отдельный, более широкий фильтр «жив и в работе», без привязки к kind.
      const ACTIVE_NOT_TERMINAL = {
        workStatus: "ACTIVE" as const,
        status: { notIn: ["LOST", "DEAL_CLOSED", "ARCHIVED"] as ("LOST" | "DEAL_CLOSED" | "ARCHIVED")[] },
        deletedAt: null,
      };
      const [activeLoad, pendingAccept, acceptedToday, buyerCount, sellerCount] =
        await Promise.all([
          prisma.client.groupBy({
            by: ["assignedAgentId"],
            where: { assignedAgentId: { in: ids }, deletedAt: null, ...OCCUPIES_SLOT_WHERE },
            _count: { _all: true },
          }),
          // ACTIVE_NOT_TERMINAL — без него клиент, ушедший в LOST/INACTIVE/ARCHIVED
          // так и не будучи принятым, висел в «непринятых» у агента вечно (найдено
          // аудитом 02.09.2026, docs/audit-02-09-2026/06-dashboard.md).
          prisma.client.groupBy({
            by: ["assignedAgentId"],
            where: { assignedAgentId: { in: ids }, acceptedAt: null, ...ACTIVE_NOT_TERMINAL },
            _count: { _all: true },
          }),
          prisma.client.groupBy({
            by: ["assignedAgentId"],
            where: { assignedAgentId: { in: ids }, acceptedAt: { gte: startOfDay }, deletedAt: null },
            _count: { _all: true },
          }),
          prisma.client.groupBy({
            by: ["assignedAgentId"],
            where: { assignedAgentId: { in: ids }, kind: "BUYER", ...ACTIVE_NOT_TERMINAL },
            _count: { _all: true },
          }),
          prisma.client.groupBy({
            by: ["assignedAgentId"],
            where: { assignedAgentId: { in: ids }, kind: "SELLER", ...ACTIVE_NOT_TERMINAL },
            _count: { _all: true },
          }),
        ]);
      const toMap = (arr: { assignedAgentId: string | null; _count: { _all: number } }[]) =>
        new Map(arr.map((x) => [x.assignedAgentId, x._count._all]));
      const load = toMap(activeLoad),
        pend = toMap(pendingAccept),
        acc = toMap(acceptedToday),
        buy = toMap(buyerCount),
        sell = toMap(sellerCount);
      return {
        agents: agents
          .map((a) => ({
            id: a.id,
            fullName: a.fullName,
            avatarUrl: a.avatarUrl,
            activeLoad: load.get(a.id) ?? 0,
            pendingAccept: pend.get(a.id) ?? 0,
            acceptedToday: acc.get(a.id) ?? 0,
            buyerCount: buy.get(a.id) ?? 0,
            sellerCount: sell.get(a.id) ?? 0,
            lastSeenAt: a.lastSeenAt ? a.lastSeenAt.toISOString() : null,
            /**
             * Принимает ли агент лиды сейчас (глубокая проверка 02.10.2026,
             * F2). «Передать наименее загруженному» в пульте брал минимум
             * нагрузки по всей команде — и у замороженного агента с нагрузкой 0
             * он оказывался первым. Правило то же, что у раздачи
             * (services/leads/assignment.ts): заморозка или пауза приёма лидов.
             */
            takesLeads: !a.frozenAt && !(a.leadsPausedUntil && a.leadsPausedUntil > now),
          }))
          .sort((a, b) => b.activeLoad - a.activeLoad),
        // «День команды» и «Показы сегодня» — блоки, которые до 12.09.2026 стояли
        // с подписью «нет данных»: разметка артефакта была, считалки не было.
        day: await loadTeamDay(now, ctx.viewerRole),
        showingsToday: await loadShowingsToday(now, ctx.viewerRole),
      };
    }),

    // Бот/ИИ — «свободная победа №2» (AiLog) + «победа №3» (GuardHit).
    gated("bot", async () => {
      const [aiAgg, aiErrorCount, aiTotalCount, guardRows, unresolvedFindings] = await Promise.all([
        prisma.aiLog.aggregate({
          where: { createdAt: { gte: startOfDay } },
          _sum: { costUsd: true },
          _avg: { ms: true },
        }),
        prisma.aiLog.count({ where: { createdAt: { gte: startOfDay }, ok: false } }),
        prisma.aiLog.count({ where: { createdAt: { gte: startOfDay } } }),
        loadGuardStats(1),
        prisma.botAuditFinding.count({ where: { resolvedAt: null } }).catch(() => null),
      ]);
      const guardToday = guardRows.filter((r) => r.day === today);
      return {
        ai: {
          requestsToday: aiTotalCount,
          errorsToday: aiErrorCount,
          errorRatePercent: aiTotalCount > 0 ? Math.round((aiErrorCount / aiTotalCount) * 100) : 0,
          // Расход на ИИ по всей компании — деньги: без finance.view null, как и у
          // остальных денежных блоков пульта (аудит Codex 04.10.2026, ACCESS-05).
          // Ключ кэша секции уже содержит seesMoney.
          costUsdToday: seesMoney ? Number(aiAgg._sum.costUsd ?? 0) : null,
          avgMs: aiAgg._avg.ms ? Math.round(aiAgg._avg.ms) : 0,
        },
        guardHitsToday: guardToday.reduce((s, r) => s + r.count, 0),
        /**
         * ЩИТ ИСХОДЯЩИХ (17.09.2026) — отдельной строкой, а не внутри общего
         * счётчика фильтров. Остальные фильтры правят текст ответа; этот не
         * выпускает сообщение вовсе, и если он начал срабатывать пачками,
         * владелец обязан увидеть это числом, а не по жалобам клиентов.
         */
        outboundShieldToday: guardToday.find((r) => r.guard === "outbound_shield")?.count ?? 0,
        // Модель BotAuditFinding могла не иметь поля resolvedAt на момент выката —
        // secция мягко деградирует до null, а не роняет весь бот-блок.
        unresolvedFindings,
        // «Бот замолчал», «Клиент ждёт агента» и строка «Бот прямо сейчас» —
        // блоки, стоявшие пустыми с переноса артефакта (владелец 12.09.2026).
        attention: await loadBotAttention(now),
      };
    }),

    // Маркетинг — Instagram-комментарии, ждущие внимания, + сквозная воронка
    // расход→лиды→показы→сделки→комиссия по каналам (фаза 3, план §6 п.5).
    gated("marketing", async () => {
      // «Ждут публикации», «Каналы» и «Пульс · 30 дней» добавлены 12.09.2026 —
      // до этого все три карточки рисовались корпусом и строкой «нет данных».
      const [igWaiting, funnel, publishQueue, channels, pulse30] = await Promise.all([
        prisma.instagramComment.count({ where: { status: { in: ["ESCALATED", "FAILED"] } } }),
        buildMarketingFunnel(seesMoney, now),
        loadPublishQueue(now),
        loadChannelsHealth(),
        loadPulse30Days(now, ctx.viewerRole),
      ]);
      return {
        instagramCommentsWaiting: igWaiting,
        funnel: funnel.channels,
        funnelMonth: funnel.month,
        publishQueue,
        channels,
        pulse30,
      };
    }),

    // Видео-конвейер — канбан-счётчики marketing.ts:197 + автомонтаж
    // («свободная победа №6», нигде агрегатом не выведен).
    gated("video", async () => {
      const deadlines = await loadPipelineDeadlines();
      const rows = await prisma.property.findMany({
        where: { deletedAt: null, status: { in: [...PROPERTY_PIPELINE_STATUSES] } },
        select: { status: true, stageEnteredAt: true },
        // Тот же потолок, что marketing.ts /summary — один механизм, не копия.
        take: MARKETING_PIPELINE_SCAN_CAP,
      });
      if (rows.length >= MARKETING_PIPELINE_SCAN_CAP) {
        void logSystemError("api", `Пульт «Видео»: конвейер подготовки больше ${MARKETING_PIPELINE_SCAN_CAP} объектов — счётчики занижены`);
      }
      let awaitingReview = 0,
        awaitingPhotos = 0,
        awaitingVideo = 0,
        editing = 0,
        overdue = 0;
      for (const p of rows) {
        if (p.status === "PENDING_REVIEW") awaitingReview++;
        if (p.status === "AWAITING_PHOTOS") awaitingPhotos++;
        if (p.status === "AWAITING_VIDEO") awaitingVideo++;
        if (p.status === "EDITING") editing++;
        if (stageState(p.status, p.stageEnteredAt, deadlines).overdue) overdue++;
      }
      return {
        pipeline: { total: rows.length, awaitingReview, awaitingPhotos, awaitingVideo, editing, overdue },
      };
    }),

    gated("properties", async () => {
      const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      const [available, newThisWeek, reserved, money, newestProperties] = await Promise.all([
        prisma.property.count({ where: { deletedAt: null, status: "AVAILABLE" } }),
        prisma.property.count({ where: { deletedAt: null, status: "AVAILABLE", createdAt: { gte: weekAgo } } }),
        prisma.property.count({ where: { deletedAt: null, status: "RESERVED" } }),
        seesMoney ? loadMoneyContext() : null,
        // items[] (задача L2-T3): пять последних объектов в продаже — одним запросом
        // с take:5, без N+1. Ссылка — тот же маршрут, что открывает карточку объекта
        // из виджетов дашборда (DashboardWidgets.tsx).
        prisma.property.findMany({
          where: { deletedAt: null, status: "AVAILABLE" },
          orderBy: { createdAt: "desc" },
          take: 5,
          select: { id: true, shortId: true, title: true, price: true, currency: true, createdAt: true },
        }),
      ]);
      let portfolioValueTjs: number | null = null;
      if (money) {
        const priced = await prisma.property.findMany({
          where: { deletedAt: null, status: "AVAILABLE" },
          select: { price: true, currency: true },
          take: 5000,
        });
        portfolioValueTjs = roundMoney(priced.reduce((s, p) => s + toTjs(p.price, p.currency, money), 0));
      }
      const items = newestProperties.map((p) => ({
        id: p.id,
        title: p.title,
        href: `/properties/${p.shortId}`,
        tone: "ok" as const,
        hint: `${Math.round(Number(p.price)).toLocaleString("ru-RU")} ${p.currency === "TJS" ? "с" : "$"}`,
      }));
      // «Объект дня», «Объекты месяц без показов» и разбивка по районам —
      // три карточки, стоявшие пустыми с переноса артефакта (владелец 12.09.2026).
      const extra = await loadPropertiesExtra(now, ctx.viewerRole);
      return { available, newThisWeek, reserved, portfolioValueTjs, items, extra };
    }),

    // HR/система — «победа №1», самая важная владельцу: сейчас НИ ОДНОГО роута
    // на CronHeartbeat/BackgroundJob не существует (три молчаливых отказа Gemini).
    gated("system", async () => {
      const [heartbeats, jobsRunning, jobsGivenUp, jobsFailedRecent, newApplications, errorsToday, unresolvedTotal] =
        await Promise.all([
          prisma.cronHeartbeat.findMany({
            where: visibleCronWhere(ctx.seesInvestigations ? ctx.viewerRole : undefined),
            orderBy: { name: "asc" },
            take: 100,
            select: { name: true, expr: true, lastRunAt: true, lastOkAt: true, lastError: true },
          }),
          countVisibleBackgroundJobs(Prisma.sql`status='RUNNING'`, ctx.seesInvestigations),
          countVisibleBackgroundJobs(Prisma.sql`status='GIVEN_UP' AND "updatedAt">=${givenUpVisibleWhere(now).updatedAt.gte}`, ctx.seesInvestigations),
          countVisibleBackgroundJobs(Prisma.sql`status='GIVEN_UP' AND "updatedAt">=${new Date(now.getTime() - 24 * 60 * 60 * 1000)}`, ctx.seesInvestigations),
          // Те же «новые кандидаты», что в сайдбаре и во вкладке «Подходят»
          // (lib/vacancyVisibility.ts): без отсеянных и без анкет без номера.
          prisma.jobApplication.count({ where: visibleNewCandidatesWhere() }),
          visibleErrorLogs(ctx.seesInvestigations ? ctx.viewerRole : undefined).count({ where: { ...visibleSystemErrorWhere(ctx.seesInvestigations ? ctx.viewerRole : undefined), createdAt: { gte: startOfDay }, resolvedAt: null } }),
          visibleErrorLogs(ctx.seesInvestigations ? ctx.viewerRole : undefined).count({ where: { ...visibleSystemErrorWhere(ctx.seesInvestigations ? ctx.viewerRole : undefined), resolvedAt: null } }),
        ]);
      return {
        crons: heartbeats.map((h) => ({
          name: h.name,
          lastRunAt: h.lastRunAt,
          lastOkAt: h.lastOkAt,
          lastError: h.lastError,
          // Тик "здоров", если последний запуск завершился успехом не позже
          // последнего старта — иначе он либо ещё не бежал, либо упал.
          healthy: !!h.lastOkAt && (!h.lastRunAt || h.lastOkAt >= h.lastRunAt),
        })),
        jobsRunning,
        jobsGivenUp,
        jobsGivenUpLast24h: jobsFailedRecent,
        newApplications,
        errorsToday,
        /** Все нерешённые ошибки (не только сегодняшние); закрыть: POST /errors/resolve-all {scope:"all"}. */
        unresolvedTotal,
        // Три плитки «Контроля» (просроченные задачи, предел нагрузки, молчание
        // после показа) до 12.09.2026 всегда показывали «нет данных».
        control: await loadControlGaps(now, ctx.viewerRole),
      };
    }),

    // Лидерборд недели (план §6, фаза 4, п.7) — тот же KpiDailyScore, что
    // «Доска почёта»/TOP AGENTS, но скользящие 7 дней вместо календарного
    // месяца (см. lib/leaderboard.ts). Ссылка на полный рейтинг — /hall-of-fame.
    gated("leaderboard", async () => ({ agents: await loadWeeklyLeaderboard(now) })),

    /**
     * КЛИЕНТЫ И ДЕНЬГИ ПО МЕСЯЦАМ — БЕЗ ТУМБЛЕРА, НАМЕРЕННО.
     *
     * Раздел «Клиенты» на пульте (ClientsSection) и полоса «Комиссия · 12 месяцев»
     * рисуются всегда — выключаемого модуля под них в реестре нет (см.
     * packages/shared/src/pultModules.ts: тумблеры заведены на team/calls/bot/
     * marketing/video/properties/system/leaderboard/ticker). Поэтому обе секции
     * идут через cachedSection напрямую, как hero, а не через makeGated: иначе
     * пришлось бы завести модуль ради одного блока и он бы тут же разъехался с
     * фронтом, который эти карточки не гасит.
     */
    cachedSection(`clientsZone:${seesMoney}:${ctx.canSeePhone}`, ZONES_TTL_MS, () =>
      section("clientsZone", async () => {
        const [attentionClient, deleteRequests, returned] = await Promise.all([
          loadAttentionClient(now),
          loadDeleteRequests(),
          loadReturnedClients(now),
        ]);
        // Имена карточек — через право на телефон (22.09.2026): у заведённых до
        // 20.08.2026 номер лежит в имени. Заявки на удаление объекта (kind
        // PROPERTY) несут заголовок объекта, его не трогаем.
        if (canSeePhone) return { attentionClient, deleteRequests, returned };
        return {
          attentionClient:
            "id" in attentionClient && attentionClient.id
              ? { ...attentionClient, fullName: clientNamePhoneSafe(attentionClient.fullName, false) }
              : attentionClient,
          deleteRequests: {
            ...deleteRequests,
            items: deleteRequests.items.map((it) =>
              it.kind === "CLIENT" ? { ...it, title: clientNamePhoneSafe(it.title, false) } : it
            ),
          },
          returned: {
            ...returned,
            items: returned.items.map((it) => ({ ...it, fullName: clientNamePhoneSafe(it.fullName, false) })),
          },
        };
      })
    ),
    // Комиссия по месяцам — деньги, поэтому за гейтом finance.view: без права
    // уходит null, а не нули (правило «никогда не показывать нулевые данные
    // в слоте цифры», ux-brainstorm/02).
    seesMoney
      ? cachedSection("commission12", ZONES_TTL_MS, () => section("commission12", () => loadCommission12Months(now)))
      : Promise.resolve(undefined),
  ]);
  return stripUndefined({
    team,
    bot: botZone,
    marketing: marketingZone,
    video: videoZone,
    properties: propertiesZone,
    system: systemZone,
    leaderboard: leaderboardZone,
    clientsZone,
    commission12,
  });
}

missionControlRouter.get(
  "/mission-control",
  requireAuth,
  requirePermission("dashboard.analytics"),
  async (req, res) => {
    const ctx = await buildContext(req);
    const [live, zones] = await Promise.all([buildLive(ctx), buildZones(ctx)]);
    res.json(envelope(ctx, { ...live, ...zones }));
  }
);

missionControlRouter.get(
  "/mission-control/live",
  requireAuth,
  requirePermission("dashboard.analytics"),
  async (req, res) => {
    const ctx = await buildContext(req);
    res.json(envelope(ctx, await buildLive(ctx)));
  }
);

missionControlRouter.get(
  "/mission-control/zones",
  requireAuth,
  requirePermission("dashboard.analytics"),
  async (req, res) => {
    const ctx = await buildContext(req);
    res.json(envelope(ctx, await buildZones(ctx)));
  }
);

const askBodySchema = z.object({
  question: z
    .string()
    .trim()
    .min(3, "Слишком короткий вопрос")
    .max(300, "Вопрос длиннее 300 символов"),
});

/**
 * «Вопрос к данным» (план §6, фаза 4, п.8) — одна реплика, без истории диалога:
 * собираем снимок данных (lib/missionControlAsk.ts, переиспользует те же
 * агрегаты, что и герой-строка/зоны выше) и просим модель ответить только по
 * нему (ai/missionControlQa.ts). Отдельный роут от основного экрана намеренно —
 * это не часть опроса раз в 15с, а разовый запрос, который не должен задерживать
 * остальной дашборд, даже если модель отвечает медленно или не отвечает вовсе
 * (callAiText внутри уже ограничен таймаутом и одним повтором — см. ai/client.ts).
 */
missionControlRouter.post(
  "/mission-control/ask",
  requireAuth,
  requirePermission("dashboard.analytics"),
  async (req, res) => {
    const parsed = askBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Неверный вопрос" });
    }
    if (!(await isPultModuleEnabled("ask"))) {
      return res.status(409).json({ error: "«Вопрос к данным» выключен в настройках пульта" });
    }
    const seesMoney = can(req, "finance.view");
    try {
      const context = await buildAskContext(seesMoney);
      const answer = await answerMissionControlQuestion(parsed.data.question, JSON.stringify(context));
      if (!answer) {
        return res.status(502).json({ error: "ИИ не смог ответить — попробуйте переформулировать вопрос" });
      }
      res.json({ answer });
    } catch (err) {
      void logSystemError("ai", `«Вопрос к данным» не отвечен: ${describeError(err)}`);
      res.status(502).json({ error: "Не удалось получить ответ — попробуйте ещё раз" });
    }
  }
);

const TICKER_LIMIT_CAP = 50;
const TICKER_LIMIT_DEFAULT = 30;

const tickerQuerySchema = z.object({
  before: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(TICKER_LIMIT_CAP).optional(),
});

/**
 * Живой тикер (план §6 п.6, «Ярус 4») — отдельный роут: опрашивается реже
 * шапки экрана (25с — план §0 предлагает 10с, но три источника (AuditLog +
 * Interaction + Client) на каждый тик — заметно дороже остальных секций
 * mission-control; 25с совпадает с глобальным интервалом опроса CRM
 * (`apps/web/src/lib/queryClient.ts:21`), разницу лента не почувствует, а
 * нагрузка на БД — вдвое-втрое меньше, чем при 10-15с). Гейт тот же —
 * `dashboard.analytics`: тикер живёт на том же экране, отдельного смысла
 * скрывать его от тех, кому открыт mission-control, нет.
 */
missionControlRouter.get(
  "/mission-control/ticker",
  requireAuth,
  requirePermission("dashboard.analytics"),
  async (req, res) => {
    const parsed = tickerQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ error: "Неверные параметры", details: parsed.error.flatten() });
    }
    if (!(await isPultModuleEnabled("ticker"))) {
      return res.json({ items: [], nextCursor: null });
    }
    const before = parsed.data.before ? new Date(parsed.data.before) : null;
    const limit = parsed.data.limit ?? TICKER_LIMIT_DEFAULT;
    const { items, nextCursor } = await loadMissionControlTicker(before, limit, can(req, "clients.viewPhone"));
    res.json({ items, nextCursor });
  }
);
