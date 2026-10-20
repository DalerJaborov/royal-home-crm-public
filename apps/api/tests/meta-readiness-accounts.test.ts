/**
 * ГОТОВНОСТЬ INSTAGRAM СЧИТАЕТ И СПИСОК «АККАУНТЫ INSTAGRAM» (28.09.2026).
 *
 * До правки Настройки считали готовность каналов Meta только по одиночным полям
 * Settings (routes/settings.ts), а «Центр управления» и «Маркетинг» — по одному
 * полю Settings.metaIgToken. Бот и публикация тем временем брали маркер основного
 * аккаунта из MessengerAccount (meta.ts/loadCredentials). Итог: завёл аккаунт
 * списком, запасное поле пустое — экраны пишут «ключи не заполнены», рубильник
 * бота в Instagram выключен, а бот при этом работает.
 *
 * Проверяем единый источник `loadMetaReadiness()`: он видит маркер аккаунта, не
 * путает его с запасным полем и по-прежнему работает без аккаунтов. База — через
 * vi.mock, тем же приёмом, что tests/instagram-token-refresh.test.ts: общая
 * строка Settings в живой базе делится со всеми тестами, трогать её нельзя.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../src/db.js", () => ({
  prisma: {
    settings: { findUnique: vi.fn() },
    messengerAccount: { findFirst: vi.fn(), findMany: vi.fn() },
    $disconnect: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock("../src/crypto.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/crypto.js")>()),
  decryptSecretSafe: (v: string | null) => v,
  encryptSecret: (v: string) => `enc:${v}`,
}));
vi.mock("../src/lib/systemError.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/systemError.js")>()),
  logSystemError: vi.fn().mockResolvedValue(undefined),
}));

import { prisma } from "../src/db.js";
import { loadMetaReadiness, resetMetaAccountCredsCache } from "../src/messengers/meta.js";

const findUnique = prisma.settings.findUnique as ReturnType<typeof vi.fn>;
const findFirst = prisma.messengerAccount.findFirst as ReturnType<typeof vi.fn>;
const findMany = prisma.messengerAccount.findMany as ReturnType<typeof vi.fn>;

const ENV_KEYS = ["META_APP_SECRET", "META_VERIFY_TOKEN", "META_IG_TOKEN", "META_IG_APP_SECRET", "META_WA_TOKEN", "META_PAGE_TOKEN"];

describe("loadMetaReadiness", () => {
  afterEach(() => vi.unstubAllEnvs());
  beforeEach(() => {
    vi.clearAllMocks();
    resetMetaAccountCredsCache();
    for (const k of ENV_KEYS) vi.stubEnv(k, "");
    findUnique.mockResolvedValue({
      metaAppSecret: "app-secret",
      metaVerifyToken: "verify",
      metaWaToken: null,
      metaWaPhoneId: null,
      metaIgToken: null,
      metaIgAppSecret: null,
      metaPageToken: null,
      metaPageId: null,
    });
  });

  it("запасное поле пустое, но основной аккаунт списка с маркером — Instagram готов", async () => {
    const account = { channel: "INSTAGRAM", externalId: "ig-1", messagingId: null, enabled: true, isDefault: true, token: "acc-token" };
    findFirst.mockResolvedValue(account);
    findMany.mockResolvedValue([account]);

    const r = await loadMetaReadiness();

    expect(r.channelsConfigured).toContain("INSTAGRAM");
    expect(r.igTokenAvailable).toBe(true);
    expect(r.igTokenFromAccount).toBe(true);
  });

  it("аккаунтов нет, маркер только в поле Настроек — готов по запасному пути", async () => {
    findUnique.mockResolvedValue({ ...(await findUnique()), metaIgToken: "settings-token" });
    findFirst.mockResolvedValue(null);
    findMany.mockResolvedValue([]);

    const r = await loadMetaReadiness();

    expect(r.channelsConfigured).toContain("INSTAGRAM");
    expect(r.igTokenAvailable).toBe(true);
    expect(r.igTokenFromAccount).toBe(false);
  });

  it("ни аккаунта, ни поля — Instagram не готов и маркера нет", async () => {
    findFirst.mockResolvedValue(null);
    findMany.mockResolvedValue([]);

    const r = await loadMetaReadiness();

    expect(r.channelsConfigured).not.toContain("INSTAGRAM");
    expect(r.igTokenAvailable).toBe(false);
    expect(r.igTokenFromAccount).toBe(false);
  });

  it("выключенный аккаунт не делает канал готовым", async () => {
    findFirst.mockResolvedValue(null); // findFirst ищет только enabled — выключенный не найден
    findMany.mockResolvedValue([
      { channel: "INSTAGRAM", externalId: "ig-off", messagingId: null, enabled: false, isDefault: true, token: "acc-token" },
    ]);

    const r = await loadMetaReadiness();

    expect(r.channelsConfigured).not.toContain("INSTAGRAM");
    expect(r.igTokenAvailable).toBe(false);
  });
});
