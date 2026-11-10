import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * СВОЙ BOT API-СЕРВЕР (прод, `--local`): ролик больше 20 МБ мастер объекта в
 * Telegram принимает — предел 2000 МБ локального сервера, а не 20 МБ облака
 * (владелец 10.11.2026: «у меня до 2 гб на моем сервере»). Файл читается с диска
 * частями по 8 МБ.
 */
const LOCAL_LIMIT = 2000 * 1024 * 1024;
const { sendMessage, sendMessageWithButtons, resolveFile } = vi.hoisted(() => ({
  sendMessage: vi.fn(async () => ({})),
  sendMessageWithButtons: vi.fn(async () => ({ message_id: 501 })),
  resolveFile: vi.fn(),
}));
vi.mock("../src/telegram/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/telegram/api.js")>()),
  IS_LOCAL_BOT_API: true,
  TELEGRAM_BOT_DOWNLOAD_LIMIT_BYTES: LOCAL_LIMIT,
  sendMessage, sendMessageWithButtons, resolveTelegramFile: resolveFile,
}));
vi.mock("../src/ai/assistant.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/assistant.js")>()),
  isAiAssistantEnabled: async () => true,
}));

const { prisma } = await import("../src/db.js");
const { handleTelegramPropertyDraft, TELEGRAM_DRAFT_VIDEO_LIMIT_BYTES } = await import("../src/telegram/assistantPropertyDraft.js");
const { localVideoDelete } = await import("../src/lib/localVideoStorage.js");

const runId = String(Date.now()).slice(-7);
const chatId = 810_000_000 + Number(runId);
let agentId = "";
let tmp = "";

beforeAll(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), "tg-local-"));
  agentId = (await prisma.agent.create({ data: {
    fullName: `Локальный ${runId}`, phone: `+992${Math.floor(Math.random() * 900_000_000) + 100_000_000}`, role: "AGENT",
    passwordHash: await bcrypt.hash("testpass123", 4), telegramUserId: String(chatId), telegramChatId: String(chatId),
  } })).id;
});

afterAll(async () => {
  const media = await prisma.propertyDraftMedia.findMany({ where: { draft: { agentId } } });
  await Promise.all(media.map(m => m.storageKey ? localVideoDelete(m.storageKey).catch(() => {}) : null));
  await prisma.telegramDialogState.deleteMany({ where: { agentId } });
  await prisma.propertyDraft.deleteMany({ where: { agentId } });
  await prisma.agent.delete({ where: { id: agentId } });
  await rm(tmp, { recursive: true, force: true });
});

const send = (message_id: number, extra: Record<string, unknown>) => handleTelegramPropertyDraft(
  { message_id, chat: { id: chatId, type: "private" }, from: { id: chatId }, ...extra } as never,
  { id: agentId, fullName: "Локальный" }, async () => ({ error: "нет" }));

describe("мастер объекта на своём Bot API-сервере", () => {
  it("предел ролика — 2000 МБ, а не 20 МБ облака", () => {
    expect(TELEGRAM_DRAFT_VIDEO_LIMIT_BYTES).toBe(LOCAL_LIMIT);
  });

  it("ролик 25 МБ с диска сервера попадает в черновик тремя частями по 8 МБ и хвостом", async () => {
    const size = 25 * 1024 * 1024;
    const file = path.join(tmp, "big.mp4");
    const handle = await open(file, "w");
    await handle.truncate(size);
    await handle.close();
    resolveFile.mockResolvedValue({ kind: "path", path: file });
    await send(1, { text: "добавь объект" });
    await send(2, { video: { file_id: "big", file_size: size, mime_type: "video/mp4" } });
    const video = (await prisma.propertyDraftMedia.findMany({ where: { draft: { agentId }, kind: "VIDEO" } }))[0];
    expect(video).toMatchObject({ status: "READY", sizeBytes: size, totalParts: 4 });
    // Таймаут getFile — общий (свой сервер сначала сам докачивает файл у Telegram).
    expect(resolveFile).toHaveBeenCalledWith("big", LOCAL_LIMIT);
    expect(String((sendMessageWithButtons.mock.calls.at(-1) as unknown[] | undefined)?.[1])).toContain("Видео добавлено");
  });
});
