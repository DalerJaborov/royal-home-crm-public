import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import sharp from "sharp";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Находки ревью мастера объекта в Telegram (10.11.2026): честный разбор чисел,
 * видео — удаляется только своя только что начатая загрузка, обрыв и повтор,
 * зависшая загрузка снимается кнопкой, кнопки с ревизией черновика, роль только
 * для чтения, личка против группы, подтверждение альбома, повторная проверка
 * дубля в момент создания, расширение ролика по типу файла.
 */
const { sendMessage, sendMessageWithButtons, answerCallbackQuery, editMessageText, resolveFile } = vi.hoisted(() => ({
  sendMessage: vi.fn(async (_c: string, _t: string) => ({})),
  sendMessageWithButtons: vi.fn(async (_c: string, _t: string, _b: unknown) => ({ message_id: 501 })),
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
vi.mock("../src/lib/landmarkPick.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/landmarkPick.js")>()),
  suggestLandmarksForPoint: async () => ({ text: "", landmarks: [] }),
}));

const { prisma } = await import("../src/db.js");
const draftModule = await import("../src/telegram/assistantPropertyDraft.js");
const { handleTelegramPropertyDraft, handleTelegramPropertyDraftCallback, telegramVideoFilename, setAlbumQuietMsForTests } = draftModule;
const { labeledPropertyFields } = await import("../src/telegram/assistantPropertyFields.js");
const { startDraftVideoSession } = await import("../src/lib/propertyDraftMedia.js");
const { localVideoDelete } = await import("../src/lib/localVideoStorage.js");
const { formatPropertyCode } = await import("@royal-home/shared");

const runId = String(Date.now()).slice(-7);
const agents: Record<string, { id: string; chatId: number; fullName: string }> = {};
let messageId = 100;
let callbackId = 1;
let tmp = "";

async function mk(key: string, n: number, role: string) {
  const chatId = 820_000_000 + Number(runId) * 10 + n;
  const fullName = `Ревью-${key} ${runId}`;
  const agent = await prisma.agent.create({ data: {
    fullName, phone: `+992${Math.floor(Math.random() * 900_000_000) + 100_000_000}`, role: role as "AGENT",
    passwordHash: await bcrypt.hash("testpass123", 4), telegramUserId: String(chatId), telegramChatId: String(chatId),
  } });
  agents[key] = { id: agent.id, chatId, fullName };
}
const send = (key: string, extra: Record<string, unknown>, type = "private") => {
  const a = agents[key];
  return handleTelegramPropertyDraft({ message_id: messageId++, chat: { id: a.chatId, type }, from: { id: a.chatId }, ...extra } as never,
    { id: a.id, fullName: a.fullName }, async () => ({ error: "нет голоса" }));
};
const click = (key: string, data: string) => {
  const a = agents[key];
  return handleTelegramPropertyDraftCallback({ id: `cb-${runId}-${callbackId++}`, data, from: { id: a.chatId },
    message: { chat: { id: a.chatId, type: "private" }, message_id: 501 } } as never);
};
const lastText = () => String(sendMessageWithButtons.mock.calls.at(-1)?.[1] ?? "");
const lastButtons = () => ((sendMessageWithButtons.mock.calls.at(-1)?.[2] ?? []) as { text: string; callback_data?: string }[][]).flat();
const button = (prefix: string) => lastButtons().find(b => b.callback_data?.startsWith(prefix))?.callback_data;
const draftOf = (key: string) => prisma.propertyDraft.findUniqueOrThrow({ where: { agentId: agents[key].id }, include: { media: true } });
const videos = async (key: string) => (await draftOf(key)).media.filter(m => m.kind === "VIDEO");
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

beforeAll(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), "tg-review-"));
  await mk("author", 1, "AGENT");
  await mk("holder", 2, "SHAREHOLDER");
});
beforeEach(() => {
  for (const m of [sendMessage, sendMessageWithButtons, answerCallbackQuery, editMessageText, resolveFile]) m.mockReset();
  sendMessageWithButtons.mockResolvedValue({ message_id: 501 });
});
afterAll(async () => {
  const ids = Object.values(agents).map(a => a.id);
  const media = await prisma.propertyDraftMedia.findMany({ where: { draft: { agentId: { in: ids } } } });
  await Promise.all(media.map(m => m.storageKey ? localVideoDelete(m.storageKey).catch(() => {}) : null));
  await prisma.telegramDialogState.deleteMany({ where: { agentId: { in: ids } } });
  await prisma.propertyDraft.deleteMany({ where: { agentId: { in: ids } } });
  await prisma.property.deleteMany({ where: { OR: [{ title: { contains: runId } }, { createdById: { in: ids } }] } });
  await prisma.client.deleteMany({ where: { OR: [{ fullName: { contains: runId } }, { assignedAgentId: { in: ids } }] } });
  await prisma.district.deleteMany({ where: { name: { contains: runId } } });
  await prisma.agent.deleteMany({ where: { id: { in: ids } } });
  await rm(tmp, { recursive: true, force: true });
});

describe("числа и имена файлов", () => {
  it("числа разбираются честно, а сомнительное уходит ИИ", () => {
    expect(labeledPropertyFields("Площадь: 68м2")).toEqual({ areaSqm: "68" });
    expect(labeledPropertyFields("Площадь: 68,5 кв.м")).toEqual({ areaSqm: "68.5" });
    expect(labeledPropertyFields("Этаж: 5/9")).toEqual({ floor: "5", totalFloors: "9" });
    expect(labeledPropertyFields("Этаж: 5 из 9")).toEqual({ floor: "5", totalFloors: "9" });
    expect(labeledPropertyFields("Цена: 120 тысяч")).toEqual({ price: "120000" });
    expect(labeledPropertyFields("Цена: 1.5 млн долларов")).toEqual({ price: "1500000", currency: "USD" });
    expect(labeledPropertyFields("Цена: 950 000 сомони")).toEqual({ price: "950000", currency: "TJS" });
    expect(labeledPropertyFields("Сотки: 6 соток")).toEqual({ landAreaSotka: "6" });
    expect(labeledPropertyFields("Цена: 1,200")).toBeNull();
    expect(labeledPropertyFields("Этаж: пятый")).toBeNull();
    expect(labeledPropertyFields("Площадь: 68 метров 2 балкона")).toBeNull();
  });

  it("ролик без годного расширения получает его по типу файла", () => {
    expect(telegramVideoFilename("Видео от 10.11", "video/mp4")).toBe("Видео от 10.11.mp4");
    expect(telegramVideoFilename("clip", "video/quicktime")).toBe("clip.mov");
    expect(telegramVideoFilename("IMG_1.MOV", "video/quicktime")).toBe("IMG_1.MOV");
    expect(telegramVideoFilename("clip.avi", "video/x-msvideo")).toBe("clip.avi");
    expect(telegramVideoFilename(undefined, "video/mp4", 7)).toBe("telegram-7.mp4");
  });
});

describe("права и чат", () => {
  it("роль только для чтения не заводит черновик; в группе мастер молчит", async () => {
    await send("holder", { text: "добавь объект" });
    expect(String(sendMessage.mock.calls.at(-1)?.[1])).toContain("Акционер только просматривает");
    expect(await prisma.propertyDraft.count({ where: { agentId: agents.holder.id } })).toBe(0);
    expect(await send("author", { text: "добавь объект" }, "supergroup")).toBe(false);
    expect(await prisma.propertyDraft.count({ where: { agentId: agents.author.id } })).toBe(0);
  });
});

describe("видео: обрыв, повтор и чужая загрузка", () => {
  it("свою начатую загрузку при сбое убирает, повтор того же сообщения проходит", async () => {
    await send("author", { text: "добавь объект" });
    const file = path.join(tmp, "clip.mp4");
    await writeFile(file, Buffer.alloc(2_000, 3));
    resolveFile.mockRejectedValueOnce(new Error("обрыв"));
    const video = { file_id: "v", file_size: 2_000, mime_type: "video/mp4", file_name: "Видео от 10.11" };
    await send("author", { message_id: 5001, document: video });
    expect(lastText()).toContain("Видео не сохранилось");
    expect(await videos("author")).toHaveLength(0);
    resolveFile.mockResolvedValue({ kind: "path", path: file });
    await send("author", { message_id: 5001, document: video });
    expect(await videos("author")).toMatchObject([{ status: "READY", filename: "Видео от 10.11.mp4" }]);
  });

  it("чужую незаконченную загрузку того же файла не удаляет; зависшую снимает кнопкой", async () => {
    const draft = await draftOf("author");
    const crm = await startDraftVideoSession(agents.author.id, draft.id, { uploadKey: `crm-upload-${runId}`, filename: "tour.mp4", sizeBytes: 4_000, contentType: "video/mp4" });
    expect(crm.status).toBe(201);
    const mediaId = (crm.body as { mediaId: string }).mediaId;
    resolveFile.mockRejectedValueOnce(new Error("обрыв"));
    await send("author", { video: { file_id: "v2", file_size: 4_000, mime_type: "video/mp4", file_name: "tour.mp4" } });
    expect(await prisma.propertyDraftMedia.findUnique({ where: { id: mediaId } })).not.toBeNull();

    // Загрузка не двигается два часа (выкат, обрыв) — «Создать» не держится вечно.
    await prisma.$executeRaw`UPDATE "PropertyDraftMedia" SET "updatedAt" = now() - interval '2 hours' WHERE id = ${mediaId}`;
    await click("author", `pdt:review:${draft.id}`);
    expect(lastText()).toContain("«tour.mp4» не догрузился");
    const remove = button("pdt:rm:");
    expect(remove).toBeDefined();
    await click("author", remove!);
    expect(await prisma.propertyDraftMedia.findUnique({ where: { id: mediaId } })).toBeNull();
    expect(lastText()).toContain("Файл убран");
  });
});

describe("кнопки, альбом и дубль", () => {
  it("кнопка выбора со старой ревизией ничего не меняет", async () => {
    const draft = await draftOf("author");
    await click("author", `pdt:f:type:${draft.id}`);
    const stale = button("pdt:v:type:2");
    await prisma.propertyDraft.update({ where: { id: draft.id }, data: { revision: { increment: 1 } } });
    await click("author", stale!);
    expect(lastText()).toContain("Карточка изменилась");
    expect(((await draftOf("author")).values as Record<string, unknown>).type).toBeUndefined();
  });

  it("альбом подтверждается одним сообщением «принято N фото»", async () => {
    setAlbumQuietMsForTests(60);
    const file = path.join(tmp, "a.jpg");
    await writeFile(file, await sharp({ create: { width: 16, height: 16, channels: 3, background: "#abcdef" } }).jpeg().toBuffer());
    resolveFile.mockResolvedValue({ kind: "path", path: file });
    for (let i = 0; i < 3; i += 1) await send("author", { photo: [{ file_id: `p${i}` }], media_group_id: `album-${runId}` });
    await wait(400);
    const confirmations = sendMessageWithButtons.mock.calls.filter(call => String(call[1]).includes("Принято фото"));
    expect(confirmations).toHaveLength(1);
    expect(String(confirmations[0][1])).toContain("Принято фото: 3");
  });

  it("дубль, появившийся после показа карточки, останавливает «Создать»", async () => {
    const draft = await draftOf("author");
    const district = await prisma.district.create({ data: { name: `Район ревью ${runId}` } });
    await prisma.propertyDraftMedia.deleteMany({ where: { draftId: draft.id } });
    await prisma.propertyDraft.update({ where: { id: draft.id }, data: { values: {
      type: "APARTMENT", condition: "GOOD", marketType: "SECONDARY", price: "650000", currency: "TJS", rooms: "2", areaSqm: "71",
      floor: "3", totalFloors: "9", windowCount: "3", districtId: district.id, address: "Новая запись дома",
      lat: 38.552, lng: 68.762, sellerName: "Хозяин", sellerPhone: "+992935551288",
    } } });
    await click("author", `pdt:review:${draft.id}`);
    const create = button("pdt:create:");
    expect(lastButtons().find(b => b.callback_data === create)?.text).toBe("Создать");
    const twin = await prisma.property.create({ data: {
      type: "APARTMENT", areaSqm: 71, price: 600000, currency: "TJS", districtId: district.id, address: `Дом ${runId}`,
      title: `Двойник ${runId}`, condition: "GOOD", status: "AVAILABLE", lat: 38.552, lng: 68.762,
    } });
    await click("author", create!);
    expect(await prisma.property.count({ where: { createdById: agents.author.id } })).toBe(0);
    expect(lastText()).toContain("появился похожий объект");
    expect(lastText()).toContain(formatPropertyCode(twin.shortId));
    await click("author", button("pdt:create:")!);
    expect(await prisma.property.count({ where: { createdById: agents.author.id } })).toBe(1);
  });
});
