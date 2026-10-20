import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import fs from "node:fs/promises";
import pathMod from "node:path";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { waitFor } from "./helpers/waitFor.js";

/**
 * «ОЧЕРЕДЬ МОНТАЖА ПОД КОНТРОЛЕМ» (25.09.2026, пачка 1 спецификации
 * docs/handoff-2026-09-25-montage-control-spec.md, раздел 2 блок А). Покрывает:
 *
 * А3 — продажа/снятие/резерв и удаление в корзину, пока объект держит место
 *      монтажёра или стоит в очереди, освобождают место и предупреждают
 *      монтажёра (closeVideoHandoff), восстановление из корзины возвращает в
 *      очередь, если объект был там на момент удаления.
 * А2 — двойное нажатие кнопки бота `mj:files` не удваивает отправку.
 * А1 — смена монтажёра в Настройках отвечает быстро, старый получает «передан
 *      другому монтажёру» (более полное покрытие — tests/montajer-reassign.test.ts).
 * А4 — причина паузы доходит до `queue-state`.
 * А5 — монтажёра без Telegram назначить нельзя (400).
 *
 * Telegram (sendMessage/sendDocumentFile) и push — подменены: тест проверяет
 * КОМУ и КОГДА уходят сообщения/файлы, не сам Telegram.
 */

const { sendMessage, sendDocumentFile, answerCallbackQuery, logSystemError } = vi.hoisted(() => ({
  sendMessage: vi.fn(async (..._args: unknown[]) => {}),
  sendDocumentFile: vi.fn(async (..._args: unknown[]) => ({ message_id: 1, document: { file_id: "fid", file_unique_id: "fuid" } })),
  answerCallbackQuery: vi.fn(async (..._args: unknown[]) => {}),
  logSystemError: vi.fn(async () => {}),
}));

vi.mock("../src/telegram/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/telegram/api.js")>()),
  sendMessage,
  sendDocumentFile,
  answerCallbackQuery,
}));
vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent: vi.fn(async () => {}),
  sendPushToAgents: vi.fn(async () => 0),
}));
vi.mock("../src/lib/systemError.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/systemError.js")>()),
  logSystemError }));

const { prisma } = await import("../src/db.js");
const { app } = await import("../src/app.js");
const {
  queueVideoHandoff,
  videoHandoffQueueState,
  settleBackgroundHandoffDispatches,
} = await import("../src/lib/videoHandoff.js");
const { trashProperty } = await import("../src/lib/trashProperty.js");
const { handleTelegramUpdate } = await import("../src/telegram/bot.js");
const { grantElevation } = await import("../src/lib/stepUp.js");
const { localVideoFilePath } = await import("../src/lib/localVideoStorage.js");

const runId = Date.now();
const tail = runId.toString().slice(-7);
const password = "testpass123";
const MONTAJER_CHAT = `8${tail}1`;

let districtId: string;
let montajerId: string;
let directorId: string;
let directorToken: string;
const propertyIds: string[] = [];
const agentIds: string[] = [];
const rawDirs = new Set<string>();
let originalSettings: {
  videoHandoffEnabled: boolean;
  videoMontajerAgentId: string | null;
  videoHandoffQueuePaused: boolean;
} | null = null;

async function seedProperty(data: Record<string, unknown> = {}) {
  const p = await prisma.property.create({
    data: {
      title: `Смена статуса на монтаже-${runId}-${propertyIds.length}`,
      type: "APARTMENT",
      areaSqm: 50,
      price: 300000,
      currency: "TJS",
      districtId,
      address: "Тестовая, 25",
      condition: "GOOD",
      status: "AVAILABLE",
      ...data,
    },
  });
  propertyIds.push(p.id);
  return p;
}

async function addRawVideo(propertyId: string) {
  const storageKey = `${propertyId}/${randomUUID()}.mp4`;
  const filePath = localVideoFilePath(storageKey);
  if (!filePath) throw new Error("путь хранилища не разрешился");
  await fs.mkdir(pathMod.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, Buffer.alloc(1024));
  rawDirs.add(pathMod.dirname(filePath));
  return prisma.propertyVideo.create({
    data: { propertyId, storageKey, filename: "raw.mp4", sizeBytes: 1024, uploadedById: montajerId },
  });
}

/**
 * «Продано» вручную сервер принимает только при завершённой сделке (находка
 * №182, 01.10.2026): без неё PATCH {status:"SOLD"} отвечает 409. Здесь проверяется
 * монтаж, а не продажа, поэтому сделку заводим заранее.
 */
const dealClientIds: string[] = [];
async function seedCompletedDeal(propertyId: string) {
  const client = await prisma.client.create({
    data: { fullName: `Покупатель смены статуса ${runId}`, phone: `+99297${tail}${dealClientIds.length}`, source: "PHONE_CALL" },
  });
  dealClientIds.push(client.id);
  await prisma.deal.create({ data: { clientId: client.id, propertyId, agentId: directorId, stage: "COMPLETED" } });
}

const videoHandoffStatusOf = async (id: string) =>
  (await prisma.property.findUniqueOrThrow({ where: { id }, select: { videoHandoffStatus: true } })).videoHandoffStatus;

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Смена статуса на монтаже-${runId}` } })).id;
  const hash = await bcrypt.hash(password, 4);
  montajerId = (
    await prisma.agent.create({
      data: {
        fullName: "Монтажёр смены статуса",
        phone: `+99295${tail}`,
        role: "EDITOR",
        passwordHash: hash,
        telegramChatId: MONTAJER_CHAT,
      },
    })
  ).id;
  agentIds.push(montajerId);
  const director = await prisma.agent.create({
    data: { fullName: "Директор смены статуса", phone: `+99296${tail}`, role: "DIRECTOR", passwordHash: hash },
  });
  directorId = director.id;
  agentIds.push(directorId);
  const login = await request(app).post("/api/v1/auth/login").send({ phone: director.phone, password });
  expect(login.status).toBe(200);
  directorToken = login.body.accessToken as string;
  grantElevation(directorId);

  originalSettings = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { videoHandoffEnabled: true, videoMontajerAgentId: true, videoHandoffQueuePaused: true },
  });
  await prisma.settings.upsert({
    where: { id: "singleton" },
    update: {
      videoHandoffEnabled: true,
      videoMontajerAgentId: montajerId,
      videoHandoffQueuePaused: false,
      videoHandoffQueuePausedAt: null,
      videoHandoffQueuePausedById: null,
      videoHandoffQueuePauseReason: null,
    },
    create: { id: "singleton", videoHandoffEnabled: true, videoMontajerAgentId: montajerId },
  });
});

beforeEach(async () => {
  // Чужие объекты общей базы из очереди выводим (не удаляем): иначе они стояли бы
  // в той же очереди и путали порядок и счёт (см. video-handoff-queue-order.test.ts).
  await prisma.property.updateMany({
    where: { videoHandoffStatus: { in: ["QUEUED", "SENT_TO_EDITOR"] }, id: { notIn: propertyIds } },
    data: { videoHandoffStatus: "RECEIVED", videoHandoffQueueOrder: null },
  });
  await prisma.settings.update({
    where: { id: "singleton" },
    data: {
      videoHandoffQueuePaused: false,
      videoHandoffQueuePausedAt: null,
      videoHandoffQueuePausedById: null,
      videoHandoffQueuePauseReason: null,
      videoMontajerAgentId: montajerId,
    },
  });
  sendMessage.mockClear();
  sendDocumentFile.mockClear();
  answerCallbackQuery.mockClear();
});

afterEach(async () => {
  await settleBackgroundHandoffDispatches();
  await prisma.property.updateMany({
    where: { id: { in: propertyIds } },
    data: {
      videoHandoffStatus: "NONE",
      videoHandoffSentAt: null,
      videoHandoffDeliveredAt: null,
      videoHandoffDispatchAttempts: 0,
      videoHandoffManualSince: null,
      videoHandoffQueueOrder: null,
      videoHandoffFinalPath: null,
      deletedAt: null,
      status: "AVAILABLE",
    },
  });
});

afterAll(async () => {
  await settleBackgroundHandoffDispatches();
  await prisma.settings.update({
    where: { id: "singleton" },
    data: originalSettings ?? { videoHandoffEnabled: false, videoMontajerAgentId: null, videoHandoffQueuePaused: false },
  });
  await prisma.montajerMessage.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.telegramCallbackSeen.deleteMany({ where: { id: { startsWith: `dup-${runId}` } } });
  await prisma.deal.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.client.deleteMany({ where: { id: { in: dealClientIds } } });
  for (const d of rawDirs) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
  await prisma.agent.deleteMany({ where: { id: { in: agentIds } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
});

describe("А3 — продажа/снятие/резерв во время монтажа", () => {
  it("SOLD во время SENT_TO_EDITOR → RECEIVED, монтажёру уведомление, следующий выдан", async () => {
    const holder = await seedProperty({ videoHandoffStatus: "SENT_TO_EDITOR", videoHandoffSentAt: new Date() });
    const next = await seedProperty();
    await addRawVideo(next.id);
    await queueVideoHandoff(next.id);
    expect(await videoHandoffStatusOf(next.id)).toBe("QUEUED");
    await seedCompletedDeal(holder.id);

    const res = await request(app)
      .patch(`/api/v1/properties/${holder.id}`)
      .set("Authorization", `Bearer ${directorToken}`)
      .send({ status: "SOLD", version: holder.version });
    expect(res.status).toBe(200);

    await waitFor(async () => (await videoHandoffStatusOf(holder.id)) === "RECEIVED", { label: "объект закрыт после продажи" });
    expect(await videoHandoffStatusOf(holder.id)).toBe("RECEIVED");
    await waitFor(
      () => prisma.montajerMessage.findFirst({ where: { propertyId: holder.id, kind: "CANCELLED" }, select: { id: true } }),
      { label: "журнал монтажёра — продан" }
    );
    const journalRow = await prisma.montajerMessage.findFirst({ where: { propertyId: holder.id }, orderBy: { sentAt: "desc" } });
    expect(journalRow?.text).toContain("продан");
    expect(sendMessage).toHaveBeenCalledWith(MONTAJER_CHAT, expect.stringContaining("продан"));

    // Место освободилось — следующий из очереди уезжает монтажёру (в фоне).
    // closeVideoHandoff сам не awaited маршрутом (crud.ts) — releaseQueueIfClear
    // внутри него регистрирует фоновую отправку не сразу же после первого
    // waitFor выше, поэтому settle идёт внутри опроса, а не одним снимком.
    await waitFor(
      async () => {
        await settleBackgroundHandoffDispatches();
        return (await videoHandoffStatusOf(next.id)) === "SENT_TO_EDITOR";
      },
      { label: "следующий объект выдан монтажёру после продажи держателя" }
    );
  });

  it("WITHDRAWN во время QUEUED (без держателя) — снимается из очереди без сообщения монтажёру", async () => {
    // Держатель места нужен, иначе queueVideoHandoff сразу посадит `queued`
    // на свободное место (SENT_TO_EDITOR), а не оставит его ждать в QUEUED.
    await seedProperty({ videoHandoffStatus: "SENT_TO_EDITOR", videoHandoffSentAt: new Date() });
    const queued = await seedProperty();
    await queueVideoHandoff(queued.id);
    expect(await videoHandoffStatusOf(queued.id)).toBe("QUEUED");

    const res = await request(app)
      .patch(`/api/v1/properties/${queued.id}`)
      .set("Authorization", `Bearer ${directorToken}`)
      .send({ status: "WITHDRAWN", version: queued.version });
    expect(res.status).toBe(200);

    await waitFor(async () => (await videoHandoffStatusOf(queued.id)) === "RECEIVED", { label: "объект снят с продажи" });
    // QUEUED — монтажёр его никогда не видел, Telegram не трогаем, только журнал.
    expect(sendMessage).not.toHaveBeenCalled();
    // Запись журнала ложится после смены статуса, отдельным шагом: читаем её с
    // ожиданием (CLAUDE.md, «тест, читающий запись, сделанную в отрыве») — на
    // занятой машине в два процесса голый findFirst успевал раньше неё.
    const journalRow = await waitFor(
      () => prisma.montajerMessage.findFirst({ where: { propertyId: queued.id } }),
      { label: "запись журнала монтажёра о снятии из очереди" }
    );
    expect(journalRow?.text).toContain("снят из очереди");
  });
});

describe("А3 — удаление в корзину и восстановление", () => {
  it("корзина во время SENT_TO_EDITOR → то же (закрыто, монтажёр предупреждён, следующий выдан)", async () => {
    const holder = await seedProperty({ videoHandoffStatus: "SENT_TO_EDITOR", videoHandoffSentAt: new Date() });
    const next = await seedProperty();
    await addRawVideo(next.id);
    await queueVideoHandoff(next.id);

    const result = await trashProperty(holder.id, directorId);
    expect(result.ok).toBe(true);

    expect(await videoHandoffStatusOf(holder.id)).toBe("RECEIVED");
    expect(sendMessage).toHaveBeenCalledWith(MONTAJER_CHAT, expect.stringContaining("удалён"));
    const journalRow = await prisma.montajerMessage.findFirst({ where: { propertyId: holder.id }, orderBy: { sentAt: "desc" } });
    expect(journalRow?.kind).toBe("PROPERTY_DELETED");

    await settleBackgroundHandoffDispatches();
    expect(await videoHandoffStatusOf(next.id)).toBe("SENT_TO_EDITOR");
  });

  it("восстановление из корзины возвращает объект в очередь, если он был в ней на момент удаления", async () => {
    const holder = await seedProperty({
      status: "EDITING",
      videoHandoffStatus: "SENT_TO_EDITOR",
      videoHandoffSentAt: new Date(),
    });
    await addRawVideo(holder.id);
    const trashed = await trashProperty(holder.id, directorId);
    expect(trashed.ok).toBe(true);
    expect(await videoHandoffStatusOf(holder.id)).toBe("RECEIVED");

    const res = await request(app)
      .post(`/api/v1/properties/${holder.id}/restore`)
      .set("Authorization", `Bearer ${directorToken}`);
    expect(res.status).toBe(204);

    await waitFor(async () => (await videoHandoffStatusOf(holder.id)) !== "RECEIVED", { label: "объект вернулся в очередь" });
    expect(["QUEUED", "SENT_TO_EDITOR"]).toContain(await videoHandoffStatusOf(holder.id));
  });
});

describe("А2 — двойное нажатие кнопки бота", () => {
  it("двойной callback mj:files → одна отправка", async () => {
    const holder = await seedProperty({ videoHandoffStatus: "SENT_TO_EDITOR", videoHandoffSentAt: new Date() });
    await addRawVideo(holder.id);

    const callbackId = `dup-${runId}-1`;
    const update = {
      update_id: 1,
      callback_query: {
        id: callbackId,
        data: "mj:files",
        message: { chat: { id: Number(MONTAJER_CHAT) }, message_id: 1 },
        from: { id: Number(MONTAJER_CHAT) },
      },
    };

    await handleTelegramUpdate(update as unknown as Parameters<typeof handleTelegramUpdate>[0]);
    await settleBackgroundHandoffDispatches();
    const firstCallCount = sendDocumentFile.mock.calls.length;
    expect(firstCallCount).toBeGreaterThan(0);

    // Второе нажатие — тот же callback_query.id (Telegram повторяет доставку,
    // пользователь тапает дважды): claimCallback гасит повтор, файлы не идут
    // второй раз.
    sendDocumentFile.mockClear();
    await handleTelegramUpdate({
      ...update,
      update_id: 2,
    } as unknown as Parameters<typeof handleTelegramUpdate>[0]);
    await settleBackgroundHandoffDispatches();
    expect(sendDocumentFile).not.toHaveBeenCalled();
    expect(answerCallbackQuery).toHaveBeenCalledWith(callbackId);
  });
});

describe("А4 — причина паузы", () => {
  it("пауза с причиной → queue-state отдаёт причину, автора и время", async () => {
    const pauseRes = await request(app)
      .post("/api/v1/marketing/video-handoff/queue/pause")
      .set("Authorization", `Bearer ${directorToken}`)
      .send({ reason: "Монтажёр в отпуске" });
    expect(pauseRes.status).toBe(200);
    expect(pauseRes.body.paused).toBe(true);
    expect(pauseRes.body.pauseReason).toBe("Монтажёр в отпуске");
    expect(pauseRes.body.pausedBy).toMatchObject({ id: directorId });
    expect(typeof pauseRes.body.pausedAt).toBe("string");

    const stateRes = await request(app)
      .get("/api/v1/marketing/video-handoff/queue-state")
      .set("Authorization", `Bearer ${directorToken}`);
    expect(stateRes.status).toBe(200);
    expect(stateRes.body.paused).toBe(true);
    expect(stateRes.body.pauseReason).toBe("Монтажёр в отпуске");
    expect(stateRes.body.pausedBy).toMatchObject({ id: directorId, fullName: expect.any(String) });

    const resumeRes = await request(app)
      .post("/api/v1/marketing/video-handoff/queue/resume")
      .set("Authorization", `Bearer ${directorToken}`);
    expect(resumeRes.status).toBe(200);
    expect(resumeRes.body.paused).toBe(false);
    expect(resumeRes.body.pauseReason).toBeNull();
    expect(resumeRes.body.pausedBy).toBeNull();
  });

  it("состояние очереди в API — совпадает с прямым вызовом videoHandoffQueueState()", async () => {
    await request(app)
      .post("/api/v1/marketing/video-handoff/queue/pause")
      .set("Authorization", `Bearer ${directorToken}`)
      .send({ reason: "проверка согласованности" });
    const state = await videoHandoffQueueState();
    expect(state.paused).toBe(true);
    expect(state.pauseReason).toBe("проверка согласованности");
    await request(app).post("/api/v1/marketing/video-handoff/queue/resume").set("Authorization", `Bearer ${directorToken}`);
  });
});

describe("А5 — валидация монтажёра в Настройках", () => {
  it("монтажёр без Telegram → 400, понятный текст", async () => {
    const noTelegram = await prisma.agent.create({
      data: { fullName: "Без Telegram", phone: `+99297${tail}`, role: "AGENT", passwordHash: "x" },
    });
    agentIds.push(noTelegram.id);

    const res = await request(app)
      .patch("/api/v1/settings")
      .set("Authorization", `Bearer ${directorToken}`)
      .send({ videoMontajerAgentId: noTelegram.id });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Telegram");

    // Настройка не должна была сохраниться поверх — прежний монтажёр остаётся.
    const settings = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { videoMontajerAgentId: true } });
    expect(settings?.videoMontajerAgentId).toBe(montajerId);
  });

  it("неактивный сотрудник → 400", async () => {
    const inactive = await prisma.agent.create({
      data: {
        fullName: "Уволенный монтажёр",
        phone: `+99298${tail}`,
        role: "AGENT",
        passwordHash: "x",
        telegramChatId: `inactive-${tail}`,
        isActive: false,
      },
    });
    agentIds.push(inactive.id);

    const res = await request(app)
      .patch("/api/v1/settings")
      .set("Authorization", `Bearer ${directorToken}`)
      .send({ videoMontajerAgentId: inactive.id });
    expect(res.status).toBe(400);
    // Текст ошибки — общий для всех пяти полей с сотрудником (settings-agent-still-active):
    // называет человека по имени и причину, «уволен» / «заморожен».
    expect(res.body.error).toMatch(/уволен/);
  });
});
