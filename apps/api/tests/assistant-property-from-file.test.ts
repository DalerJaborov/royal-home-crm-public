import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import sharp from "sharp";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { waitFor } from "./helpers/waitFor.js";
import { xlsxFixture } from "./helpers/xlsxFixture.js";
import { textPdfFixture } from "./helpers/textPdfFixture.js";

/**
 * ШАБНАМ: ОБЪЕКТ ИЗ ФАЙЛА (15.11.2026, владелец: «файл → объект, без ожидания одобрения»).
 *
 * Мастер стартует фразой с хвостом и файлом с подписью-намерением; PDF, Word, Excel и
 * фото листа читаются в поля черновика (только в пустые, телефон хозяина не в публичные
 * поля); чего нет — спрашивает карточка; объект без второго одобрения уходит в монтаж,
 * когда есть фото и видео (проверка исходников на проде выключена). Telegram и ИИ
 * подменены, база настоящая; живые ключи не нужны.
 */

const { sendMessage, sendMessageWithButtons, sendHtmlMessage, answerCallbackQuery, editMessageText, resolveFile, landmarks, documentTurn, messageTurn, mediaRead } = vi.hoisted(() => ({
  sendHtmlMessage: vi.fn(async (_c: string, _h: string, _r?: number, _b?: unknown) => ({})),
  sendMessage: vi.fn(async (_chatId: string, _text: string) => ({})),
  sendMessageWithButtons: vi.fn(async (_c: string, _t: string, _b: unknown) => ({ message_id: 501 })),
  answerCallbackQuery: vi.fn(async (_id: string, _text?: string) => ({})),
  editMessageText: vi.fn(async (_c: string, _m: number, _t: string, _b?: unknown) => {}),
  resolveFile: vi.fn(),
  landmarks: vi.fn(),
  documentTurn: vi.fn(),
  messageTurn: vi.fn(),
  mediaRead: vi.fn(),
}));
const { sendPushToAgents, queueVideoHandoff } = vi.hoisted(() => ({
  sendPushToAgents: vi.fn(async () => 0),
  queueVideoHandoff: vi.fn(async () => {}),
}));

vi.mock("../src/telegram/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/telegram/api.js")>()),
  sendMessage, sendMessageWithButtons, sendHtmlMessage, answerCallbackQuery, editMessageText, resolveTelegramFile: resolveFile,
}));
vi.mock("../src/ai/assistant.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/assistant.js")>()),
  isAiAssistantEnabled: async () => true,
}));
vi.mock("../src/lib/landmarkPick.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/landmarkPick.js")>()),
  suggestLandmarksForPoint: landmarks,
}));
vi.mock("../src/telegram/assistantPropertyFields.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/telegram/assistantPropertyFields.js")>()),
  extractPropertyDocument: documentTurn,
  extractPropertyTurn: messageTurn,
}));
vi.mock("../src/telegram/assistantMedia.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/telegram/assistantMedia.js")>()),
  runAssistantMediaUnderstanding: mediaRead,
}));
vi.mock("../src/lib/recruitmentDocumentText.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/recruitmentDocumentText.js")>()),
  // Разбор самого .docx (mammoth, отдельный поток) проверяет recruitment-document-text.test.ts; здесь — только маршрут.
  recruitmentDocxText: async () => "Объект: дом. Тестовый Кандидат продаёт дом за 300000 долларов",
}));
vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgents,
}));
vi.mock("../src/lib/videoHandoff.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/videoHandoff.js")>()),
  queueVideoHandoff,
}));

const { prisma } = await import("../src/db.js");
const { handleTelegramPropertyDraft, handleTelegramPropertyDraftCallback, waitForTelegramDraftUploadsForTests } = await import("../src/telegram/assistantPropertyDraft.js");
const realFields = await vi.importActual<typeof import("../src/telegram/assistantPropertyFields.js")>("../src/telegram/assistantPropertyFields.js");
const { localVideoDelete } = await import("../src/lib/localVideoStorage.js");
// В рабочем процессе автоодобрение подписывает lib/propertyReview.ts (его тянет telegramModeration через бота); здесь бот не поднят.
await import("../src/lib/propertyReview.js");

const runId = String(Date.now()).slice(-7);
const agents: Record<string, { id: string; chatId: number; fullName: string }> = {};
let messageId = 1;
let callbackId = 1;
let tmp = "";
let savedRawReview: boolean | null = null;

async function mk(key: string, n: number) {
  const chatId = 810_000_000 + Number(runId) * 10 + n;
  const fullName = `Файл-${key} ${runId}`;
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
    message: { chat: { id: a.chatId, type: "private" }, message_id: 501 } } as never);
};
const lastText = () => String(sendMessageWithButtons.mock.calls.at(-1)?.[1] ?? sendMessage.mock.calls.at(-1)?.[1] ?? "");
const lastButtons = () => ((sendMessageWithButtons.mock.calls.at(-1)?.[2] ?? []) as { text: string; callback_data?: string }[][]).flat();
const button = (prefix: string) => lastButtons().find(b => b.callback_data?.startsWith(prefix))?.callback_data;
const draftOf = (key: string) => prisma.propertyDraft.findUniqueOrThrow({ where: { agentId: agents[key].id }, include: { media: true } });
const values = async (key: string) => (await draftOf(key)).values as Record<string, unknown>;
/** Выход из мастера и удаление черновика: следующий тест начинает с чистого листа (черновик живёт 12 часов). */
const closeDraft = async (key: string) => {
  await prisma.telegramDialogState.deleteMany({ where: { agentId: agents[key].id } });
  await prisma.propertyDraft.deleteMany({ where: { agentId: agents[key].id } });
};
const file = async (name: string, bytes: Buffer) => { const p = path.join(tmp, name); await writeFile(p, bytes); resolveFile.mockResolvedValue({ kind: "path", path: p }); };

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const listing = { intent: "field_update", fields: {
  type: "APARTMENT", condition: "GOOD", marketType: "SECONDARY", price: "800000", currency: "TJS", rooms: "3", areaSqm: "72",
  floor: "4", totalFloors: "9", address: "Рудаки 45", sellerName: "Хозяин Азиз", sellerPhone: "+992935551234",
} };

beforeAll(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), "tg-file-wizard-"));
  await mk("author", 1);
  await mk("maker", 2);
  savedRawReview = (await prisma.settings.findUnique({ where: { id: "singleton" }, select: { rawReviewRequired: true } }))?.rawReviewRequired ?? null;
});

beforeEach(() => {
  for (const m of [sendMessage, sendMessageWithButtons, answerCallbackQuery, editMessageText, resolveFile, landmarks, documentTurn, messageTurn, mediaRead]) m.mockReset();
  sendMessageWithButtons.mockResolvedValue({ message_id: 501 });
  landmarks.mockResolvedValue({ text: "", landmarks: [] });
  // Слова сотрудника разбирает настоящий разбор «Поле: значение» (он без ИИ); модель — только если строки не такие.
  messageTurn.mockImplementation(realFields.extractPropertyTurn);
});

afterAll(async () => {
  const ids = Object.values(agents).map(a => a.id);
  const media = await prisma.propertyDraftMedia.findMany({ where: { draft: { agentId: { in: ids } } } });
  await Promise.all(media.map(m => m.storageKey ? localVideoDelete(m.storageKey).catch(() => {}) : null));
  await prisma.telegramDialogState.deleteMany({ where: { agentId: { in: ids } } });
  await prisma.propertyDraft.deleteMany({ where: { agentId: { in: ids } } });
  await prisma.property.deleteMany({ where: { OR: [{ title: { contains: runId } }, { createdById: { in: ids } }] } });
  await prisma.district.deleteMany({ where: { name: { contains: runId } } });
  await prisma.agent.deleteMany({ where: { id: { in: ids } } });
  if (savedRawReview !== null) await prisma.settings.update({ where: { id: "singleton" }, data: { rawReviewRequired: savedRawReview } });
  await rm(tmp, { recursive: true, force: true });
});

describe("файл с подписью «добавь объект»: мастер стартует и читает файл", () => {
  it("таблица Excel с подписью-намерением: черновик открыт, поля заполнены, телефон хозяина не в карточке", async () => {
    documentTurn.mockResolvedValue(listing);
    await file("listing.xlsx", xlsxFixture([["Тип", "Квартира"], ["Цена", "800000 сомони"], ["Площадь", "72"]]));
    await send("author", { caption: "добавь объект", document: { file_id: "sheet-1", mime_type: XLSX, file_name: "listing.xlsx", file_size: 5_000 } });
    expect(documentTurn).toHaveBeenCalledTimes(1);
    expect(String(documentTurn.mock.calls[0][0])).toContain("Цена | 800000 сомони");
    expect(await values("author")).toMatchObject({ type: "APARTMENT", price: "800000", currency: "TJS", areaSqm: "72", sellerPhone: "+992935551234" });
    const card = lastText();
    expect(card).toContain("Прочитала файл");
    expect(card).toContain("Проверьте объект");
    expect(card).not.toContain("555 1234");
    expect(card).not.toContain("5551234");
    // Чего нет (район, точка), карточка просит сама; видео — отдельной строкой.
    expect(card).toContain("Нужно ещё");
    expect(card).toContain("Пришлите исходное видео");
    await closeDraft("author");
  });

  it("фраза с хвостом «добавь объект и сразу выпусти» открывает мастер; «в подборку» и номер чужого объекта — нет", async () => {
    await send("author", { text: "добавь объект и сразу выпусти" });
    expect(await prisma.propertyDraft.count({ where: { agentId: agents.author.id, closedAt: null } })).toBe(1);
    expect(lastText()).toContain("Проверьте объект");
    await closeDraft("author");
    sendMessage.mockClear(); sendMessageWithButtons.mockClear();
    expect(await send("author", { text: "добавь объект в подборку Азизу" })).toBe(false);
    expect(await send("author", { text: "добавь объект и покажи ОБ-000123" })).toBe(false);
    expect(sendMessageWithButtons).not.toHaveBeenCalled();
  });

  it("данные после фразы-начала идут в черновик: «Добавь объект» и строки «Цена: …» одним сообщением", async () => {
    await send("author", { text: "Добавь объект\nЦена: 750000\nПлощадь: 64" });
    expect(await values("author")).toMatchObject({ price: "750000", areaSqm: "64" });
    await closeDraft("author");
  });

  it("просьба после фразы-начала не про объект («найди клиента …») не пропадает молча: мастер открыт, человеку сказано, что её нужно отдельным сообщением", async () => {
    expect(await send("author", { text: "Добавь объект\nнайди клиента Иван" })).toBe(true);
    expect(sendMessage.mock.calls.map((c) => String(c[1])).join("\n")).toContain("Вторую просьбу");
    expect(sendMessageWithButtons).toHaveBeenCalled();
    await closeDraft("author");
  });

  it("Word и PDF прямо в открытом черновике, без подписи", async () => {
    await send("author", { text: "добавь объект" });
    documentTurn.mockResolvedValue({ intent: "field_update", fields: { type: "HOUSE", price: "300000", currency: "USD" } });
    await file("resume.docx", Buffer.from("PK-docx-bytes"));
    await send("author", { document: { file_id: "docx-1", mime_type: DOCX, file_name: "объект.docx", file_size: 9_000 } });
    expect(documentTurn).toHaveBeenCalledTimes(1);
    expect(String(documentTurn.mock.calls[0][0])).toContain("Тестовый Кандидат");
    expect(await values("author")).toMatchObject({ type: "HOUSE", price: "300000", currency: "USD" });

    documentTurn.mockClear();
    documentTurn.mockResolvedValue({ intent: "field_update", fields: { areaSqm: "120" } });
    await file("page.pdf", textPdfFixture([[["Dom 120 sqm price list with a long enough text layer for the reader"]]]));
    await send("author", { document: { file_id: "pdf-1", mime_type: "application/pdf", file_name: "лист.pdf", file_size: 2_000 } });
    expect(documentTurn).toHaveBeenCalledTimes(1);
    expect(await values("author")).toMatchObject({ areaSqm: "120" });
    await closeDraft("author");
  });

  it("файл заполняет только пустое: цена, введённая сотрудником, не затирается", async () => {
    await send("author", { text: "добавь объект" });
    const draft = await draftOf("author");
    await prisma.propertyDraft.update({ where: { id: draft.id }, data: { values: { price: "999000", currency: "TJS" } } });
    documentTurn.mockResolvedValue({ intent: "field_update", fields: { price: "800000", currency: "USD", rooms: "2" } });
    await file("again.xlsx", xlsxFixture([["Цена", "800000"]]));
    await send("author", { document: { file_id: "sheet-2", mime_type: XLSX, file_name: "again.xlsx", file_size: 5_000 } });
    expect(await values("author")).toMatchObject({ price: "999000", currency: "TJS", rooms: "2" });
    await closeDraft("author");
  });

  it("файл без данных объекта, старый Word и таблица на мегабайты — понятный ответ, черновик цел", async () => {
    await send("author", { text: "добавь объект" });
    documentTurn.mockResolvedValue({ intent: "other_question", fields: {} });
    await file("empty.xlsx", xlsxFixture([["Привет"]]));
    await send("author", { document: { file_id: "sheet-3", mime_type: XLSX, file_name: "x.xlsx", file_size: 5_000 } });
    expect(lastText()).toContain("не нашла данных объекта");
    resolveFile.mockClear();
    await send("author", { document: { file_id: "doc-old", mime_type: "application/msword", file_name: "старый.doc", file_size: 5_000 } });
    expect(lastText()).toContain(".docx");
    expect(resolveFile).not.toHaveBeenCalled();
    await send("author", { document: { file_id: "big", mime_type: XLSX, file_name: "big.xlsx", file_size: 9_000_000 } });
    expect(lastText()).toContain("Файл больше");
    expect(resolveFile).not.toHaveBeenCalled();
    expect(await prisma.propertyDraft.count({ where: { agentId: agents.author.id, closedAt: null } })).toBe(1);
    await closeDraft("author");
  });

  it("фото листа с подписью-намерением читается как документ; фото квартиры — остаётся фото", async () => {
    documentTurn.mockResolvedValue({ intent: "field_update", fields: { type: "APARTMENT", price: "500000", currency: "TJS" } });
    const jpeg = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#aaaaaa" } }).jpeg().toBuffer();
    await file("page.jpg", jpeg);
    mediaRead.mockResolvedValue({ extraction: { readableText: "Продаётся квартира. ".repeat(12) } });
    await send("author", { caption: "новая квартира", photo: [{ file_id: "ph-1", file_size: jpeg.length }, { file_id: "ph-2", file_size: jpeg.length }] });
    expect(documentTurn).toHaveBeenCalledTimes(1);
    const page = await draftOf("author");
    expect(page.media).toHaveLength(0);
    expect(page.values).toMatchObject({ price: "500000" });
    await closeDraft("author");

    documentTurn.mockClear();
    mediaRead.mockResolvedValue({ extraction: { readableText: "Дом 5" } });
    await send("author", { caption: "новая квартира", photo: [{ file_id: "ph-3", file_size: jpeg.length }, { file_id: "ph-4", file_size: jpeg.length }] });
    expect(documentTurn).not.toHaveBeenCalled();
    expect((await draftOf("author")).media.filter(m => m.kind === "PHOTO")).toHaveLength(1);
    await closeDraft("author");
  });
});

describe("разбор текста файла: файл — недоверенный источник", () => {
  it("не назначает агента и размещение, телефон не остаётся в адресе и ориентире", async () => {
    const turn = await realFields.extractPropertyDocument(
      "Цена: 800000\nАгент: Иван Иванов\nРазмещение: только crm\nАдрес: Рудаки 45, тел. +992 93 555 12 34\nОриентир: рядом 935551234", "agent-x", {} as never);
    expect(turn.intent).toBe("field_update");
    expect(turn.fields).toMatchObject({ price: "800000", address: "Рудаки 45, тел." });
    expect(turn.fields).not.toHaveProperty("intakeAgentName");
    expect(turn.fields).not.toHaveProperty("placement");
    expect(JSON.stringify(turn.fields)).not.toMatch(/555 12 34|935551234/u);
  });
});

describe("создание из файла: без второго одобрения, сразу в монтаж", () => {
  it("с фото и видео объект уходит в монтаж сам; без видео — ждёт и мастер об этом говорит", async () => {
    await prisma.settings.upsert({ where: { id: "singleton" }, update: { rawReviewRequired: false }, create: { id: "singleton", rawReviewRequired: false } });
    const district = await prisma.district.create({ data: { name: `Район файла ${runId}` } });
    await send("maker", { text: "добавь объект" });
    const draft = await draftOf("maker");
    await prisma.propertyDraft.update({ where: { id: draft.id }, data: { values: {
      type: "APARTMENT", condition: "GOOD", marketType: "SECONDARY", price: "650000", currency: "TJS", rooms: "2", areaSqm: "70",
      floor: "3", totalFloors: "9", windowCount: "3", districtId: district.id, address: `Улица файла ${runId}`,
      lat: 39.4, lng: 69.4, sellerName: "Хозяин", sellerPhone: "+992935551299",
    } } });
    const jpeg = await sharp({ create: { width: 640, height: 480, channels: 3, background: "#336699" } }).jpeg().toBuffer();
    await file("flat.jpg", jpeg);
    await send("maker", { document: { file_id: "flat", mime_type: "image/jpeg", file_name: "flat.jpg", file_size: jpeg.length } });
    await click("maker", `pdt:review:${draft.id}`);
    // Видео ещё нет: мастер просит исходник, создать можно.
    expect(lastText()).toContain("Пришлите исходное видео");
    const withoutVideo = button("pdt:create:");
    expect(withoutVideo).toBeDefined();

    await file("clip.mp4", Buffer.alloc(3_000, 7));
    await send("maker", { video: { file_id: "clip", file_size: 3_000, mime_type: "video/mp4" } });
    await waitForTelegramDraftUploadsForTests();
    expect(lastText()).not.toContain("Пришлите исходное видео");
    await click("maker", button("pdt:create:")!);
    expect(String(editMessageText.mock.calls.at(-1)?.[2])).toContain("Объект создан");
    expect(String(editMessageText.mock.calls.at(-1)?.[2])).not.toContain("Видео пока нет");
    const property = await prisma.property.findFirstOrThrow({ where: { createdById: agents.maker.id } });
    // Ни модератора, ни кнопки «Одобрить»: CRM одобряет сама и ставит монтаж.
    const moved = await waitFor(async () => (await prisma.property.findUniqueOrThrow({ where: { id: property.id } })).status === "EDITING", { timeoutMs: 8_000 });
    expect(moved).toBe(true);
    const done = await prisma.property.findUniqueOrThrow({ where: { id: property.id } });
    expect(done.photosApprovedAt).not.toBeNull();
    expect(done.videoApprovedAt).not.toBeNull();
  }, 30_000);

  it("без видео объект создаётся, но остаётся на проверке, и мастер говорит, что делать", async () => {
    await prisma.settings.upsert({ where: { id: "singleton" }, update: { rawReviewRequired: false }, create: { id: "singleton", rawReviewRequired: false } });
    const district = await prisma.district.create({ data: { name: `Район без видео ${runId}` } });
    await send("maker", { text: "добавь объект" });
    const draft = await draftOf("maker");
    await prisma.propertyDraft.update({ where: { id: draft.id }, data: { values: {
      type: "APARTMENT", condition: "GOOD", marketType: "SECONDARY", price: "420000", currency: "TJS", rooms: "1", areaSqm: "38",
      floor: "2", totalFloors: "5", windowCount: "2", districtId: district.id, address: `Улица без видео ${runId}`,
      lat: 39.6, lng: 69.6, sellerName: "Хозяйка", sellerPhone: "+992935551288",
    } } });
    const jpeg = await sharp({ create: { width: 640, height: 480, channels: 3, background: "#996633" } }).jpeg().toBuffer();
    await file("flat2.jpg", jpeg);
    await send("maker", { document: { file_id: "flat2", mime_type: "image/jpeg", file_name: "flat2.jpg", file_size: jpeg.length } });
    await click("maker", `pdt:review:${draft.id}`);
    await click("maker", button("pdt:create:")!);
    expect(String(editMessageText.mock.calls.at(-1)?.[2])).toContain("Видео пока нет");
    const property = await prisma.property.findFirstOrThrow({ where: { createdById: agents.maker.id, address: { contains: `без видео ${runId}` } } });
    await new Promise(resolve => setTimeout(resolve, 300));
    expect((await prisma.property.findUniqueOrThrow({ where: { id: property.id } })).status).toBe("PENDING_REVIEW");
  }, 30_000);
});
