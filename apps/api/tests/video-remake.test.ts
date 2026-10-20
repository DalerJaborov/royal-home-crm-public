import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import pathMod from "node:path";

/**
 * С 07.10.2026 «Вернуть монтажёру» у опубликованного объекта делает руководство
 * (properties.editForeign — здесь роль MARKETING), агенту-владельцу — 403;
 * поэтому основной вызывающий в тестах ниже — marketingToken.
 *
 * ВОЗВРАТ РОЛИКА МОНТАЖЁРУ С ПРИЧИНОЙ (20.09.2026, решение владельца: «чтобы
 * просто так не ходил, а причину чтобы я указал, зачем, чтобы он тоже
 * прочитал»). Контракт: POST /api/v1/properties/:id/send-back-to-montajer,
 * GET .../montajer-preview, GET .../montajer-messages.
 *
 * Telegram (sendMessage/sendDocumentFile) и пуш подменены — тест никуда не ходит.
 */

const { sendMessage, sendDocumentFile, sendPushToAgent } = vi.hoisted(() => ({
  sendMessage: vi.fn(async () => {}),
  sendDocumentFile: vi.fn(async () => {}),
  sendPushToAgent: vi.fn(async () => {}),
}));

vi.mock("../src/telegram/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/telegram/api.js")>()),
  sendMessage,
  sendDocumentFile,
}));
vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent,
}));

const { prisma } = await import("../src/db.js");
const { app } = await import("../src/app.js");
const { isVideoRemakeEditorFault } = await import("@royal-home/shared");
const { localVideoFilePath } = await import("../src/lib/localVideoStorage.js");

const runId = Date.now();
const password = "testpass123";

let districtId = "";
let montajerId = "";
let agentToken = "";
let agentId = "";
let marketingToken = "";
let marketingId = "";
const propertyIds: string[] = [];
const clientIds: string[] = [];
const rawVideoDirs = new Set<string>();

async function login(phone: string): Promise<string> {
  const res = await request(app).post("/api/v1/auth/login").send({ phone, password });
  expect(res.status).toBe(200);
  return res.body.accessToken;
}

/**
 * «Вернуть монтажёру» (п.3 задания send-back-api-24-09.md, 24.09.2026) имеет
 * смысл только для объекта, который у монтажёра УЖЕ был: по умолчанию сеем
 * готовый ролик (videoHandoffFinalPath), как после реального первого круга.
 * withPublishedChannels — второй, равнозначный по правилу способ показать
 * «был у монтажёра» (см. published-video-fix.test.ts::seedPublished).
 */
async function seedProperty(withSellerClient = true, overrides: Record<string, unknown> = {}) {
  let sellerClientId: string | null = null;
  if (withSellerClient) {
    const client = await prisma.client.create({
      data: {
        fullName: `Продавец перемонтажа ${runId}-${propertyIds.length}`,
        phone: `+992977${runId}${propertyIds.length}`,
        source: "PHONE_CALL",
        kind: "SELLER",
      },
    });
    clientIds.push(client.id);
    sellerClientId = client.id;
  }
  const property = await prisma.property.create({
    data: {
      title: `Перемонтаж ${runId}-${propertyIds.length}`,
      type: "APARTMENT",
      rooms: 2,
      areaSqm: 50,
      floor: 3,
      price: 400000,
      currency: "TJS",
      districtId,
      address: "Перемонтажная, 5",
      condition: "GOOD",
      sellerClientId,
      createdById: agentId,
      videoHandoffFinalPath: "/uploads/video-handoff/test-final.mp4",
      ...overrides,
    } as never,
  });
  propertyIds.push(property.id);
  return property;
}

/** Файл реально пишется на диск — dispatchToEditor читает его stat/содержимое
 *  перед отправкой, без файла ветка «не отправляем» молча гасит sendDocumentFile
 *  (см. addRawVideoFile в video-handoff.test.ts, тот же приём). */
async function addRawVideo(propertyId: string) {
  const storageKey = `${propertyId}/${randomUUID()}.mp4`;
  const filePath = localVideoFilePath(storageKey);
  if (!filePath) throw new Error(`не разрешился путь хранилища для ${storageKey}`);
  await fs.mkdir(pathMod.dirname(filePath), { recursive: true });
  const handle = await fs.open(filePath, "w");
  await handle.truncate(1024);
  await handle.close();
  rawVideoDirs.add(pathMod.dirname(filePath));
  return prisma.propertyVideo.create({
    data: { propertyId, storageKey, filename: "obhod.mp4", sizeBytes: 1024, uploadedById: agentId },
  });
}

beforeEach(async () => {
  sendMessage.mockClear();
  sendDocumentFile.mockClear();
  sendPushToAgent.mockClear();
  if (propertyIds.length) {
    await prisma.property.updateMany({
      where: { id: { in: propertyIds } },
      data: { videoHandoffStatus: "NONE", videoHandoffSentAt: null },
    });
  }
});

async function setup() {
  districtId = (await prisma.district.create({ data: { name: `Перемонтаж ${runId}` } })).id;
  const passwordHash = await bcrypt.hash(password, 10);
  const [montajer, agent, marketing] = await Promise.all([
    prisma.agent.create({
      data: { fullName: `Монтажёр перемонтажа ${runId}`, phone: `+992966${runId}`, role: "AGENT", passwordHash, telegramChatId: `chat-${runId}` },
    }),
    prisma.agent.create({
      data: { fullName: `Агент перемонтажа ${runId}`, phone: `+992967${runId}`, role: "AGENT", passwordHash },
    }),
    // Роль для removeFromSocial:true (п.4 задания 24.09.2026) — то же право,
    // что у кнопки «Убрать из соцсетей» (requireMarketingRole).
    prisma.agent.create({
      data: { fullName: `Маркетинг перемонтажа ${runId}`, phone: `+992968${runId}`, role: "MARKETING", passwordHash },
    }),
  ]);
  montajerId = montajer.id;
  agentId = agent.id;
  marketingId = marketing.id;
  agentToken = await login(agent.phone);
  marketingToken = await login(marketing.phone);
  await prisma.settings.upsert({
    where: { id: "singleton" },
    update: { videoHandoffEnabled: true, videoMontajerAgentId: montajerId },
    create: { id: "singleton", videoHandoffEnabled: true, videoMontajerAgentId: montajerId },
  });
}

beforeAll(setup);

afterAll(async () => {
  for (const dir of rawVideoDirs) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  await prisma.montajerMessage.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.videoRemakeRequest.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.propertyVideo.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: [montajerId, agentId, marketingId] } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.$disconnect();
});

describe("Причина возврата — обязательна (валидация на границе)", () => {
  it("без reason — 400", async () => {
    const property = await seedProperty(false);
    await addRawVideo(property.id);

    const res = await request(app)
      .post(`/api/v1/properties/${property.id}/send-back-to-montajer`)
      .set("Authorization", `Bearer ${marketingToken}`)
      .send({});

    expect(res.status).toBe(400);
  });

  it("reason=OTHER без комментария — 400", async () => {
    const property = await seedProperty(false);
    await addRawVideo(property.id);

    const res = await request(app)
      .post(`/api/v1/properties/${property.id}/send-back-to-montajer`)
      .set("Authorization", `Bearer ${marketingToken}`)
      .send({ reason: "OTHER" });

    expect(res.status).toBe(400);
  });

  it("reason=WRONG_CAPTION без комментария — 400", async () => {
    const property = await seedProperty(false);
    await addRawVideo(property.id);

    const res = await request(app)
      .post(`/api/v1/properties/${property.id}/send-back-to-montajer`)
      .set("Authorization", `Bearer ${marketingToken}`)
      .send({ reason: "WRONG_CAPTION" });

    expect(res.status).toBe(400);
  });

  it("неизвестная причина — 400, а не молчаливый возврат", async () => {
    const property = await seedProperty(false);
    await addRawVideo(property.id);

    const res = await request(app)
      .post(`/api/v1/properties/${property.id}/send-back-to-montajer`)
      .set("Authorization", `Bearer ${marketingToken}`)
      .send({ reason: "SOMETHING_ELSE" });

    expect(res.status).toBe(400);
  });

  it("reason, не требующий комментария (POOR_EDIT) — проходит без него", async () => {
    const property = await seedProperty(false);
    await addRawVideo(property.id);

    const res = await request(app)
      .post(`/api/v1/properties/${property.id}/send-back-to-montajer`)
      .set("Authorization", `Bearer ${marketingToken}`)
      .send({ reason: "POOR_EDIT" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true });
    // Ответ — короткой строкой, без перечисления каналов/файлов (владелец 20.09.2026).
    expect(typeof res.body.message).toBe("string");
    expect(res.body.message.length).toBeGreaterThan(0);
  });
});

describe("Успешный возврат: заявка, счётчик, хроника", () => {
  it("пишет VideoRemakeRequest, поднимает videoRemakeCount и кладёт запись в хронику объекта", async () => {
    const property = await seedProperty(true);
    await addRawVideo(property.id);

    const res = await request(app)
      .post(`/api/v1/properties/${property.id}/send-back-to-montajer`)
      .set("Authorization", `Bearer ${marketingToken}`)
      .send({ reason: "NO_MUSIC" });

    expect(res.status).toBe(200);

    const remakeRequest = await prisma.videoRemakeRequest.findFirst({ where: { propertyId: property.id } });
    expect(remakeRequest?.reason).toBe("NO_MUSIC");
    expect(remakeRequest?.requestedById).toBe(marketingId);
    expect(remakeRequest?.messageText).toContain("ПЕРЕМОНТАЖ");

    const after = await prisma.property.findUniqueOrThrow({ where: { id: property.id } });
    expect(after.videoRemakeCount).toBe(1);
    // Поля карточки не трогаются — вся суть механизма.
    expect(after.rooms).toBe(2);
    expect(after.address).toBe("Перемонтажная, 5");

    const timelineEntry = await prisma.interaction.findFirst({
      where: { propertyId: property.id, type: "STATUS_CHANGE" },
      orderBy: { createdAt: "desc" },
    });
    expect(timelineEntry).toBeTruthy();
    expect(timelineEntry?.notes).toContain("Нет музыки или не тот звук");
    expect(timelineEntry?.actorKind).toBe("AGENT");
    expect(timelineEntry?.agentId).toBe(marketingId);
  });

  it("videoRemakeCount растёт даже на CARD_DATA_CHANGED, но это не брак монтажёра", async () => {
    const property = await seedProperty(false);
    await addRawVideo(property.id);

    expect(isVideoRemakeEditorFault("CARD_DATA_CHANGED")).toBe(false);
    expect(isVideoRemakeEditorFault("POOR_EDIT")).toBe(true);

    const res = await request(app)
      .post(`/api/v1/properties/${property.id}/send-back-to-montajer`)
      .set("Authorization", `Bearer ${marketingToken}`)
      .send({ reason: "CARD_DATA_CHANGED" });

    expect(res.status).toBe(200);
    const after = await prisma.property.findUniqueOrThrow({ where: { id: property.id } });
    expect(after.videoRemakeCount).toBe(1);
  });
});

describe("Текст монтажёру: причина словами, минимум лишнего", () => {
  it("подпись первого файла содержит пометку перемонтажа, причину и комментарий, без служебных строк обычной передачи", async () => {
    const property = await seedProperty(false);
    await addRawVideo(property.id);

    const res = await request(app)
      .post(`/api/v1/properties/${property.id}/send-back-to-montajer`)
      .set("Authorization", `Bearer ${marketingToken}`)
      .send({ reason: "WRONG_CAPTION", comment: "Написано «3 комнаты», а на самом деле 2" });

    expect(res.status).toBe(200);
    expect(sendDocumentFile).toHaveBeenCalledTimes(1);
    const caption = String(sendDocumentFile.mock.calls[0]?.[3] ?? "");

    expect(caption).toContain("🔁 ПЕРЕМОНТАЖ");
    expect(caption).toContain(`объект №${property.shortId}`);
    expect(caption).toContain("Надпись на видео неверная");
    expect(caption).toContain("Написано «3 комнаты», а на самом деле 2");
    expect(caption).toContain("Площадь: 50");
    // Строго минимум (владелец 20.09.2026) — служебные строки обычной передачи
    // в перемонтаж не попадают.
    expect(caption).not.toContain("Своя обложка");
    expect(caption).not.toContain("заход");
  });

  it("обычная (не перемонтажная) передача, наоборот, не несёт пометки перемонтажа — карточка только факты плюс очередь", async () => {
    // Строку правил передачи убрали из карточки целиком 21.09.2026 (владелец:
    // «лишнюю информацию удали из карточки телеграма монтажёру») — эта проверка
    // раньше сверялась по HANDOFF_RULES_LINE, теперь бьёт по тому, что реально
    // осталось в тексте обычной передачи.
    const { queueVideoHandoff } = await import("../src/lib/videoHandoff.js");
    const property = await seedProperty(false);
    await addRawVideo(property.id);

    await queueVideoHandoff(property.id);

    const caption = String(sendDocumentFile.mock.calls[0]?.[3] ?? "");
    expect(caption).not.toContain("🔁 ПЕРЕМОНТАЖ");
    expect(caption).not.toContain("Своя обложка");
    expect(caption).toContain(`Объект №${property.shortId}`);
  });
});

describe("Превью текста — тот же builder, что и реальная отправка", () => {
  it("GET montajer-preview возвращает ровно тот текст, что сохранён в VideoRemakeRequest.messageText", async () => {
    const property = await seedProperty(false);
    await addRawVideo(property.id);

    const previewRes = await request(app)
      .get(`/api/v1/properties/${property.id}/montajer-preview`)
      .query({ reason: "WRONG_OBJECT" })
      .set("Authorization", `Bearer ${marketingToken}`);
    expect(previewRes.status).toBe(200);
    expect(typeof previewRes.body.text).toBe("string");
    expect(previewRes.body.text).toContain("На видео не тот объект");

    const sendRes = await request(app)
      .post(`/api/v1/properties/${property.id}/send-back-to-montajer`)
      .set("Authorization", `Bearer ${marketingToken}`)
      .send({ reason: "WRONG_OBJECT" });
    expect(sendRes.status).toBe(200);

    const remakeRequest = await prisma.videoRemakeRequest.findFirst({ where: { propertyId: property.id } });
    expect(remakeRequest?.messageText).toBe(previewRes.body.text);
  });
});

describe("Рубильник монтажёра — обе проверки ДО записи (24.09.2026, п.1 задания send-back-api-24-09.md)", () => {
  it("монтажёр не назначен в Настройках — 409, транзакция не выполнена", async () => {
    const property = await seedProperty(false);
    await addRawVideo(property.id);
    await prisma.settings.update({ where: { id: "singleton" }, data: { videoMontajerAgentId: null } });

    try {
      const res = await request(app)
        .post(`/api/v1/properties/${property.id}/send-back-to-montajer`)
        .set("Authorization", `Bearer ${marketingToken}`)
        .send({ reason: "POOR_EDIT" });

      expect(res.status).toBe(409);
      expect(res.body.error).toContain("Монтажёр не назначен");

      const after = await prisma.property.findUniqueOrThrow({ where: { id: property.id } });
      expect(after.videoRemakeCount).toBe(0);
      expect(after.videoHandoffStatus).toBe("NONE");
      const remakeRequest = await prisma.videoRemakeRequest.findFirst({ where: { propertyId: property.id } });
      expect(remakeRequest).toBeNull();
      const videosLeft = await prisma.propertyVideo.count({ where: { propertyId: property.id } });
      expect(videosLeft).toBe(1);
    } finally {
      await prisma.settings.update({ where: { id: "singleton" }, data: { videoMontajerAgentId: montajerId } });
    }
  });

  it("передача монтажёру выключена в Настройках — 409, транзакция не выполнена", async () => {
    const property = await seedProperty(false);
    await addRawVideo(property.id);
    await prisma.settings.update({ where: { id: "singleton" }, data: { videoHandoffEnabled: false } });

    try {
      const res = await request(app)
        .post(`/api/v1/properties/${property.id}/send-back-to-montajer`)
        .set("Authorization", `Bearer ${marketingToken}`)
        .send({ reason: "POOR_EDIT" });

      expect(res.status).toBe(409);
      expect(res.body.error).toContain("выключена в Настройках");

      const after = await prisma.property.findUniqueOrThrow({ where: { id: property.id } });
      expect(after.videoRemakeCount).toBe(0);
      const remakeRequest = await prisma.videoRemakeRequest.findFirst({ where: { propertyId: property.id } });
      expect(remakeRequest).toBeNull();
    } finally {
      await prisma.settings.update({ where: { id: "singleton" }, data: { videoHandoffEnabled: true } });
    }
  });
});

/**
 * ЗАДАНИЕ F (24.09.2026, аудит «монтажёр ↔ CRM ↔ соцсети»): раньше функция
 * смотрела только на videoHandoffStatus — проданный или снятый с продажи
 * объект можно было отправить на перемонтаж как живой.
 */
describe("Мёртвый статус объекта — 409 (задание F, 24.09.2026)", () => {
  it("объект продан — 409, а не тихая отправка на перемонтаж", async () => {
    const property = await seedProperty(false, { status: "SOLD" });
    await addRawVideo(property.id);

    const res = await request(app)
      .post(`/api/v1/properties/${property.id}/send-back-to-montajer`)
      .set("Authorization", `Bearer ${marketingToken}`)
      .send({ reason: "POOR_EDIT" });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("продан");
    const after = await prisma.property.findUniqueOrThrow({ where: { id: property.id } });
    expect(after.videoRemakeCount).toBe(0);
  });

  it("объект снят с продажи — тот же отказ", async () => {
    const property = await seedProperty(false, { status: "WITHDRAWN" });
    await addRawVideo(property.id);

    const res = await request(app)
      .post(`/api/v1/properties/${property.id}/send-back-to-montajer`)
      .set("Authorization", `Bearer ${marketingToken}`)
      .send({ reason: "POOR_EDIT" });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("снят с продажи");
  });
});

describe("Гонка двойного клика — withPropertyLock (24.09.2026, п.2 задания)", () => {
  it("два параллельных запроса создают ровно одну VideoRemakeRequest", async () => {
    const property = await seedProperty(false);
    await addRawVideo(property.id);

    const [res1, res2] = await Promise.all([
      request(app)
        .post(`/api/v1/properties/${property.id}/send-back-to-montajer`)
        .set("Authorization", `Bearer ${marketingToken}`)
        .send({ reason: "POOR_EDIT" }),
      request(app)
        .post(`/api/v1/properties/${property.id}/send-back-to-montajer`)
        .set("Authorization", `Bearer ${marketingToken}`)
        .send({ reason: "POOR_EDIT" }),
    ]);

    const statuses = [res1.status, res2.status].sort((a, b) => a - b);
    expect(statuses).toEqual([200, 409]);
    const loser = res1.status === 409 ? res1 : res2;
    expect(loser.body.error).toContain("уже у монтажёра или стоит в очереди");

    const requests = await prisma.videoRemakeRequest.findMany({ where: { propertyId: property.id } });
    expect(requests.length).toBe(1);
    const after = await prisma.property.findUniqueOrThrow({ where: { id: property.id } });
    expect(after.videoRemakeCount).toBe(1);
  });
});

describe("Возврат бессмыслен для объекта, который не был у монтажёра (24.09.2026, п.3 задания)", () => {
  it("объект ещё в конвейере, нет videoHandoffFinalPath и нет публикаций — 409", async () => {
    const property = await seedProperty(false, { videoHandoffFinalPath: null, publishedChannels: [], status: "AWAITING_VIDEO" });
    await addRawVideo(property.id);

    const res = await request(app)
      .post(`/api/v1/properties/${property.id}/send-back-to-montajer`)
      .set("Authorization", `Bearer ${marketingToken}`)
      .send({ reason: "POOR_EDIT" });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("не был у монтажёра");
    const after = await prisma.property.findUniqueOrThrow({ where: { id: property.id } });
    expect(after.videoRemakeCount).toBe(0);
  });

  it("старый объект: сетей нет, готового ролика нет, но вписана ссылка t.me — проходит (ОБ-000082)", async () => {
    const property = await seedProperty(false, {
      videoHandoffFinalPath: null,
      publishedChannels: [],
      instagramUrl: "https://t.me/royalhome_tj/123",
    });
    await addRawVideo(property.id);

    const res = await request(app)
      .post(`/api/v1/properties/${property.id}/send-back-to-montajer`)
      .set("Authorization", `Bearer ${marketingToken}`)
      .send({ reason: "POOR_EDIT" });

    expect(res.status).toBe(200);
    // Сеть за такой ссылкой не выдумываем: отметка TELEGRAM заставила бы публикацию
    // пропустить Telegram, а снять тот пост нечем.
    const after = await prisma.property.findUniqueOrThrow({ where: { id: property.id } });
    expect(after.publishedChannels).toEqual([]);
  });

  it("пустая или пробельная ссылка следом не считается (объект ещё в конвейере) — 409", async () => {
    const property = await seedProperty(false, { videoHandoffFinalPath: null, publishedChannels: [], instagramUrl: "   ", status: "AWAITING_VIDEO" });
    await addRawVideo(property.id);

    const res = await request(app)
      .post(`/api/v1/properties/${property.id}/send-back-to-montajer`)
      .set("Authorization", `Bearer ${marketingToken}`)
      .send({ reason: "POOR_EDIT" });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("не был у монтажёра");
  });

  it("старый объект в продаже: ни сетей, ни ссылки, ни готового ролика — проходит (ОБ-000082, решение владельца 07.10.2026)", async () => {
    for (const status of ["AVAILABLE", "RESERVED"]) {
      const property = await seedProperty(false, { videoHandoffFinalPath: null, publishedChannels: [], instagramUrl: null, status });
      await addRawVideo(property.id);

      const res = await request(app)
        .post(`/api/v1/properties/${property.id}/send-back-to-montajer`)
        .set("Authorization", `Bearer ${marketingToken}`)
        .send({ reason: "POOR_EDIT" });

      expect(res.status, status).toBe(200);
    }
  });

  it("нет videoHandoffFinalPath, но есть публикация в publishedChannels — проходит", async () => {
    const property = await seedProperty(false, { videoHandoffFinalPath: null, publishedChannels: ["TELEGRAM"] });
    await addRawVideo(property.id);

    const res = await request(app)
      .post(`/api/v1/properties/${property.id}/send-back-to-montajer`)
      .set("Authorization", `Bearer ${marketingToken}`)
      .send({ reason: "POOR_EDIT" });

    expect(res.status).toBe(200);
  });
});

describe("removeFromSocial: true — снять из соцсетей перед возвратом (24.09.2026, п.4 задания)", () => {
  it("без права (роль AGENT) — 403, объект монтажёру не уходит", async () => {
    const property = await seedProperty(false, { publishedChannels: ["TELEGRAM"] });
    await addRawVideo(property.id);

    const res = await request(app)
      .post(`/api/v1/properties/${property.id}/send-back-to-montajer`)
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ reason: "POOR_EDIT", removeFromSocial: true });

    expect(res.status).toBe(403);
    // Объект в продаже (опубликован): агенту-владельцу «Вернуть монтажёру» закрыт целиком
    // (07.10.2026) — отказ раньше проверки removeFromSocial, текст про директора и админа.
    expect(res.body.error).toBe("Это делает директор или админ. Нажмите «Запросить изменение».");
    const after = await prisma.property.findUniqueOrThrow({ where: { id: property.id } });
    expect(after.videoRemakeCount).toBe(0);
    expect(["QUEUED", "SENT_TO_EDITOR"]).not.toContain(after.videoHandoffStatus);
  });

  it("с правом (роль MARKETING) — снятие вызвано, итог в ответе, объект всё равно уходит монтажёру", async () => {
    // TELEGRAM в publishedChannels без сохранённого id в publishedPostIds —
    // removeFromSocial честно кладёт канал в failed («снять нечем»), без
    // единого сетевого похода (та же ветка, что published-video-fix.test.ts
    // проверяет для removeFromSocial напрямую) — здесь важен факт вызова и
    // форма ответа, не конкретный исход канала.
    const property = await seedProperty(false, { publishedChannels: ["TELEGRAM"] });
    await addRawVideo(property.id);

    const res = await request(app)
      .post(`/api/v1/properties/${property.id}/send-back-to-montajer`)
      .set("Authorization", `Bearer ${marketingToken}`)
      .send({ reason: "POOR_EDIT", removeFromSocial: true });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(typeof res.body.queued).toBe("boolean");
    expect(res.body.social).toBeTruthy();
    expect(res.body.social.failed).toContainEqual({
      channel: "TELEGRAM",
      error: "в карточке нет сохранённого id сообщения Telegram — снять нечем",
    });
    expect(res.body.social.removed).toEqual([]);

    const after = await prisma.property.findUniqueOrThrow({ where: { id: property.id } });
    expect(["QUEUED", "SENT_TO_EDITOR"]).toContain(after.videoHandoffStatus);
    expect(after.videoRemakeCount).toBe(1);
  });

  it("removeFromSocial не передан (по умолчанию false) — ответ без поля social, как раньше", async () => {
    const property = await seedProperty(false);
    await addRawVideo(property.id);

    const res = await request(app)
      .post(`/api/v1/properties/${property.id}/send-back-to-montajer`)
      .set("Authorization", `Bearer ${marketingToken}`)
      .send({ reason: "POOR_EDIT" });

    expect(res.status).toBe(200);
    expect(res.body.social).toBeUndefined();
  });
});

describe("Журнал сообщений монтажёру", () => {
  it("после отправки на монтаж и после перемонтажа в журнале лежат ровно те тексты, что ушли", async () => {
    const property = await seedProperty(false);
    await addRawVideo(property.id);

    const sendRes = await request(app)
      .post(`/api/v1/properties/${property.id}/send-back-to-montajer`)
      .set("Authorization", `Bearer ${marketingToken}`)
      .send({ reason: "NO_MUSIC", comment: "тишина полная" });
    expect(sendRes.status).toBe(200);

    const caption = String(sendDocumentFile.mock.calls[0]?.[3] ?? "");

    const messagesRes = await request(app)
      .get(`/api/v1/properties/${property.id}/montajer-messages`)
      .set("Authorization", `Bearer ${marketingToken}`);
    expect(messagesRes.status).toBe(200);
    expect(Array.isArray(messagesRes.body.messages)).toBe(true);
    const entry = messagesRes.body.messages.find((m: { kind: string }) => m.kind === "REMAKE");
    expect(entry).toBeTruthy();
    // С 23.09.2026 запись журнала = текст сообщения + перечень файлов с исходом
    // каждого («Файлов: N», «1. имя — МБ — ✓ файлом»): владелец видит, что
    // именно ушло. Само сообщение по-прежнему лежит в начале записи дословно.
    // С 25.09.2026 подпись файла начинается строкой «Объект №N · файл 1 из 1»,
    // за которой идёт ровно то сообщение, что лежит в начале записи журнала.
    const sentMessage = entry.text.split("\n\nФайлов: ")[0];
    expect(entry.text).toContain("Файлов: ");
    expect(sentMessage).toContain("ПЕРЕМОНТАЖ");
    expect(caption.startsWith(`Объект №${property.shortId} · файл 1 из 1`)).toBe(true);
    expect(caption.endsWith(`\n\n${sentMessage}`)).toBe(true);
  });
});
