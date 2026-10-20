/**
 * Аудит ГОРИЗОНТАЛЬНОГО переполнения на телефоне (жалоба владельца 10.09.2026:
 * «заходишь, и оно немножко увеличено, потом надо делать назад»; на его кадре
 * в нижней панели у пункта «Ещё» видна только первая буква).
 *
 * Механика жалобы: настройки документа верные
 * (`width=device-width, initial-scale=1`), значит страница шире экрана из-за
 * разметки. Нижняя панель — `position: fixed; left:0; right:0`, её ширина равна
 * ширине начального содержащего блока, то есть ширине экрана; но когда страницу
 * можно прокрутить вбок, пользователь её и прокручивает, и панель уезжает
 * влево вместе со всем остальным — правый пункт обрезается краем экрана.
 * Поэтому чинить надо не панель, а переполнение.
 *
 * Что делает скрипт:
 *   1. открывает КАЖДЫЙ маршрут приложения на 390 / 360 / 320 в обеих темах;
 *   2. меряет `documentElement.scrollWidth - clientWidth` (лишние пиксели) и
 *      то же самое у внутреннего контейнера прокрутки `.rh2 .scr`;
 *   3. обходит DOM и собирает узлы, чей `getBoundingClientRect().right`
 *      выходит за ширину окна (или `left < 0`), отбрасывая потомков уже
 *      найденного виновника и содержимое законных горизонтальных скроллеров —
 *      иначе список забивается детьми одной и той же ленты;
 *   4. для каждого виновника снимает вычисленные стили, по которым обычно и
 *      видно причину (ширина в px, `min-width`, `100vw`, отрицательный отступ).
 *
 * Почему фикстуры, а не настоящий стенд: сгенерированный клиент Prisma и
 * `packages/shared/dist` лежат в ОБЩИХ node_modules (CLAUDE.md, «Артефакты
 * сборки»), базу из worktree поднимать нельзя. Здесь работает только фронтенд
 * на dev-сервере vite, API подменён через `page.route`.
 *
 * Запуск (из apps/web, СНАЧАЛА `npm run build:web` — см. OV_PROD ниже):
 *   OV_PROD=1 node scripts/overflow-audit.mjs before
 *   OV_PROD=1 node scripts/overflow-audit.mjs after
 *   OV_PROD=1 node scripts/overflow-audit.mjs after /clients,/more   # точечно
 *
 * Переключатели окружения:
 *   OV_PROD=1      мерить собранный бандл (`vite preview`) вместо dev-сервера —
 *                  ОБЯЗАТЕЛЕН для замеров, зависящих от шрифта, см. ниже;
 *   OV_WIDTHS=…    список ширин через запятую (по умолчанию 390,360,320);
 *   OV_THEMES=…    light и/или night (по умолчанию обе);
 *   OV_SHORT=1     окно 745 вместо 844 — как с ПОКАЗАННОЙ адресной строкой;
 *   OV_SELFTEST=1  самопроверка линейки: на страницу кладётся заведомо широкий
 *                  блок, прогон обязан найти именно его;
 *   OV_GREETING=1  мерить заставку приветствия (нужен и флаг
 *                  GREETING_SPLASH_ENABLED — иначе прогон честно упадёт).
 *
 * В Git Bash под Windows одиночный аргумент «/» превращается в путь Windows и
 * фильтр перестаёт совпадать с чем-либо: прогон отчитается «0 из 0», а не
 * ошибкой. Ставить `MSYS_NO_PATHCONV=1` перед командой.
 *
 * Числа: docs/pult/theme-2026/reports/img/overflow-<этап>.json + stdout.
 * Кадры (390 и 320, свет и ночь): overflow-<этап>-<экран>-<ширина>-<тема>.png
 */
import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const stage = process.argv[2] === "after" ? "after" : "before";
const only = process.argv[3] ? process.argv[3].split(",") : null;
const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, "..");
const repoRoot = path.resolve(webRoot, "../..");
const outDir = path.join(repoRoot, "docs/pult/theme-2026/reports/img");
const PORT = 4193;
// node_modules общие для главного дерева и worktree (CLAUDE.md): ищем vite там, где он лежит.
const viteBin = path.join(path.dirname(createRequire(import.meta.url).resolve("vite/package.json")), "bin/vite.js");

const agent = { id: "a-1", fullName: "Далер Джаббаров", role: "DIRECTOR", avatarUrl: null };

const PERMISSIONS = [
  "dashboard.analytics",
  "clients.view",
  "clients.create",
  "clients.viewPhone",
  "properties.view",
  "properties.create",
  "team.viewFull",
  "finance.view",
  "reports.view",
  "calls.view",
  "settings.view",
];

const profile = {
  ...agent,
  phone: "+992 98 000 10 06",
  email: null,
  permissions: PERMISSIONS,
  totpEnabled: false,
  telegramLinked: false,
  leadsPausedUntil: null,
  frozenAt: null,
  frozenReason: null,
  preferences: {},
};

const districts = [
  { id: "d-1", name: "Сомони" },
  { id: "d-2", name: "Фирдавси" },
  { id: "d-3", name: "Исмоили Сомони" },
];

/* ─────────────────────────── Покупатели ─────────────────────────── */

const NAMES = [
  "Нодирзода Мавзуна Абдусаломовна",
  "Рахимов Сухроб Кароматуллоевич",
  "Одилова Наргис Хайруллоевна",
  "Каримов Фируз Джамшедович",
  "Юсупова Манижа Саидовна",
  "Назаров Собир Абдуллоевич",
  "Шарипова Зарина Икромовна",
  "Мирзоев Далер Бахтиёрович",
  "Холова Гулнора Рустамовна",
  "Сафаров Джамшед Наимович",
  "Аминова Дилноза Фарруховна",
  "Турсунов Бахром Салимович",
];

const client = (i) => ({
  id: `c-${i}`,
  shortId: 1000 + i,
  fullName: NAMES[i % NAMES.length],
  lastName: null,
  phone: "+992 90 000 00 0" + (i % 10),
  whatsappPhone: null,
  extraPhones: [],
  email: null,
  status: ["NEW", "HOT", "COLD", "NEW"][i % 4],
  workStatus: "ACTIVE",
  inactiveLevel: null,
  refusalCount: 0,
  kind: "BUYER",
  avatarUrl: null,
  source: ["INSTAGRAM", "WHATSAPP", "CALL", "TELEGRAM"][i % 4],
  budgetMin: "45000",
  budgetMax: "72000",
  currency: "USD",
  desiredDistrictId: districts[i % districts.length].id,
  desiredDistrict: districts[i % districts.length],
  desiredRooms: 2 + (i % 3),
  unread: i % 5 === 0,
  pendingAcceptance: null,
  assignedAgentId: "a-2",
  assignedAgent: { id: "a-2", fullName: "Собир Назаров", avatarUrl: null },
  lastContactAt: "2026-09-08T10:00:00.000Z",
  createdAt: "2026-08-20T10:00:00.000Z",
  updatedAt: "2026-09-08T10:00:00.000Z",
  nextStep: i % 3 === 0 ? { nextAction: "Показ на Айни", nextActionDate: "2026-09-10T09:00:00.000Z" } : null,
  deletedAt: null,
  notes: null,
});

const clientsPage = {
  items: Array.from({ length: 12 }, (_, i) => client(i)),
  page: 1,
  pageSize: 20,
  total: 137,
};

/* ─────────────────────────── Объекты ─────────────────────────── */

const property = (i) => ({
  id: `p-${i}`,
  shortId: 100 + i,
  title: `${2 + (i % 3)}-комн. квартира на Айни, ${58 + i} м²`,
  type: "APARTMENT",
  rooms: 2 + (i % 3),
  areaSqm: `${58 + i}`,
  floor: 3 + (i % 6),
  totalFloors: 9,
  windowCount: 4,
  price: `${65000 + i * 3000}`,
  currency: "USD",
  districtId: districts[i % districts.length].id,
  district: districts[i % districts.length],
  address: "ул. Айни, 24",
  condition: "GOOD",
  amenities: [],
  description: null,
  status: ["AVAILABLE", "RESERVED", "AVAILABLE", "PENDING_REVIEW"][i % 4],
  publishedOnSite: i % 3 === 0,
  offSite: false,
  ownerContact: null,
  assignedAgentId: "a-2",
  assignedAgent: { id: "a-2", fullName: "Собир Назаров", avatarUrl: null },
  intakeAgentId: null,
  intakeAgent: null,
  viewsCount: 42,
  demandCount: 3,
  photos: [],
  pipeline: null,
  aiReason: null,
  createdAt: "2026-08-20T10:00:00.000Z",
  updatedAt: "2026-09-08T10:00:00.000Z",
  soldAt: null,
  soldPrice: null,
  lat: null,
  lng: null,
});

const propertiesPage = {
  items: Array.from({ length: 12 }, (_, i) => property(i)),
  page: 1,
  pageSize: 20,
  total: 84,
};

/* ─────────────────────────── Пульт ─────────────────────────── */

const mcEnvelope = { generatedAt: "2026-09-09T17:33:00.000Z", seesMoney: true, modulesOff: [] };

const mcLive = {
  ...mcEnvelope,
  hero: {
    commission: { fact: 184000, plan: 260000, forecastEndOfMonth: 231000, forecastPercent: 89 },
    profit: { todayTjs: 12400, previousTodayTjs: 9800 },
    leadsToday: { count: 18, deltaVsYesterday: 4 },
    firstResponse: { medianMinYesterday: 7, noneCountYesterday: 2 },
    missedCallsToday: 3,
    dealsInPipeline: {
      count: 11,
      byStage: [
        { status: "NEGOTIATION", count: 5 },
        { status: "PENDING_APPROVAL", count: 2 },
      ],
      items: [
        { id: "dl-1", title: "Сделка №312, задаток", href: "/deals", tone: "warn", hint: "ждёт подтверждения" },
      ],
    },
  },
  firstLine: {
    items: [
      { id: "f-1", severity: "critical", text: "3 лида никто не принял больше часа", href: "/clients" },
      { id: "f-2", severity: "warn", text: "2 сделки ждут одобрения", href: "/deals" },
    ],
    shownCount: 2,
    totalCount: 2,
  },
  calls: {
    live: { incoming: [], outgoing: [] },
    today: { incoming: 41, outgoing: 63, missed: 3, unqualified: 2 },
  },
};

const mcZones = {
  ...mcEnvelope,
  team: {
    agents: [
      { id: "a-2", fullName: "Собир Назаров", avatarUrl: null, activeLoad: 12, pendingAccept: 1, acceptedToday: 3, noContact: 0, buyerCount: 9, sellerCount: 3, lastSeenAt: "2026-09-09T17:20:00.000Z" },
      { id: "a-3", fullName: "Манижа Юсупова", avatarUrl: null, activeLoad: 8, pendingAccept: 0, acceptedToday: 2, noContact: 1, buyerCount: 6, sellerCount: 2, lastSeenAt: "2026-09-09T16:40:00.000Z" },
    ],
  },
  bot: { ai: { requestsToday: 812, errorsToday: 4, errorRatePercent: 0.5, costUsdToday: 1.8, avgMs: 940 }, guardHitsToday: 2, unresolvedFindings: 1 },
  marketing: { instagramCommentsWaiting: 6, funnelMonth: "2026-09", funnel: [] },
  video: { pipeline: { total: 24, awaitingReview: 6, awaitingPhotos: 9, awaitingVideo: 5, editing: 4, overdue: 3 } },
  properties: { available: 84, newThisWeek: 6, reserved: 11, portfolioValueTjs: 41200000, items: [] },
  system: {
    crons: [{ name: "leads", lastRunAt: "2026-09-09T17:30:00.000Z", lastOkAt: "2026-09-09T17:30:00.000Z", lastError: null, healthy: true }],
    jobsRunning: 1,
    jobsGivenUp: 0,
    jobsGivenUpLast24h: 0,
    newApplications: 2,
    teamRequestsPending: 3,
    errorsToday: 12,
  },
  leaderboard: { agents: [{ place: 1, id: "a-2", fullName: "Собир Назаров", avatarUrl: null, score: 96 }] },
};

const dealsPending = {
  items: [
    {
      id: "dl-1",
      shortId: 312,
      stage: "PENDING_APPROVAL",
      commissionAmount: 8400,
      client: { id: "c-1", shortId: 1001, fullName: "Рахимов Сухроб Кароматуллоевич" },
      property: { id: "p-118", shortId: 118, title: "№118, трёшка на Айни" },
    },
    {
      id: "dl-2",
      shortId: 318,
      stage: "PENDING_APPROVAL",
      commissionAmount: 6200,
      client: { id: "c-2", shortId: 1002, fullName: "Одилова Наргис Хайруллоевна" },
      property: { id: "p-141", shortId: 141, title: "№141, дом в Гиссаре" },
    },
  ],
  page: 1,
  pageSize: 20,
  total: 2,
};

const propsPendingReview = {
  items: [
    { ...property(52), id: "p-152", shortId: 152, title: "№152, трёшка на Айни", status: "PENDING_REVIEW" },
    { ...property(48), id: "p-148", shortId: 148, title: "№148, дом в Гиссаре", status: "PENDING_REVIEW" },
  ],
  page: 1,
  pageSize: 20,
  total: 2,
};


/* Полный набор прав: гейты стоят ВНУТРИ страниц (App.tsx), и без права экран
   отдаёт заглушку — по заглушке переполнение не измеришь. */
const ALL_PERMISSIONS = [
  "admin","agents.manage","archive.view","auditLog.view","calls.ownTranscripts","calls.transcripts",
  "clients.assign","clients.delete","clients.merge","clients.purge","clients.requestDelete",
  "clients.securityReview","clients.viewAll","clients.viewOrigin","clients.viewPhone",
  "comments.moderate","dashboard.analytics","deals.complete","deals.setCommission","deals.viewAll",
  "districts.manage","finance.manage","finance.view","import.run","insights.view","messages.view",
  "messages.viewAttachments","messages.viewOwn","otherInquiries.view","permissions.manage",
  "properties.aiListing","properties.delete","properties.editForeign","properties.export",
  "properties.moderate","properties.publish","properties.purge","properties.requestDelete",
  "properties.viewOwners","reports.view","score.clientLossOverride","settings.manage","settings.view",
  "siteAdmin.reset","siteChanges.resolve","siteChanges.view","team.viewFull","vacancies.view",
];
const fullProfile = { ...profile, permissions: ALL_PERMISSIONS };

const emptyPage = { items: [], page: 1, pageSize: 20, total: 0 };
const unmocked = new Set();

function body(url) {
  const u = url.replace(/^.*\/api\/v1/, "").split("?")[0];
  if (u === "/auth/refresh") return { accessToken: "tok", agent };
  if (u === "/auth/session") return { sid: "s-1" };
  if (u === "/me") return fullProfile;
  if (u === "/districts") return districts;

  if (u === "/clients") return clientsPage;
  if (u === "/clients/delete-requests" || u === "/properties/delete-requests") return { items: [] };
  if (u === "/clients/duplicates") return [];
  if (u === "/clients/lost") return clientsPage;
  if (u === "/properties") {
    return url.includes("status=PENDING_REVIEW") ? propsPendingReview : propertiesPage;
  }
  /* Доска сделок ждёт МАССИВ (`api<Deal[]>("/deals")`), а не страницу с
     пагинацией: мок неверной формы валит оболочку, и экран измеряется пустым —
     то есть «переполнения нет» там, где его просто некому создать. */
  if (u === "/deals") return dealsPending.items;
  if (/^\/properties\/[^/]+$/.test(u)) return { ...property(1), id: u.split("/")[2] };
  if (u === "/calendar/tasks") return [];
  if (u === "/lead-magnets") return [];
  if (u === "/lead-magnet-deliveries") return emptyPage;
  if (u === "/me/passkeys") return [];
  if (u === "/me/logins") return [];
  if (u === "/me/sessions") return { maxDevices: 3, sessions: [] };
  if (u === "/me/notification-kinds") return { kinds: [] };

  if (u === "/expenses") return [];
  if (u === "/expenses/summary") return { months: [], usdToTjsRate: 10.9 };
  if (u === "/expenses/forecast") return { month: "2026-09", spentTjs: 0, projectedTjs: 0, averageTjs: 0, overrun: false };
  if (u === "/expenses/recurring") return [];
  if (u === "/expenses/pulse") return { buckets: [], refreshing: false, syncedAt: null };

  if (u === "/reports/funnel") return { funnel: [], byAgent: [], bySource: [] };
  if (u === "/reports/monthly" || u === "/reports/problems" || u === "/reports/agents") return [];
  if (u === "/reports/sources") return { sources: [], avgDaysNewToClosed: null };
  if (u === "/reports/marketing-funnel") return { month: "2026-09", channels: [] };
  if (u === "/reports/lost-by-channel") return { days: 30, channels: [] };
  if (u === "/reports/waiting-now") return { channels: [], totalWaiting: 0 };
  if (u === "/reports/marketing-insights") return { headline: null, insights: [] };
  if (u === "/dashboard/heatmap") return { cells: [], days: 90 };
  if (u === "/interactions" || u === "/conversations" || u === "/instagram-comments") return emptyPage;
  if (u === "/audit-log" || u === "/clients/trash" || u === "/expenses/archive") return emptyPage;
  if (u === "/site-notifications") return [];
  if (u === "/ads/accounts") return { accounts: [] };
  if (u === "/ads/board") {
    return {
      from: "2026-09-01", to: "2026-09-10", label: "сентябрь", rows: [], syncedAt: null,
      enabled: true, refreshing: false,
      totals: { periodTjs: 0, lifetimeTjs: 0, running: 0, stalled: 0, stopped: 0, total: 0,
        linked: 0, foreign: 0, brandTjs: 0, brandCount: 0, pending: 0, conversations: 0 },
    };
  }
  if (u === "/ads/report") return { rows: [], month: "2026-09" };
  if (u === "/ads/unmatched" || u === "/ads/foreign") return { items: [] };
  if (u === "/ads/insights") return { month: "2026-09", text: null, generatedAt: null, sections: [] };

  if (u === "/team") return [];
  if (u === "/team/stages") return { statuses: ["NEW", "CONTACTED", "HOT", "COLD"], agents: [] };
  if (u === "/hall-of-fame") return { nominations: [], month: "2026-09" };
  if (u === "/hall-of-fame/top-agents") return { agents: [] };

  if (u === "/calls") return { items: [], total: 0, page: 1, pageSize: 20, ownOnly: false };
  if (u === "/calls/summary") return { days: 30, total: 0, averageScore: null, steps: null, agents: [], objections: [] };
  if (u === "/calls/incoming") return { items: [], total: 0, periodTotal: 0, missed: 0, unqualified: 0, page: 1, pageSize: 20, days: 30 };
  if (u === "/calls/insights") return null;
  if (u === "/me/queue-pause") return null;
  if (u === "/calls/telephony/dashboard") {
    return {
      station: { configured: true, online: true, registered: 4, total: 6 },
      extensions: [],
      live: { incoming: [], outgoing: [] },
      today: { incoming: 0, outgoing: 0, missed: 0, unqualified: 0 },
      settings: {
        operators: 2, pushEnabled: true, panelEnabled: true, autoCreateClient: true,
        hoursEnabled: true, hoursStart: "09:00", hoursEnd: "19:00", forwardPhone: null,
        primaryTarget: "queue", primaryExtension: null,
      },
    };
  }

  if (u === "/marketing/queue") return emptyPage;
  if (u === "/marketing/summary") return { total: 0, awaitingReview: 0, awaitingPhotos: 0, awaitingVideo: 0, editing: 0, overdue: 0 };
  if (u === "/marketing/editors-load") return { editors: [], sharedQueue: { inEditing: 0, overdue: 0 } };
  if (u === "/marketing/channels-status") {
    return {
      autoPublishEnabled: true, publishedCount: 0, openErrors: 0,
      channels: {
        INSTAGRAM: { connected: true, botEnabled: true, commentsEnabled: true },
        FACEBOOK: { connected: true, botEnabled: true },
        TELEGRAM: { botEnabled: true, crosspostConnected: true, commentsConnected: true, commentsEnabled: true, directMessagesEnabled: false },
        YOUTUBE: { connected: false },
        TIKTOK: { implemented: false },
      },
    };
  }

  if (u === "/bot-learning") return { rules: [], questions: [], rulesTotal: 0, questionsTotal: 0, activeCount: 0 };
  if (u === "/bot-learning/lost") return { digests: [], pendingReviews: 0, reviewsTotal: 0 };
  if (u === "/bot-audit") return { total: 0, unresolvedTotal: 0, resolvedTotal: 0, groups: [] };
  if (u === "/bot-training/guard-stats") return { days: 14, totals: [] };
  if (u === "/bot-training/next") return null;
  if (u === "/bot-scenarios") return { items: [] };
  if (u === "/insights") return [];
  if (u === "/dashboard/counters/seen") return {};
  if (/^\/ads\/property\//.test(u)) return { items: [] };
  if (/\/delete-request$/.test(u)) return null;

  if (u === "/dashboard/mission-control/live") return mcLive;
  if (u === "/dashboard/mission-control/zones") return mcZones;
  if (u === "/dashboard/mission-control/ticker") return { items: [], nextCursor: null };

  if (u === "/agents") return [agent, { id: "a-2", fullName: "Собир Назаров", role: "AGENT", avatarUrl: null }];
  if (u === "/team") return { agents: [], stages: [] };
  if (u === "/hall-of-fame") return { agents: [], month: "2026-09" };
  if (u === "/hall-of-fame/top-agents") return { items: [] };

  if (u === "/settings") return {};
  if (u === "/settings/branding" || u === "/branding") {
    return { companyName: "Royal Home", companySlogan: "Агентство недвижимости", companyLogoUrl: null };
  }
  if (u === "/errors") return { count24h: 0, count7d: 0, resolvedCount: 0, recent: [] };
  if (u === "/oversight/summary") return null;
  if (u === "/_seen") return {};
  if (u === "/me/summaries") return { items: [], snoozeMinutes: 15 };
  if (u === "/me/notifications" || u === "/notifications") return { items: [], unread: 0 };
  if (u === "/me/callback-requests") return { items: [] };
  if (u === "/me/owner-questions") return { items: [] };
  if (u === "/me/active-call" || u === "/active-call") return null;
  if (u === "/me/royal-score") return null;
  /* Заставку-приветствие владелец видит ПЕРВОЙ, поэтому она тоже меряется —
     но только в прогоне OV_GREETING=1: иначе она перекрывает экран, под которым
     мы ищем переполнение. Длинная строка здесь намеренная: короткая ничего не
     проверяет, а «Сначала это:» с перечислением — то, что там и бывает. */
  if (u === "/greeting") {
    if (process.env.OV_GREETING !== "1") return null;
    return {
      name: "Далер",
      partOfDay: "day",
      dushanbeDate: "2026-09-10",
      text: "Салом, Далер. Сначала это: двенадцать ошибок за сегодня и две сделки, которые ждут одобрения.",
      audioUrl: null,
      infoLine: "Сегодня задач: 7 · новых лидов вчера: 18 · пропущенных звонков: 3",
    };
  }
  if (u === "/dashboard/counters" || u === "/counters") return {};

  unmocked.add(u);
  /* Универсальный ответ подобран так, чтобы оболочка не падала (обжигались на
     каталл-моке неверной формы): пустая страница списка с полями пагинации
     читается и как `{items}`, и как `{items,total}`, и как пустой объект. */
  return emptyPage;
}

/* Маршруты — все статические из App.tsx (плюс карточки клиента и объекта:
   именно там длинные тексты, широкие таблицы и галереи). */
const routes = [
  ["/", "pult"],
  ["/activity", "activity"],
  ["/properties", "properties"],
  ["/properties/new", "properties-new"],
  ["/properties/p-1", "property-detail"],
  ["/properties/p-1/edit", "property-edit"],
  ["/clients", "clients"],
  ["/clients/c-1", "client-detail"],
  ["/sellers", "sellers"],
  ["/lost-clients", "lost-clients"],
  ["/other-inquiries", "other-inquiries"],
  ["/deals", "deals"],
  ["/calendar", "calendar"],
  ["/messages", "messages"],
  ["/comments", "comments"],
  ["/funnel", "funnel"],
  ["/reports", "reports"],
  ["/sources", "sources"],
  ["/settings", "settings"],
  ["/profile", "profile"],
  ["/finance", "finance"],
  ["/ads", "ads"],
  ["/archive", "archive"],
  ["/vacancies", "vacancies"],
  ["/site-changes", "site-changes"],
  ["/team", "team"],
  ["/hall-of-fame", "hall-of-fame"],
  ["/security", "security"],
  ["/calls", "calls"],
  ["/telephony", "telephony"],
  ["/marketing", "marketing"],
  ["/oversight", "oversight"],
  ["/mission-control", "mission-control"],
  ["/health", "health"],
  ["/ai-learning", "ai-learning"],
  ["/insights", "insights"],
  ["/bot-training", "bot-training"],
  ["/more", "more"],
  ["/notifications", "notifications"],
].filter(([p]) => !only || only.includes(p));

/* 320 — самый узкий живой Android (Galaxy Fold закрытым, старые SE), 360 —
   массовый Android, 390/393 — iPhone 13-16, 430 — iPhone Pro Max (телефон
   владельца). Узкий край ловит нехватку места, широкий — правила, привязанные
   к vw и к числу колонок. */
const widths = process.env.OV_WIDTHS ? process.env.OV_WIDTHS.split(",").map(Number) : [390, 360, 320];
const themes = (process.env.OV_THEMES ? process.env.OV_THEMES.split(",") : ["light", "night"]).map((n) => [n === "night" ? "royal-home-2026-night" : "royal-home-2026-light", n]);
/* Кадры снимаем не на всём — иначе 39 маршрутов × 3 ширины × 2 темы = 234 файла.
   Ширины 390 и 320 (обе крайние) и экраны, которые владелец назвал. */
const SHOT_ROUTES = new Set(["pult", "clients", "messages", "more"]);
const SHOT_WIDTHS = new Set([390, 320]);

/**
 * Поиск ВИНОВНИКА, а не симптома.
 *
 * Обходим дерево сверху вниз и не спускаемся внутрь элементов, которые сами
 * обрезают или прокручивают содержимое по горизонтали (`overflow-x` не
 * `visible`): их дети физически не могут расширить страницу, а в списке они
 * дают десятки ложных строк. Сам такой элемент проверяем — лента шириной
 * больше экрана переполняет страницу ровно так же, как и любой другой блок.
 */
function findOverflow() {
  window.scrollTo(0, 0);
  const de = document.documentElement;
  /* СТРАХОВКА СНИМАЕТСЯ НА ВРЕМЯ ЗАМЕРА. На корне документа стоит
     `overflow-x: clip` (index.css) — она прячет боковую прокрутку от человека и
     заодно обнуляет `scrollWidth`. Мерить под ней значит мерить страховку, а не
     вёрстку: любой ноль был бы её заслугой, и починена причина или нет, отчёт
     выглядел бы одинаково. Поэтому на время замера свойство возвращается в
     `visible`, а после — обратно. */
  const netFromSheet = getComputedStyle(de).overflowX;
  const netSaved = de.style.overflowX;
  de.style.overflowX = "visible";
  const vw = de.clientWidth;
  const hits = [];
  const label = (el) => {
    const id = el.id ? `#${el.id}` : "";
    const cls = typeof el.className === "string" && el.className.trim()
      ? "." + el.className.trim().split(/\s+/).slice(0, 4).join(".")
      : "";
    return `${el.tagName.toLowerCase()}${id}${cls}`;
  };
  const pathOf = (el) => {
    const parts = [];
    for (let n = el; n && n !== de && parts.length < 6; n = n.parentElement) parts.unshift(label(n));
    return parts.join(" > ");
  };
  const walk = (el, depth) => {
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") return;
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) {
      const over = Math.round(Math.max(r.right - vw, -r.left));
      if (over >= 1) {
        hits.push({
          path: pathOf(el),
          depth,
          overflowPx: over,
          rect: { left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width) },
          scrollWidth: el.scrollWidth,
          clientWidth: el.clientWidth,
          css: {
            position: cs.position,
            display: cs.display,
            width: cs.width,
            minWidth: cs.minWidth,
            maxWidth: cs.maxWidth,
            flex: cs.flex,
            gridTemplateColumns: cs.gridTemplateColumns.length > 80 ? cs.gridTemplateColumns.slice(0, 80) + "…" : cs.gridTemplateColumns,
            marginLeft: cs.marginLeft,
            marginRight: cs.marginRight,
            paddingLeft: cs.paddingLeft,
            paddingRight: cs.paddingRight,
            transform: cs.transform === "none" ? "none" : "есть",
            overflowX: cs.overflowX,
            whiteSpace: cs.whiteSpace,
          },
          text: (el.childElementCount === 0 ? (el.textContent || "").trim().slice(0, 60) : ""),
        });
      }
    }
    // Внутрь горизонтального скроллера/обрезки не спускаемся — см. комментарий выше.
    if (cs.overflowX !== "visible") return;
    for (const child of el.children) walk(child, depth + 1);
  };
  for (const child of document.body.children) walk(child, 1);
  hits.sort((a, b) => b.overflowPx - a.overflowPx || b.depth - a.depth);
  // Виновник — самый глубокий узел в цепочке: родитель широк, ПОТОМУ ЧТО широк ребёнок.
  const leaves = hits.filter((h) => !hits.some((o) => o !== h && o.path.startsWith(h.path + " > ")));
  const scr = document.querySelector(".rh2 .scr");
  const out = {
    /** Честное число: страховка на время замера снята (см. выше). */
    docExtraPx: de.scrollWidth - de.clientWidth,
    bodyExtraPx: document.body.scrollWidth - vw,
    scrExtraPx: scr ? scr.scrollWidth - scr.clientWidth : null,
    culpritCount: leaves.length,
    culprits: leaves.slice(0, 8),
    rendered: !!document.querySelector(".rh2") || !!document.querySelector("main"),
    /* Положительный контроль для прогона по заставке: без него «переполнения
       нет» означало бы всего лишь «заставки на экране не было». */
    greetingShown: !!document.querySelector(".greeting-splash-overlay"),
    /** Стоит ли страховка вообще — чтобы «ноль» нельзя было приписать не тому. */
    netFromSheet,
    /* Что оказалось на экране вместо содержимого — без этого «не отрисован»
       приходится выяснять отдельным заходом с руками. */
    bodyPreview: (document.body.innerText || "").trim().replace(/\s+/g, " ").slice(0, 160),
  };
  de.style.overflowX = netSaved;
  return out;
}

/**
 * ПОЛЯ ВВОДА МЕЛЬЧЕ 16px — вторая, настоящая причина «оно немножко увеличено».
 *
 * iOS (и Safari, и Chrome — движок один) при постановке курсора в поле, у
 * которого `font-size` меньше 16px, САМ приближает страницу и обратно её не
 * отпускает. Приближённая страница шире видимой области, `position:fixed`
 * нижняя панель раскладывается по ширине НАЧАЛЬНОГО содержащего блока, и её
 * правый край («Ещё») оказывается за экраном — ровно кадр владельца. Раньше это
 * гасил `maximum-scale=1` в `index.html`; его убрали 09.09.2026 ради
 * доступности (WCAG 1.4.4), и приближение вернулось на следующий день.
 * Замер — вычисленный `font-size`, а не кадр: 14px и 16px на снимке не различить.
 */
function measureInputs() {
  const nodes = Array.from(document.querySelectorAll("input, select, textarea")).filter((el) => {
    const t = (el.getAttribute("type") || "").toLowerCase();
    if (["checkbox", "radio", "range", "hidden", "submit", "button", "file", "color"].includes(t)) return false;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  });
  const small = [];
  for (const el of nodes) {
    const size = parseFloat(getComputedStyle(el).fontSize);
    if (size < 16) {
      const cls = typeof el.className === "string" ? el.className.trim().split(/\s+/).slice(0, 3).join(".") : "";
      small.push({ tag: el.tagName.toLowerCase(), cls, fontSizePx: Math.round(size * 10) / 10 });
    }
  }
  return { total: nodes.length, smallCount: small.length, small: small.slice(0, 6) };
}

/**
 * НИЗ СТРАНИЦЫ НЕ УХОДИТ ПОД НИЖНЮЮ ПАНЕЛЬ.
 *
 * Проверяется на двух высотах окна — с показанной адресной строкой браузера и
 * со скрытой: в первом случае окно ниже, и запаса снизу может не хватить.
 * Меряем после прокрутки в самый низ: последний элемент содержимого обязан
 * заканчиваться ВЫШЕ верхней границы панели.
 */
function measureBottomGap() {
  window.scrollTo(0, document.body.scrollHeight);
  const nav = document.querySelector("[data-bottomnav]");
  const scr = document.querySelector(".rh2 .scr") ?? document.querySelector("main");
  if (!nav || !scr) return null;
  const kids = Array.from(scr.children).filter((el) => {
    const r = el.getBoundingClientRect();
    return r.height > 0 && r.width > 0;
  });
  const last = kids[kids.length - 1];
  if (!last) return null;
  return {
    gapPx: Math.round(nav.getBoundingClientRect().top - last.getBoundingClientRect().bottom),
    navTop: Math.round(nav.getBoundingClientRect().top),
    viewportH: window.innerHeight,
  };
}

/** Нижняя панель обязана помещаться целиком: пять пунктов, подписи не обрезаны. */
function measureBottomNav() {
  const nav = document.querySelector("[data-bottomnav]");
  if (!nav) return null;
  const vw = document.documentElement.clientWidth;
  const links = Array.from(nav.querySelectorAll("a"));
  const tabs = links.map((a) => {
    const r = a.getBoundingClientRect();
    const lab = a.querySelector("[data-tab-label]");
    const lr = lab ? lab.getBoundingClientRect() : null;
    /* Подпись — обычный inline-span БЕЗ `overflow:hidden`, поэтому у него
       scrollWidth всегда равен clientWidth: сравнение этих двух чисел даёт
       «не обрезано» ровно тогда, когда текст вылез за ячейку и рисуется поверх
       соседа. Настоящая линейка здесь — ширина текста против ширины ячейки. */
    const labelWidth = lr ? Math.round(lr.width) : 0;
    return {
      label: lab ? (lab.textContent || "").trim() : "",
      right: Math.round(r.right),
      width: Math.round(r.width),
      height: Math.round(r.height),
      labelWidth,
      /** Текст шире своей колонки — на телефоне это и читается как «обрезано». */
      labelWiderThanCell: labelWidth > Math.round(r.width) + 1,
      labelOffscreen: lr ? Math.round(Math.max(lr.right - vw, -lr.left)) > 0 : false,
      fontFamily: lab ? getComputedStyle(lab).fontFamily.split(",")[0].replace(/"/g, "") : "",
    };
  });
  const navRect = nav.getBoundingClientRect();
  return {
    tabs,
    tabCount: tabs.length,
    navRight: Math.round(navRect.right),
    navWidth: Math.round(navRect.width),
    navOverflowPx: Math.round(Math.max(navRect.right - vw, -navRect.left)),
    minTapHeight: Math.min(...tabs.map((t) => t.height)),
    minTapWidth: Math.min(...tabs.map((t) => t.width)),
  };
}

/**
 * OV_PROD=1 — мерить СОБРАННЫЙ бандл (`vite preview`), а не dev-сервер.
 *
 * Не придирка: `@fontsource/golos-text` лежит в общих `node_modules` ВНЕ дерева
 * worktree, и dev-сервер vite отказывается его отдавать («outside of Vite serving
 * allow list»). Гарнитура молча подменяется запасной, а запасная у́же — то есть
 * ровно та проверка, ради которой всё затевалось (влезает ли подпись в ячейку
 * нижней панели), на dev-сервере меряется не тем шрифтом, каким рисует телефон.
 * Требует свежего `npm run build:web`.
 */
const prodMode = process.env.OV_PROD === "1";
const serverArgs = prodMode
  ? [viteBin, "preview", "--port", String(PORT), "--strictPort"]
  : [viteBin, "--port", String(PORT), "--strictPort"];
const server = spawn(process.execPath, serverArgs, {
  cwd: webRoot,
  stdio: "inherit",
  shell: false,
});

async function main() {
  mkdirSync(outDir, { recursive: true });
  await new Promise((r) => setTimeout(r, 6000));
  const browser = await chromium.launch();
  const results = [];
  const pageErrors = [];
  try {
    for (const [themeId, themeName] of themes) {
      for (const width of widths) {
        const ctx = await browser.newContext({
          /* 844 — iPhone 13-15 с СКРЫТОЙ адресной строкой, 745 — с показанной
             (OV_SHORT=1). Второй случай отдельным прогоном: окно ниже, и запас
             снизу под нижней панелью проверяется именно там. */
          viewport: { width, height: process.env.OV_SHORT === "1" ? 745 : 844 },
          deviceScaleFactor: 1,
          reducedMotion: "reduce",
          serviceWorkers: "block",
          colorScheme: themeName === "night" ? "dark" : "light",
          permissions: ["notifications"],
        });
        await ctx.addInitScript(
          ([auth, ui, greeting]) => {
            localStorage.setItem("royal-home-auth", auth);
            localStorage.setItem("royal-home-ui", ui);
            /* Заставка-приветствие обычно выключена: она перекрывает экран и
               мерить под ней нечего. OV_GREETING=1 — отдельный прогон ПО НЕЙ
               САМОЙ: владелец видит её первой, и если шире экрана она, то
               «увеличено» начинается ещё до того, как показался пульт. */
            if (greeting !== "1") localStorage.setItem("rh:greeting:skip", "1");
          },
          [
            JSON.stringify({ state: { agent, hasSession: true }, version: 1 }),
            JSON.stringify({
              state: {
                theme: themeId,
                look: "classic",
                aurora: false,
                glass: true,
                dashboardHidden: [],
                autoLogoutMinutes: 30,
                dismissedHints: [],
                greetingLineMode: "numbers",
                sidebarCollapsed: false,
                aiSoundsEnabled: false,
                greetingVoiceEnabled: false,
                updatedAt: Date.now(),
                syncedAt: Date.now(),
              },
              version: 1,
            }),
            process.env.OV_GREETING === "1" ? "1" : "0",
          ]
        );
        const page = await ctx.newPage();
        page.on("pageerror", (e) => { pageErrors.push(`${themeName}/${width}: ${e.message}`); console.log("PAGE ERROR", e.message); });
        await page.route("**/api/**", async (route) => {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(body(route.request().url())),
          });
        });

        for (const [routePath, name] of routes) {
          await page.goto(`http://localhost:${PORT}${routePath}`, { waitUntil: "networkidle" });
          if (process.env.OV_GREETING === "1") {
            /* Заставка живёт несколько секунд и сама закрывается: ждать её надо
               по селектору, а не паузой — иначе замер попадает уже на пульт и
               «переполнения нет» относится не к тому, что мерили. */
            await page.waitForSelector(".greeting-splash-overlay", { timeout: 8000 }).catch(() => {});
          }
          await page.waitForTimeout(700);
          if (process.env.OV_SELFTEST === "1") {
            /* САМОПРОВЕРКА ЛИНЕЙКИ. «Нигде не переполняется» и «линейка ничего
               не мерит» дают один и тот же ноль, и второй никем не оспаривается.
               Поэтому в самопроверке на страницу кладётся заведомо широкий блок:
               прогон обязан показать переполнение ровно на нём. Не показал —
               сломана линейка, а не исправлено приложение. */
            await page.evaluate((w) => {
              const probe = document.createElement("div");
              probe.id = "ov-selftest";
              probe.style.cssText = `width:${w + 100}px;height:8px;background:red`;
              document.body.appendChild(probe);
            }, width);
            await page.waitForTimeout(100);
          }
          const m = await page.evaluate(findOverflow);
          const nav = await page.evaluate(measureBottomNav);
          const inputs = await page.evaluate(measureInputs);
          const bottom = await page.evaluate(measureBottomGap);
          await page.evaluate(() => window.scrollTo(0, 0));
          results.push({ stage, theme: themeName, width, screen: name, route: routePath, nav, inputs, bottom, ...m });
          const flag = m.docExtraPx > 0 ? `ПЕРЕПОЛНЕНИЕ +${m.docExtraPx}px` : "ok";
          console.log(`[${stage}/${themeName}/${width}/${name}] ${flag}` +
            (m.docExtraPx > 0 ? ` виновники: ${m.culprits.map((c) => `${c.path} (+${c.overflowPx})`).join(" | ")}` : "") +
            (inputs.smallCount > 0 ? ` · полей мельче 16px: ${inputs.smallCount} из ${inputs.total}` : ""));
          if (SHOT_ROUTES.has(name) && SHOT_WIDTHS.has(width)) {
            await page.screenshot({ path: path.join(outDir, `overflow-${stage}-${name}-${width}-${themeName}.png`) });
          }
        }
        await ctx.close();
      }
    }
    writeFileSync(path.join(outDir, `overflow-${stage}.json`), JSON.stringify(results, null, 2), "utf8");

    const bad = results.filter((r) => r.docExtraPx > 0);
    console.log(`\nИТОГ ${stage}: экранов с переполнением ${bad.length} из ${results.length}`);
    if (unmocked.size) console.log("НЕ ЗАМОКАНО:", [...unmocked].join(", "));
    if (pageErrors.length) console.log("ОШИБКИ СТРАНИЦЫ:", [...new Set(pageErrors)].slice(0, 12).join(" | "));

    /* Прогон обязан уметь падать: не отрисовавшийся экран даёт нулевое
       переполнение и выглядит как «всё хорошо» — это худший вид зелёного. */
    if (process.env.OV_SELFTEST === "1") {
      const missed = results.filter((r) => !r.culprits.some((c) => c.path.includes("#ov-selftest")));
      if (missed.length) {
        throw new Error(`САМОПРОВЕРКА ПРОВАЛЕНА: линейка не заметила заведомо широкий блок на ${missed.length} из ${results.length} замеров`);
      }
      console.log(`САМОПРОВЕРКА ПРОЙДЕНА: заведомо широкий блок найден во всех ${results.length} замерах`);
    }
    if (process.env.OV_GREETING === "1" && !results.some((r) => r.greetingShown)) {
      throw new Error("ЗАСТАВКА НИ РАЗУ НЕ ПОКАЗАЛАСЬ — мерить было нечего");
    }
    const blank = results.filter((r) => !r.rendered);
    if (blank.length) {
      throw new Error(`ЭКРАН НЕ ОТРИСОВАН: ${[...new Set(blank.map((b) => b.screen))].join(", ")}`);
    }
    const noNav = results.filter((r) => !r.nav || r.nav.tabCount !== 4);
    if (noNav.length) {
      throw new Error(`НИЖНЯЯ ПАНЕЛЬ НЕ НАЙДЕНА ИЛИ НЕ 4 ССЫЛКИ: ${[...new Set(noNav.map((b) => `${b.screen}/${b.width}`))].join(", ")}`);
    }
  } finally {
    await browser.close();
    server.kill();
  }
}

main().catch((e) => {
  console.error(e);
  server.kill();
  process.exit(1);
});
