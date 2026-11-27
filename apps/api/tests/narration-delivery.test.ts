import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
const s = vi.hoisted(() => ({ claim: vi.fn(), row: vi.fn(), property: vi.fn(), latest: vi.fn(), settings: vi.fn(), editor: vi.fn(), videos: vi.fn(), send: vi.fn(), text: vi.fn(), save: vi.fn(), build: vi.fn(), inTx: false }));
vi.mock("../src/db.js", async (importOriginal) => {
  const tx = { $queryRaw: vi.fn(), property: { findUnique: s.property }, propertyNarrationVersion: { findFirst: s.latest, findUnique: s.latest }, settings: { findUnique: s.settings }, agent: { findFirst: s.editor }, propertyVideo: { findMany: s.videos }, propertyNarrationDelivery: { findUnique: s.row, findUniqueOrThrow: s.row, updateMany: s.save } };
  return { ...await importOriginal<typeof import("../src/db.js")>(), prisma: { ...tx, $disconnect: vi.fn(), $transaction: async (fn: any) => { s.inTx = true; try { return await fn(tx); } finally { s.inTx = false; } }, propertyNarrationDelivery: { ...tx.propertyNarrationDelivery, updateMany: s.claim } } };
});
vi.mock("../src/lib/videoHandoff.js", async (importOriginal) => ({ ...await importOriginal<typeof import("../src/lib/videoHandoff.js")>(), buildMontajerDelivery: s.build }));
vi.mock("../src/telegram/api.js", async (importOriginal) => ({ ...await importOriginal<typeof import("../src/telegram/api.js")>(), sendDocumentFile: s.send, sendMessage: s.text }));
vi.mock("../src/lib/localVideoStorage.js", async (importOriginal) => ({ ...await importOriginal<typeof import("../src/lib/localVideoStorage.js")>(), localVideoFilePath: () => "isolated-file" }));
vi.mock("node:fs", async (importOriginal) => ({ ...await importOriginal<typeof import("node:fs")>(), openAsBlob: vi.fn(async () => new Blob(["audio"])) }));
vi.mock("node:fs/promises", async (importOriginal) => ({ ...await importOriginal<typeof import("node:fs/promises")>(), stat: vi.fn(async () => ({ size: 32 })) }));
import { executeNarrationDelivery, prepareNarrationDeliveryPlan } from "../src/lib/narrationDelivery.js";
import { narrationFacts, narrationHash } from "../src/lib/propertyNarration.js";
import { mediaRecipientHash } from "../src/lib/mediaExecution.js";
describe("versioned narration delivery", () => {
  beforeEach(() => {
    vi.clearAllMocks(); vi.stubEnv("JWT_ACCESS_SECRET", "isolated-test-key"); vi.stubEnv("CRM_NARRATION_EXECUTION_MODE", "LIVE");
    const property = { id: "p", shortId: 42, type: "APARTMENT", rooms: 2, areaSqm: "90", floor: 1, totalFloors: 3, district: null, deletedAt: null, videoHandoffStatus: "SENT_TO_EDITOR", videoHandoffManualSince: null, videoHandoffDeliveredAt: new Date() };
    const version = { id: "v", propertyId: "p", revision: 4, script: "Полный проверенный текст.", storageKey: "audio", status: "READY", factsHash: narrationHash(narrationFacts(property)) };
    s.property.mockResolvedValue(property); s.latest.mockResolvedValue(version); s.settings.mockResolvedValue({ videoMontajerAgentId: "editor" }); s.editor.mockResolvedValue({ id: "editor", telegramChatId: "chat" }); s.videos.mockResolvedValue([]);
    s.build.mockResolvedValue({ property, videos: [], factsText: "Факты" });
    const plan = { factsHash: version.factsHash, recipientHash: mediaRecipientHash("editor", "chat"), sourcesHash: narrationHash([]), files: [{ id: "v", storageKey: "audio", filename: "v4.mp3", caption: "Объект42" }, { id: "v-script", storageKey: "SCRIPT", filename: "v4.txt", caption: "Полный проверенный текст." }] };
    let started = new Date();
    s.claim.mockImplementation(async (args: any) => { if (args.data.claimStartedAt) started = args.data.claimStartedAt; return { count: 1 }; });
    s.row.mockImplementation(async () => ({ id: "delivery", propertyId: "p", editorId: "editor", versionId: "v", mode: "AUDIO_ONLY", status: "SENDING", claimStartedAt: started, plan }));
    s.send.mockResolvedValue({ message_id: 123, document: { file_id: "telegram-file" } }); s.text.mockResolvedValue({ message_id: 124 }); s.save.mockImplementation(async (args: any) => { const current = await s.row(); s.row.mockResolvedValue({ ...current, ...args.data }); return { count: 1 }; });
  });
  afterEach(() => vi.unstubAllEnvs());
  it("default PREVIEW never claims or sends", async () => { vi.stubEnv("CRM_NARRATION_EXECUTION_MODE", ""); expect(await executeNarrationDelivery("delivery")).toEqual({ status: "PREVIEW" }); expect(s.claim).not.toHaveBeenCalled(); expect(s.send).not.toHaveBeenCalled(); });
  it("lost claim never sends twice", async () => { s.claim.mockResolvedValue({ count: 0 }); expect(await executeNarrationDelivery("delivery")).toEqual({ status: "NOT_CLAIMED" }); expect(s.send).not.toHaveBeenCalled(); });
  // Передача, поставленная до 19.11.2026 (план с файлом .txt), уходит по-новому: текст в подписи к mp3, без .txt.
  it("old plan with a .txt entry sends one mp3 whose caption carries the text; no .txt, receipt per audio id", async () => {
    expect(await executeNarrationDelivery("delivery")).toEqual({ status: "SENT" }); expect(s.send).toHaveBeenCalledOnce(); expect(s.text).not.toHaveBeenCalled();
    expect(s.send.mock.calls[0][2]).toBe("v4.mp3"); expect(s.send.mock.calls[0][3]).toBe("Объект42\n\nТекст:\nПолный проверенный текст.");
    expect(s.save.mock.calls.at(-1)?.[0].data.receipts).toHaveProperty("v.messageId", 123);
  });
  it("old plan: the stale two-files request is cut from the mp3 caption", async () => {
    const legacy = (await s.row()).plan; legacy.files[0].caption = "Озвучка к ролику №42, версия 4, одобрена. Вклейте этот голос сами: музыка, громкость и монтаж ваши. При сдаче пришлите два файла: готовый ролик и тот же ролик без голоса (музыка и звуки остаются) — тогда смену цены CRM сделает сама.";
    expect(await executeNarrationDelivery("delivery")).toEqual({ status: "SENT" });
    expect(s.send.mock.calls[0][3]).toBe("Озвучка к ролику №42, версия 4, одобрена. Вклейте этот голос сами: музыка, громкость и монтаж ваши.\n\nТекст:\nПолный проверенный текст.");
  });
  it("text longer than a caption goes as a plain message after the mp3, not as a file; a failure there stops without retry", async () => {
    const legacy = (await s.row()).plan; legacy.files[1].caption = "Длинный текст. ".repeat(80);
    expect(await executeNarrationDelivery("delivery")).toEqual({ status: "SENT" });
    expect(s.send).toHaveBeenCalledOnce(); expect(s.send.mock.calls[0][3]).toBe("Объект42");
    expect(s.text).toHaveBeenCalledOnce(); expect(s.text.mock.calls[0][1]).toBe(`Текст озвучки №42:\n${"Длинный текст. ".repeat(80)}`);
    expect(s.save.mock.calls.at(-1)?.[0].data.receipts).toHaveProperty("v-script.messageId", 124);
  });
  it("timeout after first receipt stops remaining parts without retry", async () => {
    const legacy = (await s.row()).plan; legacy.files[1].caption = "Длинный текст. ".repeat(80);
    s.text.mockRejectedValueOnce(new Error("timeout"));
    expect(await executeNarrationDelivery("delivery")).toEqual({ status: "UNKNOWN" }); expect(s.send).toHaveBeenCalledOnce(); expect(s.text).toHaveBeenCalledOnce(); expect(s.save).toHaveBeenCalledOnce();
  });
  it.each(["editor", "facts", "version", "trash", "reconciled"])("does not send after %s changed", async kind => {
    if (kind === "editor") s.editor.mockResolvedValue({ id: "editor", telegramChatId: "new-chat" });
    if (kind === "facts") s.property.mockResolvedValue({ ...(await s.property()), rooms: 5 });
    if (kind === "version") s.latest.mockResolvedValue({ ...(await s.latest()), id: "new-version" });
    if (kind === "trash") s.property.mockResolvedValue({ ...(await s.property()), deletedAt: new Date() });
    if (kind === "reconciled") s.row.mockResolvedValue({ ...(await s.row()), status: "FAILED" });
    expect(await executeNarrationDelivery("delivery")).toEqual({ status: "FAILED" }); expect(s.send).not.toHaveBeenCalled();
  });
  it("prepares audio-only with full script and never invokes providers", async () => { const p = await prepareNarrationDeliveryPlan("p", "v", "AUDIO_ONLY"); expect(p.editorId).toBe("editor"); expect(p.plan.files).toHaveLength(1); expect(p.plan.files[0].caption).toBe("Объект №42 · 🎙 голос, версия 4. Вклейте его сами, музыка и громкость на вас.\n\nТекст:\nПолный проверенный текст."); expect(p.plan.files[0].caption).not.toContain("без голоса"); expect(s.send).not.toHaveBeenCalled(); });
  it("cannot attach source videos from a different owner assignment", async () => { await expect(prepareNarrationDeliveryPlan("p", "v", "WITH_SOURCES", "another-editor")).rejects.toThrow("назначьте"); expect(s.send).not.toHaveBeenCalled(); });
  it("network runs after commit and late receipt cannot undo human reconciliation", async () => {
    s.send.mockImplementation(async () => { expect(s.inTx).toBe(false); const current = await s.row(); s.row.mockResolvedValue({ ...current, status: "FAILED" }); return { message_id: 77 }; });
    expect(await executeNarrationDelivery("delivery")).toEqual({ status: "UNKNOWN" }); expect(s.send).toHaveBeenCalledOnce();
    expect(s.save.mock.calls[0][0].data).not.toHaveProperty("status"); expect(s.save.mock.calls[0][0].data.receipts.v).toMatchObject({ messageId: 77, late: true });
    expect((await s.row()).status).toBe("FAILED");
  });});
