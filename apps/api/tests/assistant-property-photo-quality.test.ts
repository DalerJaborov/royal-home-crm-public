import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import sharp from "sharp";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Качество фото в мастере объекта Telegram (решение владельца 10.11.2026):
 * сжатое Telegram'ом — ОДИН вопрос на черновик, «Оставить» — больше не
 * спрашиваем; HD и файл — молча; тёмное/пересвеченное/размытое — пометка в
 * карточке без отказа; язык — по собеседнику.
 */
const { sendMessage, sendMessageWithButtons, answerCallbackQuery, editMessageText, resolveFile } = vi.hoisted(() => ({
  sendMessage: vi.fn(async (_c: string, _t: string) => ({})),
  sendMessageWithButtons: vi.fn(async (_c: string, _t: string, _b: unknown) => ({ message_id: 601 })),
  answerCallbackQuery: vi.fn(async (_id: string, _text?: string) => ({})),
  editMessageText: vi.fn(async (_c: string, _m: number, _t: string, _b?: unknown) => {}),
  resolveFile: vi.fn(),
}));
vi.mock("../src/telegram/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/telegram/api.js")>()),
  sendMessage, sendMessageWithButtons, answerCallbackQuery, editMessageText, resolveTelegramFile: resolveFile,
}));
vi.mock("../src/ai/assistant.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/assistant.js")>()),
  isAiAssistantEnabled: async () => true,
}));

const { prisma } = await import("../src/db.js");
const { handleTelegramPropertyDraft, handleTelegramPropertyDraftCallback } = await import("../src/telegram/assistantPropertyDraft.js");
const { assessPhotoQuality, isTelegramCompressed } = await import("../src/lib/photoQuality.js");

const runId = String(Date.now()).slice(-7);
const agents: Record<string, { id: string; chatId: number; fullName: string }> = {};
let messageId = 100;
let callbackId = 1;
let tmp = "";
const images: Record<string, string> = {};

const noise = (mean: number, sigma: number) =>
  sharp({ create: { width: 900, height: 600, channels: 3, background: "#808080", noise: { type: "gaussian", mean, sigma } } });

async function mk(key: string, n: number) {
  const chatId = 830_000_000 + Number(runId) * 10 + n;
  const fullName = `Качество-${key} ${runId}`;
  const agent = await prisma.agent.create({ data: {
    fullName, phone: `+992${Math.floor(Math.random() * 900_000_000) + 100_000_000}`, role: "AGENT",
    passwordHash: await bcrypt.hash("testpass123", 4), telegramUserId: String(chatId), telegramChatId: String(chatId),
  } });
  agents[key] = { id: agent.id, chatId, fullName };
}
const send = (key: string, extra: Record<string, unknown>) => {
  const a = agents[key];
  return handleTelegramPropertyDraft({ message_id: messageId++, chat: { id: a.chatId, type: "private" }, from: { id: a.chatId }, ...extra } as never,
    { id: a.id, fullName: a.fullName }, async () => ({ error: "нет голоса" }));
};
const click = (key: string, data: string) => {
  const a = agents[key];
  return handleTelegramPropertyDraftCallback({ id: `cb-${runId}-${callbackId++}`, data, from: { id: a.chatId },
    message: { chat: { id: a.chatId, type: "private" }, message_id: 601, text: "вопрос" } } as never);
};
/** Снимок «как фото»: Telegram присылает несколько размеров, крупнейший — последним. */
const photo = (id: string, side: number) => ({ photo: [{ file_id: `${id}-s`, width: 320, height: 213 }, { file_id: id, width: side, height: Math.round(side * 2 / 3) }] });
const asks = () => sendMessageWithButtons.mock.calls.filter(call => /сжатыми|фишурда омаданд/u.test(String(call[1])));
const draftOf = (key: string) => prisma.propertyDraft.findUniqueOrThrow({ where: { agentId: agents[key].id }, include: { media: true } });
const useImage = (name: string) => resolveFile.mockResolvedValue({ kind: "path", path: images[name] });

beforeAll(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), "tg-quality-"));
  const write = async (name: string, image: sharp.Sharp) => {
    images[name] = path.join(tmp, `${name}.jpg`);
    await writeFile(images[name], await image.jpeg({ quality: 92 }).toBuffer());
  };
  await write("sharp", noise(128, 60));
  await write("dark", noise(18, 8));
  await write("bright", noise(245, 25));
  await write("blurry", noise(128, 60).blur(8));
  for (const [key, n] of [["keep", 1], ["file", 2], ["hd", 3], ["tg", 4]] as const) await mk(key, n);
});
beforeEach(() => {
  for (const m of [sendMessage, sendMessageWithButtons, answerCallbackQuery, editMessageText, resolveFile]) m.mockReset();
  sendMessageWithButtons.mockResolvedValue({ message_id: 601 });
});
afterAll(async () => {
  const ids = Object.values(agents).map(a => a.id);
  await prisma.telegramDialogState.deleteMany({ where: { agentId: { in: ids } } });
  await prisma.propertyDraft.deleteMany({ where: { agentId: { in: ids } } });
  await prisma.agent.deleteMany({ where: { id: { in: ids } } });
  await rm(tmp, { recursive: true, force: true });
});

describe("оценка снимка", () => {
  it("резкое — без пометок; тёмное, пересвеченное, размытое — каждое своей пометкой", async () => {
    const { readFile } = await import("node:fs/promises");
    expect(await assessPhotoQuality(await readFile(images.sharp))).toEqual([]);
    expect(await assessPhotoQuality(await readFile(images.dark))).toEqual(["dark"]);
    expect(await assessPhotoQuality(await readFile(images.bright))).toEqual(["bright"]);
    expect(await assessPhotoQuality(await readFile(images.blurry))).toEqual(["blurry"]);
  });

  it("сжатое — по самому крупному размеру: меньше 1600 px; HD 2560 и без размеров — нет", () => {
    expect(isTelegramCompressed(photo("a", 1280).photo)).toBe(true);
    expect(isTelegramCompressed(photo("a", 2560).photo)).toBe(false);
    expect(isTelegramCompressed(photo("a", 1600).photo)).toBe(false);
    expect(isTelegramCompressed([{ width: 1280, height: 960 }, { width: 2560, height: 1920 }])).toBe(false);
    expect(isTelegramCompressed([{}])).toBe(false);
    expect(isTelegramCompressed(undefined)).toBe(false);
  });
});

describe("вопрос про сжатые — один раз на черновик", () => {
  it("два сжатых фото — один вопрос; «Оставить эти» — фото на месте и больше не спрашиваем", async () => {
    await send("keep", { text: "добавь объект" });
    useImage("sharp");
    await send("keep", photo("k1", 1280));
    await send("keep", photo("k2", 1280));
    expect(asks()).toHaveLength(1);
    const [, text, buttons] = asks()[0];
    expect(text).toBe("📸 Фото пришли сжатыми — на сайте будут хуже. Лучше файлом: 📎 → Файл → выберите фото.");
    const flat = (buttons as { text: string; callback_data: string }[][]).flat();
    expect(flat.map(b => b.text)).toEqual(["✅ Оставить эти", "📎 Пришлю файлом"]);

    await click("keep", flat[0].callback_data);
    expect(answerCallbackQuery.mock.calls.at(-1)?.[1]).toBe("Хорошо, оставляем эти.");
    expect((await draftOf("keep")).media.filter(m => m.kind === "PHOTO")).toHaveLength(2);
    // Кнопки сняты — ответ один.
    expect(editMessageText.mock.calls.at(-1)?.[3]).toBeNull();

    sendMessageWithButtons.mockClear();
    await send("keep", photo("k3", 1280));
    expect(asks()).toHaveLength(0);
  });

  it("«Пришлю файлом» убирает сжатые из черновика; фото файлом — без вопроса", async () => {
    await send("file", { text: "добавь объект" });
    useImage("sharp");
    await send("file", photo("f1", 1280));
    const fileButton = (asks()[0][2] as { callback_data: string }[][]).flat()[1].callback_data;
    await send("file", { document: { file_id: "orig", mime_type: "image/jpeg", file_name: "room.jpg" } });
    await click("file", fileButton);
    expect(answerCallbackQuery.mock.calls.at(-1)?.[1]).toBe("Жду фото файлом. Сжатые (1) убрала из черновика.");
    const photos = (await draftOf("file")).media.filter(m => m.kind === "PHOTO");
    expect(photos).toHaveLength(1);
    expect(photos[0].qualityFlags).not.toContain("compressed");
    expect(asks()).toHaveLength(1);
  });

  it("HD-фото принимается молча; тёмное — пометка в карточке, без отказа", async () => {
    await send("hd", { text: "добавь объект" });
    useImage("dark");
    await send("hd", photo("h1", 2560));
    expect(asks()).toHaveLength(0);
    const draft = await draftOf("hd");
    expect(draft.media.filter(m => m.kind === "PHOTO")).toHaveLength(1);
    expect(draft.media[0].qualityFlags).toEqual(["dark"]);
    const card = String(sendMessageWithButtons.mock.calls.at(-1)?.[1] ?? "");
    expect(card).toContain("⚠️ фото 1 — тёмное");
  });

  it("собеседник на таджикском — вопрос на таджикском", async () => {
    await send("tg", { text: "объект илова кунед" });
    useImage("blurry");
    await send("tg", photo("t1", 1280));
    expect(asks()).toHaveLength(1);
    expect(String(asks()[0][1])).toContain("Аксҳо фишурда омаданд");
    const card = String(sendMessageWithButtons.mock.calls.at(-1)?.[1] ?? "");
    expect(card).toContain("⚠️ акс 1 — хира");
  });
});
