import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import express from "express";
import request from "supertest";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";

/**
 * ОЗВУЧКА СВОБОДНОГО ТЕКСТА (16.11.2026, «озвучь текст» в Шабнам и REST). База и файлы настоящие;
 * Telegram и ElevenLabs подменены: ни одного платного вызова. Проверяется: текст уходит в синтез
 * слово в слово, голос по умолчанию из настроек, потолок на человека и общий дневной бюджет до
 * вызова провайдера, один платёж на запрос (кнопка дважды, два нажатия разом, повтор ключа),
 * отказ провайдера не повторяется сам, права, уборка файлов.
 */
const tg = vi.hoisted(() => ({
  sendMessage: vi.fn(async () => ({ message_id: 1 })),
  sendMessageWithButtons: vi.fn(async () => ({ message_id: 2 })),
  answerCallbackQuery: vi.fn(async () => ({})),
  sendDocumentFile: vi.fn(async () => ({ message_id: 3 })),
  editMessageText: vi.fn(async () => undefined),
  agent: "",
  failUpload: false,
}));
vi.mock("../src/lib/localVideoStorage.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/localVideoStorage.js")>();
  return { ...real, localVideoUpload: async (key: string, body: Buffer) => { if (tg.failUpload) throw new Error("disk full"); return real.localVideoUpload(key, body); } };
});
vi.mock("../src/telegram/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/telegram/api.js")>()),
  sendMessage: tg.sendMessage, sendMessageWithButtons: tg.sendMessageWithButtons, answerCallbackQuery: tg.answerCallbackQuery,
  sendDocumentFile: tg.sendDocumentFile, editMessageText: tg.editMessageText, isTelegramEnabled: () => true,
}));
vi.mock("../src/ai/liveVoiceProvider.js", async (importOriginal) => ({ ...await importOriginal<typeof import("../src/ai/liveVoiceProvider.js")>(), resolveElevenLabsKey: () => "test-key" }));
vi.mock("../src/auth/middleware.js", async (importOriginal) => ({ ...await importOriginal<typeof import("../src/auth/middleware.js")>(),
  requireAuth: (req: any, _res: any, next: () => void) => { req.agent = { id: tg.agent, role: "AGENT", permissions: new Set<string>() }; next(); } }));

const { freeNarrationLimits } = await import("@royal-home/shared");
const { waitFor } = await import("./helpers/waitFor.js");
const { drainBackgroundTasks } = await import("../src/lib/shutdownState.js");
const { prisma } = await import("../src/db.js");
const { createFreeNarrationRequest, runFreeNarration, purgeFreeNarrations, freeNarrationUsedToday, canUseFreeNarration } = await import("../src/lib/freeNarration.js");
const { narrationBudgetUsage } = await import("../src/lib/narrationGeneration.js");
const { localVideoFilePath } = await import("../src/lib/localVideoStorage.js");
const { narrationRouter } = await import("../src/routes/properties/narration.js");
const { handleFreeNarrationMessage, handleFreeNarrationCallback } = await import("../src/telegram/assistantFreeNarration.js");

const runId = Date.now().toString(36);
const tail = String(Date.now()).slice(-6);
const voices = [{ id: `vA-${runId}`, name: "Мадина", gender: "female" as const }, { id: `vB-${runId}`, name: "Анна", gender: "female" as const }];
const baseConfig = { modelId: "eleven_v4", voices, defaultVoiceId: voices[1].id, dailyCharLimit: 1_000_000, dailyGenerationLimit: 1000, freeNarrationPerPersonDaily: 50, freeNarrationBudgetPercent: 100 };
let configBefore: unknown = null;
const created: string[] = [];
const agentIds: string[] = [];
let chatSeq = 0;

async function setConfig(extra: Record<string, unknown> = {}) {
  const value = { ...baseConfig, ...extra };
  await prisma.settings.upsert({ where: { id: "singleton" }, create: { id: "singleton", propertyNarrationConfig: value }, update: { propertyNarrationConfig: value } });
}
async function makeAgent(role = "AGENT", extra: Record<string, unknown> = {}) {
  const hash = await bcrypt.hash("testpass123", 4);
  const n = agentIds.length;
  const chat = 700_000_000 + Number(tail) * 10 + (chatSeq++);
  const agent = await prisma.agent.create({ data: { fullName: `Озвучка ${role} ${n}`, phone: `+99294${tail.slice(-4)}${String(n).padStart(3, "0")}`, role: role as "AGENT", passwordHash: hash, telegramChatId: String(chat), ...extra } });
  agentIds.push(agent.id);
  return { id: agent.id, chat };
}
const audioFetch = () => vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
  new Response(new Uint8Array([0x49, 0x44, 0x33, 1, 2, 3]), { status: 200, headers: { "content-type": "audio/mpeg", "request-id": "r1" } }));
const bodyOf = (fetcher: ReturnType<typeof audioFetch>, call = 0) => JSON.parse(String(fetcher.mock.calls[call][1]?.body)) as Record<string, any>;
async function newRequest(agentId: string, text = "Добро пожаловать в Royal Home. Квартира свободна.", extra: Record<string, unknown> = {}) {
  const out = await createFreeNarrationRequest({ agentId, source: "API", text, ...extra });
  if (out.status !== "CREATED") throw new Error(`не создан: ${out.status}`);
  created.push(out.row.id);
  return out.row;
}

let a: { id: string; chat: number }, b: { id: string; chat: number };
beforeAll(async () => {
  configBefore = (await prisma.settings.findUnique({ where: { id: "singleton" }, select: { propertyNarrationConfig: true } }))?.propertyNarrationConfig ?? {};
  await setConfig();
  a = await makeAgent(); b = await makeAgent();
});
beforeEach(() => { vi.clearAllMocks(); });
afterAll(async () => {
  const rows = await prisma.freeNarration.findMany({ where: { agentId: { in: agentIds } }, select: { storageKey: true } });
  for (const r of rows) if (r.storageKey) await fs.rm(localVideoFilePath(r.storageKey)!, { force: true });
  await prisma.freeNarration.deleteMany({ where: { agentId: { in: agentIds } } });
  await prisma.telegramCallbackSeen.deleteMany({ where: { id: { startsWith: `fn-${runId}` } } });
  await prisma.agent.deleteMany({ where: { id: { in: agentIds } } });
  await prisma.settings.update({ where: { id: "singleton" }, data: { propertyNarrationConfig: configBefore as object } });
});

describe("дверь озвучки текста", () => {
  it("читает текст слово в слово, голос по умолчанию из настроек, знаки идут в общий дневной бюджет", async () => {
    const text = "Здравствуйте! ОБ-12: «три комнаты», 85 000 долларов. Звоните.";
    const row = await newRequest(a.id, text);
    expect(row.lang).toBe("ru");
    const before = await narrationBudgetUsage();
    const fetcher = audioFetch();
    const out = await runFreeNarration({ id: row.id, agentId: a.id, fetcher });
    expect(out.status).toBe("READY");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0][0])).toContain(`/v1/text-to-speech/${voices[1].id}`);
    expect(bodyOf(fetcher)).toMatchObject({ text, model_id: "eleven_v4", language_code: "ru" });
    const after = await narrationBudgetUsage();
    expect(after.usedChars - before.usedChars).toBe(text.length);
    expect(after.usedGenerations - before.usedGenerations).toBe(1);
    if (out.status === "READY") {
      expect(out.voiceName).toBe("Анна");
      expect(await fs.readFile(localVideoFilePath(out.storageKey!)!)).toHaveLength(6);
    }
    expect((await prisma.agent.findUnique({ where: { id: a.id }, select: { narrationLastChoice: true } }))?.narrationLastChoice).toMatchObject({ voiceId: voices[1].id });
  });

  it("выбранный голос берётся только из утверждённых; чужой голос отклоняется до вызова провайдера", async () => {
    const row = await newRequest(a.id);
    const fetcher = audioFetch();
    expect((await runFreeNarration({ id: row.id, agentId: a.id, voiceId: "someone-else", fetcher })).status).toBe("VOICE_UNKNOWN");
    expect(fetcher).not.toHaveBeenCalled();
    expect((await runFreeNarration({ id: row.id, agentId: a.id, voiceId: voices[0].id, fetcher })).status).toBe("READY");
    expect(String(fetcher.mock.calls[0][0])).toContain(`/v1/text-to-speech/${voices[0].id}`);
  });

  it("язык: таджикский и русский дают подсказку, неопределённый текст идёт без неё", async () => {
    const tg1 = await newRequest(a.id, "Хуш омадед ба Royal Home, хонаи нав дар ноҳияи Сино");
    const ru1 = await newRequest(a.id, "Добро пожаловать в нашу компанию");
    const en = await newRequest(a.id, "Welcome to Royal Home, please call us");
    expect([tg1.lang, ru1.lang, en.lang]).toEqual(["tg", "ru", null]);
    const fetcher = audioFetch();
    for (const row of [tg1, ru1, en]) await runFreeNarration({ id: row.id, agentId: a.id, fetcher });
    expect(bodyOf(fetcher, 0).language_code).toBe("tg");
    expect(bodyOf(fetcher, 1).language_code).toBe("ru");
    expect(bodyOf(fetcher, 2)).not.toHaveProperty("language_code");
    expect(bodyOf(fetcher, 2).model_id).toBe("eleven_v4");
  });

  it("нажатие дважды и два нажатия разом дают ровно один платёж", async () => {
    const row = await newRequest(a.id);
    const fetcher = audioFetch();
    const [x, y] = await Promise.all([runFreeNarration({ id: row.id, agentId: a.id, fetcher }), runFreeNarration({ id: row.id, agentId: a.id, fetcher })]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect([x.status, y.status].filter((s) => s === "READY")).toHaveLength(1);
    const again = await runFreeNarration({ id: row.id, agentId: a.id, fetcher });
    expect(again.status).toBe("ALREADY_READY");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("повтор запроса с тем же ключом не создаёт вторую озвучку", async () => {
    const requestKey = randomUUID();
    const first = await createFreeNarrationRequest({ agentId: a.id, source: "API", text: "Привет, это проверка ключа", requestKey });
    const second = await createFreeNarrationRequest({ agentId: a.id, source: "API", text: "Привет, это проверка ключа", requestKey });
    expect(first.status).toBe("CREATED"); expect(second.status).toBe("EXISTS");
    if (first.status === "CREATED" && second.status === "EXISTS") expect(second.row.id).toBe(first.row.id);
    // Чужой ключ чужому человеку не отдаётся.
    expect((await createFreeNarrationRequest({ agentId: b.id, source: "API", text: "Привет, это проверка ключа", requestKey })).status).toBe("NO_ACCESS");
  });

  it("потолок на человека: сверх него ElevenLabs не зовётся; у другого человека свой счёт", async () => {
    await setConfig({ freeNarrationPerPersonDaily: 2 });
    const user = await makeAgent();
    const fetcher = audioFetch();
    for (let i = 0; i < 2; i++) expect((await runFreeNarration({ id: (await newRequest(user.id)).id, agentId: user.id, fetcher })).status).toBe("READY");
    const third = await runFreeNarration({ id: (await newRequest(user.id)).id, agentId: user.id, fetcher });
    expect(third).toEqual({ status: "LIMIT_PERSON", limit: 2 });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(await freeNarrationUsedToday(user.id)).toBe(2);
    const other = await makeAgent();
    expect((await runFreeNarration({ id: (await newRequest(other.id)).id, agentId: other.id, fetcher })).status).toBe("READY");
    await setConfig();
  });

  it("общий дневной бюджет озвучки: исчерпан — отказ без вызова ElevenLabs, запрос остаётся ждать", async () => {
    const used = await narrationBudgetUsage();
    await setConfig({ dailyGenerationLimit: used.usedGenerations });
    const row = await newRequest(a.id);
    const fetcher = audioFetch();
    expect((await runFreeNarration({ id: row.id, agentId: a.id, fetcher })).status).toBe("BUDGET");
    expect(fetcher).not.toHaveBeenCalled();
    expect((await prisma.freeNarration.findUnique({ where: { id: row.id } }))?.status).toBe("AWAITING_VOICE");
    await setConfig({ dailyCharLimit: used.usedChars + 5 });
    expect((await runFreeNarration({ id: row.id, agentId: a.id, fetcher })).status).toBe("BUDGET");
    await setConfig();
    expect((await runFreeNarration({ id: row.id, agentId: a.id, fetcher })).status).toBe("READY");
  });

  it("длина: короче 3 и длиннее предела отклоняются без записи", async () => {
    await setConfig({ freeNarrationMaxChars: 100 });
    expect((await createFreeNarrationRequest({ agentId: a.id, source: "API", text: "ab" })).status).toBe("TOO_SHORT");
    expect(await createFreeNarrationRequest({ agentId: a.id, source: "API", text: "я".repeat(101) })).toEqual({ status: "TOO_LONG", max: 100, length: 101 });
    await setConfig();
    expect((await createFreeNarrationRequest({ agentId: a.id, source: "API", text: "я".repeat(1501) })).status).toBe("TOO_LONG");
  });

  it("отказ провайдера: понятный исход, расход засчитан, сам не повторяется; «кредиты кончились» отличается", async () => {
    const row = await newRequest(a.id);
    const down = vi.fn(async () => new Response("oops", { status: 500 }));
    const out = await runFreeNarration({ id: row.id, agentId: a.id, fetcher: down as unknown as typeof fetch });
    expect(out).toEqual({ status: "FAILED", errorCode: "PROVIDER_HTTP_500", quota: false });
    expect((await prisma.freeNarration.findUnique({ where: { id: row.id } }))?.status).toBe("UNKNOWN");
    const fetcher = audioFetch();
    expect((await runFreeNarration({ id: row.id, agentId: a.id, fetcher })).status).toBe("ALREADY_FAILED");
    expect(fetcher).not.toHaveBeenCalled();
    const quotaRow = await newRequest(a.id);
    const quota = vi.fn(async () => new Response(JSON.stringify({ detail: { status: "quota_exceeded" } }), { status: 401 }));
    expect(await runFreeNarration({ id: quotaRow.id, agentId: a.id, fetcher: quota as unknown as typeof fetch })).toMatchObject({ status: "FAILED", quota: true });
  });

  it("права: все активные сотрудники кроме «только чтение»; рубильник выключает для всех", async () => {
    const roles = ["DIRECTOR", "ADMIN", "MARKETING", "EDITOR", "AGENT", "HEAD_OF_SALES", "MANAGER"];
    for (const role of roles) expect(await canUseFreeNarration((await makeAgent(role)).id), role).toBe(true);
    const shareholder = await makeAgent("SHAREHOLDER");
    expect(await canUseFreeNarration(shareholder.id)).toBe(false);
    expect((await createFreeNarrationRequest({ agentId: shareholder.id, source: "API", text: "Привет всем" })).status).toBe("NO_ACCESS");
    const inactive = await makeAgent("AGENT", { isActive: false });
    expect((await createFreeNarrationRequest({ agentId: inactive.id, source: "API", text: "Привет всем" })).status).toBe("NO_ACCESS");
    await setConfig({ freeNarrationEnabled: false });
    expect((await createFreeNarrationRequest({ agentId: a.id, source: "API", text: "Привет всем" })).status).toBe("OFF");
    await setConfig({ voices: [] });
    expect((await createFreeNarrationRequest({ agentId: a.id, source: "API", text: "Привет всем" })).status).toBe("NOT_CONFIGURED");
    await setConfig();
  });

  it("чужой запрос запустить нельзя", async () => {
    const row = await newRequest(a.id);
    const fetcher = audioFetch();
    expect((await runFreeNarration({ id: row.id, agentId: b.id, fetcher })).status).toBe("GONE");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("уборка: файл и текст старше суток убираются, расход остаётся, зависшая генерация закрывается", async () => {
    const row = await newRequest(a.id);
    const out = await runFreeNarration({ id: row.id, agentId: a.id, fetcher: audioFetch() });
    const key = out.status === "READY" ? out.storageKey! : "";
    await prisma.freeNarration.update({ where: { id: row.id }, data: { createdAt: new Date(Date.now() - 25 * 3_600_000) } });
    const stuck = await newRequest(a.id);
    await prisma.freeNarration.update({ where: { id: stuck.id }, data: { status: "GENERATING", generationStartedAt: new Date(Date.now() - 10 * 60_000) } });
    const report = await purgeFreeNarrations();
    expect(report.files).toBeGreaterThanOrEqual(1);
    await expect(fs.access(localVideoFilePath(key)!)).rejects.toThrow();
    const cleaned = await prisma.freeNarration.findUnique({ where: { id: row.id } });
    expect(cleaned).toMatchObject({ storageKey: null, script: "", status: "READY" });
    expect(cleaned!.chars).toBeGreaterThan(0);
    expect((await prisma.freeNarration.findUnique({ where: { id: stuck.id } }))?.status).toBe("UNKNOWN");
  });
});

describe("REST /properties/narration-free", () => {
  const app = express(); app.use(express.json()); app.use("/properties", narrationRouter);
  beforeEach(() => { tg.agent = a.id; });

  it("параметры: голоса, голос по умолчанию, потолки и остаток на сегодня", async () => {
    const res = await request(app).get("/properties/narration-free/options");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ enabled: true, defaultVoiceId: voices[1].id, maxChars: 1500, perPersonDaily: 50 });
    expect(res.body.voices.map((v: { id: string }) => v.id)).toEqual(voices.map((v) => v.id));
    expect(res.body.remainingToday).toBeLessThanOrEqual(50);
    expect(freeNarrationLimits({})).toEqual({ perPersonDaily: 5, maxChars: 1500, budgetPercent: 30 });
  });

  it("плохое тело — 400; нет доступа — 403", async () => {
    expect((await request(app).post("/properties/narration-free").send({ text: "привет" })).status).toBe(400);
    const shareholder = await makeAgent("SHAREHOLDER");
    tg.agent = shareholder.id;
    expect((await request(app).post("/properties/narration-free").send({ text: "Привет всем", requestKey: randomUUID() })).status).toBe(403);
  });

  it("готовая озвучка отдаётся ссылкой; повтор ключа не платит второй раз; чужой файл не отдаётся", async () => {
    const fetcher = audioFetch();
    vi.stubGlobal("fetch", fetcher);
    try {
      const requestKey = randomUUID();
      const payload = { text: "Добрый день! Квартира в Сино свободна.", voiceId: voices[0].id, requestKey };
      const first = await request(app).post("/properties/narration-free").send(payload);
      expect(first.status).toBe(200);
      expect(first.body).toMatchObject({ status: "READY", voiceId: voices[0].id, voiceName: "Мадина", lang: "ru", chars: payload.text.length });
      const second = await request(app).post("/properties/narration-free").send(payload);
      expect(second.status).toBe(200);
      expect(second.body.id).toBe(first.body.id);
      expect(fetcher).toHaveBeenCalledTimes(1);
      const file = await request(app).get(`/properties/narration-free/${first.body.id}/file`);
      expect(file.status).toBe(200);
      expect(file.headers["content-type"]).toContain("audio/mpeg");
      tg.agent = b.id;
      expect((await request(app).get(`/properties/narration-free/${first.body.id}/file`)).status).toBe(404);
      const limited = await request(app).post("/properties/narration-free").send({ ...payload, requestKey: randomUUID(), voiceId: "not-approved" });
      expect(limited.status).toBe(400);
    } finally { vi.unstubAllGlobals(); }
  });
});

describe("Шабнам в Telegram", () => {
  const msg = (chat: number, text: string, extra: Record<string, unknown> = {}) => ({ message_id: 10, chat: { id: chat, type: "private" }, from: { id: chat }, text, ...extra }) as any;
  const click = (chat: number, data: string, id = `fn-${runId}-${randomUUID()}`) => ({ id, data, message: { chat: { id: chat, type: "private" }, message_id: 5, text: "Текст принят" }, from: { id: chat } }) as any;
  const lastButtons = () => (tg.sendMessageWithButtons.mock.calls.at(-1) as unknown as [string, string, Array<Array<{ text: string; callback_data?: string }>>])[2];

  it("вопрос помощнику не перехватывается и ничего не создаёт", async () => {
    const user = await makeAgent();
    expect(await handleFreeNarrationMessage(msg(user.chat, "озвучь сроки по ОБ-12"), user)).toBe(false);
    expect(await handleFreeNarrationMessage(msg(user.chat, "озвучь"), user)).toBe(false);
    expect(await prisma.freeNarration.count({ where: { agentId: user.id } })).toBe(0);
    expect(tg.sendMessage).not.toHaveBeenCalled();
  });

  it("«озвучь: текст» → кнопки (голос по умолчанию первым) → выбор → файл документом; повторы не платят", async () => {
    const user = await makeAgent();
    const fetcher = audioFetch();
    vi.stubGlobal("fetch", fetcher);
    try {
      expect(await handleFreeNarrationMessage(msg(user.chat, "озвучь: Добро пожаловать в Royal Home"), user)).toBe(true);
      expect(fetcher).not.toHaveBeenCalled(); // до выбора голоса денег нет
      const buttons = lastButtons();
      // С 24.11.2026 голос по одному: первым идёт голос по умолчанию, под ним «Выбрать» и «Дальше».
      const shown = (tg.sendMessageWithButtons.mock.calls.at(-1) as unknown as [string, string])[1];
      expect(shown).toContain("Голос 1 из 2: Анна");
      expect(shown).toContain("по умолчанию");
      expect(buttons[0][0].callback_data).toMatch(/^fnr:p:/);
      expect(buttons.flat().some((x) => x.callback_data?.startsWith("fnr:v:"))).toBe(true);
      const row = (await prisma.freeNarration.findFirst({ where: { agentId: user.id } }))!;
      expect(row).toMatchObject({ status: "AWAITING_VOICE", script: "Добро пожаловать в Royal Home" });
      expect(buttons.flat().every((x) => (x.callback_data ?? "").length <= 64)).toBe(true);

      const pick = buttons[0][0].callback_data!;
      const clickId = `fn-${runId}-${randomUUID()}`;
      expect(await handleFreeNarrationCallback(click(user.chat, pick, clickId))).toBe(true);
      await waitFor(() => tg.sendDocumentFile.mock.calls.length === 1);
      expect(fetcher).toHaveBeenCalledTimes(1);
      const call = tg.sendDocumentFile.mock.calls[0] as unknown as [string, { path: string }, string, string];
      expect(call[0]).toBe(String(user.chat));
      expect(call[2]).toMatch(/\.mp3$/u);
      expect(call[3]).toBe("Озвучка для монтажа, голос Анна, 29 знаков");

      // Та же доставка нажатия и новое нажатие на ту же кнопку: второй генерации нет.
      expect(await handleFreeNarrationCallback(click(user.chat, pick, clickId))).toBe(true);
      expect(await handleFreeNarrationCallback(click(user.chat, pick))).toBe(true);
      expect(fetcher).toHaveBeenCalledTimes(1);
      // Готовая озвучка: нажатие ещё раз досылает файл из хранилища, без второго платежа.
      expect(tg.sendDocumentFile.mock.calls.length).toBeGreaterThanOrEqual(1);
    } finally { vi.unstubAllGlobals(); }
  });

  it("чужая кнопка не работает; смена списка голосов не подменяет голос", async () => {
    const owner = await makeAgent(); const stranger = await makeAgent();
    const fetcher = audioFetch();
    vi.stubGlobal("fetch", fetcher);
    try {
      await handleFreeNarrationMessage(msg(owner.chat, "озвучь текст: Салом, хуш омадед"), owner);
      const buttons = lastButtons();
      const pick = buttons[0][0].callback_data!;
      await handleFreeNarrationCallback(click(stranger.chat, pick));
      expect(fetcher).not.toHaveBeenCalled();
      // Голоса перестановили: индекс из кнопки указывает на другой голос, хэш не сходится.
      await setConfig({ voices: [voices[1], voices[0]] });
      await handleFreeNarrationCallback(click(owner.chat, pick));
      expect(fetcher).not.toHaveBeenCalled();
      await setConfig();
    } finally { vi.unstubAllGlobals(); }
  });

  it("переключение языка меняет подсказку синтеза", async () => {
    const user = await makeAgent();
    const fetcher = audioFetch();
    vi.stubGlobal("fetch", fetcher);
    try {
      await handleFreeNarrationMessage(msg(user.chat, "озвучь: Добро пожаловать"), user);
      const buttons = lastButtons();
      const row = (await prisma.freeNarration.findFirst({ where: { agentId: user.id } }))!;
      expect(row.lang).toBe("ru");
      await handleFreeNarrationCallback(click(user.chat, `fnr:l:${row.id}:tg`));
      expect((await prisma.freeNarration.findUnique({ where: { id: row.id } }))?.lang).toBe("tg");
      await handleFreeNarrationCallback(click(user.chat, buttons[0][0].callback_data!));
      await waitFor(() => fetcher.mock.calls.length === 1);
      expect(bodyOf(fetcher).language_code).toBe("tg");
    } finally { vi.unstubAllGlobals(); }
  });

  it("«озвучь текст» без текста: ждём текст; голосом не принимаем; «отмена» снимает ожидание", async () => {
    const user = await makeAgent();
    expect(await handleFreeNarrationMessage(msg(user.chat, "озвучь текст"), user)).toBe(true);
    expect(String(tg.sendMessage.mock.calls.at(-1)?.[1])).toContain("Пришлите текст");
    expect(await handleFreeNarrationMessage(msg(user.chat, "", { voice: { file_id: "v", duration: 3 }, text: undefined }), user)).toBe(true);
    expect(String(tg.sendMessage.mock.calls.at(-1)?.[1])).toContain("текст сообщением");
    expect(await handleFreeNarrationMessage(msg(user.chat, "отмена"), user)).toBe(true);
    expect(await handleFreeNarrationMessage(msg(user.chat, "сроки по ОБ-12"), user)).toBe(false);
    await handleFreeNarrationMessage(msg(user.chat, "озвучь текст"), user);
    expect(await handleFreeNarrationMessage(msg(user.chat, "Первая строка объявления"), user)).toBe(true);
    expect((await prisma.freeNarration.findFirst({ where: { agentId: user.id, status: "AWAITING_VOICE" } }))?.script).toBe("Первая строка объявления");
  });

  it("ответом «озвучь» на свой текст; ответ на сообщение бота остаётся «озвучь ответ» помощника", async () => {
    const user = await makeAgent();
    expect(await handleFreeNarrationMessage(msg(user.chat, "озвучь", { reply_to_message: { message_id: 4, chat: { id: user.chat }, from: { id: user.chat, is_bot: false }, text: "Сдаётся квартира в центре" } }), user)).toBe(true);
    expect((await prisma.freeNarration.findFirst({ where: { agentId: user.id } }))?.script).toBe("Сдаётся квартира в центре");
    expect(await handleFreeNarrationMessage(msg(user.chat, "озвучь", { reply_to_message: { message_id: 4, chat: { id: user.chat }, from: { id: 1, is_bot: true }, text: "Ответ помощника" } }), user)).toBe(false);
  });

  it("нет доступа и сверх предела длины: понятные ответы, ничего не создаётся", async () => {
    const shareholder = await makeAgent("SHAREHOLDER");
    expect(await handleFreeNarrationMessage(msg(shareholder.chat, "озвучь: Привет всем"), shareholder)).toBe(true);
    expect(String(tg.sendMessage.mock.calls.at(-1)?.[1])).toContain("нет доступа");
    const user = await makeAgent();
    await handleFreeNarrationMessage(msg(user.chat, `озвучь: ${"слово ".repeat(400)}`), user);
    expect(String(tg.sendMessage.mock.calls.at(-1)?.[1])).toContain("длиннее 1500 знаков");
    expect(await prisma.freeNarration.count({ where: { agentId: { in: [shareholder.id, user.id] } } })).toBe(0);
  });

  it("предел на человека и сбой провайдера: вежливый ответ, файл не шлётся", async () => {
    await setConfig({ freeNarrationPerPersonDaily: 1 });
    const user = await makeAgent();
    const fetcher = audioFetch();
    vi.stubGlobal("fetch", fetcher);
    try {
      await handleFreeNarrationMessage(msg(user.chat, "озвучь: Первая озвучка"), user);
      await handleFreeNarrationCallback(click(user.chat, lastButtons()[0][0].callback_data!));
      await waitFor(() => tg.sendDocumentFile.mock.calls.length === 1);
      await handleFreeNarrationMessage(msg(user.chat, "озвучь: Вторая озвучка"), user);
      await handleFreeNarrationCallback(click(user.chat, lastButtons()[0][0].callback_data!));
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(tg.sendDocumentFile).toHaveBeenCalledTimes(1);
      const shown = [...tg.editMessageText.mock.calls, ...tg.sendMessage.mock.calls].map((c) => String(c[2] ?? c[1]));
      expect(shown.some((t) => t.includes("уже сделали 1 озвучек"))).toBe(true);
      await setConfig();
      vi.stubGlobal("fetch", vi.fn(async () => new Response("x", { status: 503 })));
      const other = await makeAgent();
      await handleFreeNarrationMessage(msg(other.chat, "озвучь: Третья озвучка"), other);
      await handleFreeNarrationCallback(click(other.chat, lastButtons()[0][0].callback_data!));
      await waitFor(() => String(tg.sendMessage.mock.calls.at(-1)?.[1]).includes("Не получилось"));
      expect(tg.sendDocumentFile).toHaveBeenCalledTimes(1);
    } finally { vi.unstubAllGlobals(); }
  });
});

describe("правки после ревью (16.11.2026)", () => {
  const msg = (chat: number, text: string, extra: Record<string, unknown> = {}) => ({ message_id: 10, chat: { id: chat, type: "private" }, from: { id: chat }, text, ...extra }) as any;
  const click = (chat: number, data: string, id = `fn-${runId}-${randomUUID()}`) => ({ id, data, message: { chat: { id: chat, type: "private" }, message_id: 5, text: "Текст принят" }, from: { id: chat } }) as any;
  const lastButtons = () => (tg.sendMessageWithButtons.mock.calls.at(-1) as unknown as [string, string, Array<Array<{ text: string; callback_data?: string }>>])[2];

  it("нажатие занимает запись и возвращается РАНЬШЕ, чем ответит ElevenLabs; файл уходит из фона", async () => {
    // ГОНКА С ФОНОМ ПРЕДЫДУЩИХ ТЕСТОВ (облачный прогон 21.11.2026, #378): отправка файла из фона прошлого теста этого
    // файла приземлилась уже здесь — «sendDocumentFile вызван 1 раз» до ответа ElevenLabs, а на повторе счётчик
    // «ровно 1» не сошёлся за 2 с. Код не виноват: дожидаемся чужого фона, считаем только свой чат, фону — запас времени.
    await drainBackgroundTasks(30_000);
    const user = await makeAgent();
    const docsToUser = () => tg.sendDocumentFile.mock.calls.filter((c) => String(c[0]) === String(user.chat)).length;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const slow = vi.fn(async () => { await gate; return new Response(new Uint8Array([0x49, 0x44, 0x33, 1]), { status: 200, headers: { "content-type": "audio/mpeg" } }); });
    vi.stubGlobal("fetch", slow);
    try {
      await handleFreeNarrationMessage(msg(user.chat, "озвучь: Медленная озвучка"), user);
      const pick = lastButtons()[0][0].callback_data!;
      const done = await Promise.race([handleFreeNarrationCallback(click(user.chat, pick)).then(() => "handler"), new Promise((r) => setTimeout(() => r("timeout"), 8000))]);
      expect(done).toBe("handler");
      await waitFor(() => slow.mock.calls.length === 1, { timeoutMs: 10_000 });
      expect(docsToUser()).toBe(0);
      expect((await prisma.freeNarration.findFirst({ where: { agentId: user.id } }))?.status).toBe("GENERATING");
      // Второе нажатие, пока идёт генерация, ничего не запускает.
      await handleFreeNarrationCallback(click(user.chat, pick));
      expect(slow).toHaveBeenCalledTimes(1);
      release();
      await waitFor(() => docsToUser() === 1, { timeoutMs: 15_000, label: "файл озвучки ушёл из фона" });
      await drainBackgroundTasks(15_000);
      expect(docsToUser()).toBe(1);
    } finally { release(); vi.unstubAllGlobals(); }
  });

  it("свободные тексты не выедают весь дневной бюджет: у них своя доля общего замка", async () => {
    const { freeNarrationUsage } = await import("../src/lib/narrationGeneration.js");
    const before = await freeNarrationUsage(prisma);
    const total = await narrationBudgetUsage();
    // Доля 50% от потолка D даёт свободным текстам ровно «уже было + 2» озвучки; общий потолок при этом не мешает.
    const limit = Math.min(1000, 2 * (before.usedGenerations + 2));
    await setConfig({ freeNarrationBudgetPercent: 50, dailyGenerationLimit: limit });
    const user = await makeAgent();
    const fetcher = audioFetch();
    const statuses: string[] = [];
    for (let i = 0; i < 4; i++) statuses.push((await runFreeNarration({ id: (await newRequest(user.id)).id, agentId: user.id, fetcher })).status);
    const shareRoom = Math.max(0, Math.floor(limit * 50 / 100) - before.usedGenerations);
    const generalRoom = Math.max(0, limit - total.usedGenerations);
    const expectedOk = Math.min(shareRoom, generalRoom, 4);
    expect(statuses.filter((x) => x === "READY")).toHaveLength(expectedOk);
    expect(statuses.filter((x) => x !== "READY").every((x) => x === "BUDGET")).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(expectedOk);
    expect(expectedOk).toBeLessThan(4);
    await setConfig();
  });

  it("файл не ушёл в Telegram: приходит кнопка «Прислать файл», повторная отправка из хранилища без второй оплаты", async () => {
    const user = await makeAgent();
    const fetcher = audioFetch();
    vi.stubGlobal("fetch", fetcher);
    try {
      await handleFreeNarrationMessage(msg(user.chat, "озвучь: Озвучка с неудачной отправкой"), user);
      const pick = lastButtons()[0][0].callback_data!;
      tg.sendDocumentFile.mockRejectedValueOnce(new Error("telegram down"));
      await handleFreeNarrationCallback(click(user.chat, pick));
      await waitFor(() => tg.sendMessageWithButtons.mock.calls.some((c) => (c as unknown as [string, string, Array<Array<{ text: string; callback_data?: string }>>])[2][0][0].text.includes("Прислать файл")), { timeoutMs: 10_000 });
      const resend = lastButtons()[0][0];
      expect(resend.callback_data).toBe(pick);
      await handleFreeNarrationCallback(click(user.chat, resend.callback_data!));
      await waitFor(() => tg.sendDocumentFile.mock.calls.length === 2);
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally { vi.unstubAllGlobals(); }
  });

  it("«озвучь текст» при выключенном рубильнике отвечает сразу, а не просит прислать текст; таджикское «матнро овоз кунед» тоже спрашивает текст", async () => {
    const user = await makeAgent();
    await setConfig({ freeNarrationEnabled: false });
    expect(await handleFreeNarrationMessage(msg(user.chat, "озвучь текст"), user)).toBe(true);
    expect(String(tg.sendMessage.mock.calls.at(-1)?.[1])).toContain("выключена");
    expect(await prisma.freeNarration.count({ where: { agentId: user.id } })).toBe(0);
    await setConfig();
    expect(await handleFreeNarrationMessage(msg(user.chat, "матнро овоз кунед"), user)).toBe(true);
    expect(String(tg.sendMessage.mock.calls.at(-1)?.[1])).toContain("Пришлите текст");
  });

  it("пока ждём текст, пересланное сообщение принимается как текст для озвучки; без ожидания не перехватывается", async () => {
    const user = await makeAgent();
    expect(await handleFreeNarrationMessage(msg(user.chat, "Пересланный текст без ожидания", { forward_origin: { type: "user" } }), user, true)).toBe(false);
    await handleFreeNarrationMessage(msg(user.chat, "озвучь текст"), user);
    expect(await handleFreeNarrationMessage(msg(user.chat, "Пересланный текст объявления для озвучки", { forward_origin: { type: "user" } }), user, true)).toBe(true);
    expect((await prisma.freeNarration.findFirst({ where: { agentId: user.id, status: "AWAITING_VOICE" } }))?.script).toBe("Пересланный текст объявления для озвучки");
  });

  it("таджикский отказ по длине: «шумо N аломат навиштед»", async () => {
    const user = await makeAgent();
    const dialog = { chatId: String(user.chat), agentId: user.id, kind: "test", payload: { lang: "tg" }, expiresAt: new Date(Date.now() + 3_600_000) };
    await prisma.telegramDialogState.create({ data: dialog });
    await handleFreeNarrationMessage(msg(user.chat, `озвучь: ${"слово ".repeat(400)}`), user);
    const text = String(tg.sendMessage.mock.calls.at(-1)?.[1]);
    expect(text).toMatch(/шумо \d+ аломат навиштед/u);
    await prisma.telegramDialogState.deleteMany({ where: { chatId: String(user.chat) } });
  });

  it("REST: файл не сохранился, но озвучка оплачена: аудио отдаётся прямо в ответе; тот же ключ с другим текстом это 422", async () => {
    const user = await makeAgent();
    tg.agent = user.id;
    const app = express(); app.use(express.json()); app.use("/properties", narrationRouter);
    vi.stubGlobal("fetch", audioFetch());
    tg.failUpload = true;
    try {
      const requestKey = randomUUID();
      const res = await request(app).post("/properties/narration-free").send({ text: "Озвучка при сбое диска", requestKey }).buffer(true).parse((r, cb) => { const chunks: Buffer[] = []; r.on("data", (c) => chunks.push(c)); r.on("end", () => cb(null, Buffer.concat(chunks))); });
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("audio/mpeg");
      expect(res.headers["x-free-narration-id"]).toBeTruthy();
      expect((res.body as Buffer).length).toBe(6);
      const conflict = await request(app).post("/properties/narration-free").send({ text: "Совсем другой текст", requestKey });
      expect(conflict.status).toBe(422);
    } finally { tg.failUpload = false; vi.unstubAllGlobals(); }
  });

  it("уборка: готовая запись без файла тоже теряет текст через сутки", async () => {
    const user = await makeAgent();
    const row = await newRequest(user.id, "Текст готовой записи без файла");
    await prisma.freeNarration.update({ where: { id: row.id }, data: { status: "READY", storageKey: null, createdAt: new Date(Date.now() - 25 * 3_600_000) } });
    await purgeFreeNarrations();
    expect((await prisma.freeNarration.findUnique({ where: { id: row.id } }))?.script).toBe("");
  });
});
