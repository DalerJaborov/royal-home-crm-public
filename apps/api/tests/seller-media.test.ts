import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { loginWithCode } from "./helpers/loginCode.js";
import sharp from "sharp";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { savePrivateFile, privateFilePath } from "../src/lib/privateFiles.js";
import { localVideoFilePath } from "../src/lib/localVideoStorage.js";
import { uploadsDir } from "../src/upload.js";

/**
 * POST /properties/drafts/from-client/:clientId (routes/properties/drafts.ts,
 * lib/sellerMedia.ts) — «Объект продавца заполняется сам», задание МЕДИА,
 * 21.09.2026.
 *
 * Проверяем ровно контракт агента МЕДИА: копирование вложений продавца из
 * переписки в черновик мастера, идемпотентность повторного вызова, права
 * доступа. Разбор ФАКТОВ (SellerObjectFacts → значения черновика) здесь
 * записывается напрямую в таблицу — своя функция агента ФАКТОВ ещё не готова
 * на момент письма этого файла (см. заглушку getSellerObjectFacts в
 * lib/sellerMedia.ts), но контракт поля тот же, что и у готовой
 * sellerObjectFactsSchema (@royal-home/shared).
 */

const PREFIX = "/api/v1/properties/drafts";
const runId = Date.now();
const password = "testpass123";

let agentId: string;
let token: string;
let otherAgentId: string;
let otherToken: string;

const createdAgentIds: string[] = [];
const createdClientIds: string[] = [];
const createdConversationIds: string[] = [];
const createdPrivateFiles: string[] = [];

function tinyJpeg(shade: number): Promise<Buffer> {
  return sharp({
    create: {
      width: 8,
      height: 8,
      channels: 3,
      background: { r: shade, g: 2, b: 3 },
    },
  })
    .jpeg()
    .toBuffer();
}

async function login(phone: string): Promise<string> {
  const res = await loginWithCode(app, phone);
  expect(res.status).toBe(200);
  return res.body.accessToken as string;
}

async function makeClient(
  kind: "SELLER" | "BUYER",
  opts: { assignedAgentId: string | null; dualIntent?: boolean },
) {
  const client = await prisma.client.create({
    data: {
      fullName: `Продавец переписки ${runId}-${randomUUID().slice(0, 6)}`,
      phone: `+992${String(Date.now()).slice(-9)}`,
      source: "WHATSAPP",
      kind,
      dualIntent: opts.dualIntent ?? false,
      assignedAgentId: opts.assignedAgentId,
      acceptedAt: opts.assignedAgentId ? new Date() : null,
    },
  });
  createdClientIds.push(client.id);
  return client;
}

/** Кладёт «присланное клиентом» фото в закрытое хранилище и заводит диалог с
 *  ним в BotConversation — ровно то, что читает listSellerAttachments. */
async function conversationWithPhotos(
  clientId: string,
  buffers: Buffer[],
  opts?: { role?: "user" | "assistant" },
) {
  const files: string[] = [];
  for (const buf of buffers) {
    const name = await savePrivateFile(buf, "image/jpeg");
    expect(name).toBeTruthy();
    createdPrivateFiles.push(name!);
    files.push(name!);
  }
  const conversation = await prisma.botConversation.create({
    data: {
      channel: "WHATSAPP",
      subscriberId: `seller-media-${runId}-${randomUUID().slice(0, 8)}`,
      clientId,
      messages: files.map((file, i) => ({
        role: opts?.role ?? "user",
        content: `[фото ${i}]`,
        attachments: [{ kind: "image", file, mime: "image/jpeg" }],
        at: new Date(Date.now() + i * 1000).toISOString(),
      })),
      lastMessageAt: new Date(),
    },
  });
  createdConversationIds.push(conversation.id);
  return conversation;
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  const agent = await prisma.agent.create({
    data: {
      fullName: `Агент медиа продавца ${runId}`,
      phone: `+992937${String(runId).slice(-7)}`,
      role: "AGENT",
      passwordHash,
    },
  });
  agentId = agent.id;
  createdAgentIds.push(agentId);
  token = await login(agent.phone);

  const other = await prisma.agent.create({
    data: {
      fullName: `Чужой агент медиа продавца ${runId}`,
      phone: `+992938${String(runId).slice(-7)}`,
      role: "AGENT",
      passwordHash,
    },
  });
  otherAgentId = other.id;
  createdAgentIds.push(otherAgentId);
  otherToken = await login(other.phone);
});

afterAll(async () => {
  await prisma.propertyDraft.deleteMany({
    where: { agentId: { in: [agentId, otherAgentId] } },
  });
  await prisma.botConversation.deleteMany({
    where: { id: { in: createdConversationIds } },
  });
  await prisma.client.deleteMany({ where: { id: { in: createdClientIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: createdAgentIds } } });
  for (const name of createdPrivateFiles) {
    const full = privateFilePath(name);
    if (full) fs.rmSync(full, { force: true });
  }
  await prisma.$disconnect();
});

describe("Права доступа", () => {
  it("покупатель (не продавец, не dualIntent) — 400", async () => {
    const buyer = await makeClient("BUYER", { assignedAgentId: agentId });
    const res = await request(app)
      .post(`${PREFIX}/from-client/${buyer.id}`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(400);
  });

  it("клиент чужого агента — 403", async () => {
    const seller = await makeClient("SELLER", {
      assignedAgentId: otherAgentId,
    });
    const res = await request(app)
      .post(`${PREFIX}/from-client/${seller.id}`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it("несуществующий клиент — 404", async () => {
    const res = await request(app)
      .post(`${PREFIX}/from-client/${randomUUID()}`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
  });

  it("неверный формат id — 400", async () => {
    const res = await request(app)
      .post(`${PREFIX}/from-client/not-a-guid`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(400);
  });

  it("без авторизации — 401", async () => {
    const seller = await makeClient("SELLER", { assignedAgentId: agentId });
    const res = await request(app).post(`${PREFIX}/from-client/${seller.id}`);
    expect(res.status).toBe(401);
  });

  it("dualIntent без kind=SELLER всё равно доступен", async () => {
    const dual = await makeClient("BUYER", {
      assignedAgentId: agentId,
      dualIntent: true,
    });
    const res = await request(app)
      .post(`${PREFIX}/from-client/${dual.id}`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
  });
});

describe("Копирование вложений и фактов", () => {
  // Каждый тест — с чистого черновика. До 02.10.2026 тесты молча опирались на
  // то, что смена продавца сама стирала файлы прошлого теста; теперь сервер
  // без согласия агента их не трогает (D14), и цепочка через общий черновик
  // давала бы 409 там, где тест проверяет совсем другое.
  beforeEach(async () => {
    await prisma.propertyDraft.deleteMany({ where: { agentId } });
  });

  it("фото продавца из переписки копируются в черновик, факты раскладываются по полям", async () => {
    const seller = await makeClient("SELLER", { assignedAgentId: agentId });
    await prisma.sellerObjectFacts.create({
      data: {
        clientId: seller.id,
        facts: {
          type: "APARTMENT",
          rooms: 3,
          areaSqm: 72.5,
          landAreaSotka: null,
          floor: 4,
          totalFloors: 9,
          windowCount: 5,
          price: 550000,
          currency: "TJS",
          condition: "GOOD",
          marketType: "SECONDARY",
          documents: "Договор купли-продажи",
          districtId: null,
          address: "82 мкр., дом 14",
          lat: 38.5,
          lng: 68.7,
          description: "Тёплая квартира, соседи тихие",
        },
        // getSellerObjectFacts (lib/sellerFacts.ts) читает факты только когда
        // factsUpdatedAt проставлен — им отличают «разбор ещё не было» от
        // «разбор был» и (при наличии объекта) сравнивают с датой создания
        // последнего объекта продавца, чтобы не подставить старые факты в
        // следующую квартиру того же продавца.
        factsUpdatedAt: new Date(),
      },
    });

    const [jpegA, jpegB] = await Promise.all([tinyJpeg(10), tinyJpeg(50)]);
    await conversationWithPhotos(seller.id, [jpegA, jpegB]);
    // Реплика бота с вложением (наше фото объекта) — не должна попасть в черновик.
    await conversationWithPhotos(seller.id, [await tinyJpeg(90)], {
      role: "assistant",
    });

    const res = await request(app)
      .post(`${PREFIX}/from-client/${seller.id}`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);

    const { draft } = res.body;
    expect(draft.values.sellerClientId).toBe(seller.id);
    expect(draft.values.type).toBe("APARTMENT");
    expect(draft.values.rooms).toBe("3");
    expect(draft.values.areaSqm).toBe("72.5");
    expect(draft.values.floor).toBe("4");
    expect(draft.values.price).toBe("550000");
    expect(draft.values.currency).toBe("TJS");
    expect(draft.values.condition).toBe("GOOD");
    expect(draft.values.address).toBe("82 мкр., дом 14");
    expect(draft.values.lat).toBe(38.5);
    expect(draft.values.documentsPreset).toBe("Другое");
    expect(draft.values.documentsOther).toBe("Договор купли-продажи");

    // Только 2 фото — реплика от assistant (bot) не в счёт.
    expect(draft.media).toHaveLength(2);
    for (const m of draft.media) {
      expect(m.kind).toBe("PHOTO");
      expect(m.status).toBe("READY");
      expect(m.url).toMatch(/^\/uploads\/[0-9a-f-]{36}\.webp$/);
    }
  });

  it("повторный вызов на том же продавце не плодит копии (идемпотентность по sha256)", async () => {
    const seller = await makeClient("SELLER", { assignedAgentId: agentId });
    const jpeg = await tinyJpeg(120);
    await conversationWithPhotos(seller.id, [jpeg]);

    const first = await request(app)
      .post(`${PREFIX}/from-client/${seller.id}`)
      .set("Authorization", `Bearer ${token}`);
    expect(first.status).toBe(200);
    expect(first.body.draft.media).toHaveLength(1);
    const firstUploadKey = first.body.draft.media[0].uploadKey;

    const second = await request(app)
      .post(`${PREFIX}/from-client/${seller.id}`)
      .set("Authorization", `Bearer ${token}`);
    expect(second.status).toBe(200);
    expect(second.body.draft.media).toHaveLength(1);
    expect(second.body.draft.media[0].uploadKey).toBe(firstUploadKey);
  });

  it("одна и та же картинка, присланная дважды в переписке, копируется один раз", async () => {
    const seller = await makeClient("SELLER", { assignedAgentId: agentId });
    const jpeg = await tinyJpeg(200);
    // Одинаковое содержимое под двумя разными именами в хранилище — как если бы
    // клиент переслал одно и то же фото два раза.
    await conversationWithPhotos(seller.id, [jpeg, Buffer.from(jpeg)]);

    const res = await request(app)
      .post(`${PREFIX}/from-client/${seller.id}`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.draft.media).toHaveLength(1);
  });

  /**
   * D14 (решение владельца 02.10.2026, «да, по советам»): смена продавца больше
   * не стирает файлы молча — сервер спрашивает (409), и только ответ «Заменить»
   * удаляет старое. Раньше этот тест ждал перезаписи без вопроса.
   */
  it("смена продавца: без ответа агента — 409 и файлы на месте; «Заменить» — старые удаляются, остаются только новые", async () => {
    const sellerA = await makeClient("SELLER", { assignedAgentId: agentId });
    const sellerB = await makeClient("SELLER", { assignedAgentId: agentId });
    await conversationWithPhotos(sellerA.id, [await tinyJpeg(5)]);
    await conversationWithPhotos(sellerB.id, [
      await tinyJpeg(6),
      await tinyJpeg(7),
    ]);

    const first = await request(app)
      .post(`${PREFIX}/from-client/${sellerA.id}`)
      .set("Authorization", `Bearer ${token}`);
    expect(first.status).toBe(200);
    expect(first.body.draft.values.sellerClientId).toBe(sellerA.id);
    expect(first.body.draft.media).toHaveLength(1);
    const oldPhotoUrl = first.body.draft.media[0].url as string;
    const oldPhotoOnDisk = path.join(uploadsDir, path.basename(oldPhotoUrl));

    const asked = await request(app)
      .post(`${PREFIX}/from-client/${sellerB.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ mode: "merge" });
    expect(asked.status).toBe(409);
    expect(asked.body.code).toBe("DRAFT_MEDIA_REPLACE_CONFIRM");
    expect(asked.body.draftPhotoCount).toBe(1);
    expect(fs.existsSync(oldPhotoOnDisk)).toBe(true);
    const untouched = await prisma.propertyDraft.findFirstOrThrow({ where: { agentId }, include: { media: true } });
    expect(untouched.media).toHaveLength(1);
    expect((untouched.values as { sellerClientId?: string }).sellerClientId).toBe(sellerA.id);

    const second = await request(app)
      .post(`${PREFIX}/from-client/${sellerB.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ mode: "replace", media: "replace" });
    expect(second.status).toBe(200);
    expect(second.body.draft.values.sellerClientId).toBe(sellerB.id);
    expect(second.body.draft.media).toHaveLength(2);
    // Старый файл продавца A убран с диска вместе со строкой — не остаётся мусором.
    expect(fs.existsSync(oldPhotoOnDisk)).toBe(false);
  });

  it("черновик набран руками, фото агента: без ответа — 409; «Оставить» — фото агента на месте, фото из переписки не подмешаны", async () => {
    const seller = await makeClient("SELLER", { assignedAgentId: agentId });
    await conversationWithPhotos(seller.id, [await tinyJpeg(40), await tinyJpeg(41)]);

    // Агент открыл мастер без продавца и снял два фото сам.
    const upload = await request(app)
      .post(`${PREFIX}/current/photos`)
      .set("Authorization", `Bearer ${token}`)
      .attach("photos", await tinyJpeg(30), "a.jpg")
      .attach("photos", await tinyJpeg(31), "b.jpg");
    expect(upload.status).toBeLessThan(300);
    const own = await prisma.propertyDraftMedia.findMany({ where: { draft: { agentId } } });
    expect(own).toHaveLength(2);

    const asked = await request(app)
      .post(`${PREFIX}/from-client/${seller.id}`)
      .set("Authorization", `Bearer ${token}`);
    expect(asked.status).toBe(409);
    expect(asked.body.code).toBe("DRAFT_MEDIA_REPLACE_CONFIRM");
    expect(asked.body.draftPhotoCount).toBe(2);
    // Ничего не смешалось и не пропало, пока агент не ответил.
    expect(await prisma.propertyDraftMedia.count({ where: { draft: { agentId } } })).toBe(2);

    const kept = await request(app)
      .post(`${PREFIX}/from-client/${seller.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ media: "keep" });
    expect(kept.status).toBe(200);
    expect(kept.body.draft.values.sellerClientId).toBe(seller.id);
    const ids = (kept.body.draft.media as { id: string }[]).map((m) => m.id).sort();
    expect(ids).toEqual(own.map((m) => m.id).sort());
    for (const m of own) {
      expect(fs.existsSync(path.join(uploadsDir, path.basename(m.url)))).toBe(true);
    }
  });

  it("черновик набран руками, фото агента: «Заменить» — остаются только фото из переписки", async () => {
    const seller = await makeClient("SELLER", { assignedAgentId: agentId });
    await conversationWithPhotos(seller.id, [await tinyJpeg(50), await tinyJpeg(51), await tinyJpeg(52)]);
    const upload = await request(app)
      .post(`${PREFIX}/current/photos`)
      .set("Authorization", `Bearer ${token}`)
      .attach("photos", await tinyJpeg(32), "c.jpg");
    expect(upload.status).toBeLessThan(300);

    const replaced = await request(app)
      .post(`${PREFIX}/from-client/${seller.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ media: "replace" });
    expect(replaced.status).toBe(200);
    expect(replaced.body.draft.media).toHaveLength(3);
  });

  it("в переписке файлов нет — фото агента остаются без вопроса", async () => {
    const seller = await makeClient("SELLER", { assignedAgentId: agentId });
    const upload = await request(app)
      .post(`${PREFIX}/current/photos`)
      .set("Authorization", `Bearer ${token}`)
      .attach("photos", await tinyJpeg(33), "d.jpg");
    expect(upload.status).toBeLessThan(300);

    const res = await request(app)
      .post(`${PREFIX}/from-client/${seller.id}`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.draft.media).toHaveLength(1);
  });

  it("видео продавца копируется в закрытое хранилище черновика тем же ключом, что у мастера", async () => {
    const seller = await makeClient("SELLER", { assignedAgentId: agentId });
    // savePrivateFile сегодня не регистрирует video/* в EXT_BY_MIME (см. отчёт
    // агента МЕДИА) — файл кладём на диск напрямую тем же способом, каким его
    // положил бы починенный конвейер вложений, чтобы проверить именно КОПИРОВАНИЕ
    // видео в черновик, а не отдельный, уже найденный баг сохранения.
    const anchor = (await savePrivateFile(Buffer.from("anchor"), "image/jpeg"))!;
    createdPrivateFiles.push(anchor);
    const videoDir = path.dirname(privateFilePath(anchor)!);
    const videoName = `${randomUUID()}.mp4`;
    const videoBytes = Buffer.from(`видео обхода квартиры ${runId}`);
    fs.writeFileSync(path.join(videoDir, videoName), videoBytes);
    createdPrivateFiles.push(videoName);

    const conversation = await prisma.botConversation.create({
      data: {
        channel: "WHATSAPP",
        subscriberId: `seller-media-video-${runId}`,
        clientId: seller.id,
        messages: [
          {
            role: "user",
            content: "[видео]",
            attachments: [
              { kind: "video", file: videoName, mime: "video/mp4" },
            ],
            at: new Date().toISOString(),
          },
        ],
        lastMessageAt: new Date(),
      },
    });
    createdConversationIds.push(conversation.id);

    const res = await request(app)
      .post(`${PREFIX}/from-client/${seller.id}`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.draft.media).toHaveLength(1);
    const media = res.body.draft.media[0];
    expect(media.kind).toBe("VIDEO");
    expect(media.status).toBe("READY");

    const draftRow = await prisma.propertyDraft.findUnique({
      where: { agentId },
    });
    const storedMedia = await prisma.propertyDraftMedia.findUnique({
      where: { id: media.id },
    });
    expect(storedMedia?.storageKey).toMatch(
      new RegExp(`^${draftRow!.id}/[0-9a-f-]{36}\\.mp4$`),
    );
    const onDisk = localVideoFilePath(storedMedia!.storageKey!);
    expect(onDisk && fs.readFileSync(onDisk).equals(videoBytes)).toBe(true);
  });
});

describe("Поля карточки продавца (23.09.2026)", () => {
  beforeEach(async () => {
    // Each case imports a different seller into an explicitly empty fixture.
    await prisma.propertyDraft.deleteMany({ where: { agentId } });
  });
  it("продавец, заведённый руками, без переписки — мастер открывается с полями карточки", async () => {
    const seller = await makeClient("SELLER", { assignedAgentId: agentId });
    await prisma.client.update({
      where: { id: seller.id },
      data: {
        desiredType: "APARTMENT",
        desiredRooms: 2,
        desiredAreaMin: 60,
        desiredFloorMin: 3,
        desiredTotalFloors: 9,
        budgetMin: 400000,
        budgetMax: 450000,
        currency: "USD",
        address: "Сино, ул. Айни 5",
      },
    });
    const res = await request(app)
      .post(`${PREFIX}/from-client/${seller.id}`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    const v = res.body.draft.values;
    expect(v.sellerClientId).toBe(seller.id);
    expect(v.type).toBe("APARTMENT");
    expect(v.rooms).toBe("2");
    expect(v.areaSqm).toBe("60");
    expect(v.floor).toBe("3");
    expect(v.totalFloors).toBe("9");
    expect(v.price).toBe("450000");
    expect(v.currency).toBe("USD");
    expect(v.address).toBe("Сино, ул. Айни 5");
  });

  it("переписка точнее карточки: факты из чата перекрывают поля карточки", async () => {
    const seller = await makeClient("SELLER", { assignedAgentId: agentId });
    await prisma.client.update({
      where: { id: seller.id },
      data: { desiredRooms: 2, address: "из карточки" },
    });
    await prisma.sellerObjectFacts.create({
      data: {
        clientId: seller.id,
        facts: {
          type: null,
          rooms: 3,
          areaSqm: null,
          landAreaSotka: null,
          floor: null,
          totalFloors: null,
          windowCount: null,
          price: null,
          currency: null,
          condition: null,
          marketType: null,
          documents: null,
          districtId: null,
          address: "из переписки",
          lat: null,
          lng: null,
          description: null,
        },
        factsUpdatedAt: new Date(),
      },
    });
    const res = await request(app)
      .post(`${PREFIX}/from-client/${seller.id}`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.draft.values.rooms).toBe("3");
    expect(res.body.draft.values.address).toBe("из переписки");
  });
});
