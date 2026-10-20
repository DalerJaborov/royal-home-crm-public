/**
 * Продление маркеров Instagram — ИЗ ВСЕХ ИСТОЧНИКОВ, а не только из копии в Настройках.
 *
 * 14.09.2026 выяснилось: `refreshInstagramTokenIfDue()` продлевала только
 * Settings.metaIgToken — копию, которой входящие сообщения не пользуются вовсе
 * (см. meta.ts/loadCredentials, accounts.ts/resolveIncomingAccount — оба смотрят
 * в первую очередь на MessengerAccount). Рабочие маркеры лежат в MessengerAccount
 * и умирали молча; у второго аккаунта («Royal Home Info») копии в Settings не
 * было вовсе — этот аккаунт был обречён гарантированно.
 *
 * Сеть закрыта: Graph API подменён через global fetch, база — через
 * vi.mock("../src/db.js"), тем же приёмом, что и tests/instagram-profile-cache.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Моки до импорта модуля — иначе реальные зависимости (и настоящая база) подтянутся первыми.
vi.mock("../src/db.js", () => ({
  prisma: {
    settings: {
      findUnique: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
    },
    messengerAccount: {
      findMany: vi.fn(),
      findFirst: vi.fn().mockResolvedValue(null),
      update: vi.fn().mockResolvedValue({}),
    },
    $disconnect: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock("../src/crypto.js", () => ({
  decryptSecretSafe: (v: string | null) => v,
  encryptSecret: (v: string) => `enc:${v}`,
}));
vi.mock("../src/lib/systemError.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/systemError.js")>()),
  logSystemError: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../src/lib/describeError.js", () => ({
  describeError: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));
vi.mock("../src/ai/geminiTransport.js", () => ({
  GEMINI_RETRY_DELAYS_MS: [],
  sleep: vi.fn(),
}));
vi.mock("../src/messengers/outgoingMids.js", () => ({
  rememberOutgoingMid: vi.fn(),
}));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { refreshInstagramTokenIfDue } from "../src/messengers/instagramFeed.js";
import { prisma } from "../src/db.js";
import { logSystemError } from "../src/lib/systemError.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function graphOkResponse(accessToken = "new-token") {
  return {
    ok: true,
    status: 200,
    text: async () => "",
    json: async () => ({ access_token: accessToken }),
  } as unknown as Response;
}

function graphFailResponse() {
  return {
    ok: false,
    status: 400,
    text: async () => "Invalid OAuth access token",
    json: async () => ({}),
  } as unknown as Response;
}

describe("refreshInstagramTokenIfDue", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Копия в Settings отсутствует по умолчанию в этих тестах: цель файла —
    // проверить именно ветку MessengerAccount, не смешивая её с прежним путём.
    (prisma.settings.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      metaIgToken: null,
      metaIgTokenRefreshedAt: null,
    });
  });

  it("(а) строка со старой отметкой продления попадает в продление", async () => {
    const old = new Date(Date.now() - 8 * DAY_MS);
    (prisma.messengerAccount.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "acc-1", title: "Royal Home", token: "old-token-1", tokenRefreshedAt: old, updatedAt: old },
    ]);
    mockFetch.mockResolvedValueOnce(graphOkResponse("fresh-token-1"));

    const result = await refreshInstagramTokenIfDue();

    expect(result).toEqual({ refreshed: 1, failed: 0 });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(prisma.messengerAccount.update).toHaveBeenCalledWith({
      where: { id: "acc-1" },
      data: { token: "enc:fresh-token-1", tokenRefreshedAt: expect.any(Date) },
    });
  });

  it("(б) строка со свежей отметкой пропускается — до сети дело не доходит", async () => {
    const fresh = new Date(Date.now() - 2 * DAY_MS);
    (prisma.messengerAccount.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "acc-2", title: "Royal Home Info", token: "token-2", tokenRefreshedAt: fresh, updatedAt: fresh },
    ]);

    const result = await refreshInstagramTokenIfDue();

    expect(result).toEqual({ refreshed: 0, failed: 0 });
    expect(mockFetch).not.toHaveBeenCalled();
    expect(prisma.messengerAccount.update).not.toHaveBeenCalled();
  });

  it("нет своей отметки продления — отсчёт от updatedAt, а не мгновенное продление", async () => {
    const freshUpdatedAt = new Date(Date.now() - 1 * DAY_MS);
    (prisma.messengerAccount.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: "acc-3",
        title: "Только что заведён",
        token: "token-3",
        tokenRefreshedAt: null,
        updatedAt: freshUpdatedAt,
      },
    ]);

    const result = await refreshInstagramTokenIfDue();

    expect(result).toEqual({ refreshed: 0, failed: 0 });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("(в) отказ по одному аккаунту не мешает продлить второй", async () => {
    const old = new Date(Date.now() - 10 * DAY_MS);
    (prisma.messengerAccount.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "acc-fail", title: "Сломанный", token: "bad-token", tokenRefreshedAt: old, updatedAt: old },
      { id: "acc-ok", title: "Рабочий", token: "good-token", tokenRefreshedAt: old, updatedAt: old },
    ]);
    mockFetch.mockResolvedValueOnce(graphFailResponse());
    mockFetch.mockResolvedValueOnce(graphOkResponse("fresh-token-ok"));

    const result = await refreshInstagramTokenIfDue();

    expect(result).toEqual({ refreshed: 1, failed: 1 });
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(prisma.messengerAccount.update).toHaveBeenCalledTimes(1);
    expect(prisma.messengerAccount.update).toHaveBeenCalledWith({
      where: { id: "acc-ok" },
      data: { token: "enc:fresh-token-ok", tokenRefreshedAt: expect.any(Date) },
    });
    // В журнале должно быть видно ИМЯ сломанного аккаунта, а не общее «что-то не так».
    expect(logSystemError).toHaveBeenCalledWith("meta", expect.stringContaining("Сломанный"));
  });

  it("Settings и MessengerAccount продлеваются независимо друг от друга", async () => {
    const oldSettings = new Date(Date.now() - 8 * DAY_MS);
    (prisma.settings.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      metaIgToken: "settings-token",
      metaIgTokenRefreshedAt: oldSettings,
    });
    (prisma.messengerAccount.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    mockFetch.mockResolvedValueOnce(graphOkResponse("fresh-settings-token"));

    const result = await refreshInstagramTokenIfDue();

    expect(result).toEqual({ refreshed: 1, failed: 0 });
    expect(prisma.settings.update).toHaveBeenCalledWith({
      where: { id: "singleton" },
      data: { metaIgToken: "enc:fresh-settings-token", metaIgTokenRefreshedAt: expect.any(Date) },
    });
    // Не только Settings — findMany по аккаунтам тоже реально вызывался.
    expect(prisma.messengerAccount.findMany).toHaveBeenCalled();
  });

  it("запасной маркер в Настройках не продлился при живом основном аккаунте — не авария", async () => {
    const old = new Date(Date.now() - 8 * DAY_MS);
    (prisma.settings.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      metaIgToken: "stale-settings-token",
      metaIgTokenRefreshedAt: old,
    });
    (prisma.messengerAccount.findFirst as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ token: "account-token" });
    (prisma.messengerAccount.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    mockFetch.mockResolvedValueOnce(graphFailResponse());
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await refreshInstagramTokenIfDue();

    // Продление всё равно пробовали (поле — запасной путь), но отказ не пишется
    // в журнал ошибок: этим маркером сейчас никто не пользуется.
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ refreshed: 0, failed: 0 });
    expect(logSystemError).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("без основного аккаунта отказ продления запасного маркера — ошибка, как раньше", async () => {
    const old = new Date(Date.now() - 8 * DAY_MS);
    (prisma.settings.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      metaIgToken: "stale-settings-token",
      metaIgTokenRefreshedAt: old,
    });
    (prisma.messengerAccount.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    mockFetch.mockResolvedValueOnce(graphFailResponse());

    const result = await refreshInstagramTokenIfDue();

    expect(result).toEqual({ refreshed: 0, failed: 1 });
    expect(logSystemError).toHaveBeenCalledWith("meta", expect.stringContaining("копия в Настройках"));
  });
});
