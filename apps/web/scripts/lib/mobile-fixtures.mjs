/**
 * ФИКСТУРЫ ДЛЯ СЪЁМОЧНЫХ СТЕНДОВ ФРОНТЕНДА (общие на все прогоны).
 *
 * Почему отдельным модулем: стендов уже два — плотность на телефоне
 * (`mobile-density-shots.mjs`) и сверка с макетом на 390
 * (`mobile-parity-shots.mjs`), и оба поднимают ОДИН фронтенд с ОДНИМ
 * подменённым API. Копия ответов в каждом прогоне разъедется в первый же день:
 * один стенд начнёт снимать экран с данными, второй — пустой, и разница между
 * кадрами будет означать не разницу в вёрстке, а разницу в фикстурах.
 *
 * Настоящей базы здесь нет и не будет: сгенерированный клиент Prisma и
 * `packages/shared/dist` лежат в ОБЩИХ node_modules (CLAUDE.md, «Артефакты
 * сборки»), поэтому поднимать базу из worktree нельзя. Работает только
 * фронтенд на dev-сервере vite, а API подменяется через `page.route` — для
 * облика и геометрии этого достаточно.
 *
 * `body(url)` возвращает тело ответа по пути `/api/v1/...`. Неизвестный путь
 * отдаёт `{}` — намеренно: экран, которому не хватило данных, обязан быть
 * ВИДЕН на кадре пустым, а не свалить весь прогон. Пустоту ловит проверка
 * самого стенда (замер «сколько строк на экране»), а не эта функция.
 */

export const agent = { id: "a-1", fullName: "Далер Джаббаров", role: "DIRECTOR", avatarUrl: null };

/**
 * ВСЕ права системы, вычитанные из `packages/shared/src/permissions.ts`.
 *
 * Прежний список был написан от руки и наполовину состоял из НЕСУЩЕСТВУЮЩИХ
 * идентификаторов ("clients.view", "finance.view", "settings.view"): экраны,
 * закрытые правом, молча отдавали заглушку «нет доступа», и стенд снимал её
 * вместо экрана — кадр, который выглядит как рабочий прогон. Здесь список
 * ровно тот, что знает сервер, а директор в CRM и так видит всё.
 */
export const PERMISSIONS = [
  "dashboard.analytics",
  "clients.viewAll",
  "deals.viewAll",
  "otherInquiries.view",
  "messages.view",
  "messages.viewOwn",
  "reports.view",
  "team.viewFull",
  "vacancies.view",
  "finance.view",
  "archive.view",
  "siteChanges.view",
  "settings.view",
  "auditLog.view",
  "insights.view",
  "properties.export",
  "properties.publish",
  "properties.delete",
  "properties.purge",
  "properties.requestDelete",
  "properties.aiListing",
  "properties.moderate",
  "properties.viewOwners",
  "properties.editForeign",
  "messages.viewAttachments",
  "comments.moderate",
  "clients.assign",
  "clients.merge",
  "clients.viewPhone",
  "clients.viewOrigin",
  "calls.transcripts",
  "calls.ownTranscripts",
  "clients.securityReview",
  "clients.requestDelete",
  "clients.delete",
  "clients.purge",
  "deals.setCommission",
  "deals.complete",
  "agents.manage",
  "settings.manage",
  "finance.manage",
  "import.run",
  "districts.manage",
  "siteChanges.resolve",
  "permissions.manage",
  "siteAdmin.reset",
  "score.clientLossOverride",
];

export const profile = {
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

export const districts = [
  { id: "d-1", name: "Сомони" },
  { id: "d-2", name: "Фирдавси" },
  { id: "d-3", name: "Исмоили Сомони" },
];

/* ─────────────────────────── Покупатели ─────────────────────────── */

export const NAMES = [
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

export const client = (i) => ({
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

export const clientsPage = {
  items: Array.from({ length: 12 }, (_, i) => client(i)),
  page: 1,
  pageSize: 20,
  total: 137,
};

/* ─────────────────────────── Объекты ─────────────────────────── */

export const property = (i) => ({
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

export const propertiesPage = {
  items: Array.from({ length: 12 }, (_, i) => property(i)),
  page: 1,
  pageSize: 20,
  total: 84,
};

/* ─────────────────────────── Пульт ─────────────────────────── */

export const mcEnvelope = { generatedAt: "2026-09-09T17:33:00.000Z", seesMoney: true, modulesOff: [] };

export const mcLive = {
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

export const mcZones = {
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

export const dealsPending = {
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

export const propsPendingReview = {
  items: [
    { ...property(52), id: "p-152", shortId: 152, title: "№152, трёшка на Айни", status: "PENDING_REVIEW" },
    { ...property(48), id: "p-148", shortId: 148, title: "№148, дом в Гиссаре", status: "PENDING_REVIEW" },
  ],
  page: 1,
  pageSize: 20,
  total: 2,
};

/* ───────────── Остальные экраны сверки с макетом (390) ─────────────
 *
 * Данные подобраны так, чтобы на экране БЫЛО ЧТО СРАВНИВАТЬ: длинные
 * таджикские ФИО (на них и ломается перенос строки), суммы в шесть знаков,
 * несколько статусов сразу. Пустой экран для сверки с макетом бесполезен —
 * он одинаково «совпадает» с любым макетом.
 */

export const agents = [
  { id: "a-1", fullName: "Далер Джаббаров", role: "DIRECTOR", avatarUrl: null, isActive: true },
  { id: "a-2", fullName: "Собир Назаров", role: "AGENT", avatarUrl: null, isActive: true },
  { id: "a-3", fullName: "Манижа Юсупова", role: "AGENT", avatarUrl: null, isActive: true },
];

const teamMonth = (i) => ({
  leads: 24 - i * 3,
  interactions: 61 - i * 7,
  showings: 12 - i * 2,
  dealsCompleted: 3 - i,
  commission: 18400 - i * 4200,
  conversion: 0.14 - i * 0.02,
  avgAcceptMinutes: 4 + i * 3,
});

export const team = [
  {
    id: "a-2",
    fullName: "Назаров Собир Абдуллоевич",
    role: "AGENT",
    isActive: true,
    avatarUrl: null,
    lastSeenAt: "2026-09-09T17:20:00.000Z",
    online: true,
    frozen: false,
    frozenReason: null,
    points: 128,
    noContactLeads: 0,
    month: teamMonth(0),
  },
  {
    id: "a-3",
    fullName: "Юсупова Манижа Саидовна",
    role: "AGENT",
    isActive: true,
    avatarUrl: null,
    lastSeenAt: "2026-09-09T16:40:00.000Z",
    online: false,
    frozen: false,
    frozenReason: null,
    points: 96,
    noContactLeads: 1,
    month: teamMonth(1),
  },
  {
    id: "a-4",
    fullName: "Каримов Фируз Джамшедович",
    role: "AGENT",
    isActive: true,
    avatarUrl: null,
    lastSeenAt: "2026-09-08T12:05:00.000Z",
    online: false,
    frozen: true,
    frozenReason: "Отпуск до 15 сентября",
    points: 54,
    noContactLeads: 2,
    month: teamMonth(2),
  },
];

export const teamStages = {
  statuses: ["NEW", "HOT", "COLD", "LOST"],
  agents: team.map((m, i) => ({
    id: m.id,
    byStatus: { NEW: 4 - i, HOT: 3, COLD: 2 + i, LOST: i },
    showingsScheduled: 3 - i,
    dealsInProgress: 2 - i,
  })),
};

export const hallOfFame = {
  month: "2026-09",
  team: team.map((m, i) => ({
    id: m.id,
    fullName: m.fullName,
    avatarUrl: null,
    place: i + 1,
    score: 92 - i * 11,
    points: m.points,
    frozen: m.frozen,
  })),
  nominations: [],
};

export const topAgents = {
  agents: team.map((m, i) => ({
    place: i + 1,
    id: m.id,
    fullName: m.fullName,
    avatarUrl: null,
    score: 92 - i * 11,
    frozen: m.frozen,
    dealsCount: 3 - i,
    conversion: 0.14 - i * 0.03,
    activeClients: 12 - i * 3,
  })),
};

/** Лента звонков (GET /calls/feed) — СВОЙ тип, не CallRow: у неё `at`, `kind`
 *  и `agentName`, и подмена одного другим роняет мобильный экран журнала. */
export const callsFeed = {
  items: Array.from({ length: 6 }, (_, i) => ({
    kind: ["OUT", "IN", "MISSED"][i % 3],
    id: "fd-" + i,
    at: new Date(Date.UTC(2026, 8, 9, 8 + i, 12, 0)).toISOString(),
    client: { id: "c-" + i, shortId: 1000 + i, fullName: NAMES[i % NAMES.length] },
    phone: "+992 90 000 00 0" + i,
    durationSec: i % 3 === 2 ? null : 95 + i * 40,
    agentName: "Собир Назаров",
    hasRecording: i % 3 !== 2,
    score: i % 3 === 2 ? null : 4 - (i % 3),
    transcript: "Салом, ман дар бораи хонаи Айнӣ занг мезанам…",
    transcriptRu: "Здравствуйте, я звоню по квартире на Айни…",
    transcriptionStage: null,
    transcriptionProgress: null,
    analysis: {
      score: 4 - (i % 3),
      greeted: true,
      foundNeed: i % 2 === 0,
      presentedValue: true,
      handledObjection: i % 3 === 0,
      agreedNextStep: i % 2 === 1,
      summary: "Клиент просит трёшку до 400 000 сомони, готов смотреть в выходные.",
      objections: ["дорого"],
    },
  })),
  nextCursor: null,
};

/* ───────────────────────────── Сделки ───────────────────────────── */

const dealStages = ["NEGOTIATION", "PENDING_APPROVAL", "COMPLETED", "NEGOTIATION"];

export const deal = (i) => ({
  id: "dl-" + i,
  clientId: "c-" + i,
  client: { id: "c-" + i, shortId: 1000 + i, fullName: NAMES[i % NAMES.length], phone: "+992 90 000 00 0" + i },
  propertyId: "p-" + i,
  property: {
    id: "p-" + i,
    shortId: 100 + i,
    title: (2 + (i % 3)) + "-комн. квартира на Айни, " + (58 + i) + " м²",
    price: String(65000 + i * 3000),
    currency: "USD",
    photos: [],
  },
  agentId: "a-2",
  agent: { id: "a-2", fullName: "Собир Назаров", avatarUrl: null },
  stage: dealStages[i % dealStages.length],
  commissionAmount: String(3400 + i * 800),
  commissionPercent: "2",
  soldPrice: String(64000 + i * 3000),
  commissionIntakeAmount: String(900 + i * 100),
  commissionRealtorAmount: String(1600 + i * 300),
  commissionCompanyAmount: String(900 + i * 400),
  currency: "USD",
  startedAt: "2026-09-01T10:00:00.000Z",
  closedAt: i % 4 === 2 ? "2026-09-08T10:00:00.000Z" : null,
  notes: null,
});

export const deals = Array.from({ length: 6 }, (_, i) => deal(i));

/* ─────────────────────────── Календарь ─────────────────────────── */

const taskTypes = ["SHOWING", "CALL", "MEETING", "SHOWING", "CALL"];

export const calendarTask = (i) => ({
  id: "it-" + i,
  clientId: "c-" + i,
  agentId: "a-2",
  agent: { id: "a-2", fullName: "Собир Назаров", avatarUrl: null },
  type: taskTypes[i % taskTypes.length],
  propertyId: "p-" + i,
  notes: "Показ на Айни, подъезд со двора",
  outcome: null,
  nextAction: ["Показ квартиры", "Перезвонить по ипотеке", "Встреча в офисе"][i % 3],
  nextActionDate: new Date(Date.UTC(2026, 8, 10 + (i % 5), 5 + i, 0, 0)).toISOString(),
  completedAt: null,
  createdAt: "2026-09-08T10:00:00.000Z",
  client: { id: "c-" + i, shortId: 1000 + i, fullName: NAMES[i % NAMES.length], phone: "+992 90 000 00 0" + i, status: "HOT" },
  property: { id: "p-" + i, shortId: 100 + i, title: (2 + (i % 3)) + "-комн. на Айни" },
});

export const calendarTasks = Array.from({ length: 7 }, (_, i) => calendarTask(i));

/* ───────────────────────────── Звонки ───────────────────────────── */

export const callRow = (i) => ({
  id: "cl-" + i,
  createdAt: new Date(Date.UTC(2026, 8, 9, 8 + i, 12, 0)).toISOString(),
  notes: null,
  hasRecording: true,
  durationSec: 95 + i * 40,
  transcript: "Салом, ман дар бораи хонаи Айнӣ занг мезанам…",
  transcriptRu: "Здравствуйте, я звоню по квартире на Айни…",
  transcriptionStage: null,
  transcriptionProgress: null,
  agent: { id: "a-2", fullName: "Собир Назаров", avatarUrl: null },
  client: { id: "c-" + i, shortId: 1000 + i, fullName: NAMES[i % NAMES.length] },
  analysis: {
    score: 4 - (i % 3),
    greeted: true,
    foundNeed: i % 2 === 0,
    presentedValue: true,
    handledObjection: i % 3 === 0,
    agreedNextStep: i % 2 === 1,
    summary: "Клиент просит трёшку до 400 000 сомони, готов смотреть в выходные.",
    objections: ["дорого"],
  },
});

export const calls = { items: Array.from({ length: 6 }, (_, i) => callRow(i)), page: 1, pageSize: 20, total: 41 };

export const incomingCalls = {
  items: Array.from({ length: 4 }, (_, i) => ({
    id: "ic-" + i,
    phone: "+992 90 000 00 0" + i,
    startedAt: new Date(Date.UTC(2026, 8, 9, 9 + i, 3, 0)).toISOString(),
    endedAt: new Date(Date.UTC(2026, 8, 9, 9 + i, 5, 0)).toISOString(),
    answered: i % 3 !== 1,
    talkSeconds: i % 3 !== 1 ? 120 + i * 30 : null,
    answeredBy: i % 3 !== 1 ? "1001" : null,
    answeredByName: i % 3 !== 1 ? "Собир Назаров" : null,
    client: { id: "c-" + i, shortId: 1000 + i, fullName: NAMES[i % NAMES.length], kind: "BUYER" },
    callbackAgent: i % 3 === 1 ? { id: "a-2", fullName: "Собир Назаров" } : null,
    qualifiedAt: i % 2 === 0 ? "2026-09-09T09:10:00.000Z" : null,
    qualifiedBy: i % 2 === 0 ? { id: "a-1", fullName: "Далер Джаббаров" } : null,
    irrelevant: false,
    autoCreatedClient: i === 3,
  })),
  page: 1,
  pageSize: 20,
  total: 12,
};

export const callsSummary = {
  days: 7,
  total: 214,
  averageScore: 3.8,
  steps: { greeted: 198, foundNeed: 146, presentedValue: 121, handledObjection: 74, agreedNextStep: 132 },
  agents: team.map((m) => ({ agentId: m.id, fullName: m.fullName, calls: 60, averageScore: 3.9, nextStepShare: 0.62, foundNeedShare: 0.71 })),
  objections: [
    { text: "дорого", count: 34 },
    { text: "далеко от центра", count: 19 },
  ],
};

export const callInsights = {
  days: 7,
  calls: 214,
  strengths: ["Здороваются и представляются почти всегда", "Быстро находят бюджет клиента"],
  weaknesses: ["Возражение «дорого» отрабатывают в трети разговоров", "Следующий шаг называют не всегда"],
  demand: ["Трёшки до 400 000 сомони в Сомони", "Дома в Гиссаре под ипотеку"],
  actions: ["Разобрать с агентами скрипт по возражению «дорого»", "В конце каждого звонка называть дату показа"],
  createdAt: "2026-09-09T18:00:00.000Z",
};

/* ───────────────────────────── Деньги ───────────────────────────── */

export const financeMonth = (offset) => {
  const m = 9 - offset;
  return {
    month: "2026-0" + m,
    revenue: 184000 - offset * 21000,
    intakePayouts: 21000,
    realtorPayouts: 63000,
    companyRevenue: 100000 - offset * 12000,
    payouts: team.map((t, i) => ({ agentId: t.id, name: t.fullName, intake: 7000 - i * 1500, realtor: 21000 - i * 4000, total: 28000 - i * 5500 })),
    expenses: { ADS: 24000, SALARY: 41000, OFFICE: 12000, AI: 1900 },
    totalExpenses: 78900,
    profit: 105100 - offset * 12000,
    leads: 142 - offset * 11,
    costPerLead: [
      { source: "INSTAGRAM", spent: 14000, leads: 61, costPerLead: 229, deals: 4, costPerDeal: 3500 },
      { source: "WHATSAPP", spent: 6000, leads: 38, costPerLead: 157, deals: 2, costPerDeal: 3000 },
      { source: "CALL", spent: 4000, leads: 43, costPerLead: 93, deals: 3, costPerDeal: 1333 },
    ],
    intakeCommission: 8400,
  };
};

export const financeSummary = { months: [0, 1, 2, 3, 4, 5].map(financeMonth), usdToTjsRate: 10.9 };

export const expenses = Array.from({ length: 6 }, (_, i) => ({
  id: "ex-" + i,
  category: ["ADS", "SALARY", "OFFICE", "AI", "ADS", "OTHER"][i],
  source: i % 3 === 0 ? "INSTAGRAM" : null,
  agentId: null,
  agent: null,
  autoKey: i === 3 ? "ai-monthly" : null,
  amount: String(2400 + i * 1800),
  currency: "TJS",
  month: "2026-09",
  note: ["Реклама Instagram", "Зарплата за август", "Аренда офиса", "ИИ, сентябрь", "Реклама Facebook", "Хозрасходы"][i],
  deletedAt: null,
}));

export const expenseForecast = { month: "2026-09", spentTjs: 78900, projectedTjs: 96400, averageTjs: 84200, overrun: true };

export const expensePulse = ["DAY", "WEEK", "MONTH"].map((period, i) => ({
  period,
  label: ["Сегодня", "Эта неделя", "Этот месяц"][i],
  incomeTjs: 12400 * (i + 1),
  expenseTjs: 8600 * (i + 1),
  balanceTjs: 3800 * (i + 1),
  previousIncomeTjs: 9800 * (i + 1),
  previousExpenseTjs: 9100 * (i + 1),
  previousBalanceTjs: 700 * (i + 1),
}));

export const recurringExpenses = [
  { id: "rc-1", title: "Аренда офиса", category: "OFFICE", amount: "12000", currency: "TJS", dayOfMonth: 5, note: null, active: true, lastCreatedMonth: "2026-09" },
  { id: "rc-2", title: "Интернет и связь", category: "OFFICE", amount: "900", currency: "TJS", dayOfMonth: 10, note: null, active: true, lastCreatedMonth: "2026-09" },
];

/* ──────────────────────────── Переписка ──────────────────────────── */

const messages = [
  { role: "user", content: "Салом! Ин хона ҳанӯз ҳаст?", at: "2026-09-09T09:00:00.000Z", mid: "m1" },
  { role: "assistant", content: "Здравствуйте! Да, квартира на Айни свободна. Подскажите, на какой бюджет ориентируетесь?", at: "2026-09-09T09:01:00.000Z", by: { kind: "bot" }, mid: "m2" },
  { role: "user", content: "До 400 000 сомони. Можно посмотреть завтра после обеда?", at: "2026-09-09T09:04:00.000Z", mid: "m3" },
  { role: "assistant", content: "Записал показ на завтра в 14:00, с вами свяжется Собир.", at: "2026-09-09T09:05:00.000Z", by: { kind: "agent", agentId: "a-2", agentName: "Собир Назаров" }, mid: "m4" },
];

export const conversationsPage = {
  items: Array.from({ length: 6 }, (_, i) => ({
    id: "cv-" + i,
    channel: ["INSTAGRAM", "WHATSAPP", "TELEGRAM", "MESSENGER"][i % 4],
    name: NAMES[i % NAMES.length],
    clientShortId: String(1000 + i),
    lastMessage: { role: i % 2 ? "user" : "assistant", content: messages[i % messages.length].content, by: { kind: "bot" } },
    lastMessageAt: new Date(Date.UTC(2026, 8, 9, 9 + i, 5, 0)).toISOString(),
    paused: i === 2,
    unread: i % 3 === 0,
    messagesCount: 4 + i,
    accountId: "acc-1",
    accountTitle: "Royal Home",
  })),
  page: 1,
  pageSize: 20,
  total: 38,
  channels: ["INSTAGRAM", "WHATSAPP", "TELEGRAM", "MESSENGER"],
  accounts: [
    { id: "acc-1", title: "Royal Home", channel: "INSTAGRAM" },
    { id: "acc-2", title: "Royal Home Info", channel: "WHATSAPP" },
  ],
};

export const conversationDetail = (id) => ({
  id,
  channel: "INSTAGRAM",
  name: NAMES[0],
  profileName: "nodirzoda.m",
  subscriberId: "sub-1",
  clientId: "c-0",
  clientShortId: "1000",
  clientPhone: "+992 90 000 00 00",
  firstContactAt: "2026-09-01T09:00:00.000Z",
  pausedUntil: null,
  messages,
});

/* ──────────────────── Карточки клиента и объекта ──────────────────── */

export const clientDetail = (id) => ({
  ...client(0),
  id,
  desiredAreaMin: 58,
  desiredFloorMin: 2,
  desiredFloorMax: 7,
  desiredTotalFloors: 9,
  desiredType: "APARTMENT",
  address: "напротив Зебунисо",
  isPersonalLead: false,
  requirementsNotes: "Нужен ремонт, второй этаж и выше, рядом школа.",
  assignedAt: "2026-09-01T09:00:00.000Z",
  acceptedAt: "2026-09-01T09:12:00.000Z",
  aiScore: 78,
  aiScoreReason: "Бюджет подтверждён, показ назначен, отвечает быстро.",
  aiInsight: "Ищет трёшку до 400 000 сомони рядом со школой. Готова смотреть в выходные, ипотека не нужна.",
  aiInsightAt: "2026-09-09T09:10:00.000Z",
  firstContactAt: "2026-09-01T09:20:00.000Z",
  lastClientMessageAt: "2026-09-09T09:04:00.000Z",
  pendingAcceptance: false,
  interactions: Array.from({ length: 4 }, (_, i) => calendarTask(i)),
  deals: [deal(0)],
  botConversation: [{ id: "cv-0", pausedUntil: null, channel: "INSTAGRAM", messages }],
  telegramConversation: null,
});

export const propertyDetail = (id) => ({
  ...property(0),
  id,
  description: "Светлая трёшка с ремонтом, окна во двор, рядом школа №12 и рынок.",
  ownerContact: "+992 90 111 11 11",
  amenities: ["LIFT", "PARKING"],
  photos: [],
  pipeline: null,
  intakeAgent: { id: "a-3", fullName: "Манижа Юсупова", avatarUrl: null },
  intakeAgentId: "a-3",
});

/* ───────────────────────────── Настройки ───────────────────────────── */

export const settings = {
  id: "s-1",
  companyName: "Royal Home",
  companySlogan: "Агентство недвижимости",
  companyLogoUrl: null,
  usdToTjsRate: "10.9",
  leadMaxTransfers: 3,
  leadAcceptMinutes: 15,
  leadPoolAfterMinutes: 30,
  maxActiveLeadsPerAgent: 25,
  workDayStartHour: 9,
  workDayEndHour: 19,
  botEnabled: true,
  aiModel: "claude-sonnet-5",
  updatedAt: "2026-09-09T10:00:00.000Z",
};

export function body(url) {
  const u = url.replace(/^.*\/api\/v1/, "").split("?")[0];
  if (u === "/auth/refresh") return { accessToken: "tok", agent };
  if (u === "/auth/session") return { sid: "s-1" };
  if (u === "/me") return profile;
  if (u === "/districts") return districts;
  if (u === "/agents") return agents;

  if (u === "/clients") return clientsPage;
  if (u === "/clients/delete-requests" || u === "/properties/delete-requests") return { items: [] };
  if (u === "/clients/duplicates") return [];
  if (u === "/clients/lost" || u === "/clients/reactivation-offers") return { items: [], page: 1, pageSize: 20, total: 0 };
  if (/^\/clients\/[^/]+\/interactions$/.test(u)) return Array.from({ length: 4 }, (_, i) => calendarTask(i));
  if (/^\/clients\/[^/]+\/match$/.test(u)) return { items: [] };
  /* Подсказка карточки и заявка на удаление законно ОТСУТСТВУЮТ — но именно
     `null`, а не `{}`: пустой объект компоненты принимают за подсказку и падают
     на её полях. */
  if (/^\/clients\/[^/]+\/card-suggestion$/.test(u)) return null;
  if (/^\/clients\/[^/]+\/delete-request$/.test(u)) return { request: null };
  if (/^\/clients\/[^/]+$/.test(u)) return clientDetail(u.slice("/clients/".length));

  if (u === "/properties") {
    return url.includes("status=PENDING_REVIEW") ? propsPendingReview : propertiesPage;
  }
  if (/^\/properties\/[^/]+$/.test(u)) return propertyDetail(u.slice("/properties/".length));

  if (u === "/deals") return deals;
  if (u === "/calendar/tasks") return calendarTasks;

  if (u === "/conversations") return conversationsPage;
  if (/^\/conversations\/[^/]+$/.test(u)) return conversationDetail(u.slice("/conversations/".length));

  if (u === "/calls") return calls;
  if (u === "/calls/feed") return callsFeed;
  if (u === "/calls/incoming") return incomingCalls;
  if (u === "/calls/summary") return callsSummary;
  if (u === "/calls/insights") return callInsights;
  if (u === "/calls/telephony/dashboard") return { extensions: [], queues: [], trunks: [] };

  if (u === "/team") return team;
  if (u === "/team/stages") return teamStages;
  if (u === "/hall-of-fame") return hallOfFame;
  if (u === "/hall-of-fame/top-agents") return topAgents;

  if (u === "/expenses") return expenses;
  if (u === "/expenses/summary") return financeSummary;
  if (u === "/expenses/forecast") return expenseForecast;
  if (u === "/expenses/pulse") return { buckets: expensePulse, refreshing: false, syncedAt: "2026-09-09T18:00:00.000Z" };
  if (u === "/expenses/recurring") return recurringExpenses;
  if (u === "/expenses/archive") return { items: [], page: 1, pageSize: 20, total: 0 };

  /* «Настройки CRM» закрыты повторным подтверждением личности (StepUpGate).
     Стенд отвечает «подтверждение уже есть» — это фикстура поддельного сервера,
     а не обход входа: настоящих учётных данных здесь нет вовсе, и снаружи стенда
     эта строка ничего не меняет. Без неё съёмка «Настроек» снимала бы окно ввода
     пароля и выдавала его за экран настроек. */
  if (u === "/auth/step-up") return { elevated: true, method: "password" };
  if (u === "/settings") return settings;

  if (u === "/dashboard/mission-control/live") return mcLive;
  if (u === "/dashboard/mission-control/zones") return mcZones;
  if (u === "/dashboard/mission-control/ticker") return { items: [], nextCursor: null };

  if (u === "/oversight/summary") return null;
  if (u === "/_seen") return {};
  if (u === "/me/summaries") return { items: [], snoozeMinutes: 15 };
  if (u === "/me/notifications" || u === "/notifications") return { items: [], unread: 0 };
  if (u === "/me/callback-requests") return { items: [] };
  if (u === "/me/owner-questions") return { items: [] };
  if (u === "/me/active-call" || u === "/active-call") return null;
  if (u === "/me/royal-score") return null;
  if (u === "/greeting") return null;
  if (u === "/errors") return { items: [], page: 1, pageSize: 20, total: 0 };
  if (u === "/site-notifications") return { items: [], unread: 0 };
  if (u === "/marketing/summary") return { instagram: null, comments: { waiting: 0 }, funnel: [] };
  if (u === "/push/config") return { publicKey: null };
  if (u === "/dashboard/counters" || u === "/counters") return {};
  if (u === "/settings/branding" || u === "/branding") {
    return { companyName: "Royal Home", companySlogan: "Агентство недвижимости", companyLogoUrl: null };
  }
  return {};
}
