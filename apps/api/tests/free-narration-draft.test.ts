import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import { randomUUID } from "node:crypto";

/**
 * 23.11.2026: черновики текста перед озвучкой (голос → расшифровка, рекламный текст из фактов, кнопка под длинным
 * текстом). База настоящая; Telegram, Gemini и ElevenLabs подменены: ни одного платного вызова. Главное: до «Озвучить»
 * ElevenLabs не вызывается, текст озвучивается тот, что подтверждён, повтор нажатия не создаёт вторую заявку.
 */
const tg = vi.hoisted(() => ({
  sendMessage: vi.fn(async () => ({ message_id: 1 })),
  sendMessageWithButtons: vi.fn(async () => ({ message_id: 2 })),
  answerCallbackQuery: vi.fn(async () => ({})),
  sendDocumentFile: vi.fn(async () => ({ message_id: 3 })),
  editMessageText: vi.fn(async () => undefined),
  sendChatAction: vi.fn(async () => undefined),
  sendAudioCard: vi.fn(async () => ({ message_id: 7, audio: { file_id: "fid-1" } })),
  editAudioCard: vi.fn(async () => ({ message_id: 5, audio: { file_id: "fid-2" } })),
  deletePrivateMessage: vi.fn(async () => true),
}));
/** key: "none" — образца на диске нет (текстовая карточка); корректный ключ `uuid/uuid.mp3` — путь к образцу есть (карточка-плеер). */
const samples = vi.hoisted(() => ({ ready: true, key: "none" }));
const ad = vi.hoisted(() => ({ calls: [] as Array<Record<string, unknown>>, next: [] as Array<Record<string, unknown>> }));
vi.mock("../src/telegram/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/telegram/api.js")>()),
  sendMessage: tg.sendMessage, sendMessageWithButtons: tg.sendMessageWithButtons, answerCallbackQuery: tg.answerCallbackQuery,
  sendDocumentFile: tg.sendDocumentFile, editMessageText: tg.editMessageText, sendChatAction: tg.sendChatAction, isTelegramEnabled: () => true,
  sendAudioCard: tg.sendAudioCard, editAudioCard: tg.editAudioCard, deletePrivateMessage: tg.deletePrivateMessage,
}));
vi.mock("../src/lib/narrationGeneration.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/narrationGeneration.js")>();
  // Образцы голосов «готовы» (файла на диске нет, отправка образца пропускается): нужны, чтобы Шабнам выбрала режим «по одному».
  return { ...real, readyVoiceSamples: async (config: { voices: Array<{ id: string }> }) => samples.ready ? config.voices.flatMap((v) => (["ru", "tg"] as const).map((lang) => ({ voiceId: v.id, lang, storageKey: samples.key }))) : [] };
});
vi.mock("../src/ai/assistant.js", async (importOriginal) => ({ ...await importOriginal<typeof import("../src/ai/assistant.js")>(), isAiAssistantEnabled: async () => true }));
vi.mock("../src/ai/liveVoiceProvider.js", async (importOriginal) => ({ ...await importOriginal<typeof import("../src/ai/liveVoiceProvider.js")>(), resolveElevenLabsKey: () => "test-key" }));
vi.mock("../src/ai/assistant/adScript.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/ai/assistant/adScript.js")>();
  return { ...real, generateAdScript: vi.fn(async (input: Record<string, unknown>) => { ad.calls.push(input); return ad.next.shift() ?? { status: "OK", script: "Рудаки Тауэр в районе Рудаки. Свет, канализация, парковка. Звоните, расскажем подробнее.", lang: "ru" }; }) };
});

const { waitFor } = await import("./helpers/waitFor.js");
const { prisma } = await import("../src/db.js");
const { handleFreeNarrationMessage, handleFreeNarrationCallback, handleAdTextRequest, offerNarrationButton } = await import("../src/telegram/assistantFreeNarration.js");
const { createFreeNarrationDraft, loadFreeNarrationDraft, purgeFreeNarrations } = await import("../src/lib/freeNarration.js");

const runId = Date.now().toString(36);
const tail = String(Date.now()).slice(-6);
const voices = [{ id: `vA-${runId}`, name: "Мадина", gender: "female" as const }, { id: `vB-${runId}`, name: "Анна", gender: "female" as const }];
const baseConfig = { modelId: "eleven_v4", voices, defaultVoiceId: voices[1].id, dailyCharLimit: 1_000_000, dailyGenerationLimit: 1000, freeNarrationPerPersonDaily: 50, freeNarrationBudgetPercent: 100 };
let configBefore: unknown = null;
const agentIds: string[] = [];
let chatSeq = 0;

async function setConfig(extra: Record<string, unknown> = {}) {
  const value = { ...baseConfig, ...extra };
  await prisma.settings.upsert({ where: { id: "singleton" }, create: { id: "singleton", propertyNarrationConfig: value }, update: { propertyNarrationConfig: value } });
}
async function makeAgent() {
  const hash = await bcrypt.hash("testpass123", 4);
  const n = agentIds.length;
  const chat = 710_000_000 + Number(tail) * 10 + (chatSeq++);
  const agent = await prisma.agent.create({ data: { fullName: `Черновик ${n}`, phone: `+99295${tail.slice(-4)}${String(n).padStart(3, "0")}`, role: "AGENT", passwordHash: hash, telegramChatId: String(chat) } });
  agentIds.push(agent.id);
  return { id: agent.id, chat };
}
const msg = (chat: number, text: string, extra: Record<string, unknown> = {}) => ({ message_id: 10, chat: { id: chat, type: "private" }, from: { id: chat }, text, ...extra }) as any;
const click = (chat: number, data: string, id = `fd-${runId}-${randomUUID()}`) => ({ id, data, message: { chat: { id: chat, type: "private" }, message_id: 5, text: "Черновик" }, from: { id: chat } }) as any;
const lastButtons = () => (tg.sendMessageWithButtons.mock.calls.at(-1) as unknown as [string, string, Array<Array<{ text: string; callback_data?: string }>>])[2];
const lastText = () => (tg.sendMessageWithButtons.mock.calls.at(-1) as unknown as [string, string])[1];
const FACTS = "RUDAKI TOWER, район Рудаки, рядом дворец Фарханг, свет, канализация, 3 лифта на блок, скидка 10–15%, парковка, детский двор, цена от 6500 смн за кв. м, от 59 кв. м";

beforeAll(async () => {
  configBefore = (await prisma.settings.findUnique({ where: { id: "singleton" }, select: { propertyNarrationConfig: true } }))?.propertyNarrationConfig ?? {};
  await setConfig();
});
beforeEach(() => { vi.clearAllMocks(); ad.calls.length = 0; ad.next.length = 0; });
afterAll(async () => {
  await prisma.freeNarration.deleteMany({ where: { agentId: { in: agentIds } } });
  await prisma.telegramCallbackSeen.deleteMany({ where: { id: { startsWith: `fd-${runId}` } } });
  await prisma.agent.deleteMany({ where: { id: { in: agentIds } } });
  await prisma.settings.update({ where: { id: "singleton" }, data: { propertyNarrationConfig: configBefore as object } });
});

describe("голос в ожидании текста: расшифровка черновиком", () => {
  it("расшифровка показана кнопками, ElevenLabs не вызван; «Озвучить как есть» ведёт к выбору голоса", async () => {
    const user = await makeAgent();
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    try {
      expect(await handleFreeNarrationMessage(msg(user.chat, "озвучь текст:"), user)).toBe(true);
      const transcribe = vi.fn(async () => ({ text: "Добро пожаловать в Рудаки Тауэр" }));
      const voice = msg(user.chat, "", { text: undefined, voice: { file_id: "v1", duration: 5 } });
      expect(await handleFreeNarrationMessage(voice, user, false, transcribe)).toBe(true);
      expect(transcribe).toHaveBeenCalledTimes(1);
      expect(lastText()).toContain("Добро пожаловать в Рудаки Тауэр");
      const buttons = lastButtons().flat();
      expect(buttons.map((b) => b.text).join("|")).toMatch(/как есть.*Исправить.*Отмена/u);
      const draft = (await prisma.freeNarration.findFirst({ where: { agentId: user.id, status: "DRAFT" } }))!;
      expect(draft.script).toBe("Добро пожаловать в Рудаки Тауэр");
      expect(await prisma.freeNarration.count({ where: { agentId: user.id, status: "AWAITING_TEXT" } })).toBe(0);

      const ok = buttons.find((b) => b.callback_data?.startsWith("fnr:o:"))!.callback_data!;
      expect(await handleFreeNarrationCallback(click(user.chat, ok))).toBe(true);
      expect(await prisma.freeNarration.findUnique({ where: { id: draft.id } })).toMatchObject({ status: "AWAITING_VOICE", script: "Добро пожаловать в Рудаки Тауэр" });
      expect(lastText()).toContain("Анна"); expect(lastButtons()[0][0].callback_data).toMatch(/^fnr:p:/); // выбор голоса
      // Повтор нажатия «Озвучить как есть» ничего не создаёт и не платит.
      await handleFreeNarrationCallback(click(user.chat, ok));
      expect(await prisma.freeNarration.count({ where: { agentId: user.id } })).toBe(1);
      expect(fetcher).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });

  it("«Исправить»: черновик снят, ждём набранный текст, он идёт к выбору голоса; плохая расшифровка не теряет ожидание", async () => {
    const user = await makeAgent();
    await handleFreeNarrationMessage(msg(user.chat, "озвучь текст:"), user);
    const voice = msg(user.chat, "", { text: undefined, voice: { file_id: "v2", duration: 5 } });
    expect(await handleFreeNarrationMessage(voice, user, false, async () => ({ error: "Не удалось распознать" }))).toBe(true);
    expect(await prisma.freeNarration.count({ where: { agentId: user.id, status: "AWAITING_TEXT" } })).toBe(1);
    await handleFreeNarrationMessage(voice, user, false, async () => ({ text: "Салом, хуш омадед ба Рудаки Тауэр" }));
    const fix = lastButtons().flat().find((b) => b.callback_data?.startsWith("fnr:e:"))!.callback_data!;
    await handleFreeNarrationCallback(click(user.chat, fix));
    expect(await prisma.freeNarration.count({ where: { agentId: user.id, status: "DRAFT" } })).toBe(0);
    expect(await prisma.freeNarration.count({ where: { agentId: user.id, status: "AWAITING_TEXT" } })).toBe(1);
    expect(await handleFreeNarrationMessage(msg(user.chat, "Салом, хуш омадед ба Рудаки Тауэр, хонаҳои нав"), user)).toBe(true);
    expect(await prisma.freeNarration.findFirst({ where: { agentId: user.id, status: "AWAITING_VOICE" } })).toMatchObject({ script: "Салом, хуш омадед ба Рудаки Тауэр, хонаҳои нав", lang: "tg" });
  });

  it("«Отмена» удаляет черновик", async () => {
    const user = await makeAgent();
    const created = await createFreeNarrationDraft({ agentId: user.id, chatId: String(user.chat), text: "Какой-то текст для озвучки", kind: "VOICE" });
    if (created.status !== "CREATED") throw new Error(created.status);
    await handleFreeNarrationCallback(click(user.chat, `fnr:x:${created.row.id}`));
    expect(await loadFreeNarrationDraft(created.row.id, user.id)).toBeNull();
  });

  it("чужой черновик нажатием не берётся", async () => {
    const owner = await makeAgent(); const other = await makeAgent();
    const created = await createFreeNarrationDraft({ agentId: owner.id, chatId: String(owner.chat), text: "Текст владельца для озвучки", kind: "VOICE" });
    if (created.status !== "CREATED") throw new Error(created.status);
    await handleFreeNarrationCallback(click(other.chat, `fnr:o:${created.row.id}`));
    expect(await prisma.freeNarration.findUnique({ where: { id: created.row.id } })).toMatchObject({ status: "DRAFT" });
  });
});

describe("рекламный текст из фактов", () => {
  it("факты в просьбе: текст написан, показан с кнопками, ElevenLabs не вызван; «Озвучить» → выбор голоса", async () => {
    const user = await makeAgent();
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    try {
      expect(await handleAdTextRequest(String(user.chat), user.id, `сделай рекламный текст и озвучь: ${FACTS}`, "ru")).toBe(true);
      expect(ad.calls).toHaveLength(1);
      expect(String(ad.calls[0].facts)).toContain("RUDAKI TOWER");
      expect(lastText()).toContain("Рудаки Тауэр в районе Рудаки");
      expect(lastButtons().flat().map((b) => b.text).join("|")).toMatch(/Озвучить.*Править.*Переписать.*Отмена/u);
      const draft = (await prisma.freeNarration.findFirst({ where: { agentId: user.id, status: "DRAFT" } }))!;
      expect(draft.errorCode).toBe("AD");
      expect(await prisma.freeNarration.count({ where: { agentId: user.id, status: "AD_FACTS" } })).toBe(1);

      await handleFreeNarrationCallback(click(user.chat, `fnr:o:${draft.id}`));
      expect(await prisma.freeNarration.findUnique({ where: { id: draft.id } })).toMatchObject({ status: "AWAITING_VOICE" });
      expect(await prisma.freeNarration.count({ where: { agentId: user.id, status: "AD_FACTS" } })).toBe(0);
      expect(fetcher).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });

  it("просьба без фактов: ждём факты, следующее сообщение пишется как факты, а не читается слово в слово", async () => {
    const user = await makeAgent();
    expect(await handleAdTextRequest(String(user.chat), user.id, "сделай рекламный текст и озвучь", "ru")).toBe(true);
    expect(ad.calls).toHaveLength(0);
    expect(await prisma.freeNarration.findFirst({ where: { agentId: user.id, status: "AWAITING_TEXT" } })).toMatchObject({ errorCode: "AD" });
    expect(await handleFreeNarrationMessage(msg(user.chat, FACTS), user)).toBe(true);
    expect(ad.calls).toHaveLength(1);
    expect(await prisma.freeNarration.count({ where: { agentId: user.id, status: "AWAITING_VOICE" } })).toBe(0);
    expect(await prisma.freeNarration.count({ where: { agentId: user.id, status: "DRAFT" } })).toBe(1);
  });

  it("«Переписать»: новый вариант в том же черновике, счётчик растёт, предел пять", async () => {
    const user = await makeAgent();
    await handleAdTextRequest(String(user.chat), user.id, `сделай рекламный текст и озвучь: ${FACTS}`, "ru");
    const draft = (await prisma.freeNarration.findFirst({ where: { agentId: user.id, status: "DRAFT" } }))!;
    ad.next.push({ status: "OK", script: "Другой заход: Рудаки Тауэр ждёт вас в районе Рудаки. Парковка и детский двор.", lang: "ru" });
    await handleFreeNarrationCallback(click(user.chat, `fnr:r:${draft.id}`));
    await waitFor(async () => (await prisma.freeNarration.findUnique({ where: { id: draft.id } }))?.script.includes("Другой заход") === true);
    expect((await prisma.freeNarration.findUnique({ where: { id: draft.id } }))!.script).toContain("Другой заход");
    expect(ad.calls.at(-1)).toMatchObject({ variant: 1 });
    expect(String(ad.calls.at(-1)?.avoid)).toContain("Рудаки Тауэр в районе Рудаки");
    await prisma.freeNarration.update({ where: { id: draft.id }, data: { chars: 5 } });
    const before = ad.calls.length;
    await handleFreeNarrationCallback(click(user.chat, `fnr:r:${draft.id}`));
    expect(ad.calls.length).toBe(before);
  });

  it("модель не смогла без выдумки: честный отказ, черновика нет, ElevenLabs не вызван", async () => {
    const user = await makeAgent();
    ad.next.push({ status: "UNSAFE", reason: "числа" });
    expect(await handleAdTextRequest(String(user.chat), user.id, `сделай рекламный текст: ${FACTS}`, "ru")).toBe(true);
    expect(await prisma.freeNarration.count({ where: { agentId: user.id } })).toBe(0);
    expect(String((tg.sendMessage.mock.calls.at(-1) as unknown as [string, string])[1])).toContain("только ваши факты");
  });

  it("рубильник «рекламный текст» выключен: просьба идёт дальше как раньше", async () => {
    const user = await makeAgent();
    await setConfig({ freeNarrationAdText: false });
    try {
      expect(await handleAdTextRequest(String(user.chat), user.id, `сделай рекламный текст и озвучь: ${FACTS}`, "ru")).toBe(false);
      expect(ad.calls).toHaveLength(0);
    } finally { await setConfig(); }
  });

  it("пока идёт «Переписать», «Озвучить» не пропускается, второе нажатие не запускает вторую генерацию", async () => {
    const user = await makeAgent();
    await handleAdTextRequest(String(user.chat), user.id, `сделай рекламный текст и озвучь: ${FACTS}`, "ru");
    const draft = (await prisma.freeNarration.findFirst({ where: { agentId: user.id, status: "DRAFT" } }))!;
    await prisma.freeNarration.update({ where: { id: draft.id }, data: { errorCode: "AD_BUSY" } });
    const before = ad.calls.length;
    await handleFreeNarrationCallback(click(user.chat, `fnr:o:${draft.id}`));
    await handleFreeNarrationCallback(click(user.chat, `fnr:r:${draft.id}`));
    expect(ad.calls.length).toBe(before);
    expect(await prisma.freeNarration.findUnique({ where: { id: draft.id } })).toMatchObject({ status: "DRAFT", errorCode: "AD_BUSY" });
  });

  it("в ожидании фактов обычный вопрос помощнице не забирается и не тратит Gemini", async () => {
    const user = await makeAgent();
    await handleAdTextRequest(String(user.chat), user.id, "сделай рекламный текст и озвучь", "ru");
    expect(await handleFreeNarrationMessage(msg(user.chat, "покажи мои заявки за сегодня"), user)).toBe(false);
    expect(ad.calls).toHaveLength(0);
    expect(await prisma.freeNarration.count({ where: { agentId: user.id, status: "AWAITING_TEXT" } })).toBe(0);
  });

  it("мало фактов: просим больше, модель не зовём", async () => {
    const user = await makeAgent();
    await handleAdTextRequest(String(user.chat), user.id, "сделай рекламный текст и озвучь", "ru");
    await handleFreeNarrationMessage(msg(user.chat, "Рудаки Тауэр"), user);
    expect(ad.calls).toHaveLength(0);
    expect(String((tg.sendMessage.mock.calls.at(-1) as unknown as [string, string])[1])).toContain("Фактов маловато");
  });
});

describe("кнопка «Озвучить этот текст»", () => {
  const long = Array.from({ length: 34 }, (_, i) => `слово${i}`).join(" ");
  it("по умолчанию кнопки нет (рубильник выключен)", async () => {
    const user = await makeAgent();
    expect(await offerNarrationButton(String(user.chat), user.id, long, "ru")).toBe(false);
    expect(tg.sendMessageWithButtons).not.toHaveBeenCalled();
  });
  it("под длинным текстом одна кнопка, второй раз скоро нет; нажатие ведёт к выбору голоса; чужой открытый черновик не трогает", async () => {
    await setConfig({ freeNarrationOfferButton: true });
    const user = await makeAgent();
    const other = await createFreeNarrationDraft({ agentId: user.id, chatId: String(user.chat), text: "Открытый черновик рекламы", kind: "AD", facts: "факты про дом" });
    if (other.status !== "CREATED") throw new Error(other.status);
    expect(await offerNarrationButton(String(user.chat), user.id, long, "ru")).toBe(false);
    expect(await loadFreeNarrationDraft(other.row.id, user.id)).not.toBeNull();
    await prisma.freeNarration.deleteMany({ where: { agentId: user.id } });
    expect(await offerNarrationButton(String(user.chat), user.id, long, "ru")).toBe(true);
    expect(lastButtons().flat()[0].text).toContain("Озвучить этот текст");
    expect(await offerNarrationButton(String(user.chat), user.id, `${long} ещё`, "ru")).toBe(false);
    const draft = (await prisma.freeNarration.findFirst({ where: { agentId: user.id, status: "DRAFT" } }))!;
    expect(draft.errorCode).toBe("OFFER");
    await handleFreeNarrationCallback(click(user.chat, `fnr:o:${draft.id}`));
    expect(await prisma.freeNarration.findUnique({ where: { id: draft.id } })).toMatchObject({ status: "AWAITING_VOICE", script: long });
    await setConfig();
  });
  it("короткое, вопрос и рубильник: кнопки нет", async () => {
    const user = await makeAgent();
    expect(await offerNarrationButton(String(user.chat), user.id, "короткий текст", "ru")).toBe(false);
    expect(await offerNarrationButton(String(user.chat), user.id, `${long}?`, "ru")).toBe(false);
    expect(tg.sendMessageWithButtons).not.toHaveBeenCalled();
  });
});

describe("уборка", () => {
  it("брошенные черновики и факты старше суток убираются", async () => {
    const user = await makeAgent();
    const created = await createFreeNarrationDraft({ agentId: user.id, chatId: String(user.chat), text: "Текст, который забыли подтвердить", kind: "AD", facts: "факты для текста про дом" });
    if (created.status !== "CREATED") throw new Error(created.status);
    await prisma.freeNarration.updateMany({ where: { agentId: user.id }, data: { createdAt: new Date(Date.now() - 25 * 3_600_000) } });
    await purgeFreeNarrations();
    expect(await prisma.freeNarration.count({ where: { agentId: user.id } })).toBe(0);
  });
});

describe("голос по одному (24.11.2026)", () => {
  const four = [
    { id: `sA-${runId}`, name: "Анна", gender: "female" as const }, { id: `sB-${runId}`, name: "Фаррух", gender: "male" as const },
    { id: `sC-${runId}`, name: "Мадина", gender: "female" as const }, { id: `sD-${runId}`, name: "Рустам", gender: "male" as const },
  ];
  const callbacks = () => lastButtons().flat().map((b) => b.callback_data ?? "");

  const lastEdit = () => tg.editMessageText.mock.calls.at(-1) as unknown as [string, number, string, Array<Array<{ text: string; callback_data?: string }>> | null];
  const mediaClick = (chat: number, data: string, id = `fd-${runId}-${randomUUID()}`) => ({ id, data, message: { chat: { id: chat, type: "private" }, message_id: 5, caption: "🎙 карточка с образцом" }, from: { id: chat } }) as any;
  const SAMPLE_KEY = `${randomUUID()}/${randomUUID()}.mp3`;
  type AudioCard = { caption: string; title: string; buttons: Array<Array<{ text: string; callback_data?: string }>> };
  const sentCard = () => (tg.sendAudioCard.mock.calls.at(-1) as unknown as unknown[])[2] as AudioCard;
  const editedCard = () => (tg.editAudioCard.mock.calls.at(-1) as unknown as unknown[])[3] as AudioCard;

  it("без образца на диске: текстовая карточка; листание и фильтр правят её на месте, новых сообщений нет, деньги не тратятся", async () => {
    await setConfig({ voices: four, defaultVoiceId: four[2]!.id });
    const user = await makeAgent();
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    try {
      const created = await createFreeNarrationDraft({ agentId: user.id, chatId: String(user.chat), text: "Слово в слово, длинный текст для проверки выбора голоса.", kind: "TEXT" });
      if (created.status !== "CREATED") throw new Error(created.status);
      await handleFreeNarrationCallback(click(user.chat, `fnr:o:${created.row.id}`));
      expect(lastText()).toContain("Мадина");
      expect(lastText()).toContain("1 из 4");
      expect(lastText()).toContain("рекомендуем");
      expect(lastText()).toContain("Ваш текст");
      expect(lastText()).toContain("Слово в слово");
      const first = callbacks();
      expect(first.some((d) => d.startsWith("fnr:p:"))).toBe(true);
      expect(first).toContain(`fnr:v:${created.row.id}:1a`);
      expect(first).toContain(`fnr:v:${created.row.id}:0m`);
      expect(first.every((d) => Buffer.byteLength(d) <= 64)).toBe(true);
      // Главная кнопка называет то, что делает: нажатие сразу запускает озвучку.
      expect(lastButtons()[0]![0]!.text).toBe("🎙 Озвучить этим голосом");
      tg.sendMessageWithButtons.mockClear();
      await handleFreeNarrationCallback(click(user.chat, `fnr:v:${created.row.id}:1a`));
      await waitFor(() => lastEdit()?.[2].includes("2 из 4") === true);
      expect(lastEdit()[2]).toContain("Анна");
      await handleFreeNarrationCallback(click(user.chat, `fnr:v:${created.row.id}:0m`));
      await waitFor(() => lastEdit()[2].includes("Фаррух") && lastEdit()[2].includes("1 из 2"));
      await handleFreeNarrationCallback(click(user.chat, `fnr:v:${created.row.id}:1m`));
      await waitFor(() => lastEdit()[2].includes("Рустам") && lastEdit()[2].includes("2 из 2"));
      await handleFreeNarrationCallback(click(user.chat, `fnr:v:${created.row.id}:2m`)); // за краем: по кругу
      await waitFor(() => lastEdit()[2].includes("Фаррух") && lastEdit()[2].includes("1 из 2"));
      // В чате не появилось ни одного нового сообщения и ничего не удалялось: всё правилось на месте.
      expect(tg.sendMessageWithButtons).not.toHaveBeenCalled();
      expect(tg.sendAudioCard).not.toHaveBeenCalled();
      expect(tg.deletePrivateMessage).not.toHaveBeenCalled();
      expect(fetcher).not.toHaveBeenCalled();
      expect(await prisma.freeNarration.findUnique({ where: { id: created.row.id } })).toMatchObject({ status: "AWAITING_VOICE" });
    } finally { vi.unstubAllGlobals(); await setConfig(); }
  });

  it("с образцом: одна карточка-плеер, листание подменяет файл на месте (editAudioCard), второй файл не шлётся", async () => {
    await setConfig({ voices: four, defaultVoiceId: four[2]!.id });
    samples.key = SAMPLE_KEY;
    try {
      const user = await makeAgent();
      const created = await createFreeNarrationDraft({ agentId: user.id, chatId: String(user.chat), text: "Привет, меня зовут Далер", kind: "TEXT" });
      if (created.status !== "CREATED") throw new Error(created.status);
      await handleFreeNarrationCallback(click(user.chat, `fnr:o:${created.row.id}`));
      expect(tg.sendAudioCard).toHaveBeenCalledTimes(1);
      expect(tg.sendDocumentFile).not.toHaveBeenCalled(); // образец больше не уходит безымянным документом
      const sent = sentCard();
      expect(sent.title).toBe("Мадина");
      expect(sent.caption).toContain("Женский голос · 1 из 4 · рекомендуем");
      expect(sent.caption).toContain("Привет, меня зовут Далер");
      expect(sent.caption).not.toContain("файлом выше");
      expect(sent.buttons[0]![0]!.text).toBe("🎙 Озвучить этим голосом");
      expect(sent.buttons.flat().map((b) => b.callback_data ?? "")).toContain(`fnr:v:${created.row.id}:1a`);

      await handleFreeNarrationCallback(mediaClick(user.chat, `fnr:v:${created.row.id}:1a`));
      await waitFor(() => tg.editAudioCard.mock.calls.length === 1);
      expect((tg.editAudioCard.mock.calls[0] as unknown as [string, number])[1]).toBe(5); // то же сообщение
      expect(editedCard().title).toBe("Анна");
      expect(editedCard().caption).toContain("2 из 4");
      // Второй файл не отправлялся, прежнее сообщение не удалялось: одно сообщение на экране.
      expect(tg.sendAudioCard).toHaveBeenCalledTimes(1);
      expect(tg.deletePrivateMessage).not.toHaveBeenCalled();
    } finally { samples.key = "none"; await setConfig(); }
  });

  it("правка не прошла: новая карточка отправляется, и только потом прежняя удаляется; запоздавшее нажатие по ней молчит", async () => {
    await setConfig({ voices: four, defaultVoiceId: four[2]!.id });
    samples.key = SAMPLE_KEY;
    try {
      const user = await makeAgent();
      const created = await createFreeNarrationDraft({ agentId: user.id, chatId: String(user.chat), text: "Слово в слово, проверка замены карточки.", kind: "TEXT" });
      if (created.status !== "CREATED") throw new Error(created.status);
      await handleFreeNarrationCallback(click(user.chat, `fnr:o:${created.row.id}`));
      tg.sendAudioCard.mockClear();
      tg.editAudioCard.mockRejectedValue(new Error("Bad Request: message can't be edited"));
      const msgId = 9100 + Math.floor(Math.random() * 800);
      const clickOnce = () => ({ ...mediaClick(user.chat, `fnr:v:${created.row.id}:1a`), message: { chat: { id: user.chat, type: "private" }, message_id: msgId, caption: "карточка" } });
      await handleFreeNarrationCallback(clickOnce());
      await waitFor(() => tg.deletePrivateMessage.mock.calls.some((c) => (c as unknown as [string, number])[1] === msgId));
      expect(tg.sendAudioCard).toHaveBeenCalledTimes(1);
      expect(tg.sendAudioCard.mock.invocationCallOrder[0]).toBeLessThan(tg.deletePrivateMessage.mock.invocationCallOrder[0]!); // сначала новая, потом удаление
      // Нажатие по уже заменённой карточке (двойной тап) не плодит вторую.
      await handleFreeNarrationCallback(clickOnce());
      await new Promise((r) => setTimeout(r, 50));
      expect(tg.sendAudioCard).toHaveBeenCalledTimes(1);
    } finally { tg.editAudioCard.mockReset(); tg.editAudioCard.mockResolvedValue({ message_id: 5, audio: { file_id: "fid-2" } }); samples.key = "none"; await setConfig(); }
  });

  it("отмена на карточке с образцом: карточка удалена, вместо неё «Отменено», черновик снят", async () => {
    await setConfig({ voices: four, defaultVoiceId: four[2]!.id });
    samples.key = SAMPLE_KEY;
    try {
      const user = await makeAgent();
      const created = await createFreeNarrationDraft({ agentId: user.id, chatId: String(user.chat), text: "Слово в слово, проверка отмены.", kind: "TEXT" });
      if (created.status !== "CREATED") throw new Error(created.status);
      await handleFreeNarrationCallback(click(user.chat, `fnr:o:${created.row.id}`));
      tg.sendMessageWithButtons.mockClear();
      await handleFreeNarrationCallback(mediaClick(user.chat, `fnr:x:${created.row.id}`));
      await waitFor(() => tg.deletePrivateMessage.mock.calls.length === 1);
      expect((tg.deletePrivateMessage.mock.calls[0] as unknown as [string, number])[1]).toBe(5);
      expect(lastText()).toBe("Отменено.");
    } finally { samples.key = "none"; await setConfig(); }
  });

  it("«Озвучить этим голосом» на карточке с образцом: карточка заменена строкой «готовлю», файл пришёл, строка убрана", async () => {
    await setConfig({ voices: four, defaultVoiceId: four[2]!.id });
    samples.key = SAMPLE_KEY;
    const fetcher = vi.fn(async () => new Response(new Uint8Array([0x49, 0x44, 0x33, 1, 2, 3]), { status: 200, headers: { "content-type": "audio/mpeg", "request-id": "r1" } }));
    vi.stubGlobal("fetch", fetcher);
    try {
      const user = await makeAgent();
      const created = await createFreeNarrationDraft({ agentId: user.id, chatId: String(user.chat), text: "Слово в слово, проверка выбора голоса.", kind: "TEXT" });
      if (created.status !== "CREATED") throw new Error(created.status);
      await handleFreeNarrationCallback(click(user.chat, `fnr:o:${created.row.id}`));
      const pick = sentCard().buttons[0]![0]!.callback_data!;
      tg.sendMessageWithButtons.mockClear();
      await handleFreeNarrationCallback(mediaClick(user.chat, pick));
      await waitFor(() => tg.sendDocumentFile.mock.calls.length === 1);
      expect(lastText()).toContain("Готовлю озвучку");
      expect(fetcher).toHaveBeenCalledTimes(1);
      await waitFor(() => tg.deletePrivateMessage.mock.calls.length >= 2);
      // Удалены карточка (5) и строка «готовлю» (2): в чате остался только файл.
      expect(tg.deletePrivateMessage.mock.calls.map((c) => (c as unknown as [string, number])[1])).toEqual(expect.arrayContaining([5, 2]));
    } finally { vi.unstubAllGlobals(); samples.key = "none"; await setConfig(); }
  });

  it("образцов голосов ещё нет: прежний список кнопок, а не восемь шагов вслепую", async () => {
    await setConfig({ voices: four, defaultVoiceId: four[2]!.id });
    samples.ready = false;
    try {
      const user = await makeAgent();
      const created = await createFreeNarrationDraft({ agentId: user.id, chatId: String(user.chat), text: "Слово в слово, длинный текст для проверки выбора голоса.", kind: "TEXT" });
      if (created.status !== "CREATED") throw new Error(created.status);
      await handleFreeNarrationCallback(click(user.chat, `fnr:o:${created.row.id}`));
      expect(callbacks().filter((d) => d.startsWith("fnr:p:")).length).toBe(4);
    } finally { samples.ready = true; await setConfig(); }
  });

  it("рубильник выключен: прежний список голосов кнопками", async () => {
    await setConfig({ voices: four, defaultVoiceId: four[2]!.id, freeNarrationVoiceStepper: false });
    const user = await makeAgent();
    const created = await createFreeNarrationDraft({ agentId: user.id, chatId: String(user.chat), text: "Слово в слово, длинный текст для проверки выбора голоса.", kind: "TEXT" });
    if (created.status !== "CREATED") throw new Error(created.status);
    await handleFreeNarrationCallback(click(user.chat, `fnr:o:${created.row.id}`));
    expect(callbacks().filter((d) => d.startsWith("fnr:p:")).length).toBe(4);
    expect(callbacks().some((d) => d.startsWith("fnr:v:"))).toBe(false);
    await setConfig();
  });

  it("чужой черновик и устаревшая кнопка не листаются", async () => {
    await setConfig({ voices: four });
    const user = await makeAgent();
    const other = await makeAgent();
    const created = await createFreeNarrationDraft({ agentId: user.id, chatId: String(user.chat), text: "Слово в слово, длинный текст для проверки выбора голоса.", kind: "TEXT" });
    if (created.status !== "CREATED") throw new Error(created.status);
    await handleFreeNarrationCallback(click(user.chat, `fnr:o:${created.row.id}`));
    tg.sendMessageWithButtons.mockClear();
    await handleFreeNarrationCallback(click(other.chat, `fnr:v:${created.row.id}:1a`));
    expect(tg.sendMessageWithButtons).not.toHaveBeenCalled();
    await handleFreeNarrationCallback(click(user.chat, `fnr:v:${created.row.id}:zz`));
    expect(tg.sendMessageWithButtons).not.toHaveBeenCalled();
    await setConfig();
  });
});
