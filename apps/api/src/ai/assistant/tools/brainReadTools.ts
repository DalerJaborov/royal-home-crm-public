import { z } from "zod";
import { formatClientCode, formatClientName, RATED_ROLES, type PermissionId } from "@royal-home/shared";
import { prisma } from "../../../db.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import { availabilityOf } from "../../../lib/agentAvailability.js";
import { agentLoadCounts, NO_LOAD } from "../../../lib/agentLoad.js";
import { findStaffByName } from "../../../lib/agentNameLookup.js";
import { clientNamePhoneSafe, clientPhoneFor, phoneSafeText } from "../../../lib/clientPhone.js";
import { redactSecrets } from "../../../lib/redactSecrets.js";
import { withHiddenOrigin } from "../../../lib/clientOrigin.js";
import { runLimited } from "../../../lib/concurrency.js";
import { dushanbeDateString, dushanbeDateTimeString, dushanbeDayRange, dushanbeStartOfToday } from "../../../lib/dushanbeTime.js";
import { loadIntegrationHealthSnapshot } from "../../../lib/integrationHealthSnapshot.js";
import { visibleInteractionWhere } from "../../../lib/investigationPrivacy.js";
import { loadWeeklyLeaderboard } from "../../../lib/leaderboard.js";
import { buildAskContext } from "../../../lib/missionControlAsk.js";
import { loadShowingsToday } from "../../../lib/missionControlGaps.js";
import { loadMorningNumbers } from "../../../lib/morningNumbers.js";
import { noContactWhere } from "../../../lib/noContact.js";
import { findSilentAfterShowing } from "../../../lib/silentAfterShowing.js";
import { listStuckWork } from "../../../lib/stuckWork.js";
import { overdueTasksWhere } from "../../../lib/tasks.js";
import { missedWithoutCallbackIds } from "../../../lib/telephony/missedCallEscalation.js";
import { ownIncomingCallsOr } from "../../../lib/telephony/ownIncomingCalls.js";
import { assistantInvestigationRole, type AssistantActor } from "../actor.js";
import { dealLang, money, type DealLang } from "./dealToolSupport.js";
import { listMyTasksTool } from "./listMyTasks.js";
import { safeField } from "./safeField.js";
import type { AssistantReadToolPlugin } from "./types.js";

/**
 * «МОЗГ КОМПАНИИ» — ЧТЕНИЕ НА ЕЖЕДНЕВНЫЕ ВОПРОСЫ (17.11.2026, HANDOFF
 * docs/HANDOFF_2026-11-17-shabnam-brain.md, recon-gaps.md пункты 1, 2, 3, 4, 7, 10).
 *
 * Аудит 17.11: Шабнам почти не пользуются, а на простой вопрос она отвечала
 * неверно. Здесь шесть обзорных чтений, каждое — ТОНКАЯ ОБЁРТКА над той же
 * функцией, что рисует экран CRM (второй реализации правил нет):
 *  - get_day_snapshot — пульт и утренние числа (buildAskContext, loadMorningNumbers,
 *    loadShowingsToday), право экрана — dashboard.analytics, деньги — finance.view;
 *  - get_unworked — «Контроль руководителя» (overdueTasksWhere, noContactWhere,
 *    findSilentAfterShowing), dashboard.analytics; без него — только своё;
 *  - get_my_day — «мои дела»: list_my_tasks + свои непринятые заявки, свои
 *    пропущенные без перезвона и свои клиенты без контакта;
 *  - get_missed_calls — «Звонки → Входящие → Без перезвона» (missedWithoutCallbackIds):
 *    calls.transcripts — все, calls.ownTranscripts — только свои (ownIncomingCallsOr);
 *  - get_team_load — «Команда» (agentLoadCounts, team.viewFull) и рейтинг недели
 *    пульта (loadWeeklyLeaderboard, dashboard.analytics); без прав — своя нагрузка;
 *  - get_stuck_work — «Что не доехало» и «Интеграции» (listStuckWork, снимок
 *    самопроверки), auditLog.view.
 * Общее: только личка (в общей группе Telegram их скрывает GROUP_HIDDEN_TOOLS, а
 * здесь — вторая стена); каждый список ≤ 10 строк и счётчик «ещё N»; телефоны и
 * имена клиентов — через маски lib/clientPhone.ts; Корзина не показывается; время —
 * по Душанбе; готовый короткий текст на ru/tg — в поле display. Ничего не пишут и
 * никому не пишут сами: отвечают только на вопрос человека.
 */

const LIST_LIMIT = 10;
const DAY_MS = 24 * 60 * 60 * 1000;

const LANG_PROP = {
  type: "string",
  enum: ["ru", "tg"],
  description: "Язык, на котором пишет сотрудник: ru — русский, tg — таджикский",
} as const;

const GROUP_REFUSAL = { error: "Это — только в личном чате с Шабнам" };

const has = (actor: AssistantActor, permission: PermissionId) => actor.permissions?.has(permission) ?? false;
const inGroup = (actor: AssistantActor) => actor.surface === "telegram-group";
const tr = (lang: DealLang, ru: string, tg: string) => (lang === "tg" ? tg : ru);
const moreText = (lang: DealLang, more: number) => (more > 0 ? tr(lang, ` …и ещё ${more}`, ` …ва боз ${more}`) : "");

/**
 * findSilentAfterShowing фильтрует закрытые касания, только если ей передали роль:
 * `undefined` у неё значит «экран как есть, без фильтра». Помощнице нужен фильтр
 * всегда, кроме директора/админа с правом проверки, поэтому без права подставляется
 * роль, которой закрытое не видно.
 */
const PUBLIC_ONLY_ROLE = "AGENT";

type ClientRef = { shortId: number; kind: Parameters<typeof formatClientCode>[1]; fullName: string };

/** Клиент в ответе: номер карточки, имя под маской телефона и источника, ссылка. */
function clientView(c: ClientRef, actor: AssistantActor) {
  const canSeeOrigin = has(actor, "clients.viewOrigin");
  return {
    code: formatClientCode(c.shortId, c.kind),
    name: safeField(clientNamePhoneSafe(formatClientName(withHiddenOrigin(c, canSeeOrigin)), actor.canViewPhone), 120),
    href: `/clients/${c.shortId}`,
  };
}

async function agentNames(ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await prisma.agent.findMany({ where: { id: { in: ids } }, select: { id: true, fullName: true } });
  return new Map(rows.map((r) => [r.id, r.fullName]));
}

// ───────────────────────────── пропущенные без перезвона (общая часть) ─────────────────────────────

interface MissedCallRow {
  at: string;
  phone: string;
  client: ReturnType<typeof clientView> | null;
  callbackAgent: string | null;
}

/**
 * Окно «за N дней» — сутки по Душанбе, а не скользящие N×24 часа (17.11.2026): «за 1 день» — с начала
 * сегодняшних суток, «за N дней» — с начала суток N−1 дней назад. Скользящее окно в 03:00 теряло
 * вчерашний вечер и не совпадало с тем, как директор считает «сегодня».
 */
export function missedWindowStart(days: number, now: Date = new Date()): Date {
  return dushanbeStartOfToday(new Date(now.getTime() - (days - 1) * DAY_MS));
}

/** Период словами для ответа — как `period` у get_company_stats: «ГГГГ-ММ-ДД — ГГГГ-ММ-ДД» (даты по Душанбе). */
export function missedWindowLabel(days: number, now: Date = new Date()): string {
  const from = dushanbeDateString(missedWindowStart(days, now));
  const to = dushanbeDateString(now);
  return from === to ? to : `${from} — ${to}`;
}

async function loadMissedNoCallback(
  actor: AssistantActor,
  opts: { own: boolean; days: number },
): Promise<{ total: number; items: MissedCallRow[] }> {
  const since = missedWindowStart(opts.days);
  let scope: Prisma.IncomingCallWhereInput = {};
  if (opts.own) {
    const me = await prisma.agent.findUnique({ where: { id: actor.id }, select: { sipExtension: true } });
    scope = { OR: ownIncomingCallsOr(actor.id, me?.sipExtension) };
  }
  const ids = await missedWithoutCallbackIds(since, scope);
  if (ids.length === 0) return { total: 0, items: [] };
  // Звонок без карточки показываем (номер под маской), звонок клиента из Корзины — нет.
  const where: Prisma.IncomingCallWhereInput = { id: { in: ids }, OR: [{ clientId: null }, { client: { deletedAt: null } }] };
  const [rows, total] = await Promise.all([
    prisma.incomingCall.findMany({
      where,
      orderBy: [{ startedAt: "desc" }, { id: "desc" }],
      take: LIST_LIMIT,
      select: {
        id: true,
        phone: true,
        startedAt: true,
        client: { select: { shortId: true, kind: true, fullName: true } },
        callbackAgent: { select: { fullName: true } },
      },
    }),
    prisma.incomingCall.count({ where }),
  ]);
  return {
    total,
    items: rows.map((r) => ({
      at: dushanbeDateTimeString(r.startedAt),
      phone: clientPhoneFor(r.phone, actor.canViewPhone),
      client: r.client ? clientView(r.client, actor) : null,
      callbackAgent: r.callbackAgent?.fullName ?? null,
    })),
  };
}

// ───────────────────────────── get_day_snapshot ─────────────────────────────

const langOnlyArgs = z.object({ lang: z.enum(["ru", "tg"]).optional() });

export const getDaySnapshotTool: AssistantReadToolPlugin = {
  name: "get_day_snapshot",
  level: "A",
  statusPhrase: "Собираю картину дня…",
  description:
    "Руководству: снимок дня ВСЕЙ компании на сейчас — обращения за сегодня, звонки (входящие, пропущенные), показы на " +
    "сегодня, закрытые сделки, задачи на сегодня и просроченные, клиенты без контакта, пропущенные вчера без перезвона, " +
    "вчерашние итоги, объекты в продаже; комиссия месяца и прогноз — только тем, кому видны финансы. Зови на «что сегодня " +
    "горит», «как дела в компании», «сводка дня», «имрӯз дар ширкат чӣ гап», «вазъи имрӯза». Числа бери ровно из display. " +
    "За прошлый день или период — get_company_stats с датами; свои дела сотрудника — get_my_day.",
  parameters: { type: "object", properties: { lang: LANG_PROP } },
  allowed: (actor) => !inGroup(actor) && has(actor, "dashboard.analytics"),
  async run(raw, { actor, question }) {
    if (inGroup(actor)) return GROUP_REFUSAL;
    // Тот же гейт, что у пульта и «Вопроса к данным» (routes/dashboardMissionControl.ts).
    if (!has(actor, "dashboard.analytics")) {
      return { error: "Снимок всей компании видит руководство. Свои дела на сегодня покажу по просьбе «мои дела»." };
    }
    const parsed = langOnlyArgs.safeParse(raw ?? {});
    const lang = dealLang(parsed.success ? parsed.data.lang : undefined, question);
    const now = new Date();
    const seesMoney = actor.canViewFinance;
    const viewerRole = assistantInvestigationRole(actor);
    const day = dushanbeDayRange(now);
    // Волнами, а не одним Promise.all: buildAskContext и loadMorningNumbers сами держат
    // по десятку запросов разом, вместе они выели бы пул соединений (см. oversight.ts).
    const ask = await buildAskContext(seesMoney, now);
    const morning = await loadMorningNumbers();
    const [showings, overdueTasks, noContactClients, dealsToday] = await Promise.all([
      loadShowingsToday(now, viewerRole),
      prisma.interaction.count({ where: { ...overdueTasksWhere(now), ...visibleInteractionWhere(viewerRole) } }),
      prisma.client.count({ where: noContactWhere(now) }),
      // То же условие «сделка закрыта», что у вчерашнего числа утренней сводки (morningNumbers.ts).
      prisma.deal.count({ where: { stage: "COMPLETED", closedAt: { gte: day.start, lt: day.end } } }),
    ]);

    const finance = seesMoney
      ? {
          commissionMonthTJS: ask.finance?.commissionMonthFactTjs ?? morning.commissionMonth,
          planTJS: ask.finance?.commissionMonthPlanTjs ?? null,
          forecastEndOfMonthTJS: ask.finance?.forecastEndOfMonthTjs ?? null,
          forecastPercent: ask.finance?.forecastPercent ?? null,
        }
      : null;
    const date = dushanbeDateString(now);
    const display = [
      tr(lang, `📊 Сегодня ${date} — вся компания`, `📊 Имрӯз ${date} — тамоми ширкат`),
      tr(lang, `📥 Новых обращений: ${ask.leadsToday}`, `📥 Муроҷиатҳои нав: ${ask.leadsToday}`),
      tr(
        lang,
        `📞 Входящих звонков: ${ask.callsToday.incoming}, пропущено: ${ask.callsToday.missed}`,
        `📞 Зангҳои воридотӣ: ${ask.callsToday.incoming}, ҷавобнагирифта: ${ask.callsToday.missed}`,
      ),
      tr(
        lang,
        `🏠 Показов на сегодня: ${showings.count} (подтвердили ${showings.confirmed})`,
        `🏠 Намоишҳои имрӯза: ${showings.count} (тасдиқ карданд ${showings.confirmed})`,
      ),
      tr(lang, `🤝 Сделок закрыто сегодня: ${dealsToday}`, `🤝 Муомилаҳои имрӯз басташуда: ${dealsToday}`),
      tr(
        lang,
        `⏰ Задач на сегодня: ${morning.tasksToday} · просрочено: ${overdueTasks}`,
        `⏰ Корҳои имрӯза: ${morning.tasksToday} · мӯҳлаташ гузашта: ${overdueTasks}`,
      ),
      tr(lang, `📵 Клиентов без контакта: ${noContactClients}`, `📵 Мизоҷони бе тамос: ${noContactClients}`),
      morning.missedCallsNoCallbackYesterday > 0
        ? tr(
            lang,
            `☎️ Вчера пропущено и не перезвонили: ${morning.missedCallsNoCallbackYesterday}`,
            `☎️ Дирӯз ҷавоб нагирифта, бозанг нашуд: ${morning.missedCallsNoCallbackYesterday}`,
          )
        : null,
      tr(
        lang,
        `📅 Вчера: обращений ${morning.leadsYesterday}, сделок ${morning.dealsYesterday}`,
        `📅 Дирӯз: муроҷиат ${morning.leadsYesterday}, муомила ${morning.dealsYesterday}`,
      ),
      finance
        ? tr(lang, `💰 Комиссия за месяц: ${money(finance.commissionMonthTJS, "TJS", lang)}`, `💰 Комиссияи моҳ: ${money(finance.commissionMonthTJS, "TJS", lang)}`) +
          (finance.forecastPercent !== null
            ? tr(lang, ` · прогноз ${finance.forecastPercent}% плана`, ` · пешгӯӣ ${finance.forecastPercent}% нақша`)
            : "")
        : null,
    ].filter(Boolean).join("\n");

    return {
      scope: "вся компания",
      date,
      today: {
        newLeads: ask.leadsToday,
        calls: ask.callsToday,
        showings: { planned: showings.count, confirmed: showings.confirmed },
        dealsClosed: dealsToday,
        tasksDue: morning.tasksToday,
      },
      attention: {
        overdueTasks,
        noContactClients,
        missedCallsNoCallbackYesterday: morning.missedCallsNoCallbackYesterday,
        callsAwaitingReview: morning.unqualifiedNow,
        showingSummariesOverdue48h: morning.showingSummariesOverdue48h,
      },
      yesterday: {
        newLeads: morning.leadsYesterday,
        dealsClosed: morning.dealsYesterday,
        incomingCalls: morning.incomingYesterday,
        missedCalls: morning.missedYesterday,
        firstResponseMedianMin: morning.firstTouchMedianMin,
        leadsWithoutFirstContact: morning.firstTouchNoneCount,
      },
      properties: {
        available: ask.properties.available,
        reserved: ask.properties.reserved,
        ...(seesMoney ? { portfolioValueTJS: ask.properties.portfolioValueTjs } : {}),
      },
      system: ask.system,
      ...(finance ? { finance } : { finance: "Суммы вам не показываются" }),
      display,
    };
  },
};

// ───────────────────────────── get_unworked ─────────────────────────────

const unworkedArgs = z.object({
  agent: z.string().trim().min(2).max(80).optional(),
  lang: z.enum(["ru", "tg"]).optional(),
});

type Tally = { overdue: number; noContact: number; silent: number };

export const getUnworkedTool: AssistantReadToolPlugin = {
  name: "get_unworked",
  level: "A",
  statusPhrase: "Смотрю, что не отработано…",
  description:
    "Кто не отработал: просроченные задачи, клиенты без контакта (ни разговора, ни сообщения клиента дольше порога), " +
    "«тишина после показа». Руководству — по всей компании с разбивкой по сотрудникам (agent — имя, чтобы сузить до " +
    "одного); рядовому сотруднику — только его собственное. Зови на «кто не отработал», «кому не звонили», «просрочки у " +
    "Фарруха», «кӣ кор накард», «ба кӣ занг назаданд», «корҳои мӯҳлаташ гузашта». Числа — ровно из display, подробные " +
    "строки — из списков overdueTasks / noContact / silentAfterShowing (по 10, остальное — в CRM, «Контроль»).",
  parameters: {
    type: "object",
    properties: {
      agent: { type: "string", description: "Имя сотрудника, чтобы показать только его (для руководства)" },
      lang: LANG_PROP,
    },
  },
  allowed: (actor) => !inGroup(actor),
  async run(raw, { actor, question }) {
    if (inGroup(actor)) return GROUP_REFUSAL;
    const parsed = unworkedArgs.safeParse(raw ?? {});
    if (!parsed.success) return { error: "Не понял, про кого. Назовите сотрудника полностью или спросите про всех." };
    const lang = dealLang(parsed.data.lang, question);
    // Экран «Контроль руководителя» открыт правом dashboard.analytics (routes/oversight.ts);
    // без него — только своё, как get_company_stats у агента.
    const leader = has(actor, "dashboard.analytics");
    let scopeAgentId: string | null = leader ? null : actor.id;
    let scopeLabel = leader ? tr(lang, "вся компания", "тамоми ширкат") : tr(lang, "только ваше", "танҳо аз они шумо");
    if (leader && parsed.data.agent) {
      const match = await findStaffByName(parsed.data.agent);
      if (match.kind === "none") return { error: `Сотрудник «${parsed.data.agent}» не найден` };
      if (match.kind === "many") {
        return { needChoice: true, candidates: match.candidates.map((c) => c.fullName), note: "Уточните, о ком речь" };
      }
      scopeAgentId = match.agent.id;
      scopeLabel = match.agent.fullName;
    }

    const now = new Date();
    const viewerRole = assistantInvestigationRole(actor);
    const overdueWhere: Prisma.InteractionWhereInput = {
      ...overdueTasksWhere(now),
      ...visibleInteractionWhere(viewerRole),
      // Как карточка сотрудника (routes/team.ts): задача, заведённая ботом от его имени, — тоже его.
      ...(scopeAgentId ? { OR: [{ agentId: scopeAgentId }, { subjectAgentId: scopeAgentId }] } : {}),
    };
    const noContact: Prisma.ClientWhereInput = scopeAgentId
      ? { AND: [noContactWhere(now), { assignedAgentId: scopeAgentId }] }
      : noContactWhere(now);
    const overview = scopeAgentId === null;

    const [overdueRows, overdueTotal, overdueGroups, noContactRows, noContactTotal, noContactGroups, silent] = await runLimited(
      [
        () =>
          prisma.interaction.findMany({
            where: overdueWhere,
            orderBy: [{ nextActionDate: "asc" }, { id: "asc" }],
            take: LIST_LIMIT,
            select: {
              id: true,
              nextAction: true,
              nextActionDate: true,
              client: { select: { shortId: true, kind: true, fullName: true } },
              agent: { select: { fullName: true } },
              subjectAgent: { select: { fullName: true } },
            },
          }),
        () => prisma.interaction.count({ where: overdueWhere }),
        () => prisma.interaction.groupBy({ by: ["agentId", "subjectAgentId"], where: overdueWhere, _count: { _all: true } }),
        () =>
          prisma.client.findMany({
            where: noContact,
            // Самые давно молчащие первыми — порядок пульта (routes/dashboardMissionControl.ts).
            orderBy: [{ lastClientMessageAt: { sort: "asc", nulls: "first" } }, { createdAt: "asc" }],
            take: LIST_LIMIT,
            select: {
              shortId: true,
              kind: true,
              fullName: true,
              lastClientMessageAt: true,
              assignedAgent: { select: { fullName: true } },
            },
          }),
        () => prisma.client.count({ where: noContact }),
        () => prisma.client.groupBy({ by: ["assignedAgentId"], where: noContact, _count: { _all: true } }),
        () => findSilentAfterShowing(now, viewerRole ?? PUBLIC_ONLY_ROLE),
      ],
      4,
    );

    const silentItems = silent.items.filter((c) => (scopeAgentId ? c.assignedAgent?.id === scopeAgentId : true));
    const silentShown = silentItems.slice(0, LIST_LIMIT);
    // В выборке «тишины» нет вида карточки — без него номер продавца вышел бы «ПК».
    const kindRows: { id: string; kind: ClientRef["kind"] }[] = silentShown.length
      ? await prisma.client.findMany({ where: { id: { in: silentShown.map((c) => c.id) } }, select: { id: true, kind: true } })
      : [];
    const silentKinds = new Map(kindRows.map((c) => [c.id, c.kind]));

    const tally = new Map<string, Tally>();
    const bump = (id: string | null | undefined, key: keyof Tally, n: number) => {
      if (!id) return;
      const t = tally.get(id) ?? { overdue: 0, noContact: 0, silent: 0 };
      t[key] += n;
      tally.set(id, t);
    };
    if (overview) {
      // Держатель задачи — как в «Команде» (routes/team.ts): автор, иначе сотрудник, от чьего имени запись.
      for (const g of overdueGroups) bump(g.agentId ?? g.subjectAgentId, "overdue", g._count._all);
      for (const g of noContactGroups) bump(g.assignedAgentId, "noContact", g._count._all);
      for (const c of silentItems) bump(c.assignedAgent?.id, "silent", 1);
    }
    const ranked = [...tally.entries()].sort(
      ([, a], [, b]) => b.overdue + b.noContact + b.silent - (a.overdue + a.noContact + a.silent),
    );
    const names = await agentNames(ranked.slice(0, LIST_LIMIT).map(([id]) => id));
    const byAgent = ranked.slice(0, LIST_LIMIT).map(([id, t]) => ({
      agent: names.get(id) ?? "—",
      overdueTasks: t.overdue,
      noContact: t.noContact,
      silentAfterShowing: t.silent,
    }));

    const counts = { overdueTasks: overdueTotal, noContact: noContactTotal, silentAfterShowing: silentItems.length };
    const display = [
      tr(lang, `🔴 Кто не отработал — ${scopeLabel}`, `🔴 Кӣ кор накард — ${scopeLabel}`),
      tr(lang, `⏰ Просроченные задачи: ${counts.overdueTasks}`, `⏰ Корҳои мӯҳлаташ гузашта: ${counts.overdueTasks}`),
      tr(lang, `📵 Клиенты без контакта: ${counts.noContact}`, `📵 Мизоҷони бе тамос: ${counts.noContact}`),
      tr(
        lang,
        `🤐 Тишина после показа (дольше ${silent.days} дн.): ${counts.silentAfterShowing}`,
        `🤐 Хомӯшӣ баъди намоиш (зиёда аз ${silent.days} рӯз): ${counts.silentAfterShowing}`,
      ),
      ...(byAgent.length
        ? [
            tr(lang, "По сотрудникам:", "Аз рӯи кормандон:"),
            ...byAgent.map((a) => `👤 ${a.agent}: ⏰ ${a.overdueTasks} · 📵 ${a.noContact} · 🤐 ${a.silentAfterShowing}`),
            ...(ranked.length > LIST_LIMIT ? [moreText(lang, ranked.length - LIST_LIMIT).trim()] : []),
          ]
        : []),
      counts.overdueTasks + counts.noContact + counts.silentAfterShowing === 0
        ? tr(lang, "✅ Всё отработано.", "✅ Ҳама кор иҷро шудааст.")
        : null,
    ].filter(Boolean).join("\n");

    return {
      scope: scopeLabel,
      counts,
      silentAfterShowingDays: silent.days,
      ...(overview ? { byAgent } : {}),
      overdueTasks: overdueRows.map((r) => ({
        interactionId: r.id,
        due: r.nextActionDate ? dushanbeDateTimeString(r.nextActionDate) : null,
        text: safeField(phoneSafeText(r.nextAction, actor.canViewPhone), 160),
        client: clientView(r.client, actor),
        agent: (r.agent ?? r.subjectAgent)?.fullName ?? null,
      })),
      noContact: noContactRows.map((c) => ({
        client: clientView(c, actor),
        lastClientMessage: c.lastClientMessageAt ? dushanbeDateString(c.lastClientMessageAt) : null,
        agent: c.assignedAgent?.fullName ?? null,
      })),
      silentAfterShowing: silentShown.map((c) => ({
        client: clientView({ shortId: c.shortId, kind: silentKinds.get(c.id) ?? null, fullName: c.fullName }, actor),
        lastContact: c.lastContactAt ? dushanbeDateString(c.lastContactAt) : null,
        agent: c.assignedAgent?.fullName ?? null,
      })),
      more: {
        overdueTasks: Math.max(0, overdueTotal - LIST_LIMIT),
        noContact: Math.max(0, noContactTotal - LIST_LIMIT),
        silentAfterShowing: Math.max(0, silentItems.length - LIST_LIMIT),
      },
      href: "/oversight",
      display,
    };
  },
};

// ───────────────────────────── get_my_day ─────────────────────────────

interface MyTaskRow {
  interactionId: string;
  kind: "showing" | "task";
  date: string | null;
  time: string | null;
  done: boolean;
  text: string | null;
  client: { name: string | null; href: string };
  property: { title: string | null; href: string } | null;
}
type MyTasksResult = { tasks: MyTaskRow[]; overdue: MyTaskRow[] } | { error: string };

export const getMyDayTool: AssistantReadToolPlugin = {
  name: "get_my_day",
  level: "A",
  statusPhrase: "Собираю ваши дела на сегодня…",
  description:
    "Мои дела сегодня одной сводкой — САМОМУ сотруднику, который спрашивает: задачи и показы на сегодня, просроченные, " +
    "новые заявки, которые он ещё не принял, его пропущенные звонки без перезвона за 3 дня и сколько его клиентов без " +
    "контакта. Зови на «что у меня сегодня», «мои дела», «с чего начать день», «имрӯз чӣ кор дорам», «корҳои ман», " +
    "«имрӯз ба ман чӣ кор аст». Числа — ровно из display. Конкретный другой день — list_my_tasks с датой; чужие дела " +
    "этот инструмент не показывает.",
  parameters: { type: "object", properties: { lang: LANG_PROP } },
  allowed: (actor) => !inGroup(actor),
  async run(raw, { actor, question }) {
    if (inGroup(actor)) return GROUP_REFUSAL;
    const parsed = langOnlyArgs.safeParse(raw ?? {});
    const lang = dealLang(parsed.success ? parsed.data.lang : undefined, question);
    const now = new Date();
    // Непринятая заявка — то же условие, что охраняет «Принять» (lib/leadAccept.ts).
    const unacceptedWhere: Prisma.ClientWhereInput = {
      assignedAgentId: actor.id,
      acceptedAt: null,
      deletedAt: null,
      assignmentCompletedAt: null,
    };
    // Свои звонки видит тот, кому открыт раздел «Звонки» (routes/calls.ts) — хоть своими.
    const seesCalls = has(actor, "calls.transcripts") || has(actor, "calls.ownTranscripts");
    const [tasksRaw, unaccepted, unacceptedTotal, noContactTotal, missed] = await runLimited(
      [
        // Задачи и показы — сам list_my_tasks, а не вторая выборка.
        () => listMyTasksTool.run({}, { actor, question }),
        () =>
          prisma.client.findMany({
            where: unacceptedWhere,
            orderBy: [{ assignedAt: "asc" }, { id: "asc" }],
            take: LIST_LIMIT,
            select: { shortId: true, kind: true, fullName: true, assignedAt: true },
          }),
        () => prisma.client.count({ where: unacceptedWhere }),
        () => prisma.client.count({ where: { AND: [noContactWhere(now), { assignedAgentId: actor.id }] } }),
        async () => (seesCalls ? await loadMissedNoCallback(actor, { own: true, days: 3 }) : null),
      ],
      3,
    );
    const tasks = tasksRaw as MyTasksResult;
    if ("error" in tasks) return { error: tasks.error };

    const open = tasks.tasks.filter((t) => !t.done);
    const todayTasks = open.filter((t) => t.kind === "task");
    const showings = open.filter((t) => t.kind === "showing");
    const overdue = tasks.overdue;
    // list_my_tasks отдаёт до 20 строк на список (MAX_ITEMS): на пределе честно «N+».
    const dayCapped = tasks.tasks.length >= 20;
    const overdueCapped = tasks.overdue.length >= 20;
    const capped = (list: unknown[], atCap: boolean) => `${list.length}${atCap ? "+" : ""}`;

    const display = [
      tr(lang, "📋 Ваши дела на сегодня", "📋 Корҳои шумо барои имрӯз"),
      tr(lang, `🏠 Показы: ${showings.length}`, `🏠 Намоишҳо: ${showings.length}`),
      tr(lang, `✅ Задачи: ${capped(todayTasks, dayCapped)}`, `✅ Корҳо: ${capped(todayTasks, dayCapped)}`),
      overdue.length
        ? tr(lang, `⏰ Просрочено: ${capped(overdue, overdueCapped)}`, `⏰ Мӯҳлаташ гузашта: ${capped(overdue, overdueCapped)}`)
        : null,
      unacceptedTotal
        ? tr(lang, `📥 Новые заявки, ждут «Принять»: ${unacceptedTotal}`, `📥 Дархостҳои нав, интизори «Қабул»: ${unacceptedTotal}`)
        : null,
      missed && missed.total
        ? tr(lang, `☎️ Пропущенные без перезвона: ${missed.total}`, `☎️ Зангҳои ҷавобнагирифта, бе бозанг: ${missed.total}`)
        : null,
      noContactTotal
        ? tr(lang, `📵 Ваши клиенты без контакта: ${noContactTotal}`, `📵 Мизоҷони шумо бе тамос: ${noContactTotal}`)
        : null,
      showings.length + todayTasks.length + overdue.length + unacceptedTotal + (missed?.total ?? 0) === 0
        ? tr(lang, "На сегодня дел нет.", "Барои имрӯз кор нест.")
        : null,
    ].filter(Boolean).join("\n");

    return {
      scope: "только ваше",
      date: dushanbeDateString(now),
      counts: {
        showings: showings.length,
        tasks: todayTasks.length,
        overdue: overdue.length,
        unacceptedLeads: unacceptedTotal,
        missedCallsNoCallback: missed?.total ?? null,
        noContactClients: noContactTotal,
      },
      showings: showings.slice(0, LIST_LIMIT),
      tasks: todayTasks.slice(0, LIST_LIMIT),
      overdue: overdue.slice(0, LIST_LIMIT),
      unacceptedLeads: unaccepted.map((c) => ({
        client: clientView(c, actor),
        assignedAt: c.assignedAt ? dushanbeDateTimeString(c.assignedAt) : null,
      })),
      missedCalls: missed?.items ?? [],
      more: {
        tasks: Math.max(0, todayTasks.length - LIST_LIMIT),
        overdue: Math.max(0, overdue.length - LIST_LIMIT),
        unacceptedLeads: Math.max(0, unacceptedTotal - LIST_LIMIT),
        missedCalls: Math.max(0, (missed?.total ?? 0) - LIST_LIMIT),
      },
      display,
    };
  },
};

// ───────────────────────────── get_missed_calls ─────────────────────────────

const missedArgs = z.object({
  days: z.coerce.number().int().min(1).max(30).optional(),
  // Модель иногда шлёт флаг строкой — «true»/«false» понимаем так же.
  mine: z.union([z.boolean(), z.enum(["true", "false"])]).optional(),
  lang: z.enum(["ru", "tg"]).optional(),
});

export const getMissedCallsTool: AssistantReadToolPlugin = {
  name: "get_missed_calls",
  level: "A",
  statusPhrase: "Смотрю пропущенные звонки…",
  description:
    "Пропущенные входящие звонки, по которым ещё НЕ перезвонили (ни звонка, ни сообщения клиенту после пропуска). " +
    "Руководству с доступом ко всем звонкам — по всей компании (mine=true — только свои), остальным — только звонки " +
    "своих клиентов и назначенные им на перезвон. days — за сколько суток по Душанбе (1 = только сегодня; по умолчанию 7, до 30). Зови на «кто звонил и " +
    "не дождался», «пропущенные без перезвона», «кому перезвонить», «зангҳои ҷавобнагирифта», «ба кӣ бозанг занам». " +
    "Числа — ровно из display; строки — из items (до 10).",
  parameters: {
    type: "object",
    properties: {
      days: { type: "number", description: "Окно в сутках по Душанбе, 1–30 (1 = с начала сегодняшних суток); по умолчанию 7" },
      mine: { type: "boolean", description: "Только мои звонки, даже если видно все" },
      lang: LANG_PROP,
    },
  },
  allowed: (actor) => !inGroup(actor) && (has(actor, "calls.transcripts") || has(actor, "calls.ownTranscripts")),
  async run(raw, { actor, question }) {
    if (inGroup(actor)) return GROUP_REFUSAL;
    const seesAll = has(actor, "calls.transcripts");
    // Раздел «Звонки» открыт одним из двух прав (routes/calls.ts, callsRouter.use).
    if (!seesAll && !has(actor, "calls.ownTranscripts")) return { error: "Раздел «Звонки» вам не открыт" };
    const parsed = missedArgs.safeParse(raw ?? {});
    if (!parsed.success) return { error: "Не понял параметры: окно — от 1 до 30 дней" };
    const lang = dealLang(parsed.data.lang, question);
    const days = parsed.data.days ?? 7;
    const own = !seesAll || parsed.data.mine === true || parsed.data.mine === "true";
    const { total, items } = await loadMissedNoCallback(actor, { own, days });
    const display = [
      tr(
        lang,
        `☎️ Пропущенные без перезвона за ${missedWindowLabel(days)} (${own ? "ваши" : "вся компания"}): ${total}`,
        `☎️ Зангҳои ҷавобнагирифта, бе бозанг, дар ${missedWindowLabel(days)} (${own ? "аз они шумо" : "тамоми ширкат"}): ${total}`,
      ),
      ...items.map((i) => `• ${i.at} — ${i.client ? i.client.code : i.phone}${i.callbackAgent ? ` → ${i.callbackAgent}` : ""}`),
      total > items.length ? moreText(lang, total - items.length).trim() : null,
    ].filter(Boolean).join("\n");
    return {
      scope: own ? "только ваши" : "вся компания",
      days,
      period: missedWindowLabel(days),
      total,
      items,
      more: Math.max(0, total - items.length),
      href: "/calls",
      display,
    };
  },
};

// ───────────────────────────── get_team_load ─────────────────────────────

export const getTeamLoadTool: AssistantReadToolPlugin = {
  name: "get_team_load",
  level: "A",
  statusPhrase: "Смотрю нагрузку команды…",
  description:
    "Нагрузка команды и рейтинг недели. Нагрузка — сколько покупателей у каждого агента в работе (из них по своим " +
    "объектам), сколько его клиентов без контакта, пауза заявок или отсутствие; руководству видна вся команда, " +
    "рядовому сотруднику — только своя нагрузка. Рейтинг недели (баллы за 7 дней, топ-5) — тем, кому открыт пульт. " +
    "Зови на «кто перегружен», «у кого сколько клиентов», «рейтинг недели», «кӣ бештар кор дорад», «рейтинги ҳафта». " +
    "Числа — ровно из display.",
  parameters: { type: "object", properties: { lang: LANG_PROP } },
  allowed: (actor) => !inGroup(actor),
  async run(raw, { actor, question }) {
    if (inGroup(actor)) return GROUP_REFUSAL;
    const parsed = langOnlyArgs.safeParse(raw ?? {});
    const lang = dealLang(parsed.success ? parsed.data.lang : undefined, question);
    const canTeam = has(actor, "team.viewFull"); // экран «Команда» (routes/team.ts)
    const canBoard = has(actor, "dashboard.analytics"); // рейтинг недели на пульте
    const now = new Date();

    if (!canTeam) {
      const [load, noContact, board] = await Promise.all([
        agentLoadCounts([actor.id]),
        prisma.client.count({ where: { AND: [noContactWhere(now), { assignedAgentId: actor.id }] } }),
        canBoard ? loadWeeklyLeaderboard(now) : Promise.resolve(null),
      ]);
      const mine = load.get(actor.id) ?? NO_LOAD;
      const display = [
        tr(
          lang,
          `👤 Ваша нагрузка: ${mine.total} покупателей в работе (по своим объектам ${mine.own}), без контакта ${noContact}`,
          `👤 Сарбории шумо: ${mine.total} харидор дар кор (аз рӯи объектҳои худ ${mine.own}), бе тамос ${noContact}`,
        ),
        ...(board ? leaderboardLines(board, lang) : []),
      ].join("\n");
      return {
        scope: "только ваша нагрузка",
        you: { buyersInWork: mine.total, ownPropertyBuyers: mine.own, noContact },
        ...(board ? { leaderboard: board.map((b) => ({ place: b.place, agent: b.fullName, score: b.score })) } : {}),
        display,
      };
    }

    // Тот же состав, что у «Команды»: работающие агенты (RATED_ROLES), без удалённых учёток.
    const agents = await prisma.agent.findMany({
      where: { role: { in: [...RATED_ROLES] }, isActive: true, NOT: { phone: { contains: "-deleted:" } } },
      select: { id: true, fullName: true, frozenAt: true, leadsPausedUntil: true },
      orderBy: { fullName: "asc" },
      take: 200,
    });
    const ids = agents.map((a) => a.id);
    const [load, noContactGroups, board] = await Promise.all([
      agentLoadCounts(ids),
      prisma.client.groupBy({
        by: ["assignedAgentId"],
        // «Без контакта» по агентам — тот же разрез, что у «Вопроса к данным» (lib/missionControlAsk.ts).
        where: { AND: [noContactWhere(now), { assignedAgentId: { in: ids } }] },
        _count: { _all: true },
      }),
      canBoard ? loadWeeklyLeaderboard(now) : Promise.resolve(null),
    ]);
    const noContactBy = new Map(noContactGroups.map((g) => [g.assignedAgentId, g._count._all]));
    const rows = agents
      .map((a) => {
        const l = load.get(a.id) ?? NO_LOAD;
        const availability = availabilityOf(a, now);
        return {
          agent: a.fullName,
          buyersInWork: l.total,
          ownPropertyBuyers: l.own,
          noContact: noContactBy.get(a.id) ?? 0,
          status: availability.frozen
            ? tr(lang, "❄️ отсутствует", "❄️ дар ҷой нест")
            : availability.pausedUntil
              ? tr(lang, `⏸ пауза заявок до ${dushanbeDateTimeString(availability.pausedUntil)}`, `⏸ таваққуфи дархостҳо то ${dushanbeDateTimeString(availability.pausedUntil)}`)
              : null,
        };
      })
      .sort((a, b) => b.buyersInWork - a.buyersInWork || a.agent.localeCompare(b.agent, "ru"));
    const shown = rows.slice(0, LIST_LIMIT);
    const display = [
      tr(lang, "👥 Нагрузка команды (покупатели в работе):", "👥 Сарбории даста (харидорон дар кор):"),
      ...shown.map(
        (r) =>
          `👤 ${r.agent} — ${r.buyersInWork}` +
          tr(lang, ` · без контакта ${r.noContact}`, ` · бе тамос ${r.noContact}`) +
          (r.status ? ` · ${r.status}` : ""),
      ),
      rows.length > shown.length ? moreText(lang, rows.length - shown.length).trim() : null,
      ...(board ? leaderboardLines(board, lang) : []),
    ].filter(Boolean).join("\n");
    return {
      scope: "вся команда",
      agents: shown,
      more: Math.max(0, rows.length - shown.length),
      ...(board ? { leaderboard: board.map((b) => ({ place: b.place, agent: b.fullName, score: b.score })) } : {}),
      href: "/team",
      display,
    };
  },
};

function leaderboardLines(board: { place: number; fullName: string; score: number }[], lang: DealLang): string[] {
  if (board.length === 0) return [tr(lang, "🏆 Рейтинг недели: баллов пока нет.", "🏆 Рейтинги ҳафта: ҳоло хол нест.")];
  return [
    tr(lang, "🏆 Рейтинг недели:", "🏆 Рейтинги ҳафта:"),
    ...board.map((b) => `${b.place}. ${b.fullName} — ${b.score}`),
  ];
}

// ───────────────────────────── get_stuck_work ─────────────────────────────

export const getStuckWorkTool: AssistantReadToolPlugin = {
  name: "get_stuck_work",
  level: "A",
  statusPhrase: "Проверяю, что не доехало…",
  description:
    "Что CRM не смогла сделать сама и ждёт человека: задания, исчерпавшие попытки за 14 дней, и зависшие сейчас " +
    "(экран «Что не доехало»), плюс сломанные внешние доступы по ночной самопроверке (Gemini, Meta, Telegram, R2, сайт). " +
    "Зови на «что сломалось», «что не доехало», «всё ли работает», «чӣ вайрон шуд», «чӣ кор накард», «ҳама кор мекунад?». " +
    "Числа — ровно из display. Повторить задание можно только в CRM.",
  parameters: { type: "object", properties: { lang: LANG_PROP } },
  allowed: (actor) => !inGroup(actor) && has(actor, "auditLog.view"),
  async run(raw, { actor, question }) {
    if (inGroup(actor)) return GROUP_REFUSAL;
    // Тот же гейт, что у экранов «Что не доехало» и «Интеграции» (routes/stuckWork.ts, routes/integrations.ts).
    if (!has(actor, "auditLog.view")) return { error: "Сбои и зависшие задания видит руководство (право «Журнал действий и ошибок»)" };
    const parsed = langOnlyArgs.safeParse(raw ?? {});
    const lang = dealLang(parsed.success ? parsed.data.lang : undefined, question);
    const [queue, snapshot] = await Promise.all([
      // includePrivate — как у маршрута: директор/админ с правом проверки.
      listStuckWork({ givenUpLimit: LIST_LIMIT, includePrivate: assistantInvestigationRole(actor) !== undefined }),
      loadIntegrationHealthSnapshot(),
    ]);
    const item = (i: (typeof queue.givenUp)[number]) => ({
      what: safeField(phoneSafeText(i.label, actor.canViewPhone), 160),
      type: i.typeLabel,
      status: i.status,
      owner: i.ownerAgentName,
      attempts: `${i.attempts}/${i.maxAttempts}`,
      lastError: safeField(phoneSafeText(redactSecrets(i.lastError), actor.canViewPhone), 200),
      updatedAt: dushanbeDateTimeString(i.updatedAt),
    });
    const broken = snapshot.filter((r) => r.ok === false);
    const checkedAt = snapshot.length ? new Date(Math.max(...snapshot.map((r) => r.checkedAt.getTime()))) : null;
    const display = [
      tr(lang, `⚠️ Не доехало за 14 дней: ${queue.counts.givenUp}`, `⚠️ Дар 14 рӯз иҷро нашуд: ${queue.counts.givenUp}`),
      tr(lang, `⏳ Зависло сейчас: ${queue.counts.hanging}`, `⏳ Ҳозир овезон: ${queue.counts.hanging}`),
      checkedAt === null
        ? tr(lang, "🔌 Самопроверки доступов ещё не было — данных нет.", "🔌 Санҷиши дастрасӣ ҳанӯз нашудааст — маълумот нест.")
        : broken.length
          ? tr(lang, `🔌 Сломаны доступы: ${broken.map((b) => b.name).join(", ")}`, `🔌 Дастрасиҳои вайрон: ${broken.map((b) => b.name).join(", ")}`)
          : tr(lang, "🔌 Внешние доступы в порядке.", "🔌 Дастрасиҳои берунӣ дар тартибанд."),
    ].join("\n");
    return {
      counts: queue.counts,
      givenUp: queue.givenUp.slice(0, LIST_LIMIT).map(item),
      hanging: queue.hanging.slice(0, LIST_LIMIT).map(item),
      more: {
        givenUp: Math.max(0, queue.counts.givenUp - Math.min(queue.givenUp.length, LIST_LIMIT)),
        hanging: Math.max(0, queue.counts.hanging - Math.min(queue.hanging.length, LIST_LIMIT)),
      },
      integrations: {
        checkedAt: checkedAt ? dushanbeDateTimeString(checkedAt) : null,
        broken: broken.map((b) => ({ name: b.name, detail: safeField(redactSecrets(b.detail), 160) })),
        alive: snapshot.filter((r) => r.ok === true).length,
        notConfigured: snapshot.filter((r) => r.ok === null).length,
      },
      href: "/stuck-work",
      display,
    };
  },
};

export const brainReadTools: readonly AssistantReadToolPlugin[] = [
  getDaySnapshotTool,
  getUnworkedTool,
  getMyDayTool,
  getMissedCallsTool,
  getTeamLoadTool,
  getStuckWorkTool,
];
