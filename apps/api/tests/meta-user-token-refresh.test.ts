import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/messengers/meta.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/messengers/meta.js")>()),
  fetchWithRetry: vi.fn(),
}));

import { prisma } from "../src/db.js";
import { decryptSecretSafe, encryptSecret } from "../src/crypto.js";
import { fetchWithRetry } from "../src/messengers/meta.js";
import { needsRefresh, refreshMetaUserTokensIfDue, type MetaTokenInfo } from "../src/lib/metaUserTokenRefresh.js";

/**
 * Автопродление маркеров Facebook Login (12.10.2026): маркер удаления Instagram и маркер Страницы.
 * Сети нет: ответы Meta (`/debug_token`, обмен `fb_exchange_token`) подменены. Единственная строка Settings
 * общая - значения сохраняются в beforeAll и возвращаются в afterAll.
 */

const mockedFetch = vi.mocked(fetchWithRetry);
const DAY = 24 * 60 * 60 * 1000;
const json = (body: unknown, ok = true) => ({ ok, status: ok ? 200 : 400, json: async () => body }) as unknown as Response;

let saved: { metaIgManageToken: string | null; metaPageToken: string | null; metaAppId: string | null; metaAppSecret: string | null } | null = null;

/** Meta: на /debug_token отвечаем описанием маркера, на обмен - новым маркером. */
function planMeta(info: { valid: boolean; type: string; expiresInDays: number; error?: string }, exchange: { ok: boolean; token?: string } = { ok: true, token: "fresh-60d" }) {
  mockedFetch.mockImplementation(async (url: unknown) => {
    const u = String(url);
    if (u.includes("/debug_token")) {
      return json({
        data: {
          is_valid: info.valid,
          type: info.type,
          expires_at: info.expiresInDays === 0 ? 0 : Math.floor((Date.now() + info.expiresInDays * DAY) / 1000),
          ...(info.error ? { error: { message: info.error } } : {}),
        },
      });
    }
    return exchange.ok ? json({ access_token: exchange.token }) : json({ error: { message: "exchange refused" } }, false);
  });
}

async function setTokens(data: { metaIgManageToken?: string | null; metaPageToken?: string | null }) {
  await prisma.settings.upsert({ where: { id: "singleton" }, create: { id: "singleton", ...data }, update: data });
}

const read = () => prisma.settings.findUniqueOrThrow({ where: { id: "singleton" }, select: { metaIgManageToken: true, metaPageToken: true } });

beforeAll(async () => {
  saved = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { metaIgManageToken: true, metaPageToken: true, metaAppId: true, metaAppSecret: true },
  });
});

beforeEach(async () => {
  mockedFetch.mockReset();
  await prisma.settings.upsert({
    where: { id: "singleton" },
    create: { id: "singleton", metaAppId: "123456", metaAppSecret: encryptSecret("app-secret") },
    update: { metaAppId: "123456", metaAppSecret: encryptSecret("app-secret"), metaIgManageToken: null, metaPageToken: null },
  });
});

afterAll(async () => {
  await prisma.settings.update({
    where: { id: "singleton" },
    data: {
      metaIgManageToken: saved?.metaIgManageToken ?? null,
      metaPageToken: saved?.metaPageToken ?? null,
      metaAppId: saved?.metaAppId ?? null,
      metaAppSecret: saved?.metaAppSecret ?? null,
    },
  });
});

describe("needsRefresh — когда пора менять маркер", () => {
  const base: MetaTokenInfo = { valid: true, type: "USER", expiresAt: new Date(Date.now() + 5 * DAY), error: null };
  it("пользовательский маркер, срок которого близок, - пора", () => expect(needsRefresh(base)).toBe(true));
  it("далёкий срок - рано", () => expect(needsRefresh({ ...base, expiresAt: new Date(Date.now() + 50 * DAY) })).toBe(false));
  it("бессрочный (Страница, системный пользователь) - не трогаем", () => {
    expect(needsRefresh({ ...base, expiresAt: null })).toBe(false);
    expect(needsRefresh({ ...base, type: "PAGE" })).toBe(false);
  });
  it("недействительный обменять нельзя", () => expect(needsRefresh({ ...base, valid: false })).toBe(false));
});

describe("refreshMetaUserTokensIfDue", () => {
  it("маркер удаления с коротким сроком меняется на новый 60-дневный", async () => {
    await setTokens({ metaIgManageToken: encryptSecret("short-1h") });
    planMeta({ valid: true, type: "USER", expiresInDays: 1 });
    const result = await refreshMetaUserTokensIfDue();
    expect(result.refreshed).toEqual(["Маркер удаления Instagram"]);
    expect(decryptSecretSafe((await read()).metaIgManageToken)).toBe("fresh-60d");
  });

  it("бессрочный маркер Страницы не обменивается и не перезаписывается", async () => {
    const stored = encryptSecret("page-forever");
    await setTokens({ metaPageToken: stored });
    planMeta({ valid: true, type: "PAGE", expiresInDays: 0 });
    const result = await refreshMetaUserTokensIfDue();
    expect(result).toEqual({ refreshed: [], failed: [] });
    expect((await read()).metaPageToken).toBe(stored);
    expect(mockedFetch.mock.calls.every((c) => String(c[0]).includes("/debug_token"))).toBe(true);
  });

  it("недействительный маркер: ничего не меняем, в итоге он в «не вышло»", async () => {
    const stored = encryptSecret("dead");
    await setTokens({ metaIgManageToken: stored });
    planMeta({ valid: false, type: "USER", expiresInDays: 0, error: "Session has expired" });
    const result = await refreshMetaUserTokensIfDue();
    expect(result.failed).toEqual(["Маркер удаления Instagram"]);
    expect((await read()).metaIgManageToken).toBe(stored);
  });

  it("Meta отказала в обмене: старый маркер остаётся, итог «не вышло»", async () => {
    const stored = encryptSecret("short");
    await setTokens({ metaIgManageToken: stored });
    planMeta({ valid: true, type: "USER", expiresInDays: 2 }, { ok: false });
    const result = await refreshMetaUserTokensIfDue();
    expect(result.failed).toEqual(["Маркер удаления Instagram"]);
    expect((await read()).metaIgManageToken).toBe(stored);
  });

  it("владелец вставил новый маркер, пока шёл обмен, - его не затираем", async () => {
    await setTokens({ metaIgManageToken: encryptSecret("old-short") });
    planMeta({ valid: true, type: "USER", expiresInDays: 1 });
    const newer = encryptSecret("owner-pasted-new");
    // Первый ответ Meta (описание маркера) приходит, а пока он «в пути», владелец сохраняет другой маркер.
    mockedFetch.mockImplementationOnce(async () => {
      await setTokens({ metaIgManageToken: newer });
      return json({ data: { is_valid: true, type: "USER", expires_at: Math.floor((Date.now() + DAY) / 1000) } });
    });
    const result = await refreshMetaUserTokensIfDue();
    expect(result.refreshed).toEqual([]);
    expect((await read()).metaIgManageToken).toBe(newer);
  });

  it("нет пары «приложение + секрет» - ничего не делаем и в сеть не ходим", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { metaAppId: null, metaAppSecret: null, metaIgManageToken: encryptSecret("x") } });
    const prevId = process.env.META_APP_ID;
    const prevSecret = process.env.META_APP_SECRET;
    delete process.env.META_APP_ID;
    delete process.env.META_APP_SECRET;
    try {
      const result = await refreshMetaUserTokensIfDue();
      expect(result).toEqual({ refreshed: [], failed: [] });
      expect(mockedFetch).not.toHaveBeenCalled();
    } finally {
      if (prevId !== undefined) process.env.META_APP_ID = prevId;
      if (prevSecret !== undefined) process.env.META_APP_SECRET = prevSecret;
    }
  });
});
