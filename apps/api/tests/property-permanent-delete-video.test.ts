import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";

/**
 * Удаление объекта навсегда обязано забрать с собой и видео из закрытого
 * хранилища.
 *
 * Разбор 09.08.2026: PropertyVideo уходит каскадом (ON DELETE CASCADE), и вместе
 * с записью пропадает storageKey — единственная ссылка на файл. Сами файлы (до 30
 * роликов на объект) оставались на диске навсегда, без единой ссылки из базы:
 * найти и убрать их потом было уже нечем.
 *
 * Фотографии в этом же маршруте убирались корректно, и там же стоит комментарий
 * про папку uploads/msg, которая «росла навсегда» ровно по той же причине, —
 * урок был, но на видео его не перенесли.
 */

const localVideoDelete = vi.fn<(key: string) => Promise<boolean>>();
vi.mock("../src/lib/localVideoStorage.js", () => ({
  localVideoDelete: (key: string) => localVideoDelete(key),
  localVideoUpload: vi.fn(),
  localVideoFilePath: vi.fn(),
  localVideoExists: vi.fn(),
  createLocalUploadSession: vi.fn(),
  writeLocalUploadPart: vi.fn(),
  completeLocalUploadSession: vi.fn(),
  abortLocalUploadSession: vi.fn(),
  // diskCleanup.ts (импортирован через propertyOwnedFilePaths в crud.ts) читает
  // videoStorageDir динамически только внутри runDiskCleanup — этот маршрут его
  // не зовёт, но мок модуля обязан быть полным на случай, если это изменится.
  videoStorageDir: "./uploads-private-video",
}));

const request = (await import("supertest")).default;
const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");
const { grantElevation } = await import("../src/lib/stepUp.js");
const fs = await import("node:fs/promises");
const path = await import("node:path");
const { videoHandoffDir, propertyCoversDir } = await import("../src/upload.js");

const runId = Date.now();
const password = "testpass123";

let districtId = "";
let adminId = "";
let adminToken = "";
const propertyIds: string[] = [];

beforeAll(async () => {
  localVideoDelete.mockResolvedValue(true);
  districtId = (await prisma.district.create({ data: { name: `Удаление-видео-${runId}` } })).id;
  const admin = await prisma.agent.create({
    data: {
      fullName: `Админ удаления ${runId}`,
      phone: `+992941${String(runId).slice(-7)}`,
      role: "ADMIN",
      passwordHash: await bcrypt.hash(password, 10),
    },
  });
  adminId = admin.id;
  const login = await request(app)
    .post("/api/v1/auth/login")
    .send({ phone: admin.phone, password });
  expect(login.status).toBe(200);
  adminToken = login.body.accessToken as string;
  grantElevation(admin.id);
});

const clientIds: string[] = [];
const interactionIds: string[] = [];

const unrelatedCoverPath = path.join(propertyCoversDir, `cover-${runId}.jpg`);

afterAll(async () => {
  await prisma.pendingSummary.deleteMany({ where: { subjectId: { in: interactionIds } } });
  await prisma.interaction.deleteMany({ where: { id: { in: interactionIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.propertyVideo.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.agent.deleteMany({ where: { id: adminId } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await fs.rm(unrelatedCoverPath, { force: true });
  await prisma.$disconnect();
});

async function makeTrashedPropertyWithVideos(keys: string[]) {
  const property = await prisma.property.create({
    data: {
      title: `Объект на удаление ${runId}-${propertyIds.length}`,
      type: "APARTMENT",
      areaSqm: 50,
      price: 50000,
      currency: "USD",
      districtId,
      address: `Тест ${runId}`,
      condition: "GOOD",
      status: "AVAILABLE",
      deletedAt: new Date(),
      videos: {
        create: keys.map((k) => ({ storageKey: k, filename: "v.mp4", sizeBytes: 1, uploadedById: adminId })),
      },
    },
  });
  propertyIds.push(property.id);
  return property;
}

describe("Удаление объекта навсегда", () => {
  it("забирает из хранилища все видео объекта", async () => {
    localVideoDelete.mockClear();
    const keys = [`perm-${runId}-a`, `perm-${runId}-b`, `perm-${runId}-c`];
    const property = await makeTrashedPropertyWithVideos(keys);

    const res = await request(app)
      .delete(`/api/v1/properties/${property.id}/permanent`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(204);

    // Запись ушла вместе с объектом (каскад) — значит ссылок на файлы больше нет,
    // и если бы мы их не удалили здесь, убрать их было бы уже нечем.
    expect(await prisma.propertyVideo.count({ where: { propertyId: property.id } })).toBe(0);

    const deleted = localVideoDelete.mock.calls.map((c) => c[0]).sort();
    expect(deleted).toEqual([...keys].sort());
  });

  it("объект без видео удаляется как раньше, хранилище не трогается", async () => {
    localVideoDelete.mockClear();
    const property = await makeTrashedPropertyWithVideos([]);

    const res = await request(app)
      .delete(`/api/v1/properties/${property.id}/permanent`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(204);
    expect(localVideoDelete).not.toHaveBeenCalled();
  });

  /**
   * Разведка 07.09.2026 (класс «осиротевшие спутники»): показ, ещё висевший
   * задачей в календаре, после удаления объекта превращался в строку без единой
   * зацепки — какой объект, куда ехать. propertyId нулился (история без каскада),
   * а nextAction оставался «Показ объекта» безо всякой связи с чем бы то ни было.
   */
  it("незакрытый показ снимается с календаря, а не остаётся пустой строкой", async () => {
    const property = await makeTrashedPropertyWithVideos([]);
    const client = await prisma.client.create({
      data: {
        fullName: `Клиент показа ${runId}`,
        phone: `+992942${String(runId).slice(-7)}`,
        source: "PHONE_CALL",
        assignedAgentId: adminId,
      },
    });
    clientIds.push(client.id);
    const showing = await prisma.interaction.create({
      data: {
        clientId: client.id,
        agentId: adminId,
        propertyId: property.id,
        type: "SHOWING",
        notes: "Показ назначен",
        nextAction: "Показ объекта",
        nextActionDate: new Date(Date.now() + 3600_000),
      },
    });
    interactionIds.push(showing.id);
    const summary = await prisma.pendingSummary.create({
      data: { agentId: adminId, kind: "meeting", subjectId: showing.id, subjectName: "Показ" },
    });

    const res = await request(app)
      .delete(`/api/v1/properties/${property.id}/permanent`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(204);

    const after = await prisma.interaction.findUniqueOrThrow({ where: { id: showing.id } });
    expect(after.propertyId).toBeNull();
    // Задача исчезла из календаря вместо того, чтобы висеть пустой строкой.
    expect(after.nextAction).toBeNull();
    expect(after.declinedAt).not.toBeNull();
    expect(after.notes).toContain("Объект удалён навсегда");

    const summaryAfter = await prisma.pendingSummary.findUniqueOrThrow({ where: { id: summary.id } });
    expect(summaryAfter.doneAt).not.toBeNull();
  });

  it("исторические (уже завершённые) показы не трогает — это память, а не задача", async () => {
    const property = await makeTrashedPropertyWithVideos([]);
    const client = await prisma.client.create({
      data: {
        fullName: `Клиент истории ${runId}`,
        phone: `+992943${String(runId).slice(-7)}`,
        source: "PHONE_CALL",
        assignedAgentId: adminId,
      },
    });
    clientIds.push(client.id);
    const pastShowing = await prisma.interaction.create({
      data: {
        clientId: client.id,
        agentId: adminId,
        propertyId: property.id,
        type: "SHOWING",
        notes: "Показ состоялся",
        completedAt: new Date(),
      },
    });
    interactionIds.push(pastShowing.id);

    const res = await request(app)
      .delete(`/api/v1/properties/${property.id}/permanent`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(204);

    const after = await prisma.interaction.findUniqueOrThrow({ where: { id: pastShowing.id } });
    expect(after.propertyId).toBeNull();
    expect(after.notes).toBe("Показ состоялся");
    expect(after.declinedAt).toBeNull();
  });

  /**
   * Б8 (25.09.2026): до этой правки удаление навсегда стирало запись, но финал
   * приёма ролика, его старая кадр-обложка (-cover.jpg, убрана из выпуска в
   * #953, но старые файлы остались на проде) и обе обложки ChatGPT оставались
   * на диске без единой ссылки. propertyOwnedFilePaths (lib/diskCleanup.ts)
   * теперь отдаёт эти пути, и маршрут их убирает — но чужой файл в той же папке
   * (`cover-<hex>.jpg`, обложки статей сайта, routes/webhooks.ts) трогать нельзя.
   */
  it("удаляет финал приёма ролика, его старую кадр-обложку и обе обложки ChatGPT — чужой файл не трогает", async () => {
    const property = await makeTrashedPropertyWithVideos([]);
    const finalName = `${property.id}-${runId}.mp4`;
    const finalPath = path.join(videoHandoffDir, finalName);
    const legacyCoverPath = path.join(videoHandoffDir, `${property.id}-${runId}-cover.jpg`);
    const squareName = `${property.id}-${runId}-square.jpg`;
    const storyName = `${property.id}-${runId}-story.jpg`;
    const squarePath = path.join(propertyCoversDir, squareName);
    const storyPath = path.join(propertyCoversDir, storyName);

    await fs.mkdir(videoHandoffDir, { recursive: true });
    await fs.mkdir(propertyCoversDir, { recursive: true });
    await fs.writeFile(finalPath, "final");
    await fs.writeFile(legacyCoverPath, "legacy-cover");
    await fs.writeFile(squarePath, "square");
    await fs.writeFile(storyPath, "story");
    await fs.writeFile(unrelatedCoverPath, "статья сайта — не наш файл");

    await prisma.property.update({
      where: { id: property.id },
      data: {
        videoHandoffFinalPath: `/uploads/handoff/${finalName}`,
        socialCoverSquareUrl: `/uploads/covers/${squareName}`,
        socialCoverStoryUrl: `/uploads/covers/${storyName}`,
      },
    });

    const res = await request(app)
      .delete(`/api/v1/properties/${property.id}/permanent`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(204);

    await expect(fs.access(finalPath)).rejects.toThrow();
    await expect(fs.access(legacyCoverPath)).rejects.toThrow();
    await expect(fs.access(squarePath)).rejects.toThrow();
    await expect(fs.access(storyPath)).rejects.toThrow();
    // Чужой файл в той же папке — цел.
    await expect(fs.access(unrelatedCoverPath)).resolves.toBeUndefined();
  });
});
