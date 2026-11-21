import type { Page, Route } from "@playwright/test";
import { stubDirectorDashboard } from "./directorFixtures";

/**
 * ДАННЫЕ ДЛЯ СТОРОЖА ГЕОМЕТРИИ «НОВОГО ВИДА» (20.11.2026).
 *
 * Баги, которые владелец снял на iPhone, видны только на «живых» данных: черновик
 * объекта рядом с «+ Объект», трёхзначное «Найдено», плашка «Ждут проверки»,
 * просрочка этапа, реклама с датами показа, реплика клиента со скрытым номером.
 * На пустом стенде их нет — поэтому ответы API здесь подменены. Всё вымышленное:
 * ни реальных клиентов, ни номеров.
 */
const now = Date.now();
const ago = (min: number) => new Date(now - min * 60_000).toISOString();
/**
 * Подмена поверх настоящего ответа. Страница могла закрыться или уйти на другой адрес, пока
 * ответ шёл (конец теста, переход): тогда «Response has been disposed» — это не поломка вида,
 * а гонка самой подмены, и она не должна ронять сторож.
 */
function patch(edit: (body: Record<string, unknown>, route: Route) => Record<string, unknown>) {
  return async (route: Route) => {
    if (route.request().method() !== "GET") return route.fallback();
    try {
      const response = await route.fetch();
      const body = await response.json().catch(() => null) as Record<string, unknown> | null;
      if (!body || typeof body !== "object") return await route.fulfill({ response });
      await route.fulfill({ response, json: edit(body, route) });
    } catch { /* страница уже закрыта или ушла дальше */ }
  };
}
const json = (body: unknown) => (route: Route) => route.request().method() === "GET" ? route.fulfill({ json: body }) : route.fallback();

export const LOOK_CONVERSATION_ID = "look-fix-c1";

const spend = (spendTjs: number, conversations: number) => ({ spendTjs, spendOriginal: spendTjs / 10.9, impressions: conversations * 240, clicks: conversations * 6, conversations });
const leads = (n: number) => ({ leads: n, showings: n, deals: 0, commissionTjs: 0, costPerLeadTjs: n ? 84.6 : null, costPerShowingTjs: null, costPerLeadMeta: null, romi: null });
const adRow = (id: string, name: string, delivery: string, props: number, days: number) => ({
  id, name, campaignName: name, status: "ACTIVE", delivery, todayTjs: 86.4, objective: null,
  createdTime: ago(days * 1440), startTime: ago(days * 1440), stopTime: delivery === "RUNNING" ? null : ago(60 * 24),
  firstSpendAt: ago(days * 1440), lastSpendAt: ago(40), activeDays: days, postUrl: null, previewUrl: null, headline: name, brand: false,
  property: props ? { id: `p${id}`, shortId: 211, title: name, status: "ACTIVE", coverUrl: null } : null,
  properties: Array.from({ length: props }, (_, i) => ({ id: `p${id}${i}`, shortId: 211 + i, title: name, status: "ACTIVE", thumbUrl: null, share: 1 / props, spendTjs: 1840.5 / props, conversations: 9, leadStats: leads(4) })),
  assetCount: props || 1, needsReview: false, matchSource: "AUTO", period: spend(1_840.25, 23), lifetime: spend(4_210.75, 51), currency: "USD", leadStats: leads(23),
});
const adsBoard = {
  from: ago(43_200).slice(0, 10), to: ago(0).slice(0, 10), label: "последние 30 дней", syncedAt: ago(12), enabled: true, refreshing: false,
  rows: [
    adRow("a1", "3-комн, 112 мкр, после ремонта", "RUNNING", 1, 10),
    adRow("a2", "2-комн в Сино, рядом с парком", "STALLED", 1, 4),
    adRow("a3", "Новостройка у Рудаки", "REVIEW", 0, 2),
    adRow("a4", "Дом в Гиссаре, 6 соток", "RUNNING", 2, 19),
  ],
  totals: { leadStats: leads(38), periodTjs: 3_220.7, lifetimeTjs: 8311.35, running: 2, stalled: 1, stopped: 0, total: 4, linked: 3, foreign: 1, brandTjs: 0, brandCount: 0, pending: 1, conversations: 38 },
};

const conversation = {
  id: LOOK_CONVERSATION_ID, name: "Продавец ПР-000894", profileName: null, channel: "FACEBOOK", clientId: "look-fix-client", clientShortId: "894",
  clientPhone: null, firstContactAt: ago(300), pausedUntil: ago(-600), shieldPause: null, contact: null, subscriberId: "peer",
  messages: [
    { role: "user", content: "Здравствуйте, продаю квартиру", at: ago(240) },
    { role: "assistant", content: "Здравствуйте! Подскажите этаж, площадь и район.", at: ago(238), by: { kind: "bot" } },
    // Клиент продиктовал номер с новой строки — сервер закрыл его маской «****».
    { role: "user", content: "5этаж 86кв район 112 мк после ремонта\n****", at: ago(230) },
    { role: "user", content: "звоните ****, после обеда", at: ago(229) },
  ],
};

/** Подменить ответы, на которых видны баги с кадров владельца. */
export async function stubLookVisualData(page: Page, opts: { look?: boolean; textSize?: "large" | "xlarge" } = {}) {
  const look = opts.look ?? true;
  // Подсказка «Поставьте CRM на экран» встаёт поверх низа страницы с третьего захода —
  // для сторожа геометрии она шум (у неё своя проверка), поэтому счётчик заходов обнулён.
  await page.addInitScript(() => { try { localStorage.setItem("rh-visit-count", "-100000"); } catch { /* приватный режим */ } });
  // Тема — по системе устройства (colorScheme контекста): сохранённая в файле входа
  // настройка «тёмная/светлая» иначе подменила бы обе темы одной.
  await page.addInitScript(() => { try { localStorage.removeItem("royal-home-ui"); } catch { /* приватный режим */ } });
  // Тема, сохранённая в учётке на сервере (GET /me → preferences.theme), тоже уступает системе.
  await page.route((u) => u.pathname === "/api/v1/me", patch((body) => {
    let preferences = body.preferences && typeof body.preferences === "object" ? { ...(body.preferences as Record<string, unknown>) } : body.preferences;
    if (preferences && typeof preferences === "object") delete (preferences as Record<string, unknown>).theme;
    // «Размер текста» из личных настроек (Профиль → Оформление) — для проверки «очень крупного».
    if (opts.textSize) preferences = { ...(preferences && typeof preferences === "object" ? preferences : {}), textSize: opts.textSize };
    return { ...body, preferences };
  }));
  // Дашборд директора: сервер отдаёт заглушку, данные подменены (длинное имя, нули, деньги).
  await stubDirectorDashboard(page, { seesMoney: true });
  await page.route("**/api/v1/ui-shell", (route) => route.request().method() === "GET"
    ? route.fulfill({ json: look ? { enabled: true, look: "royal" } : { enabled: true }, headers: { "cache-control": "no-store" } })
    : route.fallback());
  // Черновик объекта: рядом с «+ Объект» встаёт «Продолжить черновик».
  await page.route((u) => u.pathname === "/api/v1/properties/drafts/current", json({ revision: 1, draft: { values: { title: "Черновик" }, media: [] } }));
  // Каталог: живые объекты стенда, но «Найдено: 117», «Ждут проверки: 2» и «Этап просрочен у 4».
  await page.route((u) => u.pathname === "/api/v1/properties", patch((body, route) => ({
    ...body, total: new URL(route.request().url()).searchParams.get("status") === "PENDING_REVIEW" ? 2 : 117,
  })));
  await page.route((u) => u.pathname === "/api/v1/properties/summary", patch((body) => ({ ...body, overduePipelineCount: 4 })));
  await page.route((u) => u.pathname === "/api/v1/ads/board", json(adsBoard));
  await page.route((u) => u.pathname === "/api/v1/clients/look-fix-client/seller-object", json(null));
  await page.route((u) => u.pathname === `/api/v1/conversations/${LOOK_CONVERSATION_ID}` || u.pathname.startsWith("/api/v1/conversations/groups/"), json(conversation));
  // Список не пустой — иначе экран «Переписок пока нет» и диалог не открывается.
  await page.route((u) => u.pathname === "/api/v1/conversations", json({ page: 1, pageSize: 30, total: 1, items: [{
    id: LOOK_CONVERSATION_ID, channel: "FACEBOOK", name: conversation.name, clientShortId: "894", lastMessage: { role: "user", content: "звоните ****, после обеда" },
    lastMessageAt: ago(229), paused: true, awaitingHumanSince: ago(229), pausedSince: ago(200), unread: false, unreadCount: 0, messagesCount: 4, accountId: null, accountTitle: null,
  }] }));
}
