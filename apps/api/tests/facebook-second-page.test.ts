import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Вторая Страница Facebook (13.11.2026, Arvan estate). Основная Страница
 * (Royal.home.tj) работает через Settings, вторая подключается кнопкой и живёт
 * строкой MessengerAccount канала FACEBOOK без «по умолчанию». Здесь:
 *  - вторая Страница не забирает у основной диалоги без получателя и незнакомых
 *    получателей (иначе клиенту Royal Home ушёл бы маркер Arvan);
 *  - подключить можно только Страницу ключа компании с задачей «Сообщения»;
 *  - реклама со второй Страницы считается своей в расходах.
 */
const { prisma } = await import("../src/db.js");
const { encryptSecret } = await import("../src/crypto.js");
const eternal = await import("../src/lib/metaEternalTokens.js");
const { resolveIncomingAccount, accountTokenById, resetAccountsCache } = await import("../src/messengers/accounts.js");
const { loadOurPageIds } = await import("../src/lib/ads/adMatching.js");
const { GRAPH_VERSION } = await import("../src/messengers/meta.js");

const run = randomUUID().slice(0, 8);
const stamp = Date.now().toString().slice(-9);
const MAIN_PAGE = `8${stamp}1`;
const ARVAN_PAGE = `8${stamp}2`;
const NO_MSG_PAGE = `8${stamp}3`;
const MAIN_TOKEN = `stand-main-page-${run}`;
const ARVAN_TOKEN = `stand-arvan-page-${run}`;
const SYSTEM = `stand-system-${run}`;
const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;

let arvanId = "";
let before: Record<string, unknown> | null = null;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

beforeAll(async () => {
  await prisma.settings.upsert({ where: { id: "singleton" }, create: { id: "singleton" }, update: {} });
  before = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { metaIgManageToken: true, metaPageId: true, metaPageToken: true },
  });
  await prisma.settings.update({
    where: { id: "singleton" },
    data: { metaIgManageToken: encryptSecret(SYSTEM), metaPageId: MAIN_PAGE, metaPageToken: encryptSecret(MAIN_TOKEN) },
  });
  const row = await prisma.messengerAccount.create({
    data: { channel: "FACEBOOK", externalId: ARVAN_PAGE, title: `Arvan ${run}`, token: encryptSecret(ARVAN_TOKEN), isDefault: false },
  });
  arvanId = row.id;
  resetAccountsCache();
});

afterAll(async () => {
  await prisma.messengerAccount.deleteMany({ where: { id: arvanId } });
  if (before) await prisma.settings.update({ where: { id: "singleton" }, data: before });
  resetAccountsCache();
});

beforeEach(() => {
  eternal.resetMetaEternalCache();
  const fetchMock = vi.fn(async (input: string | URL) => {
    const url = String(input);
    if (url.startsWith(`${GRAPH}/me/accounts?`)) {
      return json({
        data: [
          { id: MAIN_PAGE, name: "Royal.home.tj", tasks: ["MANAGE", "MESSAGING"] },
          { id: ARVAN_PAGE, name: "Arvan estate", tasks: ["MESSAGING", "ADVERTISE"], instagram_business_account: { id: "17841464398378814" } },
          { id: NO_MSG_PAGE, name: "Только аналитика", tasks: ["ANALYZE"] },
        ],
      });
    }
    if (url.startsWith(`${GRAPH}/${ARVAN_PAGE}?fields=access_token`)) {
      return json({ id: ARVAN_PAGE, access_token: ARVAN_TOKEN, name: "Arvan estate", instagram_business_account: { id: "17841464398378814" } });
    }
    return json({ error: { message: `unexpected ${url}` } }, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

describe("вторая Страница не подменяет основную", () => {
  it("диалог без привязки к аккаунту (старые диалоги Royal Home) — маркер основной Страницы", async () => {
    const r = await accountTokenById(null, "FACEBOOK");
    expect(r.token).toBe(MAIN_TOKEN);
    expect(r.id).toBeNull();
  });

  it("входящее на вторую Страницу — её собственный маркер", async () => {
    const r = await resolveIncomingAccount("FACEBOOK", ARVAN_PAGE);
    expect(r.id).toBe(arvanId);
    expect(r.token).toBe(ARVAN_TOKEN);
  });

  it("незнакомый получатель не получает маркер основной Страницы (правило защиты не ослаблено)", async () => {
    const r = await resolveIncomingAccount("FACEBOOK", `7${stamp}9`);
    expect(r.token).not.toBe(MAIN_TOKEN);
  });
});

describe("подключение Страницы ключом компании", () => {
  it("Страница с задачей «Сообщения» — маркер от ключа компании и Instagram той же Страницы", async () => {
    const r = await eternal.facebookPageForConnect(ARVAN_PAGE);
    expect(r).toMatchObject({ ok: true, token: ARVAN_TOKEN, pageName: "Arvan estate", igId: "17841464398378814" });
  });

  it("без задачи «Сообщения» — отказ 409, маркер не берётся", async () => {
    const r = await eternal.facebookPageForConnect(NO_MSG_PAGE);
    expect(r).toMatchObject({ ok: false, status: 409 });
  });

  it("основная Страница из Настроек вторым путём не подключается", async () => {
    const r = await eternal.facebookPageForConnect(MAIN_PAGE);
    expect(r).toMatchObject({ ok: false, status: 409 });
  });

  it("Страница, не выданная системному пользователю, — 404", async () => {
    const r = await eternal.facebookPageForConnect(`7${stamp}8`);
    expect(r).toMatchObject({ ok: false, status: 404 });
  });

  it("список Страниц отмечает, где можно переписываться", async () => {
    const r = await eternal.listCompanyPages();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.pages.find((p) => p.id === ARVAN_PAGE)).toMatchObject({ canMessage: true, igId: "17841464398378814" });
    expect(r.pages.find((p) => p.id === NO_MSG_PAGE)).toMatchObject({ canMessage: false });
  });
});

describe("реклама со второй Страницы — своя", () => {
  it("в «наших Страницах» и основная, и подключённая", async () => {
    const ids = await loadOurPageIds();
    expect(ids.has(MAIN_PAGE)).toBe(true);
    expect(ids.has(ARVAN_PAGE)).toBe(true);
  });
});
