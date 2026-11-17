import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Продажа снимает основной ролик сама (29.10.2026): retireSocialAfterSale.
 * База и сети подменены — проверяется решение, а не сами вызовы Graph/Telegram
 * (их снятие проверяет published-video-fix.test.ts).
 */

const findProperty = vi.fn();
const findSettings = vi.fn();
vi.mock("../src/db.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/db.js")>()),
  prisma: {
    property: { findUnique: findProperty },
    settings: { findUnique: findSettings },
    $disconnect: vi.fn().mockResolvedValue(undefined),
  },
}));
const removeFromSocial = vi.fn();
vi.mock("../src/lib/publishedVideoFix.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/publishedVideoFix.js")>()),
  removeFromSocial,
}));
const editMessageCaption = vi.fn();
vi.mock("../src/telegram/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/telegram/api.js")>()),
  editMessageCaption,
}));
const createNotification = vi.fn();
vi.mock("../src/lib/notifications.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/notifications.js")>()),
  createNotification,
}));
const logSystemError = vi.fn();
vi.mock("../src/lib/systemError.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/systemError.js")>()),
  logSystemError,
}));

const { retireSocialAfterSale, isTelegramTooOldToDelete, soldTelegramCaption, manualRemovalBody } = await import(
  "../src/lib/propertySoldSocial.js"
);

const PROPERTY = {
  shortId: 412,
  publishedChannels: ["INSTAGRAM", "TELEGRAM", "TIKTOK"],
  intakeAgentId: "agent-intake",
  assignedAgentId: null,
  createdById: "agent-creator",
};

beforeEach(() => {
  vi.clearAllMocks();
  findSettings.mockResolvedValue({ telegramChannelId: "-100777" });
});

describe("retireSocialAfterSale", () => {
  it("ничего не опубликовано — снимать нечего, сети не трогаем", async () => {
    findProperty.mockResolvedValueOnce({ ...PROPERTY, publishedChannels: [] });
    expect(await retireSocialAfterSale("p1")).toBeNull();
    expect(removeFromSocial).not.toHaveBeenCalled();
  });

  it("старый пост Telegram не удаляется — подпись переписывается на «ПРОДАНО» в основном и доп. чатах", async () => {
    findProperty
      .mockResolvedValueOnce(PROPERTY)
      .mockResolvedValueOnce({ publishedPostIds: { TELEGRAM: "82", TELEGRAM_EXTRA: { "-100555": "9" } } });
    removeFromSocial.mockResolvedValueOnce({
      removed: ["INSTAGRAM"],
      failed: [{ channel: "TELEGRAM", error: "Telegram API deleteMessage: Bad Request: message can't be deleted" }],
      manual: [],
      notes: [],
    });

    const res = await retireSocialAfterSale("p1");

    expect(res?.telegramMarked).toBe(2);
    expect(editMessageCaption).toHaveBeenCalledWith("-100777", 82, soldTelegramCaption(412));
    expect(editMessageCaption).toHaveBeenCalledWith("-100555", 9, soldTelegramCaption(412));
  });

  it("Telegram отказал по другой причине — подпись не трогаем", async () => {
    findProperty.mockResolvedValueOnce(PROPERTY);
    removeFromSocial.mockResolvedValueOnce({
      removed: [],
      failed: [{ channel: "TELEGRAM", error: "Telegram API deleteMessage: timeout" }],
      manual: [],
      notes: [],
    });
    const res = await retireSocialAfterSale("p1");
    expect(res?.telegramMarked).toBe(0);
    expect(editMessageCaption).not.toHaveBeenCalled();
  });

  it("TikTok остаётся ручным — хозяин объекта получает уведомление со ссылкой", async () => {
    findProperty.mockResolvedValueOnce(PROPERTY);
    removeFromSocial.mockResolvedValueOnce({
      removed: ["INSTAGRAM", "TELEGRAM"],
      failed: [],
      manual: [{ channel: "TIKTOK", url: "https://www.tiktok.com/@royal/video/1", reason: "x" }],
      notes: [],
    });

    const res = await retireSocialAfterSale("p1");

    expect(res?.manualNotified).toBe(true);
    expect(createNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "agent-intake",
        url: "/properties/412",
        body: "TikTok: https://www.tiktok.com/@royal/video/1",
      })
    );
  });

  it("идёт публикация — снятие не начато, причина в журнале, ничего не правим", async () => {
    findProperty.mockResolvedValueOnce(PROPERTY);
    removeFromSocial.mockResolvedValueOnce({ removed: [], failed: [], manual: [], notes: [], blocked: "идёт публикация" });
    const res = await retireSocialAfterSale("p1");
    expect(res?.telegramMarked).toBe(0);
    expect(editMessageCaption).not.toHaveBeenCalled();
    expect(createNotification).not.toHaveBeenCalled();
    expect(logSystemError).toHaveBeenCalledWith("meta", expect.stringContaining("идёт публикация"));
  });
});

describe("правила текста", () => {
  it("узнаёт отказ Telegram по возрасту сообщения", () => {
    expect(isTelegramTooOldToDelete("Bad Request: message can't be deleted")).toBe(true);
    expect(isTelegramTooOldToDelete("Bad Request: message to delete not found")).toBe(false);
  });

  it("ссылки нет — человек получает подсказку, а не пустоту", () => {
    expect(manualRemovalBody([{ channel: "TIKTOK", url: null, reason: "x" }])).toBe(
      "TikTok: ссылки нет — найдите ролик в приложении"
    );
  });
});
