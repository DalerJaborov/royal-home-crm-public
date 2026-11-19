/**
 * Вымышленные ответы сервера для экранов контроля (пачка control, 19.11.2026).
 * Общие для e2e-сторожа нового вида и юнит-теста «тот же текст в обоих видах»
 * (components/look/control/ControlScreens.test.tsx). Реальных людей и номеров нет:
 * репозиторий публичный. Длинные имена и причины — нарочно, чтобы проверять перенос.
 */
const NOW = Date.parse("2026-11-19T07:00:00Z");
export const agoIso = (min: number) => new Date(NOW - min * 60_000).toISOString();

const LONG_NAME = "Клиент с очень длинным именем для проверки переноса строки";
const agentA = { id: "ag-1", fullName: "Сотрудник Один" };
const agentB = { id: "ag-2", fullName: "Сотрудник Два с длинной фамилией" };
const page = <T,>(items: T[], extra: Record<string, unknown> = {}) => ({ items, total: items.length, page: 1, pageSize: 20, ...extra });

export const oversight = {
  summary: {
    overdueTasks: 3, noContactClients: 2, recentTransfers: 4, silentAfterShowing: 1, silentAfterShowingDays: 3,
    refusedHighScore: 1, sellerPropertyMissingWarn: 1, sellerPropertyMissingCritical: 1, sellerPropertyMissingWarnDays: 3,
    sellerPropertyMissingCriticalDays: 7, endlessNegotiations: 1, sellerNegotiationMaxRounds: 3, agentLossSeries: 1,
    agentLossSeriesThreshold: 3, agentLossSeriesWindowDays: 7, recentWindowDays: 30,
  },
  overdueTasks: page([
    { id: "t1", notes: "", nextAction: "Перезвонить и уточнить бюджет на квартиру в новостройке у парка", nextActionDate: agoIso(60 * 26), client: { id: "c1", shortId: 101, fullName: LONG_NAME }, agent: agentA },
    { id: "t2", notes: "", nextAction: "Показ", nextActionDate: agoIso(90), client: { id: "c2", shortId: 102, fullName: "Клиент Два" }, agent: agentB },
  ]),
  noContactClients: page([
    { id: "c3", shortId: 103, kind: "BUYER", fullName: "Клиент Три", createdAt: agoIso(60 * 5), lastClientMessageAt: agoIso(30), assignedAgent: agentA },
    { id: "c4", shortId: 104, kind: "BUYER", fullName: "Клиент Четыре", createdAt: agoIso(60 * 30), lastClientMessageAt: null, assignedAgent: null },
  ]),
  silentAfterShowing: page([{ id: "c5", shortId: 105, fullName: "Клиент Пять", lastContactAt: agoIso(60 * 24 * 4), assignedAgent: agentB }], { days: 3 }),
  sellerPropertyMissing: page([
    { id: "c6", shortId: 106, fullName: "Продавец Шесть", propertyAcceptedAt: agoIso(60 * 24 * 9), daysSince: 9, level: "CRITICAL", assignedAgent: agentA, securityReview: "PENDING" },
    { id: "c7", shortId: 107, fullName: "Продавец Семь", propertyAcceptedAt: agoIso(60 * 24 * 4), daysSince: 4, level: "WARN", assignedAgent: agentB, securityReview: null },
  ], { warnDays: 3, criticalDays: 7 }),
  endlessNegotiations: page([{ id: "n1", subjectName: "Квартира", dueAt: agoIso(-60 * 24), rounds: 4, agent: agentA, client: { id: "c8", shortId: 108, fullName: "Клиент Восемь" } }], { maxRounds: 3 }),
  refusedHighScore: page([{ id: "r1", createdAt: agoIso(60 * 6), agent: agentB,
    client: { id: "c9", shortId: 109, fullName: "Клиент Девять", status: "LOST", aiScore: 86, aiScoreReason: null, refusalReason: "BOUGHT_SELF", securityReview: null } }], { threshold: 70, windowDays: 30 }),
  showingSurveyCalls: page([{ id: "s1", agent: agentA, client: { id: "c10", shortId: 110, fullName: "Клиент Десять" }, property: { id: "p1", shortId: 55, title: "Квартира у парка" },
    calledAt: agoIso(60 * 3), createdAt: agoIso(60 * 4), transcriptPreview: "Робот: Здравствуйте. Клиент: Да, показ был.", hasRecording: true,
    redFlags: [{ category: "personal_number", detail: "Агент дал личный номер" }, { category: "off_agency_deal", detail: "Обсуждали сделку напрямую" }],
    escalatedAt: agoIso(60 * 2), outcome: null, outcomeLabel: null, quote: null, summary: null }]),
  agentLossSeries: { items: [{ agentId: agentB.id, agentName: agentB.fullName, avatarUrl: null, count: 4 }], threshold: 3, windowDays: 7 },
  leadTransfers: page([{ id: "e1", notes: "Передан другому агенту по просьбе клиента: хочет общаться на таджикском", createdAt: agoIso(60 * 8), client: { id: "c11", shortId: 111, fullName: "Клиент Одиннадцать" }, agent: agentA }]),
  transferPairs: { pairs: [{ from: agentA, to: agentB, count: 5, frequent: true }, { from: agentB, to: agentA, count: 1, frequent: false }], windowDays: 30, frequentThreshold: 3 },
};

const securityRow = (id: string, shortId: number, review: "PENDING" | "CLEARED" | "CONFIRMED" | null, extra: Record<string, unknown> = {}) => ({
  id, shortId, fullName: shortId === 201 ? LONG_NAME : `Клиент ${shortId}`, phone: "90•••••01", kind: "BUYER", refusalReason: "BOUGHT_VIA_OTHER_AGENCY", refusalCount: 1,
  aiScore: 78, securityReview: review, securityReviewedAt: review && review !== "PENDING" ? agoIso(60 * 20) : null, securityNote: null,
  createdAt: agoIso(60 * 24 * 9), lastContactAt: agoIso(60 * 24 * 2), responsibleAgent: agentA, reviewedBy: review === "CONFIRMED" ? agentB : null,
  initiator: "CLIENT", lossFault: "client_lost_agent_fault", ...extra,
});
export const security = {
  summary: { pending: 2, cleared: 1, confirmed: 1, agentFault: 2, pendingOldCount: 1, total: 4,
    alerts: { newDeviceLogins: 2, permissionChangeCount: 1, lastPermissionChangeAt: agoIso(60 * 3),
      callRedFlags: [{ id: "f1", clientName: "Клиент Десять", detail: "Агент дал личный номер в обход CRM", createdAt: agoIso(60 * 3) }] } },
  lostClients: { items: [securityRow("l1", 201, null), securityRow("l2", 202, "PENDING", { lossFault: "client_lost_no_fault", aiScore: null }),
    securityRow("l3", 203, "CONFIRMED"), securityRow("l4", 204, "CLEARED")], total: 4, page: 1, pageSize: 20 },
  cases: { items: [{ id: "case1", status: "REVIEWING", subjectAgent: agentB, _count: { evidence: 3, decisions: 1 } }], total: 1 },
  caseDetail: { id: "case1", level: "C2", status: "REVIEWING", revision: 2, subjectAgent: agentB, clientId: "c10", propertyId: "p1", independentSources: 2,
    recommendation: { level: "C2", basis: "DISTINCT_RECORDED_TRACES_REQUIRE_REVIEW" },
    evidence: [{ id: "e1", summary: "Звонок-опрос после показа: клиент сказал, что агент дал личный номер и предложил встретиться без агентства.", occurredAt: agoIso(60 * 3), sourceType: "SHOWING_SURVEY" },
      { id: "e2", summary: "В переписке клиент спросил, можно ли оформить сделку напрямую с собственником.", occurredAt: agoIso(60 * 26), sourceType: "MESSAGE" }],
    decisions: [{ id: "d1", action: "SET_STATUS", newStatus: "REVIEWING", level: null, note: "Запросил записи двух показов.", createdAt: agoIso(60 * 2) }] },
};

export const backups = {
  latestByKind: [
    { id: "b1", kind: "DB", success: true, sizeLabel: "1,2 ГБ", detail: null, startedAt: agoIso(240), finishedAt: agoIso(236), createdAt: agoIso(236) },
    { id: "b2", kind: "OFFSITE", success: false, sizeLabel: null, detail: "Хранилище не ответило за 60 секунд, копия не отправлена", startedAt: agoIso(230), finishedAt: agoIso(229), createdAt: agoIso(229) },
    { id: "b3", kind: "RESTORE_DRILL", success: true, sizeLabel: null, detail: "Восстановлено 214 таблиц", startedAt: agoIso(60 * 30), finishedAt: agoIso(60 * 29), createdAt: agoIso(60 * 29) },
  ],
  recent: [] as unknown[],
};
backups.recent = [...backups.latestByKind];

export const stuckWork = {
  givenUp: [{ id: "j1", type: "PUBLISH_REEL", typeLabel: "Публикация ролика", status: "GIVEN_UP", label: "Объект №114: ролик в Instagram", ownerAgentId: agentA.id, ownerAgentName: agentA.fullName,
    attempts: 5, maxAttempts: 5, lastError: "Meta ответила 400: контейнер с таким номером не найден, публикация остановлена", runAt: agoIso(300), updatedAt: agoIso(200) }],
  hanging: [{ id: "j2", type: "SEND_MESSAGE", typeLabel: "Отправка сообщения", status: "PENDING", label: "Сообщение клиенту №103", ownerAgentId: null, ownerAgentName: null,
    attempts: 1, maxAttempts: 5, lastError: null, runAt: agoIso(20), updatedAt: agoIso(15) }],
  counts: { givenUp: 1, hanging: 1 },
  instagramContainers: [{ id: "ig1", status: "EXPIRED", kind: "REELS", error: null, createdAt: agoIso(60 * 30), propertyShortId: 114, propertyTitle: "Квартира у парка" }],
};

export const health = {
  errors: { count24h: 2, count7d: 9, resolvedCount: 5 },
  stuckConversations: { count: 1 },
};
