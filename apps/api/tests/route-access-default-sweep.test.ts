import "./helpers/routeMountRecorder.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Server } from "node:http";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { signAccessToken } from "../src/auth/jwt.js";
import { collectRoutes, type RegisteredRoute } from "./helpers/routeMountRecorder.js";

/**
 * СТОРОЖ «ЗАКРЫТО ПО УМОЛЧАНИЮ» ДЛЯ ВСЕХ МАРШРУТОВ (проверка безопасности 26.11.2026).
 *
 * Проверка прав в этом сервере стоит не на общем входе `/api/v1`, а внутри каждого
 * роутера (`router.use(requireAuth)` или `requireAuth` на маршруте). Значит новый
 * маршрут, у которого её забыли, открыт всему интернету молча: сборка, типы и
 * остальные тесты зелёные. До этого файла сторожем была только проверка акционера
 * (shareholder-read-only.test.ts) — и только для ЗАПИСИ: новый открытый GET с
 * клиентами или перепиской не ловил никто.
 *
 * Два обхода по ВСЕМ зарегистрированным маршрутам приложения:
 *  1. Без входа каждый маршрут отвечает ответом requireAuth, кроме явного списка
 *     публичных ниже — у каждого своя защита (подпись, ключ, токен в ссылке) и причина.
 *  2. Агент А не видит НИ ОДНОЙ метки чужого агента Б (имя и номер клиента, текст
 *     переписки, заметка звонка, номер собственника) ни в одном GET-ответе — ни по
 *     идентификатору Б, ни в списках. Каталог объектов общий по замыслу, поэтому
 *     название и адрес объекта меткой не служат; номер собственника — служит.
 *
 * Добавляешь публичный маршрут — впиши его в PUBLIC_ROUTES с причиной; запись,
 * которой больше нет в приложении, тоже валит тест (список только честный).
 */

const PUBLIC_ROUTES: Record<string, string> = {
  "GET /api/v1/health": "проверка живости для деплоя и мониторинга",
  "GET /api/v1/health/deep": "проверка базы и воркера для деплоя, без данных",
  "GET /api/v1/auth/session": "отдаёт только sid из своей же httpOnly-cookie",
  "GET /api/v1/settings/branding": "название и логотип для экрана входа",
  "GET /api/v1/attachments/s/:name": "подписанная короткая ссылка на вложение (#428)",
  "GET /api/v1/media/chat/*splat": "файл переписки по неугадываемому uuid-ключу R2",
  "GET /api/v1/l/:token": "публичная ссылка на объект для клиента, токен в адресе",
  "GET /api/v1/l/:token/go": "переход по публичной ссылке на объект",
  "GET /api/v1/morning-report": "свой служебный токен (Нужен служебный токен)",
  "GET /api/v1/properties/:id/videos/:videoId/download-file": "подписанный токен скачивания ролика",
  "GET /api/v1/telephony/whisper/manifest": "токен станции АТС в заголовке",
  "GET /api/v1/telephony/whisper/file/:name": "токен станции АТС в заголовке",
  "GET /api/v1/ads/callback": "возврат OAuth из Facebook, проверка state",
  "GET /api/v1/tiktok/oauth/callback": "возврат OAuth из TikTok, проверка state",
  "GET /api/v1/threads/oauth/callback": "возврат OAuth из Threads, проверка state",
  "GET /api/v1/search-console/oauth/callback": "возврат OAuth из Google, проверка state",
  "GET /api/v1/search-console/yandex/oauth/callback": "возврат OAuth из Яндекса, проверка state",
  "GET /api/v1/webhooks/meta": "рукопожатие Meta по verify token",
  "GET /api/v1/webhooks/website-working-hours": "часы работы для виджета сайта",
  "GET /api/v1/webhooks/website-chat/:sessionId": "чат сайта, ключ сайта X-Api-Key",
};

/** Публичные по префиксу: вебхуки с подписью/ключом, публичная витрина, вход. Их
 *  обработчики пишут и запускают фоновую работу — пустым телом их не трогаем
 *  (тот же довод, что в shareholder-read-only.test.ts). */
const PUBLIC_PREFIXES = ["/api/v1/webhooks/", "/api/v1/public/", "/api/v1/sms/webhook/", "/api/v1/push/action",
  "/api/v1/backups/report", "/api/v1/auth/"];

const AUTH_REQUIRED = "Требуется авторизация";
const DUMMY_ID = "00000000-0000-4000-8000-000000000000";

// Ни один обход не ходит наружу: часть GET-маршрутов зовёт ИИ и Meta, если ключи
// заданы в окружении прогона. Тесту нужен только ответ нашего сервера.
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (/^https?:\/\/(127\.0\.0\.1|localhost)(:|\/)/.test(url)) return realFetch(input, init);
  throw new Error("route-access-default-sweep: внешняя сеть в этом тесте закрыта");
}) as typeof fetch;

const run = String(Date.now()).slice(-7);
const MARK = `ACCSWEEP${run}`;
const CLIENT_PHONE = `+99293${run}`;
const OWNER_PHONE = `+99290${run}`;
const ids: Record<string, string> = {};
const shortIds: Record<string, number> = {};
const created = { agents: [] as string[], district: "" };
let tokenA = "";
let server: Server;

function key(r: RegisteredRoute): string {
  return `${r.method} ${r.path}`;
}

function isPublicPrefix(path: string): boolean {
  return PUBLIC_PREFIXES.some((p) => path.startsWith(p));
}

/** Подставляет в шаблон пути идентификаторы данных агента Б по имени ресурса. */
function concretePath(path: string): string {
  let resource = "";
  const byParam: Record<string, string> = {
    clientid: "clients", propertyid: "properties", dealid: "deals",
    interactionid: "interactions", conversationid: "conversations", agentid: "agents",
  };
  return path
    .split("/")
    .map((seg) => {
      if (seg.startsWith("*")) return "x";
      const m = /^:([A-Za-z0-9_]+)/.exec(seg);
      if (!m) {
        if (seg) resource = seg;
        return seg;
      }
      const name = m[1]!.toLowerCase();
      if (name === "shortid") return String(shortIds[resource] ?? 1);
      const target = byParam[name] ?? (name === "id" ? resource : "");
      return ids[target] ?? DUMMY_ID;
    })
    .join("/");
}

function allRoutes(): RegisteredRoute[] {
  return collectRoutes((app as unknown as { router: { stack: never[] } }).router.stack);
}

beforeAll(async () => {
  server = app.listen(0);
  const district = await prisma.district.create({ data: { name: `access-sweep-${run}` } });
  created.district = district.id;
  const a = await prisma.agent.create({ data: { fullName: `Агент А ${run}`, phone: `+99291${run}`, role: "AGENT" } });
  const b = await prisma.agent.create({ data: { fullName: `Агент Б ${run}`, phone: `+99292${run}`, role: "AGENT" } });
  created.agents.push(a.id, b.id);
  tokenA = signAccessToken({ sub: a.id, role: "AGENT" });

  const client = await prisma.client.create({
    data: { fullName: `${MARK} клиент`, phone: CLIENT_PHONE, source: "PHONE_CALL", assignedAgentId: b.id, acceptedAt: new Date() },
  });
  const property = await prisma.property.create({
    data: {
      title: `Объект Б ${run}`, type: "APARTMENT", areaSqm: 50, price: 40000, currency: "USD", districtId: district.id,
      address: `Тестовая ${run}`, condition: "GOOD", assignedAgentId: b.id, ownerContact: OWNER_PHONE,
    },
  });
  const deal = await prisma.deal.create({ data: { clientId: client.id, propertyId: property.id, agentId: b.id, stage: "NEGOTIATION" } });
  const interaction = await prisma.interaction.create({
    data: { clientId: client.id, propertyId: property.id, agentId: b.id, type: "CALL", notes: `${MARK} заметка звонка` },
  });
  const conversation = await prisma.botConversation.create({
    data: {
      channel: "WHATSAPP", subscriberId: CLIENT_PHONE.slice(1), clientId: client.id, name: `${MARK} диалог`,
      messages: [{ role: "user", text: `${MARK} текст переписки`, at: new Date().toISOString() }],
    },
  });
  Object.assign(ids, {
    clients: client.id, properties: property.id, deals: deal.id,
    interactions: interaction.id, conversations: conversation.id, agents: b.id,
  });
  Object.assign(shortIds, { clients: client.shortId, properties: property.shortId });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (ids.clients) {
    await prisma.botConversation.deleteMany({ where: { clientId: ids.clients } }).catch(() => {});
    await prisma.deal.deleteMany({ where: { clientId: ids.clients } }).catch(() => {});
    await prisma.interaction.deleteMany({ where: { clientId: ids.clients } }).catch(() => {});
    await prisma.client.deleteMany({ where: { id: ids.clients } }).catch(() => {});
  }
  if (ids.properties) await prisma.property.deleteMany({ where: { id: ids.properties } }).catch(() => {});
  await prisma.agent.deleteMany({ where: { id: { in: created.agents } } }).catch(() => {});
  if (created.district) await prisma.district.deleteMany({ where: { id: created.district } }).catch(() => {});
  await prisma.$disconnect();
});

describe("Маршруты закрыты по умолчанию", () => {
  it("без входа каждый маршрут, кроме списка публичных, отвечает requireAuth", async () => {
    const routes = allRoutes();
    expect(routes.length, "обход не нашёл маршрутов — сломан сборщик путей").toBeGreaterThan(300);

    const registered = new Set(routes.map(key));
    const stale = Object.keys(PUBLIC_ROUTES).filter((k) => !registered.has(k));
    expect(stale, `В списке публичных есть маршруты, которых больше нет:\n${stale.join("\n")}`).toEqual([]);

    const open: string[] = [];
    for (const route of routes) {
      if (PUBLIC_ROUTES[key(route)] || isPublicPrefix(route.path)) continue;
      // Поток событий держит соединение открытым; его вход проверяется отдельно.
      if (route.method === "GET" && route.path === "/api/v1/events") continue;
      const url = concretePath(route.path);
      const method = route.method.toLowerCase() as "get";
      const res = await request(server)[method](url).timeout(10_000).send(route.method === "GET" ? undefined : {});
      if (res.body?.error !== AUTH_REQUIRED) open.push(`${key(route)} -> ${res.status} ${String(res.text ?? "").slice(0, 80)}`);
    }
    expect(open, `Маршруты, открытые без входа (впишите в PUBLIC_ROUTES с причиной или закройте requireAuth):\n${open.join("\n")}`).toEqual([]);
  }, 600_000);

  it("агент А не видит данных клиента агента Б ни в одном GET-ответе", async () => {
    const needles = [MARK, CLIENT_PHONE.slice(4), OWNER_PHONE.slice(4)];
    const leaks: string[] = [];
    for (const route of allRoutes()) {
      if (route.method !== "GET") continue;
      if (PUBLIC_ROUTES[key(route)] || isPublicPrefix(route.path) || route.path === "/api/v1/events") continue;
      const url = `${concretePath(route.path)}?search=${MARK}&q=${MARK}`;
      const res = await request(server).get(url).set("Authorization", `Bearer ${tokenA}`).timeout(10_000);
      const body = String(res.text ?? "");
      const hits = needles.filter((n) => body.includes(n));
      if (hits.length) leaks.push(`${key(route)} -> ${res.status}: ${hits.join(", ")}`);
    }
    expect(leaks, `Чужие данные в ответах агенту:\n${leaks.join("\n")}`).toEqual([]);
  }, 600_000);

  it("метки ловятся: владелец данных их видит (проверка самого сторожа)", async () => {
    const tokenB = signAccessToken({ sub: ids.agents!, role: "AGENT" });
    const res = await request(server).get(`/api/v1/clients/${ids.clients}`).set("Authorization", `Bearer ${tokenB}`);
    expect(res.status).toBe(200);
    expect(String(res.text)).toContain(MARK);
    const conv = await request(server).get(`/api/v1/conversations/${ids.conversations}`).set("Authorization", `Bearer ${tokenB}`);
    expect(conv.status).toBe(200);
    expect(String(conv.text)).toContain(MARK);
  });
});
