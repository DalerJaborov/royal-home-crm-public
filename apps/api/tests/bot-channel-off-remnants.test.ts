import { beforeEach, describe, expect, it, vi } from "vitest";

/** Остатки #266 (18.11.2026): `arvan` под постами по аккаунту комментария; сбой чтения бренда — выключено + журнал. Без базы. */
const mocks = vi.hoisted(() => ({ findAccount: vi.fn(), findConversation: vi.fn(), log: vi.fn(async () => undefined), brand: vi.fn() }));
vi.mock("../src/db.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/db.js")>()),
  prisma: { messengerAccount: { findFirst: mocks.findAccount }, botConversation: { findUnique: mocks.findConversation }, $disconnect: async () => undefined } }));
vi.mock("../src/lib/systemError.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/lib/systemError.js")>()), logSystemError: mocks.log }));
vi.mock("../src/messengers/accounts.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/messengers/accounts.js")>()), accountBrandName: mocks.brand }));

import { isCustomerAgentCommentOff, isCustomerAgentTurnOff } from "../src/lib/customerAgentChannelOff.js";

const ARVAN = { CUSTOMER_AGENT_CHANNEL_OFF: "arvan" };
beforeEach(() => { vi.clearAllMocks(); });

describe("комментарии: ключ `arvan` по аккаунту комментария", () => {
  it("пустой рубильник — false без чтения базы", async () => {
    expect(await isCustomerAgentCommentOff({ channel: "INSTAGRAM", accountExternalId: "x" }, {})).toBe(false);
    expect(mocks.findAccount).not.toHaveBeenCalled();
  });
  it("комментарий под постом Арвана — выключен; под постом Royal Home — нет", async () => {
    mocks.findAccount.mockResolvedValueOnce({ brandName: "Арван" });
    expect(await isCustomerAgentCommentOff({ channel: "INSTAGRAM", accountExternalId: "arvan-ig" }, ARVAN)).toBe(true);
    mocks.findAccount.mockResolvedValueOnce({ brandName: null });
    expect(await isCustomerAgentCommentOff({ channel: "INSTAGRAM", accountExternalId: "rh-ig" }, ARVAN)).toBe(false);
  });
  it("YouTube и Telegram ключом `arvan` не задеваются; `instagram` глушит все аккаунты канала", async () => {
    expect(await isCustomerAgentCommentOff({ channel: "YOUTUBE", accountExternalId: null }, ARVAN)).toBe(false);
    expect(await isCustomerAgentCommentOff({ channel: "INSTAGRAM", accountExternalId: "rh-ig" }, { CUSTOMER_AGENT_CHANNEL_OFF: "instagram" })).toBe(true);
  });
  it("сбой чтения аккаунта при `arvan` — выключено и строка журнала", async () => {
    mocks.findAccount.mockRejectedValueOnce(new Error("db down"));
    expect(await isCustomerAgentCommentOff({ channel: "FACEBOOK", accountExternalId: "page" }, ARVAN)).toBe(true);
    expect(mocks.log).toHaveBeenCalledWith("ai", expect.stringContaining("считается выключенным"), expect.anything());
  });
});

describe("ход переписки: сбой чтения бренда", () => {
  it("при `arvan` сбой чтения — выключено + журнал (раньше молча включал бота)", async () => {
    mocks.brand.mockRejectedValueOnce(new Error("cache miss"));
    expect(await isCustomerAgentTurnOff({ channel: "INSTAGRAM", accountId: "acc" }, ARVAN)).toBe(true);
    expect(mocks.log).toHaveBeenCalledTimes(1);
  });
  it("без `arvan` чтения нет вовсе", async () => {
    expect(await isCustomerAgentTurnOff({ channel: "INSTAGRAM", accountId: "acc" }, { CUSTOMER_AGENT_CHANNEL_OFF: "website" })).toBe(false);
    expect(mocks.brand).not.toHaveBeenCalled();
  });
});
