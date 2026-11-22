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
const { listenNarration } = await import("../src/lib/narrationListen.js");
const { waitForCount } = await import("./helpers/waitFor.js");
const { dushanbeDayKey, NARRATION_LISTEN_PER_PERSON_DEFAULT } = await import("@royal-home/shared");
const { startNarrationForNewProperty, approveNarrationAsSaved, requestAutoNarration, runNarrationAutoFlow, requestNarrationAfterEdit, narrationsOwedToMontajer, wizardNarrationTextRejection } = await import("../src/lib/narrationAutoFlow.js");
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
  it("предел на человека — из Настроек (по умолчанию 100); повтор того же звука в него не идёт", async () => {
    expect(NARRATION_LISTEN_PER_PERSON_DEFAULT).toBe(100);
    const cfg = (await prisma.settings.findUniqueOrThrow({ where: { id: "singleton" }, select: { propertyNarrationConfig: true } })).propertyNarrationConfig as Record<string, unknown>;
    const p = await seedProperty();
    const listener = await makeAgent(5);
    await prisma.settings.update({ where: { id: "singleton" }, data: { propertyNarrationConfig: { ...cfg, narrationListenPerPersonDaily: 1 } } });
    try {
      const script = await textFor(p.id);
      expect((await listenNarration({ agentId: listener, script, voiceId: "voiceA", lang: "ru" })).status).toBe("READY");
      expect((await listenNarration({ agentId: listener, script, voiceId: "voiceA", lang: "ru" })).status).toBe("READY");
      expect(await listenNarration({ agentId: listener, script: `${script} Ещё.`, voiceId: "voiceA", lang: "ru" })).toMatchObject({ status: "LIMIT_PERSON", limit: 1 });
    } finally {
      await prisma.settings.update({ where: { id: "singleton" }, data: { propertyNarrationConfig: cfg as object } });
    }
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
    // «Одобрена: придёт сразу после файлов» обещается, только когда голос правда уйдёт (отправка включена, ревью 21.11).
    const line = await withLive(() => narrationLineForMontajer(p.id));
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
    expect(await withLive(() => narrationLineForMontajer(p.id))).toContain("одобрена");
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

  it("обход по выдаче видео решает по времени: голос ушёл раньше видео этой выдачи — слать; ушёл (любым ключом) после — не слать", async () => {
    const p = await seedProperty();
    await startNarrationForNewProperty(p.id, author, { templateId: TEMPLATE.id, voiceId: "voiceA" });
    const vid = await generate(p.id);
    expect(await approveNarrationAsSaved(vid)).toBe("AUDIO_APPROVED");
    const editor = await makeAgent(3, "EDITOR");
    const before = await prisma.settings.findUniqueOrThrow({ where: { id: "singleton" }, select: { videoMontajerAgentId: true } });
    await prisma.settings.update({ where: { id: "singleton" }, data: { videoMontajerAgentId: editor } });
    try {
      const t = (min: number) => new Date(Date.now() - 60 * 60_000 + min * 60_000);
      const told = (key: string, at: Date) => prisma.propertyNarrationDelivery.create({ data: { propertyId: p.id, versionId: vid, editorId: editor, mode: "AUDIO_ONLY", status: "SENT",
        requestKey: key, createdById: author, executionMode: "LIVE", deliveredAt: at, createdAt: at } });
      await told(`auto:${vid}:x-${runId}`, t(0));
      // Видео этой выдачи дошло до монтажёра позже голоса (как №211) — голос уходит следом.
      await prisma.property.update({ where: { id: p.id }, data: { videoHandoffStatus: "SENT_TO_EDITOR", videoHandoffDeliveredAt: t(10) } });
      await prisma.propertyVideo.create({ data: { propertyId: p.id, storageKey: `${p.id}/raw.mp4`, filename: "raw.mp4", sizeBytes: 1, uploadedById: author, montajerDeliveredAt: t(10), montajerDeliveredToId: editor } });
      expect((await narrationsOwedToMontajer()).map((r) => r.id)).toContain(vid);
      // Ручной ключ, но уже ПОСЛЕ выдачи видео — дубля нет.
      await told(`manual:${vid}:${runId}`, t(20));
      expect((await narrationsOwedToMontajer()).map((r) => r.id)).not.toContain(vid);
    } finally {
      await prisma.settings.update({ where: { id: "singleton" }, data: { videoMontajerAgentId: before.videoMontajerAgentId } });
      await prisma.propertyVideo.deleteMany({ where: { propertyId: p.id } });
    }
  });

  it("дневной предел не останавливает озвучку роликов и прослушивание: звук делается, руководству одно уведомление в сутки", async () => {
    const cfg = (await prisma.settings.findUniqueOrThrow({ where: { id: "singleton" }, select: { propertyNarrationConfig: true } })).propertyNarrationConfig as Record<string, unknown>;
    const used = (await narrationBudgetUsage()).usedGenerations;
    const tag = `narration-daily-limit:${dushanbeDayKey(new Date())}`;
    await prisma.pendingDirectorAlert.deleteMany({ where: { tag } });
    await prisma.settings.update({ where: { id: "singleton" }, data: { propertyNarrationConfig: { ...cfg, dailyGenerationLimit: Math.max(1, used) } } });
    try {
      const p = await seedProperty();
      expect((await listenNarration({ agentId: author, script: `${await textFor(p.id)} Сверх предела.`, voiceId: "voiceB", lang: "ru" })).status).toBe("READY");
      await startNarrationForNewProperty(p.id, author, { templateId: TEMPLATE.id, voiceId: "voiceA" });
      await generate(p.id);
      const q = await seedProperty();
      await startNarrationForNewProperty(q.id, author, { templateId: TEMPLATE.id, voiceId: "voiceA" });
      await generate(q.id);
      expect(tts.audio).toHaveBeenCalledTimes(3);
      // Три раза сверх предела — одна тревога за сутки.
      await waitForCount(() => prisma.pendingDirectorAlert.count({ where: { tag } }), 1);
      await new Promise((r) => setTimeout(r, 300));
      expect(await prisma.pendingDirectorAlert.count({ where: { tag } })).toBe(1);
    } finally {
      await prisma.pendingDirectorAlert.deleteMany({ where: { tag } });
      await prisma.settings.update({ where: { id: "singleton" }, data: { propertyNarrationConfig: cfg as object } });
    }
  });

  it("кончились кредиты ElevenLabs — честная ошибка и у прослушивания, и у звука ролика", async () => {
    const p = await seedProperty();
    tts.audio.mockResolvedValue({ status: "FAILED", errorCode: "PROVIDER_QUOTA_EXCEEDED" } as never);
    try {
      expect(await listenNarration({ agentId: author, script: `${await textFor(p.id)} Без кредитов.`, voiceId: "voiceB", lang: "ru" })).toMatchObject({ status: "FAILED", quota: true });
      await startNarrationForNewProperty(p.id, author, { templateId: TEMPLATE.id, voiceId: "voiceA" });
      const v = await latestOf(p.id);
      await prisma.propertyNarrationVersion.update({ where: { id: v.id }, data: { generateAfter: new Date(Date.now() - 1000) } });
      const { config, key } = await loadNarrationConfiguration();
      const out = await generateNarrationVersion({ propertyId: p.id, versionId: v.id, expectedRevision: v.revision, requireApproval: false, config, key: key! });
      expect(out).toMatchObject({ status: "FAILED", errorCode: "PROVIDER_QUOTA_EXCEEDED" });
      expect((await latestOf(p.id)).approvedAt).toBeNull();
    } finally {
      tts.audio.mockResolvedValue({ status: "READY", audio: Buffer.from("synthetic-mp3"), requestId: "req-1" });
    }
  });

  it("удачное прослушивание не меняет «последний выбор голоса» — его пишет только сохранение", async () => {
    const before = (await prisma.agent.findUniqueOrThrow({ where: { id: stranger }, select: { narrationLastChoice: true } })).narrationLastChoice;
    const p = await seedProperty();
    expect((await listenNarration({ agentId: stranger, script: await textFor(p.id), voiceId: "voiceB", lang: "ru" })).status).toBe("READY");
    expect((await prisma.agent.findUniqueOrThrow({ where: { id: stranger }, select: { narrationLastChoice: true } })).narrationLastChoice).toEqual(before);
  });
});
