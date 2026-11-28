import type { Page } from "@playwright/test";
import type { DirectorDashboardResponse, DirectorDrillResponse } from "@royal-home/shared";

/**
 * Подмена ответов «Дашборда директора» для e2e и кадров (сервер отдаёт 501, пока API-ветка не
 * доделана; а длинные имена и нули на живой базе стенда не воспроизвести). Деньги — только при `seesMoney`.
 */
const iso = (hoursAgo: number) => new Date(Date.now() - hoursAgo * 3_600_000).toISOString();
const LONG_NAME = "Абдурахмонзода Шахноза Рустамовна (старший менеджер)";

export function directorFixture(seesMoney: boolean): DirectorDashboardResponse {
  const money = (n: number) => (seesMoney ? n : null);
  return {
    period: { from: iso(24 * 30), to: iso(0), preset: "month" },
    prevPeriod: { from: iso(24 * 60), to: iso(24 * 30) },
    filters: { agentId: null, source: null, kind: null },
    seesMoney,
    kpis: [
      { key: "newLeads", label: "Новые заявки", value: 148, prev: 121, unit: "count", goodWhen: "up", drillKey: "newLeads" },
      { key: "contacted", label: "Обработано", value: 131, prev: 120, unit: "count", goodWhen: "up", drillKey: "contacted" },
      { key: "noContact", label: "Без контакта", value: 17, prev: 9, unit: "count", goodWhen: "down", drillKey: "noContact" },
      { key: "showings", label: "Показы", value: 64, prev: 70, unit: "count", goodWhen: "up", drillKey: "showings" },
      { key: "meetings", label: "Встречи", value: 22, prev: 22, unit: "count", goodWhen: "up", drillKey: "meetings" },
      { key: "negotiations", label: "Бронь и переговоры", value: 0, prev: 3, unit: "count", goodWhen: "up", drillKey: "negotiations" },
      { key: "deals", label: "Сделки", value: 12, prev: 8, unit: "count", goodWhen: "up", drillKey: "deals" },
      { key: "revenue", label: "Выручка (комиссия)", value: money(48_250_000), prev: money(31_000_000), unit: "tjs", goodWhen: "up", drillKey: "deals" },
    ],
    funnel: {
      method: "cohort",
      steps: [
        { key: "leads", label: "Новая заявка", count: 148, conversionFromPrev: null, conversionFromFirst: 100 },
        { key: "contacted", label: "Первый контакт", count: 131, conversionFromPrev: 88.5, conversionFromFirst: 88.5 },
        { key: "showings", label: "Показ или встреча", count: 52, conversionFromPrev: 39.7, conversionFromFirst: 35.1 },
        { key: "negotiations", label: "Бронь и переговоры", count: 19, conversionFromPrev: 36.5, conversionFromFirst: 12.8 },
        { key: "deals", label: "Сделка", count: 12, conversionFromPrev: 63.2, conversionFromFirst: 8.1 },
      ],
    },
    lossReasons: [
      { reason: "PRICE", label: "Не устроила цена", count: 14 },
      { reason: "NO_ANSWER", label: "Не отвечает", count: 11 },
      { reason: "COMPETITOR", label: "Выбрал конкурента", count: 6 },
      { reason: "NONE", label: "Без причины", count: 2 },
    ],
    speed: { medianMin: 12, avgMin: 95, answered: 131, noContactCount: 17, noContactDrillKey: "noContact", overdueTasks: 9, overdueDrillKey: "overdueTasks" },
    agents: [
      { id: "a1", name: LONG_NAME, isActive: true, leads: 41, contacted: 39, calls: 212, messages: 330, meetings: 9, showings: 21, deals: 5, commission: money(21_000_000), conversion: 12.2, overdueTasks: 2, lastActivityAt: iso(1) },
      { id: "a2", name: "Фаррух", isActive: true, leads: 38, contacted: 33, calls: 140, messages: 190, meetings: 7, showings: 18, deals: 4, commission: money(15_200_000), conversion: 10.5, overdueTasks: 0, lastActivityAt: iso(3) },
      { id: "a3", name: "Сухроб", isActive: true, leads: 0, contacted: 0, calls: 3, messages: 5, meetings: 0, showings: 0, deals: 0, commission: money(0), conversion: null, overdueTasks: 7, lastActivityAt: null },
      { id: "a4", name: "Бывший сотрудник", isActive: false, leads: 5, contacted: 5, calls: 20, messages: 11, meetings: 1, showings: 3, deals: 3, commission: money(12_050_000), conversion: 60, overdueTasks: 0, lastActivityAt: iso(24 * 9) },
    ],
    sources: [
      { source: "WHATSAPP", label: "WhatsApp", leads: 136, deals: 0, commission: money(0) },
      { source: "PHONE_CALL", label: "Звонок", leads: 37, deals: 0, commission: money(0) },
      { source: "INSTAGRAM", label: "Instagram", leads: 27, deals: 0, commission: money(0) },
      { source: "FACEBOOK", label: "Facebook", leads: 17, deals: 0, commission: money(0) },
      { source: "OWN_CLIENT", label: "Свой клиент", leads: 9, deals: 1, commission: money(3_500_000) },
      { source: "WALK_IN", label: "Пришёл в офис", leads: 13, deals: 0, commission: money(0) },
      { source: "REFERRAL", label: "Рекомендация", leads: 2, deals: 1, commission: money(10_400_000) },
      { source: "WEBSITE", label: "Сайт", leads: 1, deals: 0, commission: money(0) },
      { source: "TELEGRAM", label: "Telegram", leads: 0, deals: 0, commission: money(0) },
    ],
    plan: { commissionPlan: money(60_000_000), planIsDefault: false, fact: money(48_250_000), pct: money(80.4), left: money(11_750_000), month: new Date().toISOString().slice(0, 7) },
    updatedAt: new Date().toISOString(),
    cacheSeconds: 60,
  };
}

export function drillFixture(key: DirectorDrillResponse["key"], seesMoney: boolean): DirectorDrillResponse {
  const items = Array.from({ length: 3 }, (_, i) => ({
    id: `d${i}`, entity: "client" as const, clientId: `c${i}`, clientName: i === 0 ? LONG_NAME : `Клиент ${i}`,
    agentId: "a1", agentName: "Фаррух", date: iso(i * 5), source: "WEBSITE", sourceLabel: "Сайт", status: "NEW", statusLabel: "Новая заявка",
    amount: seesMoney && key === "deals" ? 1_200_000 : null,
  }));
  return { key, label: "Список", total: 3, items, limit: 50, offset: 0, hasMore: false };
}

export async function stubDirectorDashboard(page: Page, opts: { seesMoney: boolean }) {
  await page.route((u) => u.pathname === "/api/v1/reports/director", (r) => r.fulfill({ json: directorFixture(opts.seesMoney) }));
  await page.route((u) => u.pathname === "/api/v1/reports/director/drill", (r) => {
    const key = new URL(r.request().url()).searchParams.get("key") as DirectorDrillResponse["key"];
    return r.fulfill({ json: drillFixture(key, opts.seesMoney) });
  });
  await page.route((u) => u.pathname === "/api/v1/reports/director/export.xlsx", (r) => r.fulfill({ body: "xlsx", contentType: "application/octet-stream" }));
}
