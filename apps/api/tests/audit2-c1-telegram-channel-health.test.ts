import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * АУДИТ CODEX 04.10.2026, CHANNEL-NEW-15: ОСНОВНОЙ TELEGRAM-КАНАЛ СЧИТАЛСЯ ИСПРАВНЫМ БЕЗ ПРАВА ПУБЛИКАЦИИ.
 *
 * checkTelegramChannelHealth звала только getChat и при успехе возвращала ok:true; право писать
 * (can_post_messages, kicked/left) проверяли лишь дополнительные чаты. Директор видел зелёное
 * состояние до фактического отказа публикации. Теперь обе проверки идут одним правилом.
 */
const getChatTitle = vi.hoisted(() => vi.fn());
const getChatMemberStatus = vi.hoisted(() => vi.fn());
vi.mock("../src/telegram/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/telegram/api.js")>()),
  isTelegramEnabled: () => true,
  getChatTitle,
  getChatMemberStatus,
}));
const logSystemError = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../src/lib/systemError.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/systemError.js")>()),
  logSystemError,
}));

const { prisma } = await import("../src/db.js");
const { checkTelegramChannelHealth } = await import("../src/lib/integrationHealth.js");

let savedChannelId: string | null = null;

beforeAll(async () => {
  const s = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { telegramChannelId: true } });
  savedChannelId = s?.telegramChannelId ?? null;
  await prisma.settings.update({ where: { id: "singleton" }, data: { telegramChannelId: "-1001234567890" } });
});
afterAll(async () => {
  await prisma.settings.update({ where: { id: "singleton" }, data: { telegramChannelId: savedChannelId } });
  await prisma.$disconnect();
});
beforeEach(() => {
  getChatTitle.mockReset().mockResolvedValue("Royal Home канал");
  getChatMemberStatus.mockReset();
  logSystemError.mockClear();
});

describe("checkTelegramChannelHealth: право публикации", () => {
  it("администратор без can_post_messages: ok=false и запись в журнал ошибок", async () => {
    getChatMemberStatus.mockResolvedValue({ status: "administrator", can_post_messages: false });
    const res = await checkTelegramChannelHealth();
    expect(res.ok).toBe(false);
    expect(logSystemError).toHaveBeenCalledOnce();
  });

  it.each(["left", "kicked"])("бот в статусе %s: ok=false", async (status) => {
    getChatMemberStatus.mockResolvedValue({ status });
    const res = await checkTelegramChannelHealth();
    expect(res.ok).toBe(false);
    expect(logSystemError).toHaveBeenCalledOnce();
  });

  it("администратор с правом публикации: ok=true, журнал молчит", async () => {
    getChatMemberStatus.mockResolvedValue({ status: "administrator", can_post_messages: true });
    const res = await checkTelegramChannelHealth();
    expect(res.ok).toBe(true);
    expect(logSystemError).not.toHaveBeenCalled();
  });
});
