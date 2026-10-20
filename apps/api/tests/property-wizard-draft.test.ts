import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import sharp from "sharp";
import fs from "node:fs";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { localVideoFilePath } from "../src/lib/localVideoStorage.js";
import { cleanupExpiredPropertyDrafts } from "../src/routes/properties/draftAttach.js";
import { loginWithCode } from "./helpers/loginCode.js";
import { randomUUID } from "node:crypto";
import { MIN_PROPERTY_PHOTOS } from "@royal-home/shared";

/**
 * ЧЕРНОВИК НОВОГО ОБЪЕКТА (routes/properties/drafts.ts, routes/properties/draftAttach.ts,
 * packages/shared/src/propertyWizardDraft.ts — коммит a0b716b0, 11.09.2026).
 *
 * Черновик — своя таблица на один на агента (agentId уникален), файлы уходят в
 * общее хранилище в тот же миг, когда их выбрали, а при создании объекта
 * (POST /properties с draftId) строки PropertyPhoto/PropertyVideo заводятся с уже
 * готовыми путями, и черновик одной транзакцией удаляется.
 *
 * Тесты идут одной историей на черновике агента A (таблица на агента одна,
 * второй PUT/upload не заводит вторую строку), а не по одному черновику на тест —
 * так и проверяется идемпотентность и «не портится мусором».
 */

const PREFIX = "/api/v1/properties/drafts/current";
const runId = Date.now();
const password = "testpass123";

let districtId: string;
let agentId: string;
let token: string;
let strangerId: string;
let strangerToken: string;

const propertyIds: string[] = [];
const propertyVideoStorageKeys: string[] = [];

function tinyJpeg(shade: number) {
  return sharp({ create: { width: 8, height: 8, channels: 3, background: { r: shade, g: 2, b: 3 } } })
    .jpeg()
    .toBuffer();
}

/** Общие обязательные поля объекта (property-create-required-fields.test.ts). */
function propertyBody(extra: Record<string, unknown>) {
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
    ownerContact: `+992937${runId}`, // не сидовый номер (staffPhoneGuard, 17.09.2026)
    ...extra,
  };
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  districtId = (await prisma.district.create({ data: { name: `Тест-район-черновик-${runId}` } })).id;

  agentId = (
    await prisma.agent.create({
      data: { fullName: "Агент черновика", phone: `+992955${runId}`, role: "AGENT", passwordHash },
    })
  ).id;
  const res = await loginWithCode(app, `+992955${runId}`);
  expect(res.status).toBe(200);
  token = res.body.accessToken as string;

  strangerId = (
    await prisma.agent.create({
      data: { fullName: "Чужой агент черновика", phone: `+992956${runId}`, role: "AGENT", passwordHash },
    })
  ).id;
  const strangerRes = await loginWithCode(app, `+992956${runId}`);
  expect(strangerRes.status).toBe(200);
  strangerToken = strangerRes.body.accessToken as string;
});

afterAll(async () => {
  await prisma.propertyPhoto.deleteMany({ where: { propertyId: { in: propertyIds } } });
  const videos = await prisma.propertyVideo.findMany({ where: { propertyId: { in: propertyIds } }, select: { storageKey: true } });
  await prisma.propertyVideo.deleteMany({ where: { propertyId: { in: propertyIds } } });
  for (const key of [...new Set([...videos.map((v) => v.storageKey), ...propertyVideoStorageKeys])]) {
    const p = localVideoFilePath(key);
    if (p) fs.rmSync(p, { force: true });
  }
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  // Страховка: если какой-то тест упал на середине, черновик/файлы всё равно уходят —
  // cascade на PropertyDraftMedia.draft (onDelete: Cascade) уберёт строки медиа.
  await prisma.propertyDraft.deleteMany({ where: { agentId: { in: [agentId, strangerId] } } });
  await prisma.agent.deleteMany({ where: { id: { in: [agentId, strangerId] } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.$disconnect();
});

describe("1. Пустой черновик", () => {
  it("GET /drafts/current до всего отвечает { draft: null }", async () => {
    const res = await request(app).get(PREFIX).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ draft: null, revision: 0 });
  });
});

describe("2-3. Автосохранение полей", () => {
  it("PUT заводит черновик, повторный PUT обновляет его же, а не плодит вторую строку", async () => {
    const first = await request(app)
      .put(PREFIX)
      .set("Authorization", `Bearer ${token}`)
      .send({ values: { type: "APARTMENT", address: "Первая версия адреса" }, step: 0 });
    expect(first.status).toBe(200);
    expect(first.body.draft.step).toBe(0);
    expect(first.body.draft.values.address).toBe("Первая версия адреса");

    const second = await request(app)
      .put(PREFIX)
      .set("Authorization", `Bearer ${token}`)
      .send({ values: { type: "APARTMENT", address: "Вторая версия адреса" }, step: 2 });
    expect(second.status).toBe(200);
    expect(second.body.draft.step).toBe(2);
    expect(second.body.draft.values.address).toBe("Вторая версия адреса");
    expect(second.body.draft.id).toBe(first.body.draft.id);

    expect(await prisma.propertyDraft.count({ where: { agentId } })).toBe(1);
  });

  /**
   * ЧЕТЫРЕ ПОЛЯ, КОТОРЫХ НЕ БЫЛО В СХЕМЕ (21.09.2026, жалоба владельца на
   * черновик). `details`, `documentsPreset`, `documentsOther` и `stage` живут в
   * WizardValues с 15.09.2026, а в propertyWizardDraftValuesSchema их забыли —
   * и zod срезал их МОЛЧА: автосохранение отвечало 200, а характеристики,
   * документы и стадия стройки в черновик не попадали.
   *
   * Проверка без починки красная: `values.details` приходит undefined.
   */
  it("характеристики, документы и стадия стройки доживают до ответа, а не срезаются молча", async () => {
    const res = await request(app)
      .put(PREFIX)
      .set("Authorization", `Bearer ${token}`)
      .send({
        values: {
          type: "APARTMENT",
          address: "Адрес с характеристиками",
          // «__not_set__» — «не указано» в мастере: черновик обязан уметь
          // хранить и наполовину заполненное, поэтому схема здесь ленивая и
          // строгий propertyDetailsSchema тут не годится.
          details: { balcony: "Лоджия", bathroom: "__not_set__" },
          documentsPreset: "Другое",
          documentsOther: "Дарственная у нотариуса",
          stage: "FOUNDATION",
        },
        step: 1,
      });
    expect(res.status).toBe(200);
    expect(res.body.draft.values.details).toEqual({ balcony: "Лоджия", bathroom: "__not_set__" });
    expect(res.body.draft.values.documentsPreset).toBe("Другое");
    expect(res.body.draft.values.documentsOther).toBe("Дарственная у нотариуса");
    expect(res.body.draft.values.stage).toBe("FOUNDATION");

    // И то же самое читается обратно при следующем входе в мастер.
    const read = await request(app).get(PREFIX).set("Authorization", `Bearer ${token}`);
    expect(read.status).toBe(200);
    expect(read.body.draft.values.details).toEqual({ balcony: "Лоджия", bathroom: "__not_set__" });
    expect(read.body.draft.values.stage).toBe("FOUNDATION");
  });

  it("мусор в теле (шаг вне диапазона, координата вне диапазона, слишком длинный адрес) — 400, черновик не портится", async () => {
    const before = await prisma.propertyDraft.findUniqueOrThrow({ where: { agentId } });

    const badStep = await request(app)
      .put(PREFIX)
      .set("Authorization", `Bearer ${token}`)
      .send({ values: {}, step: 99 });
    expect(badStep.status).toBe(400);

    const badLat = await request(app)
      .put(PREFIX)
      .set("Authorization", `Bearer ${token}`)
      .send({ values: { lat: 1000 }, step: 0 });
    expect(badLat.status).toBe(400);

    const badAddress = await request(app)
      .put(PREFIX)
      .set("Authorization", `Bearer ${token}`)
      .send({ values: { address: "а".repeat(10_000) }, step: 0 });
    expect(badAddress.status).toBe(400);

    const after = await prisma.propertyDraft.findUniqueOrThrow({ where: { agentId } });
    expect(after.values).toEqual(before.values);
    expect(after.step).toBe(before.step);
    expect(await prisma.propertyDraft.count({ where: { agentId } })).toBe(1);
  });
});

let photoMediaIds: string[] = [];

describe("4-5. Загрузка снимков в черновик", () => {
  it("две настоящих фотографии — 201, готовые пути, кадр READY", async () => {
    const [jpegA, jpegB] = await Promise.all([tinyJpeg(1), tinyJpeg(9)]);
    const res = await request(app)
      .post(`${PREFIX}/photos`)
      .set("Authorization", `Bearer ${token}`)
      .field("uploadKeys", `${runId}-photo-1`)
      .field("uploadKeys", `${runId}-photo-2`)
      .attach("photos", jpegA, "photo-1.jpg")
      .attach("photos", jpegB, "photo-2.jpg");

    expect(res.status).toBe(201);
    expect(res.body).toHaveLength(2);
    for (const media of res.body) {
      expect(media.kind).toBe("PHOTO");
      expect(media.status).toBe("READY");
      expect(media.url).toBeTruthy();
      expect(media.thumbUrl).toBeTruthy();
    }
    photoMediaIds = res.body.map((m: { id: string }) => m.id);
    expect(await prisma.propertyDraftMedia.count({ where: { draft: { agentId } } })).toBe(2);
  });

  it("идемпотентность: повтор той же пачки с теми же ключами не создаёт вторые строки", async () => {
    const [jpegA, jpegB] = await Promise.all([tinyJpeg(1), tinyJpeg(9)]);
    const res = await request(app)
      .post(`${PREFIX}/photos`)
      .set("Authorization", `Bearer ${token}`)
      .field("uploadKeys", `${runId}-photo-1`)
      .field("uploadKeys", `${runId}-photo-2`)
      .attach("photos", jpegA, "photo-1.jpg")
      .attach("photos", jpegB, "photo-2.jpg");

    expect(res.status).toBe(201);
    expect(res.body.map((m: { id: string }) => m.id)).toEqual(photoMediaIds);
    expect(await prisma.propertyDraftMedia.count({ where: { draft: { agentId } } })).toBe(2);
  });
});

describe("6. Чужой черновик недоступен", () => {
  it("GET агента B не отдаёт файлы агента A", async () => {
    const res = await request(app).get(PREFIX).set("Authorization", `Bearer ${strangerToken}`);
    expect(res.status).toBe(200);
    if (res.body.draft) {
      const ids = res.body.draft.media.map((m: { id: string }) => m.id);
      for (const id of photoMediaIds) expect(ids).not.toContain(id);
    } else {
      expect(res.body.draft).toBeNull();
    }
  });

  it("DELETE файла агента A от имени агента B — 403, файл остаётся", async () => {
    const res = await request(app)
      .delete(`${PREFIX}/media/${photoMediaIds[0]}`)
      .set("Authorization", `Bearer ${strangerToken}`);
    expect(res.status).toBe(403);
    expect(await prisma.propertyDraftMedia.findUnique({ where: { id: photoMediaIds[0] } })).not.toBeNull();
  });
});

const PART_SIZE = 8 * 1024 * 1024;
let readyVideoMediaId: string;
let incompleteVideoMediaId: string;

describe("7. Видео черновика по частям", () => {
  it("сессия на 2 части, обе части дошли, complete → READY со storageKey", async () => {
    const uploadKey = `${runId}-video-ready`;
    const sizeBytes = 10 * 1024 * 1024; // 8 МБ + 2 МБ = 2 части

    const started = await request(app)
      .post(`${PREFIX}/videos/sessions`)
      .set("Authorization", `Bearer ${token}`)
      .send({ uploadKey, filename: "obhod.mp4", sizeBytes, contentType: "video/mp4" });
    expect(started.status).toBe(201);
    expect(started.body).toMatchObject({ status: "started", totalParts: 2, uploadedPartNumbers: [] });
    readyVideoMediaId = started.body.mediaId;

    // Повтор того же ключа до завершения — та же сессия, не вторая запись.
    const resumed = await request(app)
      .post(`${PREFIX}/videos/sessions`)
      .set("Authorization", `Bearer ${token}`)
      .send({ uploadKey, filename: "obhod.mp4", sizeBytes, contentType: "video/mp4" });
    expect(resumed.status).toBe(200);
    expect(resumed.body.status).toBe("in-progress");
    expect(resumed.body.mediaId).toBe(readyVideoMediaId);
    expect(await prisma.propertyDraftMedia.count({ where: { uploadKey } })).toBe(1);

    const part1 = await request(app)
      .put(`${PREFIX}/videos/${readyVideoMediaId}/parts/1`)
      .set("Authorization", `Bearer ${token}`)
      .set("Content-Type", "application/octet-stream")
      .send(Buffer.alloc(PART_SIZE, 1));
    expect(part1.status).toBe(200);

    const part2 = await request(app)
      .put(`${PREFIX}/videos/${readyVideoMediaId}/parts/2`)
      .set("Authorization", `Bearer ${token}`)
      .set("Content-Type", "application/octet-stream")
      .send(Buffer.alloc(sizeBytes - PART_SIZE, 2));
    expect(part2.status).toBe(200);

    const done = await request(app)
      .post(`${PREFIX}/videos/${readyVideoMediaId}/complete`)
      .set("Authorization", `Bearer ${token}`);
    expect(done.status).toBe(200);
    expect(done.body.media.status).toBe("READY");
    expect(done.body.media.id).toBe(readyVideoMediaId);
    const stored = await prisma.propertyDraftMedia.findUniqueOrThrow({ where: { id: readyVideoMediaId } });
    expect(stored.storageKey).toBeTruthy();
    propertyVideoStorageKeys.push(stored.storageKey!);
  });

  it("complete при неполном наборе частей — 409 с недостающими номерами", async () => {
    const uploadKey = `${runId}-video-incomplete`;
    const sizeBytes = 10 * 1024 * 1024;

    const started = await request(app)
      .post(`${PREFIX}/videos/sessions`)
      .set("Authorization", `Bearer ${token}`)
      .send({ uploadKey, filename: "obhod-2.mp4", sizeBytes, contentType: "video/mp4" });
    expect(started.status).toBe(201);
    incompleteVideoMediaId = started.body.mediaId;

    await request(app)
      .put(`${PREFIX}/videos/${incompleteVideoMediaId}/parts/1`)
      .set("Authorization", `Bearer ${token}`)
      .set("Content-Type", "application/octet-stream")
      .send(Buffer.alloc(PART_SIZE, 3));

    const res = await request(app)
      .post(`${PREFIX}/videos/${incompleteVideoMediaId}/complete`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(409);
    expect(res.body.uploadedPartNumbers).toEqual([1]);
    expect(res.body.totalParts).toBe(2);

    const stored = await prisma.propertyDraftMedia.findUniqueOrThrow({ where: { id: incompleteVideoMediaId } });
    expect(stored.status).toBe("UPLOADING");
  });

  /**
   * ТОТ ЖЕ ФАЙЛ ВЫБРАН ДВАЖДЫ — ОДИН РОЛИК, А НЕ ДВА (19.09.2026).
   *
   * На проде объект №111 уехал монтажёру как «Ролик 1 из 2» и «Ролик 2 из 2»,
   * где обоими роликами был один и тот же IMG_8354.mov: одинаковое имя,
   * одинаковый размер до байта, один черновик, две строки и две копии на
   * диске. uploadKey придумывает клиент, и при повторном выборе того же файла
   * в мастере он НОВЫЙ — прежняя защита такое не ловила вовсе.
   */
  it("тот же файл вторым uploadKey — та же запись, а не второй ролик в черновике", async () => {
    const draft = await prisma.propertyDraft.findUniqueOrThrow({ where: { agentId } });
    const before = await prisma.propertyDraftMedia.count({ where: { draftId: draft.id, kind: "VIDEO" } });

    const again = await request(app)
      .post(`${PREFIX}/videos/sessions`)
      .set("Authorization", `Bearer ${token}`)
      .send({
        uploadKey: `${runId}-video-ready-ВТОРОЙ-ВЫБОР`,
        filename: "obhod.mp4",
        sizeBytes: 10 * 1024 * 1024,
        contentType: "video/mp4",
      });

    expect(again.status).toBe(200);
    expect(again.body.status).toBe("done");
    expect(again.body.media.id).toBe(readyVideoMediaId);
    expect(await prisma.propertyDraftMedia.count({ where: { draftId: draft.id, kind: "VIDEO" } })).toBe(before);
  });
});

describe("8. Отмена загрузки", () => {
  it("DELETE удаляет файл, повторный вызов снова 204 (не 404)", async () => {
    const jpeg = await tinyJpeg(5);
    const upload = await request(app)
      .post(`${PREFIX}/photos`)
      .set("Authorization", `Bearer ${token}`)
      .field("uploadKeys", `${runId}-photo-cancel`)
      .attach("photos", jpeg, "cancel.jpg");
    expect(upload.status).toBe(201);
    const mediaId = upload.body[0].id;

    const first = await request(app).delete(`${PREFIX}/media/${mediaId}`).set("Authorization", `Bearer ${token}`);
    expect(first.status).toBe(204);
    expect(await prisma.propertyDraftMedia.findUnique({ where: { id: mediaId } })).toBeNull();

    const second = await request(app).delete(`${PREFIX}/media/${mediaId}`).set("Authorization", `Bearer ${token}`);
    expect(second.status).toBe(204);
  });
});

// После пунктов 1-8 в черновике агента A: 2 снимка (photoMediaIds), 1 готовое видео
// (readyVideoMediaId) и 1 незаконченная видеосессия (incompleteVideoMediaId) — ровно
// тот набор, который нужен пунктам 9 и 11.
let movedPropertyId: string;

describe("9, 11. Переезд файлов черновика в объект", () => {
  it("POST /properties с draftId создаёт объект и переносит файлы", async () => {
    const draft = await prisma.propertyDraft.findUniqueOrThrow({ where: { agentId } });
    const res = await request(app)
      .post("/api/v1/properties")
      .set("Authorization", `Bearer ${token}`)
      .send(propertyBody({ address: `Из черновика, ${runId}`, draftId: draft.id }));
    expect(res.status).toBe(201);
    movedPropertyId = res.body.id;
    propertyIds.push(movedPropertyId);
  });

  it("2 снимка и 1 готовое видео переехали, порядок снимков сохранён (0,1)", async () => {
    const photos = await prisma.propertyPhoto.findMany({
      where: { propertyId: movedPropertyId },
      orderBy: { order: "asc" },
    });
    expect(photos).toHaveLength(2);
    expect(photos.map((p) => p.order)).toEqual([0, 1]);
    expect(await prisma.propertyVideo.count({ where: { propertyId: movedPropertyId } })).toBe(1);
  });

  /**
   * НАХОДКА 12.09.2026: раньше объект уходил в PENDING_REVIEW ещё ДО переезда фото
   * из черновика, поэтому мог оказаться на проверке с нулём снимков (или, как
   * здесь, значение случайно совпадало с правильным, потому что фото были — сама
   * проверка на их наличие отсутствовала). Здесь объект не offSite и фото из
   * черновика реально приехали — статус обязан стать PENDING_REVIEW уже ПОСЛЕ
   * переезда (routes/properties/crud.ts, блок после attachDraftToProperty).
   */
  it("объект с фото из черновика уходит на проверку (PENDING_REVIEW), не в «ждут фото»", async () => {
    const property = await prisma.property.findUniqueOrThrow({ where: { id: movedPropertyId } });
    expect(property.status).toBe("PENDING_REVIEW");
  });

  /**
   * НАХОДКА 12.09.2026: сжатие обзорного ролика (480p, clipVideoStatus) задумано
   * ТОЛЬКО для offSite-объектов — обычный объект получает готовый Reels от
   * монтажёра тем же конвейером, и сжатие черновикового видео для него не нужно.
   * Этот объект — обычный (offSite не передан), поэтому clipVideoStatus обязан
   * остаться NONE, даже когда готовое видео из черновика реально переехало.
   */
  it("обычный (не offSite) объект не ставит видео черновика в сжатие 480p", async () => {
    const property = await prisma.property.findUniqueOrThrow({ where: { id: movedPropertyId } });
    expect(property.clipVideoStatus).toBe("NONE");
  });

  it("черновик закрыт, оставлен tombstone, незаконченная сессия не стала PropertyVideo", async () => {
    const draft = await prisma.propertyDraft.findUnique({ where: { agentId } });
    expect(draft?.closedAt).not.toBeNull();
    expect(draft?.values).toEqual({});
    // Готовое видео — единственное: незаконченная сессия не превратилась во второе.
    expect(await prisma.propertyVideo.count({ where: { propertyId: movedPropertyId } })).toBe(1);
    expect(await prisma.propertyDraftMedia.findUnique({ where: { id: incompleteVideoMediaId } })).toBeNull();
  });
});

let foreignDraftId: string;
let foreignPropertyId: string;

describe("10. Чужой draftId при создании объекта не переезжает", () => {
  it("подготовка: у агента A новый черновик с одним снимком", async () => {
    const state = await request(app).get(PREFIX).set("Authorization", `Bearer ${token}`);
    const started = await request(app).post(`${PREFIX}/start`).set("Authorization", `Bearer ${token}`).send({ sessionId: randomUUID(), revision: state.body.revision });
    expect(started.status).toBe(200);
    foreignDraftId = started.body.draft.id;
    const jpeg = await tinyJpeg(7);
    const res = await request(app)
      .post(`${PREFIX}/photos`)
      .set("Authorization", `Bearer ${token}`)
      .set("X-Property-Draft-Id", foreignDraftId)
      .field("uploadKeys", `${runId}-photo-foreign`)
      .attach("photos", jpeg, "foreign.jpg");
    expect(res.status).toBe(201);
    const draft = await prisma.propertyDraft.findUniqueOrThrow({ where: { agentId } });
    foreignDraftId = draft.id;
  });

  it("агент B не создаёт объект с чужим draftId, чужие файлы остаются", async () => {
    const res = await request(app)
      .post("/api/v1/properties")
      .set("Authorization", `Bearer ${strangerToken}`)
      // Свой номер собственника: номер из propertyBody уже привязан к продавцу
      // агента A, а чужого продавца по номеру объект больше не берёт (глубокая
      // проверка 02.10.2026, A7) — этот тест не про это.
      .send(
        propertyBody({
          address: `Чужой черновик, ${runId}`,
          draftId: foreignDraftId,
          ownerContact: `+99293${String(runId).slice(-7)}9`,
        })
      );
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("DRAFT_CONFLICT");
    // Черновик агента A остался на месте — переезда не было.
    const draft = await prisma.propertyDraft.findUnique({ where: { id: foreignDraftId } });
    expect(draft).not.toBeNull();
    expect(await prisma.propertyDraftMedia.count({ where: { draftId: foreignDraftId } })).toBe(1);
  });
});

describe("12. Просроченный черновик", () => {
  it("GET после истечения срока отдаёт null и сохраняет закрытую generation", async () => {
    await prisma.propertyDraft.update({
      where: { id: foreignDraftId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const res = await request(app).get(PREFIX).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.draft).toBeNull();
    expect((await prisma.propertyDraft.findUniqueOrThrow({ where: { id: foreignDraftId } })).closedAt).not.toBeNull();
  });
});

describe("13. Ночная уборка просроченных черновиков", () => {
  it("cleanupExpiredPropertyDrafts удаляет просроченный черновик и возвращает число удалённых", async () => {
    const expired = await prisma.propertyDraft.update({
      where: { agentId }, data: { closedAt: null, values: {}, step: 0, expiresAt: new Date(Date.now() - 1000) },
    });

    const removed = await cleanupExpiredPropertyDrafts();
    expect(removed).toBeGreaterThanOrEqual(1);
    expect((await prisma.propertyDraft.findUniqueOrThrow({ where: { id: expired.id } })).closedAt).not.toBeNull();
  });
});

/**
 * ГОНКА СОЗДАНИЯ ЧЕРНОВИКА — P2002 БЕЗ 500 (21.09.2026, аудит памяти/надёжности
 * черновика, drafts.ts::ensureDraft + upsertOwnDraft).
 *
 * Прод: Умед 21.09 11:08 UTC, Ноза 17.09 — 500 на POST /drafts/current/photos
 * сразу после автосохранения PUT /drafts/current. Оба маршрута читают «черновика
 * нет» и оба идут в create; проигравший ловит P2002 по уникальному agentId.
 * Свои агенты БЕЗ черновика на старте (не пересекаются с историей агента A выше) —
 * важна именно гонка на СОЗДАНИИ первой строки, а не повтор на уже существующей.
 */
describe("14. Гонка создания черновика — параллельные запросы не 500 на P2002", () => {
  const racePassword = "testpass123";
  let racePhotosAgentId = "";
  let racePhotosToken = "";
  let racePutAgentId = "";
  let racePutToken = "";

  beforeAll(async () => {
    const passwordHash = await bcrypt.hash(racePassword, 10);

    racePhotosAgentId = (
      await prisma.agent.create({
        data: { fullName: "Агент гонки черновика (фото)", phone: `+992961${runId}`, role: "AGENT", passwordHash },
      })
    ).id;
    const resPhotos = await loginWithCode(app, `+992961${runId}`);
    expect(resPhotos.status).toBe(200);
    racePhotosToken = resPhotos.body.accessToken as string;

    racePutAgentId = (
      await prisma.agent.create({
        data: { fullName: "Агент гонки черновика (PUT)", phone: `+992962${runId}`, role: "AGENT", passwordHash },
      })
    ).id;
    const resPut = await loginWithCode(app, `+992962${runId}`);
    expect(resPut.status).toBe(200);
    racePutToken = resPut.body.accessToken as string;
  });

  afterAll(async () => {
    await prisma.propertyDraftMedia.deleteMany({
      where: { draft: { agentId: { in: [racePhotosAgentId, racePutAgentId] } } },
    });
    await prisma.propertyDraft.deleteMany({ where: { agentId: { in: [racePhotosAgentId, racePutAgentId] } } });
    await prisma.agent.deleteMany({ where: { id: { in: [racePhotosAgentId, racePutAgentId] } } });
  });

  it("ensureDraft: два параллельных POST /photos на пустой черновик — оба 201, строка одна", async () => {
    const [jpegA, jpegB] = await Promise.all([tinyJpeg(2), tinyJpeg(4)]);
    const [resA, resB] = await Promise.all([
      request(app)
        .post(`${PREFIX}/photos`)
        .set("Authorization", `Bearer ${racePhotosToken}`)
        .field("uploadKeys", `${runId}-race-photo-a`)
        .attach("photos", jpegA, "race-a.jpg"),
      request(app)
        .post(`${PREFIX}/photos`)
        .set("Authorization", `Bearer ${racePhotosToken}`)
        .field("uploadKeys", `${runId}-race-photo-b`)
        .attach("photos", jpegB, "race-b.jpg"),
    ]);

    // До фикса один из двух получал 500 (P2002 не ловился — Prisma 7 с адаптером
    // не отдаёт meta.target, см. lib/prismaUniqueConflict.ts).
    expect(resA.status).toBe(201);
    expect(resB.status).toBe(201);
    expect(await prisma.propertyDraft.count({ where: { agentId: racePhotosAgentId } })).toBe(1);
    // Разные uploadKeys — оба снимка реально сохранились, ни один не потерялся
    // из-за повторного захода в ensureDraft.
    expect(await prisma.propertyDraftMedia.count({ where: { draft: { agentId: racePhotosAgentId } } })).toBe(2);
  });

  it("upsertOwnDraft: два параллельных PUT на пустой черновик — оба 200, строка одна", async () => {
    const [resA, resB] = await Promise.all([
      request(app)
        .put(PREFIX)
        .set("Authorization", `Bearer ${racePutToken}`)
        .send({ values: { address: "Гонка А" }, step: 0 }),
      request(app)
        .put(PREFIX)
        .set("Authorization", `Bearer ${racePutToken}`)
        .send({ values: { address: "Гонка Б" }, step: 1 }),
    ]);

    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);
    expect(await prisma.propertyDraft.count({ where: { agentId: racePutAgentId } })).toBe(1);
    // Одна и та же строка у обоих ответов — второй upsert (после P2002) обновил
    // ту же запись, а не создал вторую.
    expect(resA.body.draft.id).toBe(resB.body.draft.id);
  });
});

describe("13. Закрытый объект из мастера (23.09.2026)", () => {
  it("только цена, площадь и продавец — создаётся; с фото из черновика сразу в продаже, а не «ждут фото»", async () => {
    const state = await request(app).get(PREFIX).set("Authorization", `Bearer ${token}`);
    const started = await request(app).post(`${PREFIX}/start`).set("Authorization", `Bearer ${token}`).send({ sessionId: randomUUID(), revision: state.body.revision });
    expect(started.status).toBe(200);
    for (let n = 0; n < MIN_PROPERTY_PHOTOS; n++) {
      const up = await request(app).post(`${PREFIX}/photos`).set("Authorization", `Bearer ${token}`).set("X-Property-Draft-Id", started.body.draft.id)
        .field("uploadKeys", `${runId}-photo-offsite-${n}`).attach("photos", await tinyJpeg(9+n), "offsite.jpg");
      expect(up.status).toBe(201);
    }
    const draft = await prisma.propertyDraft.findUniqueOrThrow({ where: { agentId } });
    const res = await request(app)
      .post("/api/v1/properties")
      .set("Authorization", `Bearer ${token}`)
      .send({
        type: "APARTMENT",
        areaSqm: 48,
        price: 350000,
        currency: "TJS",
        condition: "GOOD",
        offSite: true,
        ownerContact: `+992938${runId}`,
        draftId: draft.id,
        draftRevision: draft.revision,
      });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    propertyIds.push(res.body.id);
    const property = await prisma.property.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(await prisma.propertyPhoto.count({ where: { propertyId: property.id } })).toBe(MIN_PROPERTY_PHOTOS);
    expect(property.status).toBe("AVAILABLE");
  });

  it("этаж выше этажности — 400 с полем floor, и при создании, и при правке", async () => {
    const created = await request(app)
      .post("/api/v1/properties")
      .set("Authorization", `Bearer ${token}`)
      .send(propertyBody({ address: `Этаж выше дома, ${runId}`, floor: 5, totalFloors: 2 }));
    expect(created.status).toBe(400);
    expect(created.body.details.fieldErrors.floor).toBeTruthy();

    const ok = await request(app)
      .post("/api/v1/properties")
      .set("Authorization", `Bearer ${token}`)
      .send(propertyBody({ address: `Этаж в порядке, ${runId}`, floor: 2, totalFloors: 2 }));
    expect(ok.status).toBe(201);
    propertyIds.push(ok.body.id);
    const patched = await request(app)
      .patch(`/api/v1/properties/${ok.body.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ floor: 7 });
    expect(patched.status).toBe(400);
    expect(patched.body.details.fieldErrors.floor).toBeTruthy();
  });

  it("новостройка «черновые работы сделаны» сохраняется", async () => {
    const res = await request(app)
      .post("/api/v1/properties")
      .set("Authorization", `Bearer ${token}`)
      .send(
        propertyBody({
          address: `Черновые, ${runId}`,
          marketType: "NEW_BUILD",
          stage: "ROUGH_FINISH",
          condition: "NEW_BUILDING",
        })
      );
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    propertyIds.push(res.body.id);
    expect(res.body.stage).toBe("ROUGH_FINISH");
  });
});
