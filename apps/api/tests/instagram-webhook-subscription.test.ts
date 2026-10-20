import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import { resetAccountsCache, saveAccount } from "../src/messengers/accounts.js";
import {
  checkInstagramSubscriptions,
  ensureInstagramSubscription,
  findSilentInstagramAccounts,
  parseSubscribedAppIds,
  parseSubscribedFields,
  REQUIRED_INSTAGRAM_FIELDS,
} from "../src/lib/instagramWebhookSubscription.js";

/**
 * Подписка аккаунтов Instagram на наши уведомления (02.10.2026).
 *
 * С 21.09 Meta перестала присылать события Royal Home Info — ни писем, ни
 * комментариев, — и в «Диалогах» под этим аккаунтом последней осталась
 * переписка 21 сентября. CRM подписку не проверяла вовсе; теперь проверяет,
 * восстанавливает и замечает замолчавший аккаунт.
 */

const IG_A = "17841400000301";
const IG_B = "17841400000302";

async function clear() {
  await prisma.botConversation.deleteMany({ where: { subscriberId: { startsWith: "test-igsub-" } } });
  await prisma.messengerAccount.deleteMany({ where: { externalId: { in: [IG_A, IG_B] } } });
  resetAccountsCache();
}

beforeEach(clear);
afterEach(() => vi.unstubAllGlobals());
afterAll(clear);

describe("ответ Meta о подписке", () => {
  it("собирает поля и строками, и объектами", () => {
    expect(
      parseSubscribedFields({ data: [{ subscribed_fields: ["messages", { name: "comments" }] }, { subscribed_fields: ["messages"] }] })
    ).toEqual(["messages", "comments"]);
    expect(parseSubscribedFields({ data: [] })).toEqual([]);
    expect(parseSubscribedFields("мусор")).toEqual([]);
  });

  it("достаёт, на какие приложения подписан аккаунт", () => {
    expect(parseSubscribedAppIds({ data: [{ id: "18085797515299054", subscribed_fields: ["messages"] }] })).toEqual([
      "18085797515299054",
    ]);
    expect(parseSubscribedAppIds({ data: [{ subscribed_fields: ["messages"] }] })).toEqual([]);
  });
});

describe("проверка и починка подписки", () => {
  function stub(getBody: unknown, postBody: unknown = { success: true }, getStatus = 200) {
    const calls: Array<{ url: string; method: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: { method?: string }) => {
        const method = init?.method ?? "GET";
        calls.push({ url: decodeURIComponent(String(url)), method });
        if (method === "POST") return new Response(JSON.stringify(postBody), { status: 200 });
        return new Response(JSON.stringify(getBody), { status: getStatus });
      })
    );
    return calls;
  }

  it("всё на месте — ничего не трогает", async () => {
    const calls = stub({ data: [{ subscribed_fields: [...REQUIRED_INSTAGRAM_FIELDS, "message_reactions"] }] });
    const outcome = await ensureInstagramSubscription("tok");
    expect(outcome.status).toBe("ok");
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("подписка слетела — подписывает заново, не теряя прежних полей", async () => {
    const calls = stub({ data: [{ subscribed_fields: ["message_reactions"] }] });
    const outcome = await ensureInstagramSubscription("tok");
    expect(outcome.status).toBe("restored");
    if (outcome.status !== "restored") return;
    expect(outcome.missing).toEqual([...REQUIRED_INSTAGRAM_FIELDS]);
    const post = calls.find((c) => c.method === "POST");
    expect(post?.url).toContain("/me/subscribed_apps?subscribed_fields=");
    for (const f of [...REQUIRED_INSTAGRAM_FIELDS, "message_reactions"]) expect(post?.url).toContain(f);
  });

  it("пустой ответ (аккаунт не подписан вовсе) — тоже восстанавливает", async () => {
    stub({ data: [] });
    expect((await ensureInstagramSubscription("tok")).status).toBe("restored");
  });

  it("отказ Meta — честный «не смог», без подписки вслепую", async () => {
    const calls = stub({ error: { message: "Invalid OAuth access token" } }, { success: true }, 400);
    const outcome = await ensureInstagramSubscription("tok");
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") expect(outcome.error).toContain("Invalid OAuth access token");
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("Meta не приняла подписку — тоже «не смог»", async () => {
    stub({ data: [] }, { success: false });
    expect((await ensureInstagramSubscription("tok")).status).toBe("failed");
  });

  it("сеть упала — «не смог», без исключения наружу", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("fetch failed");
      })
    );
    expect((await ensureInstagramSubscription("tok")).status).toBe("failed");
  });
});

describe("аккаунты на разных приложениях", () => {
  it("называет оба аккаунта и их приложения в журнале", async () => {
    await saveAccount({ channel: "INSTAGRAM", externalId: IG_A, title: "Тест А", token: "t-app-a", isDefault: true });
    await saveAccount({ channel: "INSTAGRAM", externalId: IG_B, title: "Тест Б", token: "t-app-b" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: { headers?: Record<string, string> }) => {
        const sent = `${decodeURIComponent(String(url))} ${init?.headers?.Authorization ?? ""}`;
        const app = sent.includes("t-app-b") ? "app-bbb" : "app-aaa";
        return new Response(JSON.stringify({ data: [{ id: app, subscribed_fields: [...REQUIRED_INSTAGRAM_FIELDS] }] }), {
          status: 200,
        });
      })
    );
    await checkInstagramSubscriptions();
    const row = await prisma.errorLog.findFirst({
      where: { source: "meta", message: { contains: "разные приложения" } },
      orderBy: { createdAt: "desc" },
    });
    expect(row?.message).toContain("«Тест А» — app-aaa");
    expect(row?.message).toContain("«Тест Б» — app-bbb");
  });
});

describe("сторож тишины", () => {
  async function seed(accountId: string, prefix: string, count: number, at: Date) {
    await prisma.botConversation.createMany({
      data: Array.from({ length: count }, (_, i) => ({
        channel: "INSTAGRAM",
        subscriberId: `test-igsub-${prefix}-${i}`,
        accountId,
        lastMessageAt: at,
      })),
    });
  }

  async function accounts() {
    const a = await saveAccount({ channel: "INSTAGRAM", externalId: IG_A, title: "Тест А", token: "t-a", isDefault: true });
    const b = await saveAccount({ channel: "INSTAGRAM", externalId: IG_B, title: "Тест Б", token: "t-b" });
    return { a, b };
  }

  const now = new Date();
  const daysAgo = (d: number) => new Date(now.getTime() - d * 24 * 60 * 60 * 1000);

  it("замечает аккаунт, который молчит, пока соседний получает письма", async () => {
    const { a, b } = await accounts();
    await seed(a, "a", 3, daysAgo(0.5));
    await seed(b, "b", 12, daysAgo(11));
    const silent = (await findSilentInstagramAccounts(now)).filter((s) => [a, b].includes(s.id));
    expect(silent.map((s) => s.title)).toEqual(["Тест Б"]);
  });

  it("тихо у всех — не тревога (выходные, а не поломка)", async () => {
    const { a, b } = await accounts();
    await seed(a, "a", 12, daysAgo(5));
    await seed(b, "b", 12, daysAgo(6));
    const silent = (await findSilentInstagramAccounts(now)).filter((s) => [a, b].includes(s.id));
    expect(silent).toEqual([]);
  });

  it("у аккаунта почти нет истории — по паузе не судим", async () => {
    const { a, b } = await accounts();
    await seed(a, "a", 3, daysAgo(0.5));
    await seed(b, "b", 2, daysAgo(11));
    const silent = (await findSilentInstagramAccounts(now)).filter((s) => [a, b].includes(s.id));
    expect(silent).toEqual([]);
  });
});
