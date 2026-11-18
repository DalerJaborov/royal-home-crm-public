import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import { randomUUID } from "node:crypto";
import type { PermissionId } from "@royal-home/shared";

/**
 * ОЗВУЧКА СЛОВАМИ В ШАБНАМ (18.11.2026): narration_status, send_narration_audio, request_narration,
 * approve_narration, голос вместо текста в «Править текст», цена «85 тысяч».
 *
 * База настоящая (стенд), брокер подтверждений настоящий. Telegram, файловое хранилище и платный голос
 * подменены: ElevenLabs не зовётся вовсе (версию «готово» засеваем строкой), в Telegram ничего не уходит.
 * Двери озвучки (requestAutoNarration, approveNarrationVersion, afterNarrationApproved) — настоящие
 * функции под шпионом: проверяем, что инструменты зовут именно их с теми же аргументами, что кнопка.
 */
const tg = vi.hoisted(() => ({
  sendMessage: vi.fn(async () => ({ message_id: 1 })),
  sendDocumentFile: vi.fn(async () => ({ message_id: 3 })),
  samples: [] as Array<{ voiceId: string; lang: "ru" | "tg"; storageKey: string }>,
}));
vi.mock("../src/telegram/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/telegram/api.js")>()),
  sendMessage: tg.sendMessage, sendDocumentFile: tg.sendDocumentFile, isTelegramEnabled: () => true,
}));
vi.mock("../src/lib/localVideoStorage.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/localVideoStorage.js")>()),
  localVideoFilePath: (key: string) => `/stand/${key}`,
}));
vi.mock("../src/lib/narrationGeneration.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/narrationGeneration.js")>()),
  readyVoiceSamples: vi.fn(async () => tg.samples),
}));
vi.mock("../src/lib/narrationAutoFlow.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/narrationAutoFlow.js")>();
  return {
    ...real,
    requestAutoNarration: vi.fn(real.requestAutoNarration),
    approveNarrationVersion: vi.fn(real.approveNarrationVersion),
    afterNarrationApproved: vi.fn(async () => "QUEUED" as const),
  };
});

const { prisma } = await import("../src/db.js");
await import("../src/ai/assistant/tools/index.js");
const flow = await import("../src/lib/narrationAutoFlow.js");
const { narrationFacts, narrationHash } = await import("../src/lib/propertyNarration.js");
const { createPendingAssistantAction, confirmAssistantAction, AssistantActionError } = await import("../src/lib/assistantActions.js");
const { findAssistantToolPlugin, listAssistantToolPlugins } = await import("../src/ai/assistant/tools/index.js");
const { runAssistantToolPlugin } = await import("../src/ai/assistant/tools/run.js");
const { actorFromAccess } = await import("../src/ai/assistant/actor.js");
const { NARRATION_TOOL_NAMES } = await import("../src/ai/assistant/tools/narrationTools.js");
const { handleNarrationTextReply } = await import("../src/telegram/assistantNarration.js");
const { matchByName } = await import("../src/lib/staffNarration.js");
const { parseSpokenAmount } = await import("../src/ai/assistant/tools/spokenAmount.js");
const { changePropertyPriceExecutor } = await import("../src/ai/assistant/tools/changePropertyPrice.js");
const { groupHiddenToolsForTests } = await import("../src/telegram/assistantBot.js");
const { cleanupAssistantActionAgents } = await import("./helpers/assistantActionFixture.js");

const runId = Date.now();
const tail = runId.toString().slice(-6);
const TEMPLATES = [
  { id: "ru-test-21", name: "Короткий", lang: "ru" as const, text: "В продаже {вид}. Площадь {площадь} метров." },
  { id: "ru-test-22", name: "Подробный", lang: "ru" as const, text: "В продаже {вид}. Площадь {площадь} метров. Цена {цена}." },
];
const VOICES = [
  { id: "voiceA", name: "Алина", gender: "female" as const },
  { id: "voiceB", name: "Алибек", gender: "male" as const },
  { id: "voiceC", name: "Фаррух", gender: "male" as const },
];
const CONFIG = { modelId: "eleven_v4", voices: VOICES, templates: TEMPLATES, autoGenerate: true };
const OWN_PERMS: PermissionId[] = ["properties.requestChange"];
const MANAGER_PERMS: PermissionId[] = ["properties.requestChange", "properties.editForeign", "marketing.access"];

let districtId = "", ownerId = "", strangerId = "", directorId = "";
const ownerChat = `-7${tail}1`;
const propertyIds: string[] = [];
let configBefore: unknown = null;

const setConfig = (extra: Record<string, unknown> = {}) =>
  prisma.settings.upsert({ where: { id: "singleton" }, create: { id: "singleton", propertyNarrationConfig: { ...CONFIG, ...extra } }, update: { propertyNarrationConfig: { ...CONFIG, ...extra } } });

async function seedProperty(data: Record<string, unknown> = {}) {
  const p = await prisma.property.create({ data: { title: `Озвучка-Шабнам-${runId}`, type: "APARTMENT", rooms: 2, areaSqm: 64, floor: 3, totalFloors: 9, price: 61000, currency: "USD", districtId,
    address: `Сино, ${propertyIds.length + 1}`, condition: "GOOD", status: "AVAILABLE", assignedAgentId: ownerId, createdById: ownerId, ...data } as never, include: { district: true } });
  propertyIds.push(p.id);
  return p;
}
async function seedVersion(propertyId: string, extra: Record<string, unknown> = {}) {
  const p = await prisma.property.findUniqueOrThrow({ where: { id: propertyId }, include: { district: true } });
  const facts = narrationFacts(p);
  const latest = await prisma.propertyNarrationVersion.findFirst({ where: { propertyId }, orderBy: { revision: "desc" } });
  return prisma.propertyNarrationVersion.create({ data: { propertyId, revision: (latest?.revision ?? 0) + 1, script: "В продаже квартира. Площадь шестьдесят четыре метра. Ремонт хороший.",
    factsSnapshot: facts, factsHash: narrationHash(facts), voiceId: "voiceA", modelId: "eleven_v4", status: "READY", storageKey: `${propertyId}/${randomUUID()}.mp3`, createdById: ownerId,
    requestKey: randomUUID(), source: "AGENT", templateId: "ru-test-21", language: "ru", ...extra } });
}
/** Актор для чтения, как его строит Telegram-вход: в личке. */
const readActor = (agentId: string, role = "AGENT", perms: PermissionId[] = OWN_PERMS, surface: "telegram-private" | "crm-private" | "telegram-group" = "telegram-private") =>
  actorFromAccess(agentId, { role: role as never, permissions: new Set(perms) }, surface);
const act = (agentId: string, perms: PermissionId[] = OWN_PERMS) => ({ agentId, channel: "telegram" as const, telegramPrivate: true, can: (p: PermissionId) => perms.includes(p) });
const plugin = (name: string) => findAssistantToolPlugin(name)!;
const runRead = (name: string, args: Record<string, unknown>, actor = readActor(ownerId)) => runAssistantToolPlugin(plugin(name), args, actor, { channel: "telegram" }) as Promise<Record<string, any>>;
async function refused(agentId: string, tool: string, args: Record<string, unknown>, status: number) {
  const error = await createPendingAssistantAction(act(agentId), tool, args).then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(AssistantActionError);
  expect((error as InstanceType<typeof AssistantActionError>).status).toBe(status);
  return error as Error;
}

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Озвучка-Шабнам ${runId}` } })).id;
  const hash = await bcrypt.hash("testpass123", 4);
  ownerId = (await prisma.agent.create({ data: { fullName: "Агент Озвучки", phone: `+99292${tail}1`, role: "AGENT", passwordHash: hash, telegramChatId: ownerChat } })).id;
  strangerId = (await prisma.agent.create({ data: { fullName: "Чужой Агент", phone: `+99292${tail}2`, role: "AGENT", passwordHash: hash } })).id;
  directorId = (await prisma.agent.create({ data: { fullName: "Директор Озвучки", phone: `+99292${tail}3`, role: "DIRECTOR", passwordHash: hash } })).id;
  configBefore = (await prisma.settings.findUnique({ where: { id: "singleton" }, select: { propertyNarrationConfig: true } }))?.propertyNarrationConfig ?? null;
  await setConfig();
});
beforeEach(async () => { vi.clearAllMocks(); tg.samples = []; await setConfig(); });
afterAll(async () => {
  await prisma.settings.update({ where: { id: "singleton" }, data: { propertyNarrationConfig: (configBefore ?? {}) as object } }).catch(() => {});
  await prisma.telegramDialogState.deleteMany({ where: { chatId: ownerChat } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await cleanupAssistantActionAgents([ownerId, strangerId, directorId]);
  await prisma.district.deleteMany({ where: { id: districtId } });
});

describe("реестр и группа", () => {
  it("четыре инструмента зарегистрированы, закрыты в общей группе (список буквами сверен с реестром)", () => {
    const names = listAssistantToolPlugins().map((p) => p.name);
    for (const name of NARRATION_TOOL_NAMES) {
      expect(names).toContain(name);
      expect(groupHiddenToolsForTests().has(name), `${name} должен быть закрыт в группе`).toBe(true);
    }
  });
  it("не объявляются «только просмотр», монтажёру и в группе; записи — только с карточкой подтверждения", () => {
    for (const name of NARRATION_TOOL_NAMES) {
      const p = plugin(name);
      expect(p.allowed!(readActor(ownerId))).toBe(true);
      expect(p.allowed!(readActor(ownerId, "SHAREHOLDER"))).toBe(false);
      expect(p.allowed!(readActor(ownerId, "EDITOR"))).toBe(false);
      expect(p.allowed!(readActor(ownerId, "AGENT", OWN_PERMS, "telegram-group"))).toBe(false);
    }
    expect(plugin("request_narration").level).toBe("C");
    expect(plugin("approve_narration").level).toBe("C");
  });
});

describe("narration_status", () => {
  it("хозяин видит текст, голос, шаблон, готовность; голоса и шаблоны — по именам", async () => {
    const p = await seedProperty();
    await seedVersion(p.id);
    const r = await runRead("narration_status", { ref: String(p.shortId) });
    expect(r.version).toMatchObject({ revision: 1, status: "READY", hasAudio: true, waitingForApproval: true, approved: false, voice: "Алина", template: "Короткий", language: "ru" });
    expect(r.version.script).toContain("Ремонт хороший");
    expect(r.voices.map((v: { name: string }) => v.name)).toEqual(["Алина", "Алибек", "Фаррух"]);
    expect(r.templates.map((t: { name: string }) => t.name)).toEqual(["Короткий", "Подробный"]);
    expect(r.narrationOff).toBe(false);
  });
  it("озвучки нет — version null и подсказка заказать; чужой агент — отказ", async () => {
    const p = await seedProperty();
    expect((await runRead("narration_status", { ref: String(p.shortId) })).version).toBeNull();
    const denied = await runRead("narration_status", { ref: String(p.shortId) }, readActor(strangerId));
    expect(denied).toMatchObject({ code: "FORBIDDEN" });
    expect(denied.version).toBeUndefined();
  });
  it("руководитель с правом на чужие объекты видит озвучку чужого объекта", async () => {
    const p = await seedProperty();
    await seedVersion(p.id);
    expect((await runRead("narration_status", { ref: String(p.shortId) }, readActor(directorId, "DIRECTOR", MANAGER_PERMS))).version.status).toBe("READY");
  });
});

describe("send_narration_audio", () => {
  it("готовая озвучка уходит файлом в личный чат, с кодом и версией в имени", async () => {
    const p = await seedProperty();
    await seedVersion(p.id);
    const r = await runRead("send_narration_audio", { what: "current", ref: String(p.shortId) });
    expect(r).toMatchObject({ sent: 1, revision: 1, waitingForApproval: true });
    expect(tg.sendDocumentFile).toHaveBeenCalledTimes(1);
    const [chatId, file, filename] = tg.sendDocumentFile.mock.calls[0] as unknown as [string, { path: string }, string];
    expect(chatId).toBe(ownerChat);
    expect(file.path).toContain(p.id);
    expect(filename).toMatch(/^ОБ-\d+-ovoz-v1\.mp3$/u);
  });
  it("файла ещё нет (идёт генерация) — отказ без отправки; в CRM файл не шлётся; чужой — отказ", async () => {
    const p = await seedProperty();
    await seedVersion(p.id, { status: "GENERATING", storageKey: null });
    expect(await runRead("send_narration_audio", { what: "current", ref: String(p.shortId) })).toMatchObject({ code: "NO_FILE" });
    const ready = await seedProperty();
    await seedVersion(ready.id);
    expect(await runRead("send_narration_audio", { what: "current", ref: String(ready.shortId) }, readActor(ownerId, "AGENT", OWN_PERMS, "crm-private"))).toMatchObject({ code: "NOT_TELEGRAM" });
    expect(await runRead("send_narration_audio", { what: "current", ref: String(ready.shortId) }, readActor(strangerId))).toMatchObject({ code: "FORBIDDEN" });
    expect(tg.sendDocumentFile).not.toHaveBeenCalled();
  });
  it("образцы голосов: готовые уходят файлами, один голос — по имени; нет образцов — честно", async () => {
    expect(await runRead("send_narration_audio", { what: "samples" })).toMatchObject({ code: "NO_FILE" });
    tg.samples = [{ voiceId: "voiceA", lang: "ru", storageKey: "s/a.mp3" }, { voiceId: "voiceC", lang: "ru", storageKey: "s/c.mp3" }];
    expect(await runRead("send_narration_audio", { what: "samples" })).toMatchObject({ sent: 2 });
    tg.sendDocumentFile.mockClear();
    expect(await runRead("send_narration_audio", { what: "samples", voice: "Фаррух" })).toMatchObject({ sent: 1 });
    expect((tg.sendDocumentFile.mock.calls[0] as unknown as [string, unknown, string, string])[3]).toBe("Фаррух");
    expect(await runRead("send_narration_audio", { what: "samples", voice: "Али" })).toMatchObject({ code: "NAME_AMBIGUOUS" });
  });
});

describe("request_narration", () => {
  it("карточка «было → станет»: полный текст, голос по имени; зовёт requestAutoNarration теми же аргументами, что кнопки", async () => {
    const p = await seedProperty();
    const v1 = await seedVersion(p.id);
    const newScript = "В продаже квартира. Площадь шестьдесят четыре метра.";
    const pending = await createPendingAssistantAction(act(ownerId), "request_narration", { ref: String(p.shortId), script: newScript, voice: "Фаррух" });
    expect(pending.preview.was.Текст).toBe(v1.script);
    expect(pending.preview.becomes).toMatchObject({ Текст: newScript, Голос: "Фаррух" });
    expect(pending.preview.becomes.Внимание).toBeUndefined();
    expect(flow.requestAutoNarration).not.toHaveBeenCalled();
    const { action } = await confirmAssistantAction(pending.id, act(ownerId));
    expect(action.status).toBe("EXECUTED");
    expect(flow.requestAutoNarration).toHaveBeenCalledWith(expect.objectContaining({ propertyId: p.id, actorId: ownerId, source: "AGENT", script: newScript, voiceId: "voiceC", expectedRevision: 1, debounceMs: 0 }));
    const v2 = await prisma.propertyNarrationVersion.findFirstOrThrow({ where: { propertyId: p.id, revision: 2 } });
    expect(v2).toMatchObject({ script: newScript, voiceId: "voiceC", source: "AGENT" });
    expect(action.result).toMatchObject({ status: "QUEUED", revision: 2, deliversTo: "you" });
  });
  it("числа, которых не было в прежнем тексте, видны в карточке (страховка от выдуманных фактов)", async () => {
    const p = await seedProperty();
    await seedVersion(p.id);
    const pending = await createPendingAssistantAction(act(ownerId), "request_narration", { ref: String(p.shortId), script: "В продаже квартира на пятом этаже, 5 этаж, цена 85000 долларов." });
    expect(String(pending.preview.becomes.Внимание)).toMatch(/5.*85000|85000.*5/u);
  });
  it("шаблон и голос — только из настроек: неизвестный и неоднозначный отказ с перечнем; без изменений — отказ схемы", async () => {
    const p = await seedProperty();
    await seedVersion(p.id);
    expect((await refused(ownerId, "request_narration", { ref: String(p.shortId), voice: "Зоя" }, 400)).message).toMatch(/Алина, Алибек, Фаррух/u);
    expect((await refused(ownerId, "request_narration", { ref: String(p.shortId), voice: "Али" }, 400)).message).toMatch(/несколько/u);
    await refused(ownerId, "request_narration", { ref: String(p.shortId), template: "Нет такого" }, 400);
    await expect(createPendingAssistantAction(act(ownerId), "request_narration", { ref: String(p.shortId) })).rejects.toBeTruthy();
    expect(flow.requestAutoNarration).not.toHaveBeenCalled();
  });
  it("шаблон по имени и «другой случайный» доходят до двери как templateId / reroll", async () => {
    const p = await seedProperty();
    await seedVersion(p.id);
    const a = await createPendingAssistantAction(act(ownerId), "request_narration", { ref: String(p.shortId), template: "подробный" });
    await confirmAssistantAction(a.id, act(ownerId));
    expect(flow.requestAutoNarration).toHaveBeenLastCalledWith(expect.objectContaining({ templateId: "ru-test-22", expectedRevision: 1 }));
    const b = await createPendingAssistantAction(act(ownerId), "request_narration", { ref: String(p.shortId), reroll: true });
    expect(b.preview.becomes.Шаблон).toBe("другой случайный");
  });
  it("чужой агент не может; руководитель может и текст идёт хозяину объекта", async () => {
    const p = await seedProperty();
    await seedVersion(p.id);
    await refused(strangerId, "request_narration", { ref: String(p.shortId), voice: "Алина" }, 403);
    const pending = await createPendingAssistantAction(act(directorId, MANAGER_PERMS), "request_narration", { ref: String(p.shortId), voice: "Фаррух" });
    expect(String(pending.preview.risk)).toMatch(/агенту объекта/u);
    const { action } = await confirmAssistantAction(pending.id, act(directorId, MANAGER_PERMS));
    expect(action.result).toMatchObject({ deliversTo: "owner" });
  });
  it("«Без озвучки», выключенная автоозвучка и идущая генерация отказывают ещё на карточке", async () => {
    const off = await seedProperty({ narrationOff: true });
    expect((await refused(ownerId, "request_narration", { ref: String(off.shortId), voice: "Алина" }, 409)).message).toMatch(/Без озвучки/u);
    const busy = await seedProperty();
    await seedVersion(busy.id, { status: "GENERATING", storageKey: null });
    await refused(ownerId, "request_narration", { ref: String(busy.shortId), voice: "Алина" }, 409);
    const p = await seedProperty();
    await setConfig({ autoGenerate: false });
    expect((await refused(ownerId, "request_narration", { ref: String(p.shortId), voice: "Алина" }, 409)).message).toMatch(/выключена/u);
  });
  it("новая версия появилась между карточкой и «Подтвердить» — устарело, ничего не заказано", async () => {
    const p = await seedProperty();
    await seedVersion(p.id);
    const pending = await createPendingAssistantAction(act(ownerId), "request_narration", { ref: String(p.shortId), voice: "Фаррух" });
    await seedVersion(p.id, { script: "Другая версия, кто-то успел раньше." });
    await expect(confirmAssistantAction(pending.id, act(ownerId))).rejects.toMatchObject({ status: 409 });
    expect(flow.requestAutoNarration).not.toHaveBeenCalled();
  });
});

describe("approve_narration", () => {
  it("зовёт approveNarrationVersion и afterNarrationApproved теми же аргументами, что кнопка nar:a; озвучка одобрена в базе", async () => {
    const p = await seedProperty();
    const v = await seedVersion(p.id);
    const pending = await createPendingAssistantAction(act(ownerId), "approve_narration", { ref: String(p.shortId) });
    expect(pending.preview).toMatchObject({ irreversible: true, was: { Статус: "ждёт одобрения", Версия: 1 } });
    expect(flow.approveNarrationVersion).not.toHaveBeenCalled();
    const { action } = await confirmAssistantAction(pending.id, act(ownerId));
    expect(flow.approveNarrationVersion).toHaveBeenCalledWith({ propertyId: p.id, versionId: v.id, expectedRevision: 1, actorId: ownerId, isManager: false, actorRole: "AGENT" });
    expect(flow.afterNarrationApproved).toHaveBeenCalledWith(p.id, v.id);
    expect((await prisma.propertyNarrationVersion.findUniqueOrThrow({ where: { id: v.id } })).approvedAt).not.toBeNull();
    expect(action.result).toMatchObject({ approved: true, delivery: "QUEUED" });
    expect(String((action.result as { message: string }).message)).toContain("Одобрено");
  });
  it("не готова, уже одобрена, прежний путь маркетинга, чужой агент — отказ ещё на карточке, одобрения нет", async () => {
    const gen = await seedProperty();
    await seedVersion(gen.id, { status: "GENERATING", storageKey: null });
    expect((await refused(ownerId, "approve_narration", { ref: String(gen.shortId) }, 409)).message).toMatch(/ещё не готова/u);
    const none = await seedProperty();
    expect((await refused(ownerId, "approve_narration", { ref: String(none.shortId) }, 409)).message).toMatch(/ещё нет/u);
    const done = await seedProperty();
    await seedVersion(done.id, { approvedAt: new Date(), approvedById: ownerId });
    expect((await refused(ownerId, "approve_narration", { ref: String(done.shortId) }, 409)).message).toMatch(/уже одобрили/u);
    const manual = await seedProperty();
    await seedVersion(manual.id, { source: "MANUAL" });
    await refused(ownerId, "approve_narration", { ref: String(manual.shortId) }, 409);
    const mine = await seedProperty();
    await seedVersion(mine.id);
    await refused(strangerId, "approve_narration", { ref: String(mine.shortId) }, 403);
    expect(flow.approveNarrationVersion).not.toHaveBeenCalled();
  });
  it("озвучка разового прохода (BACKFILL) — только владельцу (директору), агенту отказ", async () => {
    const p = await seedProperty();
    await seedVersion(p.id, { source: "BACKFILL" });
    await refused(ownerId, "approve_narration", { ref: String(p.shortId) }, 403);
    const pending = await createPendingAssistantAction(act(directorId, MANAGER_PERMS), "approve_narration", { ref: String(p.shortId) });
    await confirmAssistantAction(pending.id, act(directorId, MANAGER_PERMS));
    expect(flow.approveNarrationVersion).toHaveBeenCalledWith(expect.objectContaining({ isManager: true, actorRole: "DIRECTOR" }));
  });
  it("данные объекта изменились после озвучки — одобрить нельзя, нужна новая", async () => {
    const p = await seedProperty();
    await seedVersion(p.id);
    await prisma.property.update({ where: { id: p.id }, data: { floor: 7 } });
    expect((await refused(ownerId, "approve_narration", { ref: String(p.shortId) }, 409)).message).toMatch(/Данные объекта изменились/u);
  });
  it("одобрение записано, а передача дальше упала — честный ответ «передать не вышло», не «готово»", async () => {
    const p = await seedProperty();
    await seedVersion(p.id);
    vi.mocked(flow.afterNarrationApproved).mockRejectedValueOnce(new Error("сеть"));
    const pending = await createPendingAssistantAction(act(ownerId), "approve_narration", { ref: String(p.shortId) });
    const { action } = await confirmAssistantAction(pending.id, act(ownerId));
    expect(action.result).toMatchObject({ approved: true, delivery: null });
    expect(String((action.result as { message: string }).message)).toMatch(/передать дальше сразу не вышло/u);
  });
});

describe("голосом править текст озвучки", () => {
  const voiceMsg = (extra: Record<string, unknown> = {}) => ({ message_id: 10, chat: { id: Number(ownerChat), type: "private" }, voice: { file_id: "f", duration: 5 }, ...extra }) as never;
  async function waitEdit(propertyId: string) {
    const v = await seedVersion(propertyId, { approvalChatId: ownerChat, editRequestedAt: new Date() });
    return v;
  }
  it("голосовое в окне правки расшифровывается и становится новым текстом, как набранный", async () => {
    const p = await seedProperty();
    const v = await waitEdit(p.id);
    const transcribe = vi.fn(async () => ({ text: "  В продаже квартира, шестьдесят четыре метра, звоните.  " }));
    expect(await handleNarrationTextReply(voiceMsg(), { id: ownerId }, transcribe)).toBe(true);
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(flow.requestAutoNarration).toHaveBeenCalledWith(expect.objectContaining({ propertyId: p.id, actorId: ownerId, source: "AGENT", script: "В продаже квартира, шестьдесят четыре метра, звоните.", expectedRevision: v.revision }));
    expect((await prisma.propertyNarrationVersion.findUniqueOrThrow({ where: { id: v.id } })).editRequestedAt).toBeNull();
    expect(await prisma.propertyNarrationVersion.count({ where: { propertyId: p.id } })).toBe(2);
  });
  it("не расшифровалось — человеку причина, окно правки остаётся (можно повторить), ничего не заказано", async () => {
    const p = await seedProperty();
    const v = await waitEdit(p.id);
    expect(await handleNarrationTextReply(voiceMsg(), { id: ownerId }, async () => ({ error: "Лимит голосовых на сегодня исчерпан — напишите текстом." }))).toBe(true);
    expect(tg.sendMessage).toHaveBeenCalledWith(ownerChat, expect.stringContaining("Лимит голосовых"));
    expect((await prisma.propertyNarrationVersion.findUniqueOrThrow({ where: { id: v.id } })).editRequestedAt).not.toBeNull();
    expect(flow.requestAutoNarration).not.toHaveBeenCalled();
  });
  it("без расшифровщика — как раньше, просьба прислать текстом; текстовый путь не изменился", async () => {
    const p = await seedProperty();
    const v = await waitEdit(p.id);
    expect(await handleNarrationTextReply(voiceMsg(), { id: ownerId })).toBe(true);
    expect(tg.sendMessage).toHaveBeenCalledWith(ownerChat, expect.stringContaining("текстом"));
    expect(flow.requestAutoNarration).not.toHaveBeenCalled();
    expect(await handleNarrationTextReply({ message_id: 11, chat: { id: Number(ownerChat), type: "private" }, text: "Новый текст озвучки для проверки." } as never, { id: ownerId })).toBe(true);
    expect(flow.requestAutoNarration).toHaveBeenCalledWith(expect.objectContaining({ script: "Новый текст озвучки для проверки.", expectedRevision: v.revision }));
  });
});

describe("цена «85 тысяч»", () => {
  it.each([
    ["85 тысяч", 85000], ["85тыс", 85000], ["85 тыс.", 85000], ["85к", 85000], ["85 000", 85000], ["85000$", 85000], ["85000 usd", 85000],
    ["1,5 млн", 1500000], ["1.5 миллиона", 1500000], ["85 тысяч долларов", 85000], ["85 000 с.", 85000], ["85", 85], [90000, 90000],
  ])("%j → %d", (input, expected) => expect(parseSpokenAmount(input)).toBe(expected));
  it.each(["много", "", "85 кошек", "полтора", "85 тысяч и 5", null, undefined])("%j не угадывается (NaN, схема откажет)", (input) => expect(Number.isNaN(parseSpokenAmount(input))).toBe(true));

  it("change_property_price принимает «85 тысяч» строкой и числом, отвергает мусор", () => {
    expect(changePropertyPriceExecutor.parseArgs({ ref: "205", newPrice: "85 тысяч" })).toMatchObject({ newPrice: 85000 });
    expect(changePropertyPriceExecutor.parseArgs({ ref: "205", newPrice: 85000 })).toMatchObject({ newPrice: 85000 });
    expect(changePropertyPriceExecutor.parseArgs({ ref: "205", newPrice: "85000", currency: "USD" })).toMatchObject({ newPrice: 85000, currency: "USD" });
    expect(() => changePropertyPriceExecutor.parseArgs({ ref: "205", newPrice: "много" })).toThrow();
    expect(() => changePropertyPriceExecutor.parseArgs({ ref: "205", newPrice: 0 })).toThrow();
  });
  it("карточка цены по «85 тысяч»: станет 85 000, а не 85", async () => {
    const p = await seedProperty({ price: 90000, currency: "TJS" });
    const pending = await createPendingAssistantAction(act(ownerId), "change_property_price", { ref: String(p.shortId), newPrice: "85 тысяч" });
    expect(String(pending.preview.becomes.Цена).replace(/\D/gu, "")).toBe("85000");
  });
});

describe("поиск по имени", () => {
  const items = [{ name: "Алина" }, { name: "Алибек" }, { name: "Фаррух" }];
  it("точное имя побеждает вхождение; регистр и ё не мешают; неоднозначное и неизвестное различаются", () => {
    expect(matchByName(items, "алина")).toMatchObject({ ok: true, item: { name: "Алина" } });
    expect(matchByName(items, "Фаррух")).toMatchObject({ ok: true });
    expect(matchByName(items, "Али")).toMatchObject({ ok: false, reason: "MANY" });
    expect(matchByName(items, "Зоя")).toMatchObject({ ok: false, reason: "NONE" });
    expect(matchByName([{ name: "Мёд" }], "мед")).toMatchObject({ ok: true });
    expect(matchByName(items, "  ")).toMatchObject({ ok: false, reason: "NONE" });
  });
});
