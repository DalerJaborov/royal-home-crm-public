import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
const s = vi.hoisted(() => ({ claim: vi.fn(), row: vi.fn(), property: vi.fn(), latest: vi.fn(), settings: vi.fn(), editor: vi.fn(), videos: vi.fn(), send: vi.fn(), save: vi.fn(), build: vi.fn(), inTx: false }));
vi.mock("../src/db.js", async (importOriginal) => {
  const tx = { $queryRaw: vi.fn(), property: { findUnique: s.property }, propertyNarrationVersion: { findFirst: s.latest, findUnique: s.latest }, settings: { findUnique: s.settings }, agent: { findFirst: s.editor }, propertyVideo: { findMany: s.videos }, propertyNarrationDelivery: { findUnique: s.row, findUniqueOrThrow: s.row, updateMany: s.save } };
  return { ...await importOriginal<typeof import("../src/db.js")>(), prisma: { ...tx, $disconnect: vi.fn(), $transaction: async (fn: any) => { s.inTx = true; try { return await fn(tx); } finally { s.inTx = false; } }, propertyNarrationDelivery: { ...tx.propertyNarrationDelivery, updateMany: s.claim } } };
});
vi.mock("../src/lib/videoHandoff.js", async (importOriginal) => ({ ...await importOriginal<typeof import("../src/lib/videoHandoff.js")>(), buildMontajerDelivery: s.build }));
vi.mock("../src/telegram/api.js", async (importOriginal) => ({ ...await importOriginal<typeof import("../src/telegram/api.js")>(), sendDocumentFile: s.send }));
vi.mock("../src/lib/localVideoStorage.js", async (importOriginal) => ({ ...await importOriginal<typeof import("../src/lib/localVideoStorage.js")>(), localVideoFilePath: () => "isolated-file" }));
vi.mock("node:fs", async (importOriginal) => ({ ...await importOriginal<typeof import("node:fs")>(), openAsBlob: vi.fn(async () => new Blob(["audio"])) }));
vi.mock("node:fs/promises", async (importOriginal) => ({ ...await importOriginal<typeof import("node:fs/promises")>(), stat: vi.fn(async () => ({ size: 32 })) }));
import { executeNarrationDelivery, prepareNarrationDeliveryPlan } from "../src/lib/narrationDelivery.js";
import { narrationFacts, narrationHash } from "../src/lib/propertyNarration.js";
import { mediaRecipientHash } from "../src/lib/mediaExecution.js";
describe("versioned narration delivery", () => {
  beforeEach(() => {
    vi.clearAllMocks(); vi.stubEnv("JWT_ACCESS_SECRET", "isolated-test-key"); vi.stubEnv("CRM_NARRATION_EXECUTION_MODE", "LIVE");
    const property = { id: "p", shortId: 42, type: "APARTMENT", rooms: 2, areaSqm: "90", floor: 1, totalFloors: 3, district: null, deletedAt: null, videoHandoffStatus: "SENT_TO_EDITOR", videoHandoffManualSince: null };
    const version = { id: "v", propertyId: "p", revision: 4, script: "Полный проверенный текст.", storageKey: "audio", status: "READY", factsHash: narrationHash(narrationFacts(property)) };
    s.property.mockResolvedValue(property); s.latest.mockResolvedValue(version); s.settings.mockResolvedValue({ videoMontajerAgentId: "editor" }); s.editor.mockResolvedValue({ id: "editor", telegramChatId: "chat" }); s.videos.mockResolvedValue([]);
    s.build.mockResolvedValue({ property, videos: [], factsText: "Факты" });
    const plan = { factsHash: version.factsHash, recipientHash: mediaRecipientHash("editor", "chat"), sourcesHash: narrationHash([]), files: [{ id: "v", storageKey: "audio", filename: "v4.mp3", caption: "Объект42" }, { id: "script", storageKey: "SCRIPT", filename: "v4.txt", caption: "Полный проверенный текст." }] };
    let started = new Date();
    s.claim.mockImplementation(async (args: any) => { if (args.data.claimStartedAt) started = args.data.claimStartedAt; return { count: 1 }; });
    s.row.mockImplementation(async () => ({ id: "delivery", propertyId: "p", editorId: "editor", versionId: "v", mode: "AUDIO_ONLY", status: "SENDING", claimStartedAt: started, plan }));
    s.send.mockResolvedValue({ message_id: 123, document: { file_id: "telegram-file" } }); s.save.mockImplementation(async (args: any) => { const current = await s.row(); s.row.mockResolvedValue({ ...current, ...args.data }); return { count: 1 }; });
  });
  afterEach(() => vi.unstubAllEnvs());
  it("default PREVIEW never claims or sends", async () => { vi.stubEnv("CRM_NARRATION_EXECUTION_MODE", ""); expect(await executeNarrationDelivery("delivery")).toEqual({ status: "PREVIEW" }); expect(s.claim).not.toHaveBeenCalled(); expect(s.send).not.toHaveBeenCalled(); });
  it("lost claim never sends twice", async () => { s.claim.mockResolvedValue({ count: 0 }); expect(await executeNarrationDelivery("delivery")).toEqual({ status: "NOT_CLAIMED" }); expect(s.send).not.toHaveBeenCalled(); });
  it("sends full script as document plus versioned audio with per-part receipts", async () => {
    expect(await executeNarrationDelivery("delivery")).toEqual({ status: "SENT" }); expect(s.send).toHaveBeenCalledTimes(2);
    expect(await s.send.mock.calls[1][1].text()).toBe("Полный проверенный текст."); expect(s.save.mock.calls.at(-1)?.[0].data.receipts).toHaveProperty("script.messageId", 123);
  });
  it("timeout after first receipt stops remaining parts without retry", async () => { s.send.mockResolvedValueOnce({ message_id: 123 }).mockRejectedValueOnce(new Error("timeout")); expect(await executeNarrationDelivery("delivery")).toEqual({ status: "UNKNOWN" }); expect(s.send).toHaveBeenCalledTimes(2); expect(s.save).toHaveBeenCalledOnce(); });
  it.each(["editor", "facts", "version", "trash", "reconciled"])("does not send after %s changed", async kind => {
    if (kind === "editor") s.editor.mockResolvedValue({ id: "editor", telegramChatId: "new-chat" });
    if (kind === "facts") s.property.mockResolvedValue({ ...(await s.property()), rooms: 5 });
    if (kind === "version") s.latest.mockResolvedValue({ ...(await s.latest()), id: "new-version" });
    if (kind === "trash") s.property.mockResolvedValue({ ...(await s.property()), deletedAt: new Date() });
    if (kind === "reconciled") s.row.mockResolvedValue({ ...(await s.row()), status: "FAILED" });
    expect(await executeNarrationDelivery("delivery")).toEqual({ status: "FAILED" }); expect(s.send).not.toHaveBeenCalled();
  });
  it("prepares audio-only with full script and never invokes providers", async () => { const p = await prepareNarrationDeliveryPlan("p", "v", "AUDIO_ONLY"); expect(p.editorId).toBe("editor"); expect(p.plan.files).toHaveLength(2); expect(p.plan.files[1].caption).toBe("Полный проверенный текст."); expect(s.send).not.toHaveBeenCalled(); });
  it("cannot attach source videos from a different owner assignment", async () => { await expect(prepareNarrationDeliveryPlan("p", "v", "WITH_SOURCES", "another-editor")).rejects.toThrow("назначьте"); expect(s.send).not.toHaveBeenCalled(); });
  it("network runs after commit and late receipt cannot undo human reconciliation", async () => {
    s.send.mockImplementation(async () => { expect(s.inTx).toBe(false); const current = await s.row(); s.row.mockResolvedValue({ ...current, status: "FAILED" }); return { message_id: 77 }; });
    expect(await executeNarrationDelivery("delivery")).toEqual({ status: "UNKNOWN" }); expect(s.send).toHaveBeenCalledOnce();
    expect(s.save.mock.calls[0][0].data).not.toHaveProperty("status"); expect(s.save.mock.calls[0][0].data.receipts.v).toMatchObject({ messageId: 77, late: true });
    expect((await s.row()).status).toBe("FAILED");
  });});
