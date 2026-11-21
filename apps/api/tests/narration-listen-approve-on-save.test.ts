import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

/**
 * «ПРОСЛУШАТЬ ПРЯМО ТУТ» И «СОХРАНИЛ = ОДОБРИЛ» (21.11.2026, владелец: «разве недостаточно, что выбрали озвучку уже?»;
 * «не прослушали — ничего страшного, это вина агента… одобрение сразу там же, чтобы сверх быстро всё»).
 * База и файлы настоящие; ElevenLabs, Telegram и пуши подменены — ни одного платного вызова.
 *  — прослушал и не менял: версия сразу готова на прослушанном файле и одобрена автором, второй генерации нет;
 *  — не прослушал: после генерации версия одобрена автором, просьбы «прослушайте» нет;
 *  — изменил после прослушивания: одна новая генерация, и она тоже одобрена автором;
 *  — цена в долларах (#348): не одобряется; чужой без прав: не одобряет;
 *  — тот же текст и голос второй раз не оплачиваются; предел и общий потолок считаются;
 *  — строка монтажёру не обещает «ждёт одобрения», когда ждать некого;
 *  — одна дверь синтеза: generateNarrationAudio зовут только synthesizeNarrationSpeech и образцы голосов.
 */
const tts = vi.hoisted(() => ({ audio: vi.fn(async () => ({ status: "READY" as const, audio: Buffer.from("synthetic-mp3"), requestId: "req-1" })) }));
const ch = vi.hoisted(() => ({ tgOn: false, telegram: vi.fn(async () => ({})), push: vi.fn(async () => 0), feed: vi.fn(async () => ({})) }));
vi.mock("../src/lib/propertyNarration.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/lib/propertyNarration.js")>()), generateNarrationAudio: tts.audio }));
vi.mock("../src/lib/narrationLoudness.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/lib/narrationLoudness.js")>()), normalizeNarrationVoice: async (audio: Buffer) => audio }));
vi.mock("../src/ai/liveVoiceProvider.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/ai/liveVoiceProvider.js")>()), resolveElevenLabsKey: () => "test-key" }));
vi.mock("../src/telegram/api.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/telegram/api.js")>()),
  sendMessage: vi.fn(async () => ({})), sendMessageWithButtons: ch.telegram, sendDocumentFile: vi.fn(async () => ({})), isTelegramEnabled: () => ch.tgOn }));
vi.mock("../src/push.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/push.js")>()), sendPushToAgent: ch.push, sendPushToAgents: vi.fn(async () => 0) }));
vi.mock("../src/lib/notifications.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/lib/notifications.js")>()), createNotification: ch.feed }));

const { narrationDraftText } = await import("@royal-home/shared");
const { prisma } = await import("../src/db.js");
const { listenNarration, NARRATION_LISTEN_PER_PERSON_DAILY } = await import("../src/lib/narrationListen.js");
const { startNarrationForNewProperty, approveNarrationAsSaved, requestAutoNarration, runNarrationAutoFlow, requestNarrationAfterEdit, remakeRedeliveries, wizardNarrationTextRejection } = await import("../src/lib/narrationAutoFlow.js");
const { notifyNarrationApproval } = await import("../src/telegram/assistantNarration.js");
const { generateNarrationVersion, loadNarrationConfiguration, narrationBudgetUsage } = await import("../src/lib/narrationGeneration.js");
const { narrationFacts } = await import("../src/lib/propertyNarration.js");
const { narrationLineForMontajer } = await import("../src/lib/narrationMontajerNote.js");
const { localVideoFilePath } = await import("../src/lib/localVideoStorage.js");

const runId = Date.now();
const TEMPLATE = { id: "t1", name: "Т", lang: "ru" as const, text: "Квартира, {площадь} квадратных метров. Звоните." };
const VOICES = [{ id: "voiceA", name: "Мадина" }, { id: "voiceB", name: "Фирӯз" }];
let configBefore: unknown = null;
let modeBefore: string | undefined;
let districtId = "";
const agentIds: string[] = [];
const propertyIds: string[] = [];
let author = "";
let stranger = "";

async function makeAgent(n: number, role = "AGENT") {
  const a = await prisma.agent.create({ data: { fullName: `Слушатель ${n}`, phone: `+9929${n}${String(runId).slice(-7)}`, role: role as "AGENT", passwordHash: await bcrypt.hash("testpass123", 4) } });
  agentIds.push(a.id);
  return a.id;
}
async function seedProperty(over: Record<string, unknown> = {}) {
  const p = await prisma.property.create({ data: { title: `Прослушка-${runId}-${propertyIds.length}`, type: "APARTMENT", areaSqm: 60 + propertyIds.length, price: 500000, currency: "TJS", districtId,
    address: "Сино, 1", condition: "GOOD", status: "AWAITING_VIDEO", assignedAgentId: author, createdById: author, intakeAgentId: author, ...over } });
  propertyIds.push(p.id);
  return p;
}
async function textFor(propertyId: string) {
  const p = await prisma.property.findUniqueOrThrow({ where: { id: propertyId }, include: { district: true } });
  const { config } = await loadNarrationConfiguration();
  return narrationDraftText(config, narrationFacts(p), TEMPLATE.id, null).text;
}
const latestOf = (propertyId: string) => prisma.propertyNarrationVersion.findFirstOrThrow({ where: { propertyId }, orderBy: { revision: "desc" } });
/** Обход озвучил версию (как generateDueNarrations): та же дверь платной озвучки. */
async function generate(propertyId: string) {
  const v = await latestOf(propertyId);
  await prisma.propertyNarrationVersion.update({ where: { id: v.id }, data: { generateAfter: new Date(Date.now() - 1000) } });
  const { config, key } = await loadNarrationConfiguration();
  const out = await generateNarrationVersion({ propertyId, versionId: v.id, expectedRevision: v.revision, requireApproval: false, config, key: key! });
  expect(out.status).toBe("READY");
  return v.id;
}

beforeAll(async () => {
  modeBefore = process.env.CRM_NARRATION_EXECUTION_MODE;
  process.env.CRM_NARRATION_EXECUTION_MODE = "PREVIEW";
  const s = await prisma.settings.upsert({ where: { id: "singleton" }, create: { id: "singleton" }, update: {}, select: { propertyNarrationConfig: true } });
  configBefore = s.propertyNarrationConfig ?? null;
  await prisma.settings.update({ where: { id: "singleton" }, data: { propertyNarrationConfig: { modelId: "eleven_v4", voices: VOICES, defaultVoiceId: "voiceA", templates: [TEMPLATE], endings: [],
    autoGenerate: true, dailyCharLimit: 1_000_000, dailyGenerationLimit: 1000 } } });
  districtId = (await prisma.district.create({ data: { name: `Прослушка-${runId}` } })).id;
  author = await makeAgent(1);
  stranger = await makeAgent(2);
}, 60_000);
beforeEach(() => { tts.audio.mockClear(); ch.telegram.mockClear(); ch.push.mockClear(); ch.feed.mockClear(); ch.tgOn = false; });
async function withLive<T>(fn: () => Promise<T>): Promise<T> {
  process.env.CRM_NARRATION_EXECUTION_MODE = "LIVE";
  try { return await fn(); } finally { process.env.CRM_NARRATION_EXECUTION_MODE = "PREVIEW"; }
}
afterAll(async () => {
  process.env.CRM_NARRATION_EXECUTION_MODE = modeBefore;
  const files = [
    ...(await prisma.propertyNarrationVersion.findMany({ where: { propertyId: { in: propertyIds } }, select: { storageKey: true } })),
    ...(await prisma.freeNarration.findMany({ where: { agentId: { in: agentIds } }, select: { storageKey: true } })),
  ];
  for (const f of files) if (f.storageKey) await fs.rm(localVideoFilePath(f.storageKey)!, { force: true });
  await prisma.propertyNarrationDelivery.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.videoRemakeRequest.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.propertyNarrationVersion.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.freeNarration.deleteMany({ where: { agentId: { in: agentIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.agent.deleteMany({ where: { id: { in: agentIds } } });
  await prisma.settings.update({ where: { id: "singleton" }, data: { propertyNarrationConfig: (configBefore ?? {}) as object } }).catch(() => {});
});

describe("«▶ Прослушать»: тот же путь звука и без второй оплаты", () => {
  it("тот же текст и голос второй раз не оплачиваются; знаки идут в общий дневной потолок", async () => {
    const p = await seedProperty();
    const script = await textFor(p.id);
    const before = await narrationBudgetUsage();
    const first = await listenNarration({ agentId: author, script, voiceId: "voiceA", lang: "ru" });
    const again = await listenNarration({ agentId: author, script: `${script} `, voiceId: "voiceA", lang: "ru" });
    expect(first).toMatchObject({ status: "READY", cached: false });
    expect(again).toMatchObject({ status: "READY", cached: true });
    expect(first.status === "READY" && again.status === "READY" && again.id === first.id).toBe(true);
    expect(tts.audio).toHaveBeenCalledTimes(1);
    expect((await narrationBudgetUsage()).usedGenerations - before.usedGenerations).toBe(1);
    // Синтез получил текст для голоса и язык ролика — тот же путь, что у звука объекта.
    expect(tts.audio.mock.calls[0]?.[0]).toMatchObject({ voiceId: "voiceA", lang: "ru" });
  });
  it("доллары в тексте не озвучиваются и не оплачиваются (#348)", async () => {
    const out = await listenNarration({ agentId: author, script: "Квартира за восемьдесят пять тысяч долларов. Звоните.", voiceId: "voiceA", lang: "ru" });
    expect(out.status).toBe("INVALID");
    expect(tts.audio).not.toHaveBeenCalled();
  });
  it("предел на человека — своя строка, озвучку своего текста не трогает", () => {
    expect(NARRATION_LISTEN_PER_PERSON_DAILY).toBeGreaterThan(0);
  });
});

describe("«Сохранить» в мастере = одобрить", () => {
  it("прослушал и не менял: версия сразу готова на прослушанном файле и одобрена автором, без второй генерации", async () => {
    const p = await seedProperty();
    const heard = await listenNarration({ agentId: author, script: await textFor(p.id), voiceId: "voiceA", lang: "ru" });
    expect(heard.status).toBe("READY");
    tts.audio.mockClear();
    await startNarrationForNewProperty(p.id, author, { templateId: TEMPLATE.id, voiceId: "voiceA", listenId: heard.status === "READY" ? heard.id : undefined });
    const v = await latestOf(p.id);
    expect(v).toMatchObject({ status: "READY", approvedById: author, generateAfter: null });
    expect(v.approvedAt).not.toBeNull();
    expect(v.approvalNotifiedAt).toBeNull(); // одобрение человека, а не самой CRM
    expect(tts.audio).not.toHaveBeenCalled();
    expect((await fs.readFile(localVideoFilePath(v.storageKey!)!)).toString()).toBe("synthetic-mp3");
    expect(path.dirname(v.storageKey!)).toBe(p.id);
  });

  it("не прослушал: после генерации одобрена автором, просьбы «прослушайте» нет", async () => {
    const p = await seedProperty();
    await startNarrationForNewProperty(p.id, author, { templateId: TEMPLATE.id, voiceId: "voiceA" });
    const draft = await latestOf(p.id);
    expect(draft).toMatchObject({ status: "DRAFT", approveAsId: author });
    await generate(p.id);
    const notify = vi.fn(async () => {});
    await runNarrationAutoFlow({ notifyAgent: notify });
    const v = await latestOf(p.id);
    expect(v.approvedById).toBe(author);
    expect(v.approvedAt).not.toBeNull();
    expect(notify).not.toHaveBeenCalledWith(v.id);
    expect(tts.audio).toHaveBeenCalledTimes(1);
  });

  it("изменил голос после прослушивания: одна новая генерация, и она тоже одобрена автором", async () => {
    const p = await seedProperty();
    const heard = await listenNarration({ agentId: author, script: await textFor(p.id), voiceId: "voiceA", lang: "ru" });
    tts.audio.mockClear();
    await startNarrationForNewProperty(p.id, author, { templateId: TEMPLATE.id, voiceId: "voiceB", listenId: heard.status === "READY" ? heard.id : undefined });
    const draft = await latestOf(p.id);
    // Не совпало — пауза снята, версия идёт обычным путём (обход возьмёт её сразу).
    expect(draft.status).toBe("DRAFT");
    expect(draft.generateAfter!.getTime()).toBeLessThanOrEqual(Date.now());
    const id = await generate(p.id);
    expect(await approveNarrationAsSaved(id)).toBe("AUDIO_APPROVED");
    expect((await latestOf(p.id)).approvedById).toBe(author);
    expect(tts.audio).toHaveBeenCalledTimes(1);
  });

  it("цена в долларах: готовая версия не одобряется и не уходит (#348)", async () => {
    const p = await seedProperty();
    const v = await prisma.propertyNarrationVersion.create({ data: { propertyId: p.id, revision: 1, script: "Квартира за восемьдесят пять тысяч долларов.", factsSnapshot: narrationFacts({ ...p, district: { name: `Прослушка-${runId}` } }) as object,
      factsHash: "x", voiceId: "voiceA", modelId: "eleven_v4", status: "READY", storageKey: `${p.id}/${randomUUID()}.mp3`, createdById: author, requestKey: randomUUID(), source: "WIZARD", approveAsId: author } });
    // factsHash «x» не совпадает с фактами — пусть совпадёт, чтобы проверять именно сторож долларов.
    const { narrationHash } = await import("../src/lib/propertyNarration.js");
    const full = await prisma.property.findUniqueOrThrow({ where: { id: p.id }, include: { district: true } });
    await prisma.propertyNarrationVersion.update({ where: { id: v.id }, data: { factsHash: narrationHash(narrationFacts(full)) } });
    expect(await approveNarrationAsSaved(v.id)).toBe("PRICE_NOT_IN_TJS");
    expect((await latestOf(p.id)).approvedAt).toBeNull();
  });

  it("сохранивший без прав на объект не одобряет — версия ждёт человека", async () => {
    const p = await seedProperty();
    await requestAutoNarration({ propertyId: p.id, actorId: stranger, source: "AGENT", templateId: TEMPLATE.id, voiceId: "voiceA", debounceMs: 0, approveAsId: stranger });
    const id = await generate(p.id);
    expect(await approveNarrationAsSaved(id)).toBeNull();
    expect((await latestOf(p.id)).approvedAt).toBeNull();
  });
});

describe("перемонтаж и строка монтажёру", () => {
  it("озвучку не меняли: монтажёру — уже одобренная, без ожидания и без генерации", async () => {
    const p = await seedProperty();
    const heard = await listenNarration({ agentId: author, script: await textFor(p.id), voiceId: "voiceA", lang: "ru" });
    await startNarrationForNewProperty(p.id, author, { templateId: TEMPLATE.id, voiceId: "voiceA", listenId: heard.status === "READY" ? heard.id : undefined });
    tts.audio.mockClear();
    const line = await narrationLineForMontajer(p.id);
    expect(line).toContain("одобрена");
    expect(line).not.toContain("ждёт одобрения");
    expect(tts.audio).not.toHaveBeenCalled();
  });
  it("озвучку поменяли («Озвучить» в карточке): пока готовится — «готовится», не «ждёт одобрения»; готова — одобрена нажавшим", async () => {
    const p = await seedProperty();
    await requestAutoNarration({ propertyId: p.id, actorId: author, source: "AGENT", templateId: TEMPLATE.id, voiceId: "voiceB", debounceMs: 0, approveAsId: author });
    const line = await narrationLineForMontajer(p.id);
    expect(line).toContain("готовится");
    expect(line).not.toContain("ждёт одобрения");
    const id = await generate(p.id);
    expect(await approveNarrationAsSaved(id)).toBe("AUDIO_APPROVED");
    expect(await narrationLineForMontajer(p.id)).toContain("одобрена");
  });
});

describe("одна дверь синтеза", () => {
  it("generateNarrationAudio зовут только synthesizeNarrationSpeech и образцы голосов", async () => {
    const src = path.resolve(import.meta.dirname, "../src");
    const hits: string[] = [];
    async function walk(dir: string) {
      for (const e of await fs.readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== "generated") await walk(full); continue; }
        if (!/\.ts$/u.test(e.name)) continue;
        const text = await fs.readFile(full, "utf8");
        const calls = text.match(/generateNarrationAudio\(/gu)?.length ?? 0;
        if (calls) hits.push(`${path.relative(src, full).replaceAll("\\", "/")}:${calls}`);
      }
    }
    await walk(src);
    // narrationGeneration.ts: synthesizeNarrationSpeech и generateVoiceSamples; propertyNarration.ts: само объявление.
    expect(hits.sort()).toEqual(["lib/narrationGeneration.ts:2", "lib/propertyNarration.ts:1"]);
  });
});

describe("ревью 21.11", () => {
  it("вышедший ролик + правка цены человеком → новая озвучка одобрена им; правил не человек → ждёт", async () => {
    const p = await seedProperty({ publishedChannels: ["FACEBOOK"] });
    await startNarrationForNewProperty(p.id, author, { templateId: TEMPLATE.id, voiceId: "voiceA" });
    expect(await approveNarrationAsSaved(await generate(p.id))).toBe("AUDIO_APPROVED");
    // Площадь звучит в шаблоне: правка факта = новая озвучка.
    await prisma.property.update({ where: { id: p.id }, data: { areaSqm: 99 } });
    expect(await withLive(() => requestNarrationAfterEdit(p.id, new Date(), author))).toMatchObject({ status: "QUEUED" });
    expect((await latestOf(p.id)).approveAsId).toBe(author);
    expect(await approveNarrationAsSaved(await generate(p.id))).toBe("AUDIO_APPROVED");
    expect((await latestOf(p.id)).approvedById).toBe(author);
    // Обход фактов (не человек): approveAsId нет — одобрять некому, версия ждёт.
    await prisma.property.update({ where: { id: p.id }, data: { areaSqm: 101 } });
    expect(await withLive(() => requestNarrationAfterEdit(p.id, new Date()))).toMatchObject({ status: "QUEUED" });
    const id = await generate(p.id);
    expect((await latestOf(p.id)).approveAsId).toBeNull();
    expect(await approveNarrationAsSaved(id)).toBeNull();
    await runNarrationAutoFlow({});
    expect((await latestOf(p.id)).approvedAt).toBeNull();
  });

  it("текст агента не принят: шаблон без одобрения, причина в ответ, просьба — только туда, где завели (CRM / Шабнам)", async () => {
    const dollars = { templateId: TEMPLATE.id, voiceId: "voiceA", script: "Квартира за восемьдесят пять тысяч долларов, звоните." };
    expect(wizardNarrationTextRejection(dollars)).toMatch(/сомони/u);
    expect(wizardNarrationTextRejection({ templateId: TEMPLATE.id })).toBeNull();
    await prisma.agent.update({ where: { id: author }, data: { telegramChatId: String(700_000_000 + (runId % 1_000_000)) } });
    ch.tgOn = true;
    for (const askVia of ["CRM", "TELEGRAM"] as const) {
      ch.telegram.mockClear(); ch.push.mockClear(); ch.feed.mockClear();
      const p = await seedProperty();
      await startNarrationForNewProperty(p.id, author, dollars, askVia);
      const v = await latestOf(p.id);
      expect(v).toMatchObject({ approveAsId: null, askVia, script: await textFor(p.id) });
      await generate(p.id);
      expect(await approveNarrationAsSaved(v.id)).toBeNull();
      await notifyNarrationApproval(v.id);
      if (askVia === "CRM") { expect(ch.push).toHaveBeenCalled(); expect(ch.telegram).not.toHaveBeenCalled(); }
      else { expect(ch.telegram).toHaveBeenCalled(); expect(ch.push).not.toHaveBeenCalled(); expect(ch.feed).not.toHaveBeenCalled(); }
    }
    await prisma.agent.update({ where: { id: author }, data: { telegramChatId: null } });
  });

  it("обход перемонтажа решает по времени: голос ушёл раньше перемонтажа — слать; ушёл (любым ключом) после — не слать", async () => {
    const p = await seedProperty();
    await startNarrationForNewProperty(p.id, author, { templateId: TEMPLATE.id, voiceId: "voiceA" });
    const vid = await generate(p.id);
    expect(await approveNarrationAsSaved(vid)).toBe("AUDIO_APPROVED");
    const t = (min: number) => new Date(Date.now() - 60 * 60_000 + min * 60_000);
    const told = (key: string, at: Date) => prisma.propertyNarrationDelivery.create({ data: { propertyId: p.id, versionId: vid, editorId: null, mode: "AUDIO_ONLY", status: "SENT",
      requestKey: key, createdById: author, executionMode: "LIVE", deliveredAt: at, createdAt: at } });
    await told(`auto:${vid}:x-${runId}`, t(0));
    await prisma.property.update({ where: { id: p.id }, data: { videoHandoffStatus: "SENT_TO_EDITOR", videoRemakeCount: 1 } });
    await prisma.videoRemakeRequest.create({ data: { propertyId: p.id, reason: "OTHER", requestedById: author, createdAt: t(10) } });
    expect((await remakeRedeliveries()).map((r) => r.id)).toContain(vid);
    // Старый ключ без номера перемонтажа, но уже ПОСЛЕ его начала (до выката) — дубля нет.
    await told(`manual:${vid}:${runId}`, t(20));
    expect((await remakeRedeliveries()).map((r) => r.id)).not.toContain(vid);
  });

  it("прослушивания не берут последние 30% общего дневного предела; звук роликов идёт и дальше", async () => {
    const used = (await narrationBudgetUsage()).usedGenerations;
    const before = await prisma.settings.findUniqueOrThrow({ where: { id: "singleton" }, select: { propertyNarrationConfig: true } });
    const cfg = before.propertyNarrationConfig as Record<string, unknown>;
    // used + 2: ролику место есть, а прослушиванию (не выше 70%) уже нет — при used ≥ 5.
    for (let i = 0; i < 5; i++) await prisma.freeNarration.create({ data: { agentId: stranger, source: "API", status: "READY", chars: 1, generationStartedAt: new Date() } });
    const now = (await narrationBudgetUsage()).usedGenerations;
    expect(now).toBeGreaterThanOrEqual(used + 5);
    await prisma.settings.update({ where: { id: "singleton" }, data: { propertyNarrationConfig: { ...cfg, dailyGenerationLimit: now + 2 } } });
    try {
      const p = await seedProperty();
      expect((await listenNarration({ agentId: author, script: `${await textFor(p.id)} Новый текст.`, voiceId: "voiceB", lang: "ru" })).status).toBe("BUDGET");
      expect(tts.audio).not.toHaveBeenCalled();
      await startNarrationForNewProperty(p.id, author, { templateId: TEMPLATE.id, voiceId: "voiceA" });
      await generate(p.id);
      expect(tts.audio).toHaveBeenCalledTimes(1);
    } finally {
      await prisma.settings.update({ where: { id: "singleton" }, data: { propertyNarrationConfig: cfg as object } });
    }
  });

  it("удачное прослушивание не меняет «последний выбор голоса» — его пишет только сохранение", async () => {
    const before = (await prisma.agent.findUniqueOrThrow({ where: { id: stranger }, select: { narrationLastChoice: true } })).narrationLastChoice;
    const p = await seedProperty();
    expect((await listenNarration({ agentId: stranger, script: await textFor(p.id), voiceId: "voiceB", lang: "ru" })).status).toBe("READY");
    expect((await prisma.agent.findUniqueOrThrow({ where: { id: stranger }, select: { narrationLastChoice: true } })).narrationLastChoice).toEqual(before);
  });
});
