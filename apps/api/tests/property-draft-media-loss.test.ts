import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { waitFor } from "./helpers/waitFor.js";

const sendPushToAgent = vi.fn(async () => 1);
vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent,
}));

const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");
const { uploadsDir } = await import("../src/upload.js");
const { discardDraft, cleanupExpiredPropertyDrafts } = await import("../src/routes/properties/draftAttach.js");

/**
 * «ТИХАЯ ПОТЕРЯ» ФАЙЛОВ МАСТЕРА (07.10.2026, владелец: «ролики и фото всегда
 * дозагружаются, агент видит процесс»). Живой случай: видео не догрузилось, объект
 * и фото созданы, ролика нет, никто не узнал.
 *
 * Каждому агенту — свой черновик (agentId уникален), поэтому на каждый сценарий
 * заводим своего агента: тесты независимы и не делят состояние.
 */

const runId = Date.now();
const last7 = String(runId).slice(-7);
const password = "testpass123";
const agentIds: string[] = [];
const propertyIds: string[] = [];
const createdFiles: string[] = [];
let districtId: string;
let counter = 0;

async function makeAgent() {
  counter++;
  const phone = `+99292${last7}${counter}`;
  const agent = await prisma.agent.create({
    data: { fullName: `Агент потери ${counter}`, phone, role: "AGENT", passwordHash: await bcrypt.hash(password, 10) },
  });
  agentIds.push(agent.id);
  const res = await request(app).post("/api/v1/auth/login").send({ phone, password });
  expect(res.status).toBe(200);
  return { id: agent.id, token: res.body.accessToken as string, counter };
}

function body(extra: Record<string, unknown>, n: number) {
  return {
    type: "APARTMENT" as const,
    areaSqm: 60,
    price: 400000,
    currency: "TJS" as const,
    districtId,
    condition: "GOOD" as const,
    rooms: 2,
    floor: 3,
    totalFloors: 9,
    windowCount: 4,
    ownerContact: `+99293${last7}${n}`,
    address: `Потеря файлов ${runId}-${n}`,
    ...extra,
  };
}

async function makeDraft(
  agentId: string,
  media: Array<{ kind: "PHOTO" | "VIDEO"; status: "READY" | "UPLOADING"; updatedAt?: Date }>,
  expiresAt = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000)
) {
  const draft = await prisma.propertyDraft.create({ data: { agentId, values: {}, step: 1, expiresAt } });
  let i = 0;
  for (const m of media) {
    const name = `${randomUUID()}.webp`;
    await prisma.propertyDraftMedia.create({
      data: {
        draftId: draft.id,
        kind: m.kind,
        status: m.status,
        uploadKey: `loss-${runId}-${randomUUID()}`,
        filename: m.kind === "PHOTO" ? "a.webp" : "v.mp4",
        contentType: m.kind === "PHOTO" ? "image/webp" : "video/mp4",
        sizeBytes: 10,
        order: i++,
        ...(m.kind === "PHOTO" && m.status === "READY" ? { url: `/uploads/${name}`, thumbUrl: `/uploads/thumbs/${name}` } : {}),
        ...(m.kind === "VIDEO" && m.status === "READY" ? { storageKey: `${draft.id}/${randomUUID()}.mp4` } : {}),
      },
    });
    if (m.updatedAt) {
      await prisma.$executeRaw`UPDATE "PropertyDraftMedia" SET "updatedAt" = ${m.updatedAt} WHERE "draftId" = ${draft.id} AND "order" = ${i - 1}`;
    }
  }
  return draft;
}

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Тест-район-потери-${runId}` } })).id;
});

beforeEach(() => {
  sendPushToAgent.mockClear();
});

afterAll(async () => {
  await prisma.propertyPhoto.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.propertyDraft.deleteMany({ where: { agentId: { in: agentIds } } });
  await prisma.auditLog.deleteMany({ where: { entityId: { in: propertyIds } } });
  await prisma.errorLog.deleteMany({ where: { dedupKey: { in: propertyIds.map((id) => `draft-media-lost:${id}`) } } });
  for (const f of createdFiles) fs.rmSync(f, { force: true });
  await prisma.notification.deleteMany({ where: { agentId: { in: agentIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: agentIds } } });
  await prisma.client.deleteMany({ where: { phone: { contains: last7 } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.$disconnect();
});

describe("POST /properties с черновиком: недогруженное не пропадает молча", () => {
  it("1 готовый снимок + 2 незаконченные закачки: 201, media.skipped = 2, автору пуш, запись в журналах", async () => {
    const a = await makeAgent();
    const draft = await makeDraft(a.id, [
      { kind: "PHOTO", status: "READY" },
      { kind: "VIDEO", status: "UPLOADING" },
      { kind: "PHOTO", status: "UPLOADING" },
    ]);
    const res = await request(app)
      .post("/api/v1/properties")
      .set("Authorization", `Bearer ${a.token}`)
      .send(body({ draftId: draft.id }, a.counter));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    propertyIds.push(res.body.id);

    expect(res.body.media).toEqual({
      attached: { photos: 1, videos: 0 },
      skipped: { photos: 1, videos: 1 },
    });
    expect(res.body.media.error).toBeUndefined();
    // Объект при этом создан с переехавшим снимком — создание не отменяется.
    expect(await prisma.propertyPhoto.count({ where: { propertyId: res.body.id } })).toBe(1);

    const push = sendPushToAgent.mock.calls.find(([, p]) => (p as { tag?: string }).tag === `property-draft-media-lost-${res.body.id}`);
    expect(push).toBeDefined();
    expect(push![0]).toBe(a.id);
    expect((push![1] as { body: string }).body).toContain("2 файлов из мастера не дошли");
    expect((push![1] as { url: string }).url).toBe(`/properties/${res.body.shortId}`);

    const audit = await waitFor(() =>
      prisma.auditLog.findFirst({ where: { action: "PROPERTY_DRAFT_MEDIA_LOST", entityId: res.body.id } })
    );
    expect((audit.meta as { skippedVideos: number }).skippedVideos).toBe(1);
    const logged = await waitFor(() => prisma.errorLog.findFirst({ where: { dedupKey: `draft-media-lost:${res.body.id}` } }));
    expect(logged.source).toBe("storage");
  });

  it("всё готово: media без skipped и без error, пуша «не дошли» нет", async () => {
    const a = await makeAgent();
    const draft = await makeDraft(a.id, [{ kind: "PHOTO", status: "READY" }]);
    const res = await request(app)
      .post("/api/v1/properties")
      .set("Authorization", `Bearer ${a.token}`)
      .send(body({ draftId: draft.id }, a.counter));
    expect(res.status).toBe(201);
    propertyIds.push(res.body.id);
    expect(res.body.media).toEqual({ attached: { photos: 1, videos: 0 }, skipped: { photos: 0, videos: 0 } });
    expect(sendPushToAgent.mock.calls.find(([, p]) => (p as { tag?: string }).tag === `property-draft-media-lost-${res.body.id}`)).toBeUndefined();
  });

  it("черновик не найден или чужой: объект создан, в ответе media.error, автору пуш", async () => {
    const a = await makeAgent();
    const stranger = await makeAgent();
    const foreign = await makeDraft(stranger.id, [{ kind: "PHOTO", status: "READY" }]);

    const notFound = await request(app)
      .post("/api/v1/properties")
      .set("Authorization", `Bearer ${a.token}`)
      .send(body({ draftId: randomUUID() }, a.counter));
    expect(notFound.status).toBe(201);
    propertyIds.push(notFound.body.id);
    expect(notFound.body.media.error).toBeTruthy();
    expect(notFound.body.media.attached).toEqual({ photos: 0, videos: 0 });

    const foreignRes = await request(app)
      .post("/api/v1/properties")
      .set("Authorization", `Bearer ${a.token}`)
      .send(body({ draftId: foreign.id }, a.counter + 5));
    expect(foreignRes.status).toBe(201);
    propertyIds.push(foreignRes.body.id);
    expect(foreignRes.body.media.error).toBeTruthy();
    // Чужой черновик не тронут.
    expect(await prisma.propertyDraft.count({ where: { id: foreign.id } })).toBe(1);
    expect(sendPushToAgent.mock.calls.filter(([id]) => id === a.id).length).toBeGreaterThanOrEqual(2);
  });

  it("пустой черновик — штатный случай «создали без медиа»: без error и без пуша", async () => {
    const a = await makeAgent();
    const draft = await makeDraft(a.id, []);
    const res = await request(app)
      .post("/api/v1/properties")
      .set("Authorization", `Bearer ${a.token}`)
      .send(body({ draftId: draft.id }, a.counter));
    expect(res.status).toBe(201);
    propertyIds.push(res.body.id);
    expect(res.body.media.error).toBeUndefined();
    expect(res.body.media.skipped).toEqual({ photos: 0, videos: 0 });
    expect(sendPushToAgent).not.toHaveBeenCalledWith(a.id, expect.objectContaining({ title: "⚠️ Файлы не догрузились" }));
  });

  it("запрос без draftId: поле media в ответе не появляется (обратная совместимость)", async () => {
    const a = await makeAgent();
    const res = await request(app).post("/api/v1/properties").set("Authorization", `Bearer ${a.token}`).send(body({}, a.counter));
    expect(res.status).toBe(201);
    propertyIds.push(res.body.id);
    expect(res.body.media).toBeUndefined();
  });
});

describe("discardDraft: падение удаления не стирает файлы", () => {
  it("delete упал — снимок на диске и строки черновика остаются, возвращается false", async () => {
    const a = await makeAgent();
    const draft = await makeDraft(a.id, [{ kind: "PHOTO", status: "READY" }]);
    const media = await prisma.propertyDraftMedia.findFirstOrThrow({ where: { draftId: draft.id } });
    const file = path.join(uploadsDir, path.basename(media.url!));
    fs.mkdirSync(uploadsDir, { recursive: true });
    fs.writeFileSync(file, "x");
    createdFiles.push(file);

    const spy = vi.spyOn(prisma.propertyDraft, "delete").mockRejectedValueOnce(new Error("БД недоступна"));
    try {
      expect(await discardDraft(draft.id)).toBe(false);
    } finally {
      spy.mockRestore();
    }
    expect(fs.existsSync(file)).toBe(true);
    expect(await prisma.propertyDraftMedia.count({ where: { draftId: draft.id } })).toBe(1);

    // Контроль: без сбоя черновик и файл уходят вместе.
    expect(await discardDraft(draft.id)).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
    expect(await prisma.propertyDraft.count({ where: { id: draft.id } })).toBe(0);
  });
});

describe("cleanupExpiredPropertyDrafts: не молча для автора", () => {
  it("черновик с закачкой, обновлённой за 6 часов, не удаляется даже по истёкшему сроку", async () => {
    const a = await makeAgent();
    const draft = await makeDraft(
      a.id,
      [{ kind: "VIDEO", status: "UPLOADING", updatedAt: new Date(Date.now() - 60 * 60 * 1000) }],
      new Date(Date.now() - 60 * 1000)
    );
    await cleanupExpiredPropertyDrafts();
    expect(await prisma.propertyDraft.count({ where: { id: draft.id } })).toBe(1);

    // Закачка старше шести часов — это уже брошенный черновик.
    await prisma.$executeRaw`UPDATE "PropertyDraftMedia" SET "updatedAt" = ${new Date(Date.now() - 7 * 60 * 60 * 1000)} WHERE "draftId" = ${draft.id}`;
    await cleanupExpiredPropertyDrafts();
    expect(await prisma.propertyDraft.count({ where: { id: draft.id } })).toBe(0);
  });

  it("удаление черновика с файлами — запись автору со счётчиком файлов", async () => {
    const a = await makeAgent();
    const draft = await makeDraft(
      a.id,
      [
        { kind: "PHOTO", status: "READY" },
        { kind: "PHOTO", status: "READY" },
        { kind: "VIDEO", status: "UPLOADING", updatedAt: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      ],
      new Date(Date.now() - 60 * 1000)
    );
    await cleanupExpiredPropertyDrafts();
    expect(await prisma.propertyDraft.count({ where: { id: draft.id } })).toBe(0);
    const call = sendPushToAgent.mock.calls.find(([, p]) => (p as { tag?: string }).tag === `property-draft-expired-${draft.id}`);
    expect(call).toBeDefined();
    expect(call![0]).toBe(a.id);
    expect((call![1] as { body: string }).body).toContain("фото 2, видео 1");
  });

  it("за двое суток до срока — предупреждение автору, и только один раз", async () => {
    const a = await makeAgent();
    const draft = await makeDraft(a.id, [{ kind: "PHOTO", status: "READY" }], new Date(Date.now() + 24 * 60 * 60 * 1000));
    const warnTag = `property-draft-expiring-${draft.id}-${draft.expiresAt.getTime()}`;
    await cleanupExpiredPropertyDrafts();
    expect(sendPushToAgent.mock.calls.filter(([, p]) => (p as { tag?: string }).tag === warnTag)).toHaveLength(1);
    // Само уведомление в ленте пишет sendPushToAgent (здесь подменён) — имитируем его.
    await prisma.notification.create({
      data: { agentId: a.id, kind: "other", title: "t", body: "b", tag: warnTag },
    });
    sendPushToAgent.mockClear();
    await cleanupExpiredPropertyDrafts();
    expect(sendPushToAgent.mock.calls.filter(([, p]) => (p as { tag?: string }).tag === warnTag)).toHaveLength(0);
    // Черновик живой — не удалён.
    expect(await prisma.propertyDraft.count({ where: { id: draft.id } })).toBe(1);
  });
});
