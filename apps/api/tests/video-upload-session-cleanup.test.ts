import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/** Уборка брошенных многочастевых загрузок видео (lib/videoUploadCleanup.ts).
 *
 *  Тот же порядок гарантий, что и у уборки готовых видео (property-video-cleanup):
 *  1. Свежую сессию не трогаем — агент может ещё вернуться и дослать части.
 *  2. Папка сессии на диске убирается ПЕРЕД удалением строки. Обратный порядок
 *     при отказе терял бы единственную ссылку на незакрытую загрузку. */

const abortLocalUploadSession = vi.fn<(sessionId: string) => Promise<boolean>>();
vi.mock("../src/lib/localVideoStorage.js", () => ({
  abortLocalUploadSession: (sessionId: string) => abortLocalUploadSession(sessionId),
}));
const sendPushToAgent = vi.fn(async () => 1);
vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent,
}));
vi.mock("../src/lib/systemError.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/systemError.js")>()),
  logSystemError: vi.fn() }));

const { prisma } = await import("../src/db.js");
const { cleanupStaleVideoUploadSessions } = await import("../src/lib/videoUploadCleanup.js");

const runId = Date.now();
let districtId: string;
let agentId: string;
const propertyIds: string[] = [];

async function makeSession(ageHours: number, parts: Array<{ partNumber: number }> = []) {
  const property = await prisma.property.create({
    data: {
      title: `Уборка-сессии-${runId}-${propertyIds.length}`,
      type: "APARTMENT",
      areaSqm: 50,
      price: 50000,
      currency: "USD",
      districtId,
      address: `Тест ${runId}`,
      condition: "GOOD",
      status: "AVAILABLE",
    },
  });
  propertyIds.push(property.id);
  const session = await prisma.videoUploadSession.create({
    data: {
      propertyId: property.id,
      uploadKey: `key-${runId}-${propertyIds.length}`,
      storageKey: `${property.id}/raw.mp4`,
      filename: "raw.mp4",
      sizeBytes: 1,
      contentType: "video/mp4",
      partSize: 1,
      totalParts: 2,
      parts,
      createdById: agentId,
    },
  });
  if (ageHours > 0) {
    await prisma.videoUploadSession.update({
      where: { id: session.id },
      data: { updatedAt: new Date(Date.now() - ageHours * 60 * 60 * 1000) },
    });
  }
  return { property, session };
}

beforeEach(async () => {
  abortLocalUploadSession.mockReset();
  sendPushToAgent.mockClear();
  abortLocalUploadSession.mockResolvedValue(true);
  const district = await prisma.district.upsert({
    where: { name: `Тест-уборка-сессии-${runId}` },
    update: {},
    create: { name: `Тест-уборка-сессии-${runId}` },
  });
  districtId = district.id;
  const agent = await prisma.agent.upsert({
    where: { phone: `+99298${runId}`.slice(0, 15) },
    update: {},
    create: { fullName: "Тест уборки сессий", phone: `+99298${runId}`.slice(0, 15), role: "AGENT", passwordHash: "x" },
  });
  agentId = agent.id;
});

afterAll(async () => {
  await prisma.videoUploadSession.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.$disconnect();
});

describe("уборка брошенных загрузок видео", () => {
  it("НЕ трогает свежую сессию — агент ещё может вернуться и дослать части", async () => {
    const { session } = await makeSession(1);
    await cleanupStaleVideoUploadSessions();
    expect(await prisma.videoUploadSession.findUnique({ where: { id: session.id } })).not.toBeNull();
    expect(abortLocalUploadSession).not.toHaveBeenCalled();
  });

  it("забирает сессию старше 48 часов и убирает её папку на диске", async () => {
    const { session } = await makeSession(49);
    await cleanupStaleVideoUploadSessions();
    expect(await prisma.videoUploadSession.findUnique({ where: { id: session.id } })).toBeNull();
    expect(abortLocalUploadSession).toHaveBeenCalledWith(session.id);
  });

  it("автору уходит пуш «загрузка отменена, загрузите заново», а при отказе уборки пуша нет", async () => {
    const { session, property } = await makeSession(49);
    await cleanupStaleVideoUploadSessions();
    const call = sendPushToAgent.mock.calls.find(([, p]) => (p as { tag?: string }).tag === `video-upload-cancelled-${session.id}`);
    expect(call).toBeDefined();
    expect(call![0]).toBe(agentId);
    expect((call![1] as { url?: string }).url).toBe(`/properties/${property.shortId}`);

    sendPushToAgent.mockClear();
    const failed = await makeSession(49);
    abortLocalUploadSession.mockResolvedValue(false);
    await cleanupStaleVideoUploadSessions();
    expect(
      sendPushToAgent.mock.calls.find(([, p]) => (p as { tag?: string }).tag === `video-upload-cancelled-${failed.session.id}`)
    ).toBeUndefined();
  });

  it("при отказе уборки строка остаётся — ссылку на незакрытую загрузку не теряем", async () => {
    const { session } = await makeSession(49);
    abortLocalUploadSession.mockResolvedValue(false);
    const result = await cleanupStaleVideoUploadSessions();
    expect(result.failed).toBeGreaterThan(0);
    expect(await prisma.videoUploadSession.findUnique({ where: { id: session.id } })).not.toBeNull();
  });

  /**
   * D4 (23.09.2026): сессия без единого куска — свой, меньший порог (24 ч),
   * а не общие 48. Разбор жалобы «не грузится»: 6 сессий с parts=[], ни один
   * кусок не пришёл ни разу, а общий порог ждал бы ещё сутки с лишним.
   */
  it("сессию без единого куска убирает уже в 25 часов — младше общего порога в 48", async () => {
    const { session } = await makeSession(25, []);
    await cleanupStaleVideoUploadSessions();
    expect(await prisma.videoUploadSession.findUnique({ where: { id: session.id } })).toBeNull();
    expect(abortLocalUploadSession).toHaveBeenCalledWith(session.id);
  });

  it("НЕ трогает пустую сессию младше 24 часов — агент мог просто отойти на минуту", async () => {
    const { session } = await makeSession(23, []);
    await cleanupStaleVideoUploadSessions();
    expect(await prisma.videoUploadSession.findUnique({ where: { id: session.id } })).not.toBeNull();
    expect(abortLocalUploadSession).not.toHaveBeenCalled();
  });

  it("сессию, у которой хоть один кусок дошёл, младший порог не трогает — ждёт общие 48 часов", async () => {
    const { session } = await makeSession(25, [{ partNumber: 1 }]);
    await cleanupStaleVideoUploadSessions();
    expect(await prisma.videoUploadSession.findUnique({ where: { id: session.id } })).not.toBeNull();
    expect(abortLocalUploadSession).not.toHaveBeenCalled();
  });
});
