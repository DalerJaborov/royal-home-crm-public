import { narrationDraftText } from "@royal-home/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * АВТООЗВУЧКА (11.11.2026): одна дверь генерации, дребезг, потолок, одно сообщение
 * агенту, одобрение агентом и передача монтажёру. База — маленькая подделка в памяти:
 * проверяются переходы состояний версии, а не SQL.
 */
type Row = Record<string, any>;
const s = vi.hoisted(() => ({
  versions: [] as Row[], deliveries: [] as Row[], property: null as Row | null, config: {} as Row,
  audio: vi.fn(), upload: vi.fn(), prepare: vi.fn(), log: vi.fn(), mode: "PREVIEW", sendBack: vi.fn(), audit: vi.fn(),
}));

function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([key, cond]) => {
    // Условие на объект «продан, снят, удалён или без озвучки» (12.11.2026) — по единственному объекту подделки.
    if (key === "property" && cond && typeof cond === "object" && "OR" in cond) return !!s.property && cond.OR.some((sub: Row) => matches(s.property!, sub));
    if (["property", "deliveries"].includes(key)) return true;
    const value = row[key];
    if (cond === null) return value === null || value === undefined;
    if (cond instanceof Date) return value instanceof Date && value.getTime() === cond.getTime();
    if (typeof cond === "object") {
      if ("in" in cond) return cond.in.includes(value);
      if ("not" in cond) return cond.not === null ? value !== null && value !== undefined : value !== cond.not;
      if ("lte" in cond) return value instanceof Date && value.getTime() <= cond.lte.getTime();
      if ("gte" in cond) return value instanceof Date && value.getTime() >= cond.gte.getTime();
      return true;
    }
    return value === cond;
  });
}
const copy = (row: Row | undefined) => (row ? { ...row } : null);
const byRevisionDesc = (rows: Row[]) => [...rows].sort((a, b) => b.revision - a.revision);
const versionModel = {
  // Чтение отдаёт снимок, как настоящая база: дальнейшие записи его не меняют.
  findFirst: vi.fn(async ({ where }: Row) => copy(byRevisionDesc(s.versions.filter((r) => matches(r, where)))[0])),
  findUnique: vi.fn(async ({ where }: Row) => copy(s.versions.find((r) => (where.id ? r.id === where.id : r.requestKey === where.requestKey)))),
  findMany: vi.fn(async ({ where, take }: Row) => s.versions.filter((r) => matches(r, where)).slice(0, take ?? 1000).map((r) => copy(r)!)),
  count: vi.fn(async ({ where }: Row) => s.versions.filter((r) => matches(r, where)).length),
  create: vi.fn(async ({ data }: Row) => { const row = { id: `v${s.versions.length + 1}-0000-4000-8000-000000000000`, status: "DRAFT", approvedAt: null, approvalNotifiedAt: null, generationAttempts: 0, createdAt: new Date(), ...data }; s.versions.push(row); return row; }),
  update: vi.fn(async ({ where, data }: Row) => { const row = s.versions.find((r) => r.id === where.id)!; apply(row, data); return row; }),
  updateMany: vi.fn(async ({ where, data }: Row) => { const rows = s.versions.filter((r) => matches(r, where)); rows.forEach((r) => apply(r, data)); return { count: rows.length }; }),
};
function apply(row: Row, data: Row) {
  for (const [key, value] of Object.entries(data)) row[key] = value && typeof value === "object" && "increment" in value ? (row[key] ?? 0) + value.increment : value;
}
const deliveryModel = {
  findUnique: vi.fn(async ({ where }: Row) => s.deliveries.find((d) => d.requestKey === where.requestKey) ?? null),
  count: vi.fn(async ({ where }: Row) => s.deliveries.filter((d) => matches(d, where)).length),
  // Сторож зависших передач (19.11.2026): в этой подделке упавших и зависших нет.
  findMany: vi.fn(async () => []),
  create: vi.fn(async ({ data }: Row) => { s.deliveries.push(data); return data; }),
  // Снятие осиротевших передач (12.11.2026): в этой подделке объект живой, гасить нечего.
  updateMany: vi.fn(async () => ({ count: 0 })),
  update: vi.fn(async ({ where, data }: Row) => { const row = s.deliveries.find((d) => d.id === where.id)!; Object.assign(row, data); return row; }),
};

vi.mock("../src/db.js", async (importOriginal) => {
  const db = {
    $queryRaw: vi.fn().mockResolvedValue([]), $disconnect: vi.fn(),
    property: {
      findUnique: vi.fn(async () => s.property), findUniqueOrThrow: vi.fn(async () => s.property),
      findMany: vi.fn(async () => []), findFirst: vi.fn(async () => null), updateMany: vi.fn(async () => ({ count: 0 })),
    },
    // Идущая замена постов (lib/publishedClip.ts, 18.11.2026): у подделки её нет.
    videoRemakeRequest: { findFirst: vi.fn(async () => null), findMany: vi.fn(async () => []) },
    // Последний выбор голоса сотрудника (12.11.2026): у подделки его нет.
    agent: { findUnique: vi.fn(async () => null), update: vi.fn(async () => ({})) },
    settings: { findUnique: vi.fn(async () => ({ propertyNarrationConfig: s.config, elevenLabsApiKey: "test-key", usdToTjsRate: "9.27" })) },
    propertyNarrationVersion: versionModel, propertyNarrationDelivery: deliveryModel,
    // Образцы голосов (11.11.2026) считаются в том же дневном потолке; здесь их нет.
    narrationVoiceSample: { findMany: vi.fn(async () => []) },
    freeNarration: { findMany: vi.fn(async () => []) },
  };
  return { ...await importOriginal<typeof import("../src/db.js")>(), prisma: { ...db, $transaction: (fn: (tx: typeof db) => unknown) => fn(db) } };
});
vi.mock("../src/ai/liveVoiceProvider.js", async (importOriginal) => ({ ...await importOriginal<typeof import("../src/ai/liveVoiceProvider.js")>(), resolveElevenLabsKey: (key: string) => key }));
vi.mock("../src/lib/propertyNarration.js", async (importOriginal) => ({ ...await importOriginal<typeof import("../src/lib/propertyNarration.js")>(), generateNarrationAudio: s.audio }));
vi.mock("../src/lib/localVideoStorage.js", async (importOriginal) => ({ ...await importOriginal<typeof import("../src/lib/localVideoStorage.js")>(), localVideoUpload: s.upload, localVideoDelete: vi.fn() }));
vi.mock("../src/lib/narrationDelivery.js", async (importOriginal) => ({ ...await importOriginal<typeof import("../src/lib/narrationDelivery.js")>(), prepareNarrationDeliveryPlan: s.prepare }));
vi.mock("../src/lib/systemError.js", async (importOriginal) => ({ ...await importOriginal<typeof import("../src/lib/systemError.js")>(), logSystemError: s.log }));
vi.mock("../src/lib/publishedVideoFix.js", async (importOriginal) => ({ ...await importOriginal<typeof import("../src/lib/publishedVideoFix.js")>(), sendBackToMontajer: s.sendBack }));
vi.mock("../src/lib/audit.js", async (importOriginal) => ({ ...await importOriginal<typeof import("../src/lib/audit.js")>(), logAgentAudit: s.audit }));
vi.mock("../src/lib/mediaExecution.js", async (importOriginal) => ({ ...await importOriginal<typeof import("../src/lib/mediaExecution.js")>(), mediaExecutionMode: () => s.mode }));

const { requestAutoNarration, startNarrationForNewProperty, approveNarrationVersion, afterNarrationApproved, runNarrationAutoFlow } = await import("../src/lib/narrationAutoFlow.js");
const { generateNarrationVersion } = await import("../src/lib/narrationGeneration.js");
const { NarrationDeliveryRefused } = await import("../src/lib/narrationDelivery.js");

const propertyId = "11111111-1111-4111-8111-111111111111";
const TEMPLATES = [
  { id: "tg-short", name: "Кӯтоҳ", lang: "tg", text: "{вид} барои фурӯш. [{комнаты} ҳуҷра.] Масоҳаташ {площадь} метри мураббаъ." },
  { id: "ru-short", name: "Рус", lang: "ru", text: "В продаже {вид}. Площадь {площадь} метров." },
];
const baseConfig = () => ({ modelId: "eleven_v4", voices: [{ id: "voiceA", name: "Мадина", gender: "female" }, { id: "voiceB", name: "Фирӯз", gender: "male" }], autoGenerate: true, debounceMinutes: 3, templates: TEMPLATES });
const now = new Date("2026-11-11T08:00:00Z");
const later = (ms: number) => new Date(now.getTime() + ms);

beforeEach(() => {
  vi.clearAllMocks();
  // С 12.11.2026 автоозвучка платит только при LIVE (в PREVIEW аудио некуда отдать).
  s.versions = []; s.deliveries = []; s.mode = "LIVE";
  s.config = baseConfig();
  s.property = { id: propertyId, shortId: 7, deletedAt: null, type: "APARTMENT", rooms: 2, areaSqm: "62", floor: 3, totalFloors: 9, district: { name: "Сино" }, price: "85000", currency: "USD",
    assignedAgentId: "agent", videoHandoffStatus: "NONE", status: "AWAITING_VIDEO", publishedChannels: [], videoHandoffFinalPath: null, instagramUrl: null };
  s.sendBack.mockResolvedValue({ ok: true, queued: false, message: "Отправлено монтажёру" });
  s.audio.mockResolvedValue({ status: "READY", audio: Buffer.from("mp3"), requestId: "req" });
  s.upload.mockResolvedValue(undefined);
  s.prepare.mockResolvedValue({ editorId: "editor", plan: { factsHash: "x", recipientHash: "y", files: [{ id: "f" }], sourcesHash: "z" } });
});

describe("auto narration after property creation", () => {
  it("is off until leadership enables the switch: no draft, no money", async () => {
    s.config = { ...baseConfig(), autoGenerate: false };
    expect(await startNarrationForNewProperty(propertyId, "agent")).toEqual({ status: "OFF" });
    expect(s.versions).toHaveLength(0);
  });
  it("the montage-queue pass (owner approval) does not run with auto narration alone: its own switch, off by default", async () => {
    const { prisma } = await import("../src/db.js");
    const findMany = vi.mocked(prisma.property.findMany);
    findMany.mockClear();
    await runNarrationAutoFlow({ now });
    const backfillQuery = (calls: unknown[][]) => calls.some((c) => JSON.stringify(c[0]).includes("SENT_TO_EDITOR") && JSON.stringify(c[0]).includes("\"videoHandoffManualSince\":null"));
    expect(backfillQuery(findMany.mock.calls)).toBe(false);
    s.config = { ...baseConfig(), backfillMontageQueue: true };
    await runNarrationAutoFlow({ now });
    expect(backfillQuery(findMany.mock.calls)).toBe(true);
  });
  it("creates a WIZARD draft from the default Tajik template and voice, due immediately", async () => {
    const outcome = await requestAutoNarration({ propertyId, actorId: "agent", source: "WIZARD", debounceMs: 0, now });
    expect(outcome).toMatchObject({ status: "QUEUED", revision: 1 });
    expect(s.versions[0]).toMatchObject({ script: "Квартира барои фурӯш. Ду ҳуҷра. Масоҳаташ шасту ду метри мураббаъ.", voiceId: "voiceA", templateId: "tg-short", language: "tg", source: "WIZARD", modelId: "eleven_v4" });
    expect(s.versions[0].generateAfter.getTime()).toBe(now.getTime());
  });
  it("keeps the agent's wizard choice, including a price the agent typed (spoken price, owner 11.11.2026)", async () => {
    await startNarrationForNewProperty(propertyId, "agent", { templateId: "ru-short", voiceId: "voiceB" });
    expect(s.versions[0]).toMatchObject({ templateId: "ru-short", voiceId: "voiceB", language: "ru", script: "В продаже квартира. Площадь шестьдесят два метров." });
    s.versions = [];
    await startNarrationForNewProperty(propertyId, "agent", { script: "Квартира за 90 000 сомони, звоните." });
    expect(s.versions[0].script).toBe("Квартира за 90 000 сомони, звоните.");
  });
});

describe("one paid door: generation", () => {
  it("generates the due draft once, speaks Tajik digits as words, and a second run does not pay again", async () => {
    await requestAutoNarration({ propertyId, actorId: "agent", source: "AGENT", script: "Квартира, 3 ҳуҷра, шумо бинед.", debounceMs: 0, now, templateId: "tg-short" });
    const notify = vi.fn().mockResolvedValue(undefined);
    await runNarrationAutoFlow({ notifyAgent: notify, now });
    expect(s.audio).toHaveBeenCalledTimes(1);
    expect(s.audio.mock.calls[0][0].script).toBe("Квартира, се ҳуҷра, шумо бинед.");
    expect(s.versions[0]).toMatchObject({ status: "READY", generateAfter: null, generationAttempts: 1 });
    expect(notify).toHaveBeenCalledTimes(1);
    await runNarrationAutoFlow({ notifyAgent: notify, now: later(60_000) });
    expect(s.audio).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledTimes(1);
  });
  it("debounce: several quick fact changes collapse into one pending version and one generation", async () => {
    await requestAutoNarration({ propertyId, actorId: "agent", source: "WIZARD", debounceMs: 0, now });
    await runNarrationAutoFlow({ now });
    expect(s.audio).toHaveBeenCalledTimes(1);
    for (const [i, rooms] of [3, 4, 5].entries()) {
      s.property = { ...s.property, rooms };
      await requestAutoNarration({ propertyId, actorId: "agent", source: "AUTO", now: later(i * 30_000) });
    }
    expect(s.versions).toHaveLength(2);
    expect(s.versions[1].script).toContain("Панҷ ҳуҷра");
    await runNarrationAutoFlow({ now: later(90_000) });
    expect(s.audio).toHaveBeenCalledTimes(1);
    await runNarrationAutoFlow({ now: later(60_000 + 3 * 60_000 + 1) });
    expect(s.audio).toHaveBeenCalledTimes(2);
  });
  it("unchanged facts do not create a new version; a running generation blocks a new one", async () => {
    await requestAutoNarration({ propertyId, actorId: "agent", source: "WIZARD", debounceMs: 0, now });
    await runNarrationAutoFlow({ now });
    expect(await requestAutoNarration({ propertyId, actorId: "agent", source: "AUTO", now })).toEqual({ status: "UNCHANGED" });
    s.versions[0].status = "GENERATING";
    s.property = { ...s.property, rooms: 4 };
    expect(await requestAutoNarration({ propertyId, actorId: "agent", source: "AUTO", now })).toEqual({ status: "BUSY" });
  });
  it("daily ceiling stops spending before the provider is called", async () => {
    s.config = { ...baseConfig(), dailyGenerationLimit: 1 };
    s.versions.push({ id: "spent-0000-4000-8000-000000000000", propertyId: "other", revision: 1, script: "x".repeat(20), status: "READY", generationStartedAt: now });
    await requestAutoNarration({ propertyId, actorId: "agent", source: "WIZARD", debounceMs: 0, now });
    await runNarrationAutoFlow({ now });
    expect(s.audio).not.toHaveBeenCalled();
    expect(s.log).toHaveBeenCalledWith("ai", expect.stringContaining("дневной предел"), { dedupKey: "narration-daily-budget" });
    expect(s.versions.find((v) => v.propertyId === propertyId)).toMatchObject({ status: "DRAFT" });
  });
  it("rate limit (429) retries later without messaging anyone; other failures are logged once and not retried", async () => {
    s.audio.mockResolvedValue({ status: "FAILED", errorCode: "PROVIDER_HTTP_429" });
    const notify = vi.fn();
    await requestAutoNarration({ propertyId, actorId: "agent", source: "WIZARD", debounceMs: 0, now });
    await runNarrationAutoFlow({ notifyAgent: notify, now });
    expect(s.versions[0]).toMatchObject({ status: "DRAFT", errorCode: null });
    expect(s.versions[0].generateAfter.getTime()).toBe(now.getTime() + 15 * 60_000);
    s.audio.mockResolvedValue({ status: "UNKNOWN", errorCode: "PROVIDER_OUTCOME_UNKNOWN" });
    await runNarrationAutoFlow({ notifyAgent: notify, now: later(16 * 60_000) });
    expect(s.versions[0].status).toBe("UNKNOWN");
    expect(s.log).toHaveBeenCalledWith("ai", expect.stringContaining("PROVIDER_OUTCOME_UNKNOWN"), { dedupKey: `narration-failed:${s.versions[0].id}` });
    await runNarrationAutoFlow({ notifyAgent: notify, now: later(30 * 60_000) });
    expect(s.audio).toHaveBeenCalledTimes(2);
    expect(notify).not.toHaveBeenCalled();
  });
  it("the marketing button still requires an approved text (requireApproval)", async () => {
    await requestAutoNarration({ propertyId, actorId: "agent", source: "WIZARD", debounceMs: 0, now });
    const v = s.versions[0];
    expect(await generateNarrationVersion({ propertyId, versionId: v.id, expectedRevision: 1, requireApproval: true, config: baseConfig() as never, key: "k", now })).toEqual({ status: "REJECTED" });
    expect(s.audio).not.toHaveBeenCalled();
  });
});

describe("approval by the property's agent and hand-over to the editor", () => {
  async function readyVersion() {
    await requestAutoNarration({ propertyId, actorId: "agent", source: "WIZARD", debounceMs: 0, now });
    await runNarrationAutoFlow({ now });
    return s.versions[0];
  }
  it("agent approves ready audio; a marketing-only DRAFT stays forbidden to agents", async () => {
    s.versions.push({ id: "manual-000-4000-8000-000000000000", propertyId, revision: 1, status: "DRAFT", source: "MANUAL", factsHash: "", approvedAt: null });
    const { narrationFacts, narrationHash } = await import("../src/lib/propertyNarration.js");
    s.versions[0].factsHash = narrationHash(narrationFacts(s.property as never));
    expect(await approveNarrationVersion({ propertyId, versionId: s.versions[0].id, expectedRevision: 1, actorId: "agent", isManager: false })).toBe("FORBIDDEN");
    s.versions = [];
    const v = await readyVersion();
    expect(await approveNarrationVersion({ propertyId, versionId: v.id, expectedRevision: 1, actorId: "agent", isManager: false })).toBe("AUDIO_APPROVED");
    expect(v.approvedById).toBe("agent");
    // Двойное нажатие — то же «одобрено», без второй записи.
    expect(await approveNarrationVersion({ propertyId, versionId: v.id, expectedRevision: 1, actorId: "agent", isManager: false })).toBe("AUDIO_APPROVED");
  });
  it("stale facts block approval of the old audio", async () => {
    const v = await readyVersion();
    s.property = { ...s.property, areaSqm: "70" };
    expect(await approveNarrationVersion({ propertyId, versionId: v.id, expectedRevision: 1, actorId: "agent", isManager: false })).toBe("CONFLICT");
  });
  it("waits for the montage queue; in PREVIEW nothing is marked as sent, after LIVE exactly one delivery goes", async () => {
    const v = await readyVersion();
    await approveNarrationVersion({ propertyId, versionId: v.id, expectedRevision: 1, actorId: "agent", isManager: false });
    s.prepare.mockRejectedValueOnce(new NarrationDeliveryRefused("NOT_WITH_MONTAJER", "Сначала передайте объект в работу монтажёру"));
    expect(await afterNarrationApproved(propertyId, v.id)).toBe("WAITING_FOR_MONTAGE");
    s.mode = "PREVIEW";
    expect(await afterNarrationApproved(propertyId, v.id)).toBe("PREVIEW");
    expect(s.deliveries).toHaveLength(0);
    s.mode = "LIVE";
    expect(await afterNarrationApproved(propertyId, v.id)).toBe("QUEUED");
    expect(await afterNarrationApproved(propertyId, v.id)).toBe("BUSY");
    expect(s.deliveries).toHaveLength(1);
    expect(s.deliveries[0]).toMatchObject({ mode: "AUDIO_ONLY", status: "QUEUED", executionMode: "LIVE", requestKey: `auto:${v.id}:editor`, createdById: "agent" });
  });
  it("a delivery row left in PREVIEW before this fix is sent once LIVE is on, not counted as sent", async () => {
    const v = await readyVersion();
    await approveNarrationVersion({ propertyId, versionId: v.id, expectedRevision: 1, actorId: "agent", isManager: false });
    s.deliveries.push({ id: "old-preview", propertyId, versionId: v.id, editorId: "editor", mode: "AUDIO_ONLY", status: "PREVIEW", executionMode: "PREVIEW", requestKey: `auto:${v.id}:editor` });
    expect(await afterNarrationApproved(propertyId, v.id)).toBe("QUEUED");
    expect(s.deliveries).toHaveLength(1);
    expect(s.deliveries[0]).toMatchObject({ status: "QUEUED", executionMode: "LIVE" });
  });
  it("PREVIEW: the paid provider is not called at all", async () => {
    s.mode = "PREVIEW";
    await requestAutoNarration({ propertyId, actorId: "agent", source: "WIZARD", debounceMs: 0, now });
    await runNarrationAutoFlow({ now: later(1000) });
    expect(s.audio).not.toHaveBeenCalled();
    expect(s.versions[0]).toMatchObject({ status: "DRAFT" });
  });
  it("LIVE switch queues the delivery for the existing sender; an in-flight delivery makes it wait", async () => {
    s.mode = "LIVE";
    const v = await readyVersion();
    await approveNarrationVersion({ propertyId, versionId: v.id, expectedRevision: 1, actorId: "agent", isManager: false });
    s.deliveries.push({ propertyId, versionId: "older", status: "SENDING", requestKey: "older" });
    expect(await afterNarrationApproved(propertyId, v.id)).toBe("BUSY");
    s.deliveries = [];
    expect(await afterNarrationApproved(propertyId, v.id)).toBe("QUEUED");
    expect(s.deliveries[0]).toMatchObject({ status: "QUEUED", executionMode: "LIVE" });
  });
});

describe("spoken price (owner 11.11.2026): new version on price change, sound-only replacement of a published clip", () => {
  const PRICED = [{ id: "tg-short", name: "Кӯтоҳ", lang: "tg", text: "{вид} барои фурӯш. Нархаш {цена}." }];
  async function approvedAt(price: string, at: Date) {
    s.property = { ...s.property, price };
    await requestAutoNarration({ propertyId, actorId: "agent", source: "AUTO", now: at });
  }
  it("price changed twice within 3 minutes gives one new version and one paid generation", async () => {
    s.config = { ...baseConfig(), templates: PRICED };
    await requestAutoNarration({ propertyId, actorId: "agent", source: "WIZARD", debounceMs: 0, now });
    await runNarrationAutoFlow({ now });
    expect(s.versions[0].script).toBe("Квартира барои фурӯш. Нархаш ҳафтсаду ҳаштоду ҳашт ҳазор сомонӣ.");
    await approvedAt("82000", later(10_000));
    await approvedAt("80000", later(70_000));
    expect(s.versions).toHaveLength(2);
    expect(s.versions[1].script).toBe("Квартира барои фурӯш. Нархаш ҳафтсаду чилу ду ҳазор сомонӣ.");
    await runNarrationAutoFlow({ now: later(70_000 + 3 * 60_000 + 1) });
    expect(s.audio).toHaveBeenCalledTimes(2);
    expect(s.versions[1]).toMatchObject({ status: "READY", approvedAt: null });
  });
  async function approveNewPrice() {
    s.config = { ...baseConfig(), templates: PRICED };
    await requestAutoNarration({ propertyId, actorId: "agent", source: "WIZARD", debounceMs: 0, now });
    await runNarrationAutoFlow({ now });
    const first = s.versions[0];
    s.deliveries.push({ propertyId, versionId: first.id, editorId: "editor", mode: "AUDIO_ONLY", status: "SENT", requestKey: "old" });
    s.property = { ...s.property, price: "80000" };
    await requestAutoNarration({ propertyId, actorId: "agent", source: "AUTO", now, debounceMs: 0 });
    await runNarrationAutoFlow({ now: later(60_000) });
    const second = s.versions[1];
    expect(await approveNarrationVersion({ propertyId, versionId: second.id, expectedRevision: 2, actorId: "agent", isManager: false })).toBe("AUDIO_APPROVED");
    s.prepare.mockRejectedValue(new NarrationDeliveryRefused("NOT_WITH_MONTAJER", "Сначала передайте объект в работу монтажёру"));
    return second;
  }
  it("published clip with the old narration: after approval the editor gets a sound-only task, old posts go when the new one is out", async () => {
    s.mode = "LIVE";
    s.property = { ...s.property, status: "AVAILABLE", publishedChannels: ["FACEBOOK"], videoHandoffStatus: "RECEIVED" };
    const v = await approveNewPrice();
    // Рубильник «голос кладёт CRM» включён явно (с 12.11.2026 по умолчанию выключен).
    s.config = { ...s.config, mixByCrm: true };
    expect(await afterNarrationApproved(propertyId, v.id)).toBe("SOUND_REMAKE");
    expect(s.sendBack).toHaveBeenCalledTimes(1);
    // Голос накладывает CRM: монтажёр присылает тот же ролик без голоса (один раз).
    expect(s.sendBack).toHaveBeenCalledWith(propertyId, "agent", "NARRATION_CHANGED", expect.stringContaining("БЕЗ голоса"), null, { removeFromSocial: "on-new-video" });
    expect(s.audit).toHaveBeenCalledWith("agent", "PROPERTY_SENT_BACK_TO_MONTAJER", "Property", propertyId, expect.objectContaining({ reason: "NARRATION_CHANGED" }));
  });
  it("default (12.11.2026): the editor replaces only the voice himself; no second voiceless file is asked (19.11.2026)", async () => {
    s.mode = "LIVE";
    s.property = { ...s.property, status: "AVAILABLE", publishedChannels: ["FACEBOOK"], videoHandoffStatus: "RECEIVED" };
    const v = await approveNewPrice();
    expect(await afterNarrationApproved(propertyId, v.id)).toBe("SOUND_REMAKE");
    expect(s.sendBack).toHaveBeenCalledWith(propertyId, "agent", "NARRATION_CHANGED", `Новая озвучка, версия ${v.revision}: замените в ролике только голос, музыку и монтаж не трогайте. Новый mp3 придёт следом.`, null, { removeFromSocial: "on-new-video" });
  });
  it("same template and voice after a price change: approves itself, nothing to the agent", async () => {
    s.property = { ...s.property, status: "AVAILABLE", videoHandoffStatus: "NONE" };
    await approveNewPrice();
    s.property = { ...s.property, price: "90000" };
    const notify = vi.fn();
    await requestAutoNarration({ propertyId, actorId: "agent", source: "AUTO", now: later(120_000), debounceMs: 0 });
    await runNarrationAutoFlow({ notifyAgent: notify, now: later(180_000) });
    expect(s.versions[2]).toMatchObject({ status: "READY", approvedById: "agent" });
    expect(s.versions[2].approvedAt).toBeInstanceOf(Date);
    expect(notify).not.toHaveBeenCalled();
    expect(s.audit).toHaveBeenCalledWith("agent", "PROPERTY_NARRATION_AUTO_APPROVED", "Property", propertyId, expect.objectContaining({ narrationVersionId: s.versions[2].id }));
  });
  it("no published clip: no task for the editor", async () => {
    s.mode = "LIVE";
    const v = await approveNewPrice();
    expect(await afterNarrationApproved(propertyId, v.id)).toBe("WAITING_FOR_MONTAGE");
    expect(s.sendBack).not.toHaveBeenCalled();
  });
  it("nothing starts before the agent approves, while the editor already works, or while sending is PREVIEW", async () => {
    const { requestNarrationSoundRemake } = await import("../src/lib/narrationAutoFlow.js");
    s.mode = "LIVE";
    s.property = { ...s.property, status: "AVAILABLE", publishedChannels: ["FACEBOOK"], videoHandoffStatus: "RECEIVED" };
    const v = await approveNewPrice();
    s.property = { ...s.property, videoHandoffStatus: "SENT_TO_EDITOR" };
    expect(await requestNarrationSoundRemake(propertyId, v.id)).toBe("IN_MONTAGE");
    s.property = { ...s.property, videoHandoffStatus: "RECEIVED" };
    s.mode = "PREVIEW";
    expect(await requestNarrationSoundRemake(propertyId, v.id)).toBe("OFF");
    s.mode = "LIVE";
    s.property = { ...s.property, price: "75000" };
    // Другой голос — не то, что агент уже одобрял: самоодобрения нет, ждём агента.
    await requestAutoNarration({ propertyId, actorId: "agent", source: "AUTO", voiceId: "voiceB", now: later(120_000), debounceMs: 0 });
    await runNarrationAutoFlow({ now: later(180_000) });
    expect(s.versions[2]).toMatchObject({ status: "READY", approvedAt: null });
    expect(await requestNarrationSoundRemake(propertyId, s.versions[2].id)).toBe("NOT_APPROVED");
    expect(s.sendBack).not.toHaveBeenCalled();
  });
});

describe("ElevenLabs credits are over", () => {
  it("waits for a top-up: no retries for an hour, one log line, nothing to the agent, Settings flag clears after success", async () => {
    const { narrationQuotaExceededSince } = await import("../src/lib/narrationGeneration.js");
    s.audio.mockResolvedValue({ status: "FAILED", errorCode: "PROVIDER_QUOTA_EXCEEDED" });
    const notify = vi.fn();
    await requestAutoNarration({ propertyId, actorId: "agent", source: "WIZARD", debounceMs: 0, now });
    await runNarrationAutoFlow({ notifyAgent: notify, now });
    expect(s.versions[0]).toMatchObject({ status: "DRAFT", errorCode: "PROVIDER_QUOTA_EXCEEDED" });
    expect(s.versions[0].generateAfter.getTime()).toBe(now.getTime() + 60 * 60_000);
    expect(s.log).toHaveBeenCalledWith("ai", expect.stringContaining("кредиты ElevenLabs закончились"), { dedupKey: "narration-quota-exceeded" });
    expect(await narrationQuotaExceededSince()).not.toBeNull();
    s.versions[0].generateAfter = now; // даже ожидающая версия не тратит вызов, пока пауза
    await runNarrationAutoFlow({ notifyAgent: notify, now: later(30 * 60_000) });
    expect(s.audio).toHaveBeenCalledTimes(1);
    s.audio.mockResolvedValue({ status: "READY", audio: Buffer.from("mp3"), requestId: "req" });
    await runNarrationAutoFlow({ notifyAgent: notify, now: later(61 * 60_000) });
    expect(s.audio).toHaveBeenCalledTimes(2);
    expect(s.versions[0]).toMatchObject({ status: "READY", errorCode: null });
    expect(await narrationQuotaExceededSince()).toBeNull();
    expect(s.log.mock.calls.filter(([, message]) => String(message).includes("кредиты"))).toHaveLength(1);
    expect(notify).toHaveBeenCalledTimes(1); // только «озвучка готова», про кредиты — ничего
  });
});

describe("templates by property type, endings and random choice without repeat (16.11.2026)", () => {
  const TYPED = {
    templates: [
      { id: "apt-a", name: "Квартира 1", lang: "tg", text: "{вид} барои фурӯш. Нархаш {цена}.", propertyTypes: ["APARTMENT"] },
      { id: "apt-b", name: "Квартира 2", lang: "tg", text: "Хонаи нав! {вид}, масоҳаташ {площадь} метр. Нархаш {цена}.", propertyTypes: ["APARTMENT"] },
      { id: "house-a", name: "Дом 1", lang: "tg", text: "Ҳавлии нав дар фурӯш аст. Нархаш {цена}.", propertyTypes: ["HOUSE"] },
    ],
    endings: [
      { id: "end-1", lang: "tg", text: "Ба мо дар Директ нависед ё занг занед.", propertyTypes: ["APARTMENT", "HOUSE"] },
      { id: "end-2", lang: "tg", text: "Барои тамошо ба мо занг занед.", propertyTypes: ["APARTMENT", "HOUSE"] },
      { id: "end-3", lang: "tg", text: "Ҷойро аз наздик бинед.", propertyTypes: ["HOUSE"] },
    ],
  };
  const ending = (id: string) => TYPED.endings.find((e) => e.id === id)!.text;
  const draftOf = (v: Row) => narrationDraftText(s.config as never, { type: s.property!.type, rooms: s.property!.rooms, areaSqm: s.property!.areaSqm, floor: s.property!.floor,
    totalFloors: s.property!.totalFloors, district: s.property!.district.name, price: s.property!.price, currency: s.property!.currency, usdToTjs: 9.27 }, v.templateId, v.endingId).text;
  beforeEach(() => { s.config = { ...baseConfig(), ...TYPED }; });

  it("a new apartment gets an apartment template and an apartment ending; the text equals body + ending rebuilt from the saved codes", async () => {
    await requestAutoNarration({ propertyId, actorId: "agent", source: "WIZARD", debounceMs: 0, now });
    const v = s.versions[0];
    expect(["apt-a", "apt-b"]).toContain(v.templateId);
    expect(["end-1", "end-2"]).toContain(v.endingId);
    expect(v.script.endsWith(ending(v.endingId))).toBe(true);
    expect(v.script).toBe(draftOf(v));
    expect(v.script).not.toContain("Ҳавлии");
  });

  it("does not repeat the previous choice of the employee: only the other template and the other ending are left", async () => {
    for (let i = 0; i < 20; i++) {
      s.versions = [];
      await requestAutoNarration({ propertyId, actorId: "agent", source: "WIZARD", debounceMs: 0, now, avoid: { templateId: "apt-a", endingId: "end-1" } });
      expect(s.versions[0]).toMatchObject({ templateId: "apt-b", endingId: "end-2" });
    }
  });

  it("the agent's own choice is respected, even a template of another type, together with the chosen ending", async () => {
    await startNarrationForNewProperty(propertyId, "agent", { templateId: "house-a", endingId: "end-3" });
    expect(s.versions[0]).toMatchObject({ templateId: "house-a", endingId: "end-3" });
    expect(s.versions[0].script).toBe(`Ҳавлии нав дар фурӯш аст. Нархаш ҳафтсаду ҳаштоду ҳашт ҳазор сомонӣ. ${ending("end-3")}`);
  });

  it("«Другой шаблон»: a new random template and a new random ending, never the previous ones", async () => {
    await requestAutoNarration({ propertyId, actorId: "agent", source: "WIZARD", debounceMs: 0, now });
    for (let i = 0; i < 10; i++) {
      const before = s.versions[s.versions.length - 1];
      const outcome = await requestAutoNarration({ propertyId, actorId: "agent", source: "AGENT", reroll: true, debounceMs: 0, now, expectedRevision: before.revision });
      expect(outcome.status).toBe("QUEUED");
      const after = s.versions[s.versions.length - 1];
      expect(after.templateId).not.toBe(before.templateId);
      expect(after.endingId).not.toBe(before.endingId);
      expect(after.script).toBe(draftOf(after));
    }
  });

  it("a price change keeps the template and the ending: same text with the new price, and it approves itself", async () => {
    await requestAutoNarration({ propertyId, actorId: "agent", source: "WIZARD", debounceMs: 0, now });
    await runNarrationAutoFlow({ now });
    const first = s.versions[0];
    expect(await approveNarrationVersion({ propertyId, versionId: first.id, expectedRevision: 1, actorId: "agent", isManager: false })).toBe("AUDIO_APPROVED");
    s.property = { ...s.property, price: "90000" };
    await requestAutoNarration({ propertyId, actorId: "agent", source: "AUTO", now: later(60_000), debounceMs: 0 });
    const second = s.versions[1];
    expect(second).toMatchObject({ templateId: first.templateId, endingId: first.endingId });
    expect(second.script).toBe(first.script.replace("ҳафтсаду ҳаштоду ҳашт ҳазор", "ҳаштсаду сиву чор ҳазор"));
    await runNarrationAutoFlow({ now: later(120_000) });
    expect(s.versions[1]).toMatchObject({ status: "READY", approvedById: "agent" });
  });

  it("the owner changed the ending text in Settings after the approval: the new version is not approved by itself, a person listens", async () => {
    await requestAutoNarration({ propertyId, actorId: "agent", source: "WIZARD", debounceMs: 0, now });
    await runNarrationAutoFlow({ now });
    await approveNarrationVersion({ propertyId, versionId: s.versions[0].id, expectedRevision: 1, actorId: "agent", isManager: false });
    s.config = { ...s.config, endings: TYPED.endings.map((e) => ({ ...e, text: `${e.text} Мо ҳамеша дар хидмати шумо ҳастем.` })) };
    s.property = { ...s.property, price: "90000" };
    await requestAutoNarration({ propertyId, actorId: "agent", source: "AUTO", now: later(60_000), debounceMs: 0 });
    await runNarrationAutoFlow({ now: later(120_000) });
    expect(s.versions[1]).toMatchObject({ status: "READY", approvedAt: null });
  });

  it("the type of the property changed: the old template no longer fits, a template and an ending of the new type are chosen", async () => {
    await requestAutoNarration({ propertyId, actorId: "agent", source: "WIZARD", debounceMs: 0, now });
    s.property = { ...s.property, type: "HOUSE" };
    await requestAutoNarration({ propertyId, actorId: "agent", source: "AUTO", now: later(60_000), debounceMs: 0 });
    // Ожидающий черновик правится той же версией (дребезг), поэтому смотрим на неё.
    expect(s.versions).toHaveLength(1);
    expect(s.versions[0].templateId).toBe("house-a");
    expect(["end-1", "end-2", "end-3"]).toContain(s.versions[0].endingId);
    expect(s.versions[0].script).toBe(draftOf(s.versions[0]));
  });

  it("review 17.11: the client's finished text never gets a random ending; endingId null means none; absent endingId on a template pick is chosen by the server", async () => {
    await requestAutoNarration({ propertyId, actorId: "agent", source: "WIZARD", debounceMs: 0, now, script: "Квартира барои фурӯш, нархаш хуб аст." });
    expect(s.versions[0]).toMatchObject({ endingId: null, script: "Квартира барои фурӯш, нархаш хуб аст." });
    s.versions = [];
    await requestAutoNarration({ propertyId, actorId: "agent", source: "WIZARD", debounceMs: 0, now, templateId: "apt-a", endingId: null });
    expect(s.versions[0]).toMatchObject({ templateId: "apt-a", endingId: null });
    expect(s.versions[0].script).toBe(draftOf(s.versions[0]));
    s.versions = [];
    await requestAutoNarration({ propertyId, actorId: "agent", source: "WIZARD", debounceMs: 0, now, templateId: "apt-a" });
    expect(["end-1", "end-2"]).toContain(s.versions[0].endingId);
  });

  it("review 17.11: «Другой шаблон» with a single variant makes no paid copy (UNCHANGED); with two variants it does", async () => {
    s.config = { ...baseConfig(), templates: [TYPED.templates[0]], endings: [TYPED.endings[0]] };
    await requestAutoNarration({ propertyId, actorId: "agent", source: "WIZARD", debounceMs: 0, now });
    const outcome = await requestAutoNarration({ propertyId, actorId: "agent", source: "AGENT", reroll: true, debounceMs: 0, now, expectedRevision: 1 });
    expect(outcome.status).toBe("UNCHANGED");
    expect(s.versions).toHaveLength(1);
    s.config = { ...baseConfig(), ...TYPED };
    const two = await requestAutoNarration({ propertyId, actorId: "agent", source: "AGENT", reroll: true, debounceMs: 0, now, expectedRevision: 1 });
    expect(two.status).toBe("QUEUED");
  });

  it("settings without endings and versions without an ending code work as before 16.11.2026", async () => {
    s.config = { ...baseConfig() };
    await requestAutoNarration({ propertyId, actorId: "agent", source: "WIZARD", debounceMs: 0, now });
    expect(s.versions[0]).toMatchObject({ templateId: "tg-short", endingId: null, script: "Квартира барои фурӯш. Ду ҳуҷра. Масоҳаташ шасту ду метри мураббаъ." });
  });
});

/** Ревью #348 (21.11.2026): версии с долларами, собранные до сторожа валюты. */
describe("старые версии с ценой в долларах", () => {
  const PRICED = [{ id: "tg-short", name: "Кӯтоҳ", lang: "tg", text: "{вид} барои фурӯш. Нархаш {цена}." }];
  const DOLLAR_SCRIPT = "Квартира барои фурӯш. Нархаш ҳаштоду панҷ ҳазор доллар.";

  it("черновик в очереди не уходит в ElevenLabs: честная причина в журнал, текст пересобран из шаблона в сомони", async () => {
    s.config = { ...baseConfig(), templates: PRICED };
    await requestAutoNarration({ propertyId, actorId: "agent", source: "WIZARD", debounceMs: 0, now });
    s.versions[0].script = DOLLAR_SCRIPT;
    await runNarrationAutoFlow({ now: later(1_000) });
    expect(s.versions[0]).toMatchObject({ status: "FAILED", errorCode: "PRICE_NOT_IN_TJS" });
    expect(s.versions).toHaveLength(2);
    expect(s.versions[1]).toMatchObject({ templateId: "tg-short", source: "AUTO" });
    expect(s.versions[1].script).toBe("Квартира барои фурӯш. Нархаш ҳафтсаду ҳаштоду ҳашт ҳазор сомонӣ.");
    expect(s.audio.mock.calls.every(([input]) => !/доллар/u.test(input.script))).toBe(true);
    expect(s.log).toHaveBeenCalledWith("ai", expect.stringMatching(/цена в долларах.*Новая версия собрана/su), expect.anything());
    expect(s.log.mock.calls.some(([, text]) => /проверьте ключ, модель и голос/u.test(String(text)))).toBe(false);
  });

  it("одобренная версия с долларами монтажёру не уходит и запасными путями: ни возврата монтажёру, ни перемикса", async () => {
    s.config = { ...baseConfig(), templates: PRICED };
    await requestAutoNarration({ propertyId, actorId: "agent", source: "WIZARD", debounceMs: 0, now });
    await runNarrationAutoFlow({ now });
    Object.assign(s.versions[0], { script: DOLLAR_SCRIPT, approvedAt: now, approvedById: "agent" });
    s.prepare.mockRejectedValueOnce(new NarrationDeliveryRefused("PRICE_NOT_IN_TJS", "Озвучка не отправлена: в тексте озвучки цена в долларах"));
    expect(await afterNarrationApproved(propertyId, s.versions[0].id)).toBe("NOT_READY");
    expect(s.sendBack).not.toHaveBeenCalled();
    expect(s.deliveries).toHaveLength(0);
    expect(s.log).toHaveBeenCalledWith("api", expect.stringMatching(/цена в долларах/u), expect.objectContaining({ dedupKey: expect.stringContaining("PRICE_NOT_IN_TJS") }));
  });
});

/** Ревью #348, круг 2: готовая (READY), ещё не одобренная версия с долларами. Пересборка — новая платная озвучка, сама не идёт. */
describe("готовая неодобренная версия с ценой в долларах", () => {
  const PRICED = [{ id: "tg-short", name: "Кӯтоҳ", lang: "tg", text: "{вид} барои фурӯш. Нархаш {цена}." }];
  async function readyDollarVersion() {
    s.config = { ...baseConfig(), templates: PRICED };
    await requestAutoNarration({ propertyId, actorId: "agent", source: "AGENT", debounceMs: 0, now });
    await runNarrationAutoFlow({ now });
    Object.assign(s.versions[0], { script: "Квартира барои фурӯш. Нархаш ҳаштоду панҷ ҳазор доллар.", approvedAt: null, approvalNotifiedAt: null });
    return s.versions[0];
  }

  it("одобрить нельзя (Шабнам, кнопка, API — одна функция): честный отказ, версия не одобрена, пересборки нет", async () => {
    const v = await readyDollarVersion();
    const before = s.versions.length;
    expect(await approveNarrationVersion({ propertyId, versionId: v.id, expectedRevision: v.revision, actorId: "agent", isManager: false })).toBe("PRICE_NOT_IN_TJS");
    expect(s.versions[0].approvedAt).toBeNull();
    expect(s.versions).toHaveLength(before);
  });

  it("«Послушайте озвучку» агенту не уходит, строка снимается с очереди и напоминаний", async () => {
    const v = await readyDollarVersion();
    const notifyAgent = vi.fn(async () => {});
    s.audio.mockClear();
    await runNarrationAutoFlow({ now: later(60_000), notifyAgent });
    expect(notifyAgent).not.toHaveBeenCalled();
    expect(s.versions.find((r) => r.id === v.id)).toMatchObject({ status: "READY", approvedAt: null });
    expect(s.versions.find((r) => r.id === v.id)!.approvalEscalatedAt).toBeInstanceOf(Date);
    expect(s.audio).not.toHaveBeenCalled();
  });
});
