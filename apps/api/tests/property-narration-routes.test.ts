import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

const s = vi.hoisted(() => ({ role: "MARKETING", access: true, property: vi.fn(), settings: vi.fn(), latest: vi.fn(), findVersion: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn(), count: vi.fn(), audio: vi.fn(), file: vi.fn(), upload: vi.fn(), delivery: vi.fn(), deliveryFind: vi.fn(), deliveryUpdate: vi.fn(), preview: vi.fn(), report: vi.fn(), assigned: vi.fn(), configSave: vi.fn(), versions: vi.fn() }));
vi.mock("../src/auth/middleware.js", async (importOriginal) => ({ ...await importOriginal<typeof import("../src/auth/middleware.js")>(), requireAuth: (req: any, _res: any, next: () => void) => { req.agent = { id: "staff", role: s.role }; next(); } }));
vi.mock("../src/routes/properties/shared.js", async (importOriginal) => ({ ...await importOriginal<typeof import("../src/routes/properties/shared.js")>(), canManageProperty: () => s.access }));
vi.mock("../src/routes/marketing.js", async (importOriginal) => ({ ...await importOriginal<typeof import("../src/routes/marketing.js")>(), hasMarketingRole: (role: string) => ["MARKETING", "ADMIN", "DIRECTOR"].includes(role) }));
vi.mock("../src/ai/liveVoiceProvider.js", async (importOriginal) => ({ ...await importOriginal<typeof import("../src/ai/liveVoiceProvider.js")>(), resolveElevenLabsKey: (key: string) => key }));
vi.mock("../src/lib/localVideoStorage.js", async (importOriginal) => ({ ...await importOriginal<typeof import("../src/lib/localVideoStorage.js")>(), localVideoUpload: s.upload, localVideoFilePath: s.file, localVideoDelete: vi.fn().mockResolvedValue(true) }));
vi.mock("../src/lib/ownerReport/link.js", async (importOriginal) => ({ ...await importOriginal<typeof import("../src/lib/ownerReport/link.js")>(), findActiveOwnerReportLink: vi.fn(), presentOwnerReportLink: vi.fn() }));
vi.mock("../src/lib/propertyNarration.js", async (importOriginal) => ({ ...await importOriginal<typeof import("../src/lib/propertyNarration.js")>(), generateNarrationAudio: s.audio }));
vi.mock("../src/lib/narrationDelivery.js", async (importOriginal) => ({ ...await importOriginal<typeof import("../src/lib/narrationDelivery.js")>(), prepareNarrationDeliveryPlan: vi.fn().mockResolvedValue({ editorId: "editor", plan: {} }) }));
vi.mock("../src/lib/publicationMetadataSync.js", async (importOriginal) => ({ ...await importOriginal<typeof import("../src/lib/publicationMetadataSync.js")>(), preparePublicationMetadataPreview: vi.fn().mockResolvedValue([{ status: "MANUAL_REQUIRED" }]) }));
vi.mock("../src/db.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/db.js")>();
  const prisma = { $disconnect: vi.fn(), $queryRaw: vi.fn().mockResolvedValue([]),
    property: { findUnique: s.property, findUniqueOrThrow: s.property }, settings: { findUnique: s.settings, upsert: s.configSave }, auditLog: { create: vi.fn().mockResolvedValue({}) },
    propertyNarrationVersion: { findFirst: s.latest, findUnique: s.findVersion, findMany: s.versions, create: s.create, update: s.update, updateMany: s.updateMany, count: s.count },
    ownerReportSubscription: { findUnique: vi.fn().mockResolvedValue(null) }, propertyNarrationDelivery: { findMany: vi.fn().mockResolvedValue([]), findFirst: s.assigned, findUnique: s.deliveryFind, updateMany: s.deliveryUpdate, count: vi.fn().mockResolvedValue(0), upsert: s.delivery }, publicationMetadataSync: { upsert: s.preview }, ownerReportDelivery: { upsert: s.report, findMany: vi.fn().mockResolvedValue([]) },
  };
  return { ...actual, prisma: { ...prisma, $transaction: (fn: (tx: typeof prisma) => unknown) => fn(prisma) } };
});
import { narrationRouter } from "../src/routes/properties/narration.js";
import { narrationFacts, narrationHash } from "../src/lib/propertyNarration.js";
const app = express(); app.use(express.json()); app.use("/properties", narrationRouter);
const propertyId = "11111111-1111-4111-8111-111111111111", versionId = "22222222-2222-4222-8222-222222222222";
const base = `/properties/${propertyId}/narration`;
const p = { id: propertyId, shortId: 5, deletedAt: null, type: "APARTMENT", rooms: 2, areaSqm: "90", floor: 3, totalFloors: 7, district: { name: "Исмоили Сомони" }, publishedChannels: ["INSTAGRAM"], price: 900000 };
const row = () => ({ id: versionId, propertyId, revision: 1, script: "Площадь девяносто квадратных метров.", voiceId: "voice", modelId: "configured", status: "DRAFT", approvedAt: new Date(), factsHash: narrationHash(narrationFacts(p)) });
describe("property narration route boundaries", () => {
  beforeEach(() => {
    vi.clearAllMocks(); s.deliveryFind.mockResolvedValue(null); s.deliveryUpdate.mockResolvedValue({ count: 1 }); s.role = "MARKETING"; s.access = true; s.assigned.mockResolvedValue(null); s.versions.mockResolvedValue([]); s.property.mockResolvedValue(p);
    s.settings.mockResolvedValue({ propertyNarrationConfig: { modelId: "configured", voices: [{ id: "voice", name: "Утверждённый" }] }, elevenLabsApiKey: "test" });
    s.latest.mockResolvedValue(row()); s.findVersion.mockResolvedValue(null); s.count.mockResolvedValue(0); s.updateMany.mockResolvedValue({ count: 1 });
  });
  it("denies private audio before storage lookup when property access is absent", async () => {
    s.access = false;
    expect((await request(app).get(`${base}/${versionId}/audio`)).status).toBe(403);
    expect(s.file).not.toHaveBeenCalled();
  });
  it("denies an editor with broad property permissions unless a delivery is assigned", async () => {
    s.role = "EDITOR";
    expect((await request(app).get(`${base}/${versionId}/audio`)).status).toBe(403);
    expect(s.file).not.toHaveBeenCalled();
    s.assigned.mockResolvedValue({ id: "assigned" }); s.latest.mockResolvedValue(null);
    expect((await request(app).get(`${base}/${versionId}/audio`)).status).toBe(404);
    expect(s.latest).toHaveBeenLastCalledWith({ where: { id: versionId, propertyId, status: "READY", deliveries: { some: { editorId: "staff" } } } });
  });
  it("allows configuration only to leadership and creates a missing singleton", async () => {
    const body = { modelId: "configured", voices: [] };
    expect((await request(app).put("/properties/narration-settings").send(body)).status).toBe(403);
    s.role = "ADMIN"; s.configSave.mockResolvedValue({});
    expect((await request(app).put("/properties/narration-settings").send(body)).status).toBe(200);
    expect(s.configSave).toHaveBeenCalledWith({ where: { id: "singleton" }, create: { id: "singleton", propertyNarrationConfig: body }, update: { propertyNarrationConfig: body } });
  });
  it("only leadership can reconcile UNKNOWN, with no provider call or unsafe replay", async () => {
    const body = { expectedRevision: 1, checkedProviderHistory: true, note: "Проверена история: пригодного аудио нет." };
    for (const role of ["AGENT", "MARKETING"]) {
      s.role = role; expect((await request(app).post(`${base}/${versionId}/reconcile`).send(body)).status).toBe(403);
    }
    s.role = "ADMIN"; s.latest.mockResolvedValue({ ...row(), status: "UNKNOWN", generationStartedAt: null });
    expect((await request(app).post(`${base}/${versionId}/reconcile`).send(body)).status).toBe(200);
    expect(s.updateMany).toHaveBeenLastCalledWith({ where: { id: versionId, propertyId, revision: 1, status: "UNKNOWN", generationStartedAt: null }, data: { status: "FAILED", errorCode: "MANUALLY_RECONCILED" } });
    s.updateMany.mockResolvedValue({ count: 0 });
    expect((await request(app).post(`${base}/${versionId}/reconcile`).send(body)).status).toBe(409);
    expect(s.audio).not.toHaveBeenCalled();
  });
  it("an owning agent can draft but cannot approve or spend on generation", async () => {
    s.role = "AGENT";
    for (const action of ["approve", "generate"]) expect((await request(app).post(`${base}/${versionId}/${action}`).send({ expectedRevision: 1, confirmed: true })).status).toBe(403);
    expect(s.audio).not.toHaveBeenCalled();
  });
  it("unconfigured voices block provider calls cleanly", async () => {
    s.settings.mockResolvedValue({ propertyNarrationConfig: {}, elevenLabsApiKey: "test" });
    expect((await request(app).post(`${base}/${versionId}/generate`).send({ expectedRevision: 1, confirmed: true })).status).toBe(409);
    expect(s.audio).not.toHaveBeenCalled();
  });
  it("changed property facts invalidate approval", async () => {
    s.latest.mockResolvedValue({ ...row(), factsHash: "old-facts" });
    expect((await request(app).post(`${base}/${versionId}/approve`).send({ expectedRevision: 1, confirmed: true })).status).toBe(409);
    expect(s.updateMany).not.toHaveBeenCalled();
  });
  it("rejects a property trashed after initial access but before approval or generation", async () => {
    for (const action of ["approve", "generate"]) {
      s.property.mockResolvedValueOnce(p).mockResolvedValueOnce({ ...p, deletedAt: new Date() });
      expect((await request(app).post(`${base}/${versionId}/${action}`).send({ expectedRevision: 1, confirmed: true })).status).toBe(409);
    }
    expect(s.audio).not.toHaveBeenCalled(); expect(s.updateMany).not.toHaveBeenCalled();
  });
  it("stale expected revision cannot overwrite another draft", async () => {
    const response = await request(app).post(base).send({ expectedRevision: 0, requestKey: crypto.randomUUID(), script: "Новая квартира площадью девяносто метров." });
    expect(response.status).toBe(409); expect(s.create).not.toHaveBeenCalled();
  });
  it("an owning agent can save a first draft without invoking the provider", async () => {
    s.role = "AGENT"; s.latest.mockResolvedValue(null); s.create.mockResolvedValue({ id: versionId, revision: 1 });
    expect((await request(app).post(base).send({ expectedRevision: 0, requestKey: crypto.randomUUID(), script: "Квартира площадью девяносто квадратных метров." })).status).toBe(201);
    expect(s.create).toHaveBeenCalledOnce(); expect(s.audio).not.toHaveBeenCalled();
  });
  it("requires listening confirmation and stores an audio-only handoff without sending", async () => {
    s.latest.mockResolvedValue({ ...row(), status: "READY" });
    s.delivery.mockImplementation(async ({ create }) => ({ ...create, editorId: "editor", status: "PREVIEW" }));
    const body = { expectedRevision: 1, confirmed: true, requestKey: crypto.randomUUID(), mode: "AUDIO_ONLY" };
    expect((await request(app).post(`${base}/${versionId}/handoff-preview`).send(body)).status).toBe(400);
    const response = await request(app).post(`${base}/${versionId}/handoff-preview`).send({ ...body, audioReviewed: true });
    expect(response.status).toBe(200); expect(response.body.sent).toBe(false); expect(response.body.delivery.mode).toBe("AUDIO_ONLY");
    expect(s.audio).not.toHaveBeenCalled();
  });
  it("unknown paid outcome is saved and the same request never retries", async () => {
    const version = row(); s.latest.mockImplementation(async () => version);
    s.update.mockImplementation(async ({ data }) => Object.assign(version, data));
    s.updateMany.mockImplementation(async ({ data }) => { Object.assign(version, data); return { count: 1 }; });
    s.audio.mockResolvedValue({ status: "UNKNOWN", errorCode: "PROVIDER_OUTCOME_UNKNOWN" });
    const send = () => request(app).post(`${base}/${versionId}/generate`).send({ expectedRevision: 1, confirmed: true });
    expect((await send()).status).toBe(502); expect(version.status).toBe("UNKNOWN");
    expect((await send()).status).toBe(409); expect(s.audio).toHaveBeenCalledTimes(1);
  });
  it("keeps generated audio history when trash occurs while the provider is working", async () => {
    s.property.mockResolvedValueOnce(p).mockResolvedValueOnce(p).mockResolvedValueOnce({ deletedAt: new Date() });
    s.update.mockResolvedValue(row()); s.upload.mockResolvedValue(undefined);
    s.audio.mockResolvedValue({ status: "READY", audio: Buffer.from("synthetic-audio"), requestId: "test" });
    const response = await request(app).post(`${base}/${versionId}/generate`).send({ expectedRevision: 1, confirmed: true });
    expect(response.status).toBe(200); expect(response.body.propertyTrashed).toBe(true);
    expect(s.upload).toHaveBeenCalledOnce(); expect(s.delivery).not.toHaveBeenCalled();
  });
  it("allows only stale GENERATING reconciliation after the provider timeout margin", async () => {
    s.role = "ADMIN";
    const send = () => request(app).post(`${base}/${versionId}/reconcile`).send({ expectedRevision: 1, checkedProviderHistory: true, note: "История ElevenLabs проверена, пригодного аудио нет." });
    s.latest.mockResolvedValue({ ...row(), status: "GENERATING", generationStartedAt: new Date() });
    expect((await send()).status).toBe(409);
    const started = new Date(Date.now() - 121_000);
    s.latest.mockResolvedValue({ ...row(), status: "GENERATING", generationStartedAt: started });
    expect((await send()).status).toBe(200);
    expect(s.updateMany).toHaveBeenLastCalledWith({ where: { id: versionId, propertyId, revision: 1, status: "GENERATING", generationStartedAt: started }, data: { status: "FAILED", errorCode: "MANUALLY_RECONCILED" } });
    expect(s.audio).not.toHaveBeenCalled();
  });
  it("late provider completion cannot overwrite a manually reconciled decision", async () => {
    s.audio.mockResolvedValue({ status: "READY", audio: Buffer.from("late"), requestId: "late" }); s.upload.mockResolvedValue(undefined);
    s.updateMany.mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 1 });
    const response = await request(app).post(`${base}/${versionId}/generate`).send({ expectedRevision: 1, confirmed: true });
    expect(response.status).toBe(409);
    expect(s.updateMany.mock.calls[0][0].where).toMatchObject({ status: "GENERATING" });
    expect(s.updateMany.mock.calls[1][0].data).not.toHaveProperty("status");
    expect(s.audio).toHaveBeenCalledOnce();
  });
  it("retains late reconciled audio in storage but never advertises FAILED audio as playable", async () => {
    s.versions.mockResolvedValue([{ ...row(), status: "FAILED", storageKey: `${propertyId}/${versionId}.mp3`, errorCode: "MANUALLY_RECONCILED" }]);
    const response = await request(app).get(base);
    expect(response.status).toBe(200);
    expect(response.body.versions[0].hasAudio).toBe(false);
    expect(response.body.versions[0]).not.toHaveProperty("storageKey");
    s.latest.mockResolvedValue(null);
    expect((await request(app).get(`${base}/${versionId}/audio`)).status).toBe(404);
    expect(s.latest.mock.calls.at(-1)?.[0].where.status).toBe("READY");
  });
  it("never queues preview delivery while server gate is disabled", async () => {
    vi.stubEnv("CRM_NARRATION_EXECUTION_MODE", "PREVIEW");
    const response = await request(app).post(`${base}/deliveries/${versionId}/queue`).send({ confirmed: true, planHash: "a".repeat(64) });
    expect(response.status).toBe(409); expect(s.deliveryUpdate).not.toHaveBeenCalled(); vi.unstubAllEnvs();
  });
  it.each(["AGENT", "MARKETING", "EDITOR"])("%s cannot reconcile a provider outcome", async role => {
    s.role = role; s.assigned.mockResolvedValue({ id: "assigned" });
    expect((await request(app).post(`${base}/delivery-reconcile`).send({ kind: "NARRATION", deliveryId: versionId, checkedProviderHistory: true, note: "Проверена история Telegram: пригодный файл не найден" })).status).toBe(403);
    expect(s.deliveryUpdate).not.toHaveBeenCalled();
  });
  it("leadership cannot reconcile fresh SENDING but may resolve stale without generating audio", async () => {
    s.role = "ADMIN";
    const body = { kind: "NARRATION", deliveryId: versionId, checkedProviderHistory: true, note: "Проверена история Telegram: пригодный файл не найден" };
    s.deliveryFind.mockResolvedValue({ id: versionId, propertyId, status: "SENDING", claimStartedAt: new Date() });
    expect((await request(app).post(`${base}/delivery-reconcile`).send(body)).status).toBe(409);
    s.deliveryFind.mockResolvedValue({ id: versionId, propertyId, status: "SENDING", claimStartedAt: new Date(Date.now() - 240000) });
    expect((await request(app).post(`${base}/delivery-reconcile`).send(body)).status).toBe(200);
    expect(s.deliveryUpdate.mock.calls.at(-1)?.[0].data).not.toHaveProperty("receipts"); expect(s.audio).not.toHaveBeenCalled();
  });
  it("does not reconcile a valid multi-file batch merely because 180 seconds elapsed", async () => {
    s.role = "ADMIN";
    const plan = { factsHash: "facts", recipientHash: "recipient", sourcesHash: "sources", files: Array.from({ length: 4 }, (_, i) => ({ id: `f${i}`, storageKey: `key${i}`, filename: `file${i}`, caption: "caption" })) };
    const body = { kind: "NARRATION", deliveryId: versionId, checkedProviderHistory: true, note: "Проверена история Telegram: пригодный файл не найден" };
    s.deliveryFind.mockResolvedValue({ id: versionId, propertyId, plan, status: "SENDING", claimStartedAt: new Date(Date.now() - 240000) });
    expect((await request(app).post(`${base}/delivery-reconcile`).send(body)).status).toBe(409);
    expect(s.deliveryUpdate).not.toHaveBeenCalled();
    s.deliveryFind.mockResolvedValue({ id: versionId, propertyId, plan, status: "SENDING", claimStartedAt: new Date(Date.now() - 481000) });
    expect((await request(app).post(`${base}/delivery-reconcile`).send(body)).status).toBe(200);
    expect(s.audio).not.toHaveBeenCalled();
  });
  it("publication preparation records manual fallback without calling providers", async () => {
    const response = await request(app).post(`${base}/publication-preview`).send({});
    expect(response.status).toBe(200); expect(response.body.sent).toBe(false);
    expect(response.body.rows.every((r: { status: string }) => r.status === "MANUAL_REQUIRED")).toBe(true);
    expect(s.audio).not.toHaveBeenCalled();
  });
});
