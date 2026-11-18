import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

/**
 * ПРОСЛУШАТЬ ПЕРЕД ВЫПУСКОМ (17.11.2026): решение по новому ролику из карточки CRM и тексты Шабнам.
 * Маршрут зовёт те же функции, что кнопки Telegram (lib/narrationPreview.ts); монтажёр и «только чтение» не решают.
 */
const s = vi.hoisted(() => ({ role: "AGENT", release: vi.fn(), decline: vi.fn() }));
vi.mock("../src/auth/middleware.js", async (importOriginal) => ({ ...await importOriginal<typeof import("../src/auth/middleware.js")>(), requireAuth: (req: any, _res: any, next: () => void) => { req.agent = { id: "agent-1", role: s.role, permissions: new Set() }; next(); } }));
vi.mock("../src/routes/properties/shared.js", async (importOriginal) => ({ ...await importOriginal<typeof import("../src/routes/properties/shared.js")>(), canManageProperty: () => true }));
vi.mock("../src/lib/narrationPreview.js", async (importOriginal) => ({ ...await importOriginal<typeof import("../src/lib/narrationPreview.js")>(), releaseNarrationPreview: s.release, declineNarrationPreview: s.decline }));
vi.mock("../src/db.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/db.js")>();
  return { ...actual, prisma: { $disconnect: vi.fn(), $queryRaw: vi.fn(async () => []), property: { findUnique: vi.fn(async () => ({ id: "11111111-1111-4111-8111-111111111111", deletedAt: null })) }, propertyNarrationDelivery: { findFirst: vi.fn(async () => null) } } };
});
const { narrationRouter } = await import("../src/routes/properties/narration.js");
const { narrationPreviewButtons, narrationPreviewCaption } = await import("../src/telegram/narrationPreviewBot.js");

const app = express(); app.use(express.json()); app.use("/properties", narrationRouter);
const url = "/properties/11111111-1111-4111-8111-111111111111/narration/preview";
const versionId = "22222222-2222-4222-8222-222222222222";

describe("прослушать перед выпуском: маршрут карточки", () => {
  beforeEach(() => { s.role = "AGENT"; s.release.mockReset(); s.decline.mockReset(); });
  it("«Выпустить» → releaseNarrationPreview от имени сотрудника", async () => {
    s.release.mockResolvedValue("RELEASED");
    const res = await request(app).post(url).send({ versionId, decision: "RELEASE" });
    expect(res.status).toBe(200);
    expect(s.release).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111", versionId, { agentId: "agent-1", source: "crm" });
  });
  it("«Оставить старый» и «Другой голос или текст» → declineNarrationPreview с причиной", async () => {
    s.decline.mockResolvedValue("DECLINED");
    expect((await request(app).post(url).send({ versionId, decision: "KEEP_OLD" })).status).toBe(200);
    expect((await request(app).post(url).send({ versionId, decision: "CHANGE" })).status).toBe(200);
    expect(s.decline.mock.calls.map((c) => c[3])).toEqual(["KEEP_OLD", "CHANGE"]);
  });
  it("уже решён или устарел — 409; кривое тело — 400; монтажёр — 403", async () => {
    s.release.mockResolvedValue("STALE");
    expect((await request(app).post(url).send({ versionId, decision: "RELEASE" })).status).toBe(409);
    expect((await request(app).post(url).send({ versionId: "x", decision: "RELEASE" })).status).toBe(400);
    expect((await request(app).post(url).send({ versionId, decision: "PUBLISH_NOW" })).status).toBe(400);
    s.role = "EDITOR";
    expect((await request(app).post(url).send({ versionId, decision: "RELEASE" })).status).toBe(403);
    expect(s.release).toHaveBeenCalledTimes(1);
  });
});

describe("прослушать перед выпуском: Шабнам", () => {
  it("подпись: длины, строка подгонки, срок; без срока — «сам не выйдет»; по-таджикски на «шумо» без «лутфан»", () => {
    const due = new Date("2026-11-18T10:20:00Z");
    const ru = narrationPreviewCaption("ru", { shortId: 192, voiceSec: 33.6, clipSec: 36.2, note: "Голос чуть длиннее ролика: CRM ускорила его на 5 %.", dueAt: due });
    expect(ru).toContain("Голос 34 с · ролик 36 с");
    expect(ru).toContain("ускорила его на 5 %");
    expect(ru).toContain("15:20");
    expect(narrationPreviewCaption("ru", { shortId: 192, voiceSec: null, clipSec: null, note: null, dueAt: null })).toContain("Сам не выйдет");
    const tg = narrationPreviewCaption("tg", { shortId: 192, voiceSec: 10, clipSec: 12, note: null, dueAt: null });
    expect(tg).toContain("шуморо");
    expect(tg.toLowerCase()).not.toContain("лутфан");
  });
  it("три кнопки, callback_data в пределе Telegram (64 байта)", () => {
    for (const lang of ["ru", "tg"] as const) {
      const rows = narrationPreviewButtons(lang, versionId);
      expect(rows.map((r) => r[0].callback_data)).toEqual([`nrp:a:${versionId}`, `nrp:c:${versionId}`, `nrp:k:${versionId}`]);
      for (const r of rows) expect(Buffer.byteLength(r[0].callback_data!)).toBeLessThanOrEqual(64);
    }
  });
});
