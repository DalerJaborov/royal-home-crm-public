import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * АВТООЗВУЧКА (11.11.2026): одна дверь генерации, дребезг, потолок, одно сообщение
 * агенту, одобрение агентом и передача монтажёру. База — маленькая подделка в памяти:
 * проверяются переходы состояний версии, а не SQL.
 */
type Row = Record<string, any>;
const s = vi.hoisted(() => ({
  versions: [] as Row[], deliveries: [] as Row[], property: null as Row | null, config: {} as Row,
  audio: vi.fn(), upload: vi.fn(), prepare: vi.fn(), log: vi.fn(), mode: "PREVIEW",
}));

function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([key, cond]) => {
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
  create: vi.fn(async ({ data }: Row) => { s.deliveries.push(data); return data; }),
};

vi.mock("../src/db.js", async (importOriginal) => {
  const db = {
    $queryRaw: vi.fn().mockResolvedValue([]), $disconnect: vi.fn(),
    property: {
      findUnique: vi.fn(async () => s.property), findUniqueOrThrow: vi.fn(async () => s.property),
      findMany: vi.fn(async () => []),
    },
    settings: { findUnique: vi.fn(async () => ({ propertyNarrationConfig: s.config, elevenLabsApiKey: "test-key" })) },
    propertyNarrationVersion: versionModel, propertyNarrationDelivery: deliveryModel,
  };
  return { ...await importOriginal<typeof import("../src/db.js")>(), prisma: { ...db, $transaction: (fn: (tx: typeof db) => unknown) => fn(db) } };
});
vi.mock("../src/ai/liveVoiceProvider.js", async (importOriginal) => ({ ...await importOriginal<typeof import("../src/ai/liveVoiceProvider.js")>(), resolveElevenLabsKey: (key: string) => key }));
vi.mock("../src/lib/propertyNarration.js", async (importOriginal) => ({ ...await importOriginal<typeof import("../src/lib/propertyNarration.js")>(), generateNarrationAudio: s.audio }));
vi.mock("../src/lib/localVideoStorage.js", async (importOriginal) => ({ ...await importOriginal<typeof import("../src/lib/localVideoStorage.js")>(), localVideoUpload: s.upload, localVideoDelete: vi.fn() }));
vi.mock("../src/lib/narrationDelivery.js", async (importOriginal) => ({ ...await importOriginal<typeof import("../src/lib/narrationDelivery.js")>(), prepareNarrationDeliveryPlan: s.prepare }));
vi.mock("../src/lib/systemError.js", async (importOriginal) => ({ ...await importOriginal<typeof import("../src/lib/systemError.js")>(), logSystemError: s.log }));
vi.mock("../src/lib/mediaExecution.js", async (importOriginal) => ({ ...await importOriginal<typeof import("../src/lib/mediaExecution.js")>(), mediaExecutionMode: () => s.mode }));

const { requestAutoNarration, startNarrationForNewProperty, approveNarrationVersion, afterNarrationApproved, runNarrationAutoFlow } = await import("../src/lib/narrationAutoFlow.js");
const { generateNarrationVersion } = await import("../src/lib/narrationGeneration.js");

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
  s.versions = []; s.deliveries = []; s.mode = "PREVIEW";
  s.config = baseConfig();
  s.property = { id: propertyId, shortId: 7, deletedAt: null, type: "APARTMENT", rooms: 2, areaSqm: "62", floor: 3, totalFloors: 9, district: { name: "Сино" }, assignedAgentId: "agent", videoHandoffStatus: "NONE" };
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
  it("creates a WIZARD draft from the default Tajik template and voice, due immediately", async () => {
    const outcome = await requestAutoNarration({ propertyId, actorId: "agent", source: "WIZARD", debounceMs: 0, now });
    expect(outcome).toMatchObject({ status: "QUEUED", revision: 1 });
    expect(s.versions[0]).toMatchObject({ script: "Квартира барои фурӯш. Ду ҳуҷра. Масоҳаташ шасту ду метри мураббаъ.", voiceId: "voiceA", templateId: "tg-short", language: "tg", source: "WIZARD", modelId: "eleven_v4" });
    expect(s.versions[0].generateAfter.getTime()).toBe(now.getTime());
  });
  it("keeps the agent's wizard choice; a price in the text falls back to the template", async () => {
    await startNarrationForNewProperty(propertyId, "agent", { templateId: "ru-short", voiceId: "voiceB" });
    expect(s.versions[0]).toMatchObject({ templateId: "ru-short", voiceId: "voiceB", language: "ru", script: "В продаже квартира. Площадь 62 метров." });
    s.versions = [];
    await startNarrationForNewProperty(propertyId, "agent", { script: "Квартира за 90 000 сомони, звоните." });
    expect(s.versions[0].script).not.toMatch(/сомони/u);
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
  it("waits for the montage queue, then creates exactly one audio-only delivery (PREVIEW until the server switch)", async () => {
    const v = await readyVersion();
    await approveNarrationVersion({ propertyId, versionId: v.id, expectedRevision: 1, actorId: "agent", isManager: false });
    s.prepare.mockRejectedValueOnce(new Error("Сначала передайте объект в работу монтажёру"));
    expect(await afterNarrationApproved(propertyId, v.id)).toBe("WAITING_FOR_MONTAGE");
    expect(await afterNarrationApproved(propertyId, v.id)).toBe("PREVIEW");
    expect(await afterNarrationApproved(propertyId, v.id)).toBe("ALREADY");
    expect(s.deliveries).toHaveLength(1);
    expect(s.deliveries[0]).toMatchObject({ mode: "AUDIO_ONLY", status: "PREVIEW", executionMode: "PREVIEW", requestKey: `auto:${v.id}:editor`, createdById: "agent" });
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
