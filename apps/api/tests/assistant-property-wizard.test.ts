import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import sharp from "sharp";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * МАСТЕР ОБЪЕКТА В TELEGRAM «КАК МАСТЕР CRM» (10.11.2026, пробелы 1–7 из
 * docs/design/shabnam-full-gap-list-2026-11-10.md): видео тем же протоколом
 * частей, рынок/стадия/документы/характеристики/размещение, дубль до создания,
 * объект из карточки продавца с правами REST, точка → ориентир, текст для
 * озвучки, «Исправить поле» кнопками. Telegram и ИИ подменены; база настоящая.
 */

const { sendMessage, sendMessageWithButtons, sendHtmlMessage, answerCallbackQuery, editMessageText, resolveFile, landmarks } = vi.hoisted(() => ({
  sendHtmlMessage: vi.fn(async (_c: string, _h: string, _r?: number, _b?: unknown) => ({})),
  sendMessage: vi.fn(async (_chatId: string, _text: string) => ({})),
  sendMessageWithButtons: vi.fn(async (_c: string, _t: string, _b: unknown) => ({ message_id: 501 })),
  answerCallbackQuery: vi.fn(async (_id: string, _text?: string) => ({})),
  editMessageText: vi.fn(async (_c: string, _m: number, _t: string, _b?: unknown) => {}),
  resolveFile: vi.fn(),
  landmarks: vi.fn(),
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

const { prisma } = await import("../src/db.js");
const { handleTelegramPropertyDraft, handleTelegramPropertyDraftCallback, waitForTelegramDraftUploadsForTests } = await import("../src/telegram/assistantPropertyDraft.js");
const { labeledPropertyFields } = await import("../src/telegram/assistantPropertyFields.js");
const { localVideoDelete } = await import("../src/lib/localVideoStorage.js");
const { formatPropertyCode } = await import("@royal-home/shared");

const runId = String(Date.now()).slice(-7);
const agents: Record<string, { id: string; chatId: number; fullName: string }> = {};
let messageId = 1;
let callbackId = 1;
let tmp = "";

async function mk(key: string, n: number, role: string) {
  const chatId = 800_000_000 + Number(runId) * 10 + n;
  const fullName = `Мастер-${key} ${runId}`;
  const agent = await prisma.agent.create({ data: {
    fullName, phone: `+992${Math.floor(Math.random() * 900_000_000) + 100_000_000}`, role: role as "AGENT",
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

beforeAll(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), "tg-wizard-"));
  await mk("author", 1, "AGENT");
  await mk("other", 2, "AGENT");
  await mk("holder", 3, "SHAREHOLDER");
});

beforeEach(() => {
  for (const m of [sendMessage, sendMessageWithButtons, answerCallbackQuery, editMessageText, resolveFile, landmarks]) m.mockReset();
  sendMessageWithButtons.mockResolvedValue({ message_id: 501 });
  landmarks.mockResolvedValue({ text: "", landmarks: [] });
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

describe("разбор «Поле: значение» без ИИ", () => {
  it("понимает рынок, стадию, документы, характеристики и размещение", () => {
    expect(labeledPropertyFields([
      "Рынок: новостройка", "Стадия: Строится", "Документы: Техпаспорт", "Балкон: лоджия", "Размещение: только crm", "Цена: 950 000",
    ].join("\n"))).toEqual({
      marketType: "NEW_BUILD", stage: "UNDER_CONSTRUCTION", documents: "Техпаспорт", details: { balcony: "Лоджия" }, placement: "CRM_ONLY", price: "950000",
    });
    expect(labeledPropertyFields("Нарх: 500000\nОшёна: 3")).toEqual({ price: "500000", floor: "3" });
    // Значение, которое не разобралось, отдаётся ИИ, а не роняет весь разбор.
    expect(labeledPropertyFields("Этаж: пятый")).toBeNull();
    expect(labeledPropertyFields("Балкон: космический")).toBeNull();
  });
});

describe("мастер объекта в Telegram", () => {
  it("поля мастера: рынок, документы, характеристики, «Исправить поле», тип кнопкой и текст для озвучки", async () => {
    await send("author", { text: "добавь объект" });
    const draft = await draftOf("author");
    // Вид не назван — спрашиваем кнопками сразу, создавать нечего.
    expect(button("pdt:create:")).toBeUndefined();
    expect(button("pdt:v:type:")).toBeDefined();
    await click("author", button("pdt:v:type:0")!);
    expect(await values("author")).toMatchObject({ type: "APARTMENT" });

    await send("author", { text: ["Документы: Договор + техпаспорт", "Балкон: Лоджия", "Мебель: Частично", "Размещение: только crm"].join("\n") });
    expect(await values("author")).toMatchObject({
      documentsPreset: "Договор + техпаспорт", details: { balcony: "Лоджия", furniture: "Частично" }, offSite: true,
    });

    await click("author", `pdt:edit:${draft.id}`);
    expect(lastText()).toContain("Что исправить?");
    expect(button(`pdt:f:price:`)).toBeDefined();
    await click("author", `pdt:f:finish:${draft.id}`);
    const pit = lastButtons().findIndex(b => b.text === "Новостройка, котлован");
    expect(pit).toBeGreaterThanOrEqual(0);
    await click("author", lastButtons()[pit].callback_data!);
    expect(await values("author")).toMatchObject({ marketType: "FOUNDATION_PIT", stage: "FOUNDATION", condition: "NEW_BUILDING" });

    await click("author", `pdt:f:d4:${draft.id}`);
    await click("author", button("pdt:v:d4:")!);
    expect((await values("author")).details).toMatchObject({ heating: "Автономное", balcony: "Лоджия" });

    // Текстовое поле: кнопка → ответ текстом становится значением этого поля.
    await click("author", `pdt:f:price:${draft.id}`);
    expect(lastText()).toContain("цена");
    await send("author", { text: "780 000" });
    expect(await values("author")).toMatchObject({ price: "780000" });
    await click("author", `pdt:f:area:${draft.id}`);
    await send("author", { text: "64" });
    await click("author", `pdt:f:cur:${draft.id}`);
    await click("author", button("pdt:v:cur:")!);
    await send("author", { text: "Продавец: Сосед\nТелефон: +992 93 555 12 34" });

    const card = lastText();
    expect(card).toContain("Проверьте объект");
    expect(card).toContain("Только CRM (закрытый)");
    expect(card).toContain("Новостройка, котлован");
    expect(card).toContain("Документы: Договор + техпаспорт");
    expect(card).toContain("Отопление: Автономное");
    expect(card).toContain("Текст для озвучки ролика");
    expect(card).not.toContain("555 12 34");
    // Закрытому объекту хватает цены, площади и продавца — как в мастере CRM.
    expect(button("pdt:create:")).toBeDefined();
    // После создания — в том же сообщении, кому объект подходит (без рассылок клиентам).
    await click("author", button("pdt:create:")!);
    const done = String(editMessageText.mock.calls.at(-1)?.[2] ?? "");
    expect(done).toContain("Объект создан");
    // Кому подходит — отдельным сообщением сразу следом (без процента совпадения).
    expect(String(sendHtmlMessage.mock.calls.at(-1)?.[1])).toMatch(/🎯 (?:Подходит \d+|Подходящих клиентов в базе пока нет)/u);
    expect(await prisma.property.count({ where: { createdById: agents.author.id } })).toBe(1);
  });

  it("фото файлом без сжатия принимается, файл не-картинка — нет", async () => {
    await send("author", { text: "добавь объект" });
    const draft = await draftOf("author");
    const file = path.join(tmp, "IMG_0001.png");
    await writeFile(file, await sharp({ create: { width: 32, height: 32, channels: 3, background: "#123456" } }).png().toBuffer());
    resolveFile.mockResolvedValue({ kind: "path", path: file });
    await send("author", { document: { file_id: "photo-doc", mime_type: "image/png", file_name: "IMG_0001.png", file_size: 200 } });
    expect((await draftOf("author")).media.filter(m => m.kind === "PHOTO" && m.status === "READY")).toHaveLength(1);
    expect(lastText()).toContain("Фото добавлено");
    resolveFile.mockClear();
    await send("author", { document: { file_id: "zip-doc", mime_type: "application/zip", file_name: "plan.zip", file_size: 200 } });
    expect(resolveFile).not.toHaveBeenCalled();
    expect((await draftOf("author")).media).toHaveLength(1);
    await click("author", `pdt:exit:${draft.id}`);
  });

  it("точка из ссылки Google/Yandex, координат текстом и места (venue) — как точка на карте", async () => {
    await send("author", { text: "добавь объект" });
    const draft = await draftOf("author");
    await send("author", { text: "https://www.google.com/maps/place/Dushanbe/@38.5612,68.7712,17z" });
    expect(await values("author")).toMatchObject({ lat: 38.5612, lng: 68.7712 });
    await send("author", { text: "https://yandex.ru/maps/?ll=68.70,38.50&pt=68.7801,38.5702&z=16" });
    expect(await values("author")).toMatchObject({ lat: 38.5702, lng: 68.7801 });
    await send("author", { text: "38.5800, 68.7900" });
    expect(await values("author")).toMatchObject({ lat: 38.58, lng: 68.79 });
    await send("author", { venue: { location: { latitude: 38.59, longitude: 68.8 }, title: "ТЦ" } });
    expect(await values("author")).toMatchObject({ lat: 38.59, lng: 68.8 });
    expect(lastText()).toContain("Точка на карте сохранена");
    await click("author", `pdt:exit:${draft.id}`);
  });

  it("видео: сохраняет ролик частями в черновик и честно отказывает в слишком большом", async () => {
    await send("author", { text: "/new_property" });
    const draft = await draftOf("author");
    const file = path.join(tmp, "clip.mp4");
    const bytes = Buffer.alloc(3_000, 7);
    await writeFile(file, bytes);
    resolveFile.mockResolvedValue({ kind: "path", path: file });
    await send("author", { video: { file_id: "video-1", file_size: bytes.length, mime_type: "video/mp4" } });
    expect(lastText()).toContain("Видео загружается");
    await waitForTelegramDraftUploadsForTests();
    const media = (await draftOf("author")).media.filter(m => m.kind === "VIDEO");
    expect(media).toHaveLength(1);
    expect(media[0]).toMatchObject({ status: "READY", sizeBytes: bytes.length, draftId: draft.id });
    expect(lastText()).toContain("Видео добавлено");
    expect(lastText()).toContain("видео 1");

    resolveFile.mockClear();
    await send("author", { video: { file_id: "video-2", file_size: 25 * 1024 * 1024, mime_type: "video/mp4" } });
    expect(resolveFile).not.toHaveBeenCalled();
    expect(lastText()).toMatch(/Видео больше \d+ МБ/u);
    expect((await draftOf("author")).media.filter(m => m.kind === "VIDEO")).toHaveLength(1);
    await click("author", `pdt:exit:${draft.id}`);
  });

  it("дубль: показывает номер ОБ найденного объекта и спрашивает перед созданием", async () => {
    const district = await prisma.district.create({ data: { name: `Район дубля ${runId}` } });
    const existing = await prisma.property.create({ data: {
      type: "APARTMENT", areaSqm: 70, price: 600000, currency: "TJS", districtId: district.id, address: `Улица дубля ${runId}`,
      title: `Дубль ${runId}`, condition: "GOOD", status: "AVAILABLE", lat: 38.561, lng: 68.771,
    } });
    await send("author", { text: "добавь объект" });
    const draft = await draftOf("author");
    await prisma.propertyDraft.update({ where: { id: draft.id }, data: { values: {
      type: "APARTMENT", condition: "GOOD", marketType: "SECONDARY", price: "650000", currency: "TJS", rooms: "2", areaSqm: "70",
      floor: "3", totalFloors: "9", windowCount: "3", districtId: district.id, address: "Другая запись того же дома",
      lat: 38.561, lng: 68.771, sellerName: "Хозяин", sellerPhone: "+992935551299",
    } } });
    await click("author", `pdt:review:${draft.id}`);
    expect(lastText()).toContain(formatPropertyCode(existing.shortId));
    expect(lastButtons().find(b => b.callback_data?.startsWith("pdt:create:"))?.text).toBe("Всё равно создать");
    await click("author", `pdt:exit:${draft.id}`);
  });

  it("объект из карточки продавца: своя карточка переносится, чужая — отказ с правами REST", async () => {
    const own = await prisma.client.create({ data: {
      fullName: `Продавец мастера ${runId}`, phone: `+99291${runId}`, source: "WEBSITE", kind: "SELLER", acceptedAt: new Date(), assignedAgentId: agents.author.id,
    } as never });
    const foreign = await prisma.client.create({ data: {
      fullName: `Чужой продавец ${runId}`, phone: `+99290${runId}`, source: "WEBSITE", kind: "SELLER", acceptedAt: new Date(), assignedAgentId: agents.other.id,
    } as never });
    await prisma.propertyDraft.deleteMany({ where: { agentId: agents.author.id } });
    await send("author", { text: `добавь объект продавца ПР-${String(foreign.shortId).padStart(6, "0")}` });
    expect(lastText()).toContain("Недостаточно прав");
    expect((await values("author")).sellerClientId).toBeUndefined();

    await send("author", { text: `добавь объект продавца ПР-${String(own.shortId).padStart(6, "0")}` });
    expect(await values("author")).toMatchObject({ sellerClientId: own.id });
    expect(lastText()).toContain("Данные продавца перенесены");
    expect(lastText()).toContain(own.fullName);
    await click("author", `pdt:exit:${(await draftOf("author")).id}`);
  });

  it("точка на карте ставит ориентир в пустое поле той же функцией, что GET /geo/landmarks", async () => {
    await send("author", { text: "добавь объект" });
    const draft = await draftOf("author");
    landmarks.mockResolvedValue({ text: "рядом ТЦ Садбарг", landmarks: [] });
    await send("author", { location: { latitude: 38.57, longitude: 68.78 } });
    expect(landmarks).toHaveBeenCalledWith(38.57, 68.78);
    expect(await values("author")).toMatchObject({ lat: 38.57, lng: 68.78, landmark: "рядом ТЦ Садбарг" });
    expect(lastText()).toContain("Ориентир: рядом ТЦ Садбарг");
    // Написанный агентом ориентир не перетирается.
    landmarks.mockClear();
    await send("author", { location: { latitude: 38.58, longitude: 68.79 } });
    expect(landmarks).not.toHaveBeenCalled();
    await click("author", `pdt:exit:${draft.id}`);
  });

  it("говорит по-таджикски, если сотрудник пишет по-таджикски", async () => {
    await send("author", { text: "объект илова кунед" });
    expect(lastText()).toContain("Объектро санҷед");
    await click("author", `pdt:exit:${(await draftOf("author")).id}`);
  });
});
