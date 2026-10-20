import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";

const { sendMessage } = vi.hoisted(() => ({ sendMessage: vi.fn(async () => {}) }));
vi.mock("../src/telegram/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/telegram/api.js")>()),
  sendMessage,
}));

const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");
const { findAgentsWithPermission } = await import("../src/lib/recipients.js");
const { queueVideoHandoff, settleBackgroundHandoffDispatches } = await import("../src/lib/videoHandoff.js");

/**
 * Рабочая очередь монтажёра (GET /marketing/editor-queue) — источник данных для
 * его Главной.
 *
 * ЗАЧЕМ ТЕСТ. До 16.08.2026 у роли EDITOR не было ни своей Главной, ни списка
 * работы: единственным сигналом о новом объекте был веб-пуш, а без разрешения
 * браузера на уведомления — вообще ничего. Здесь фиксируем ровно то, на что
 * опирается его экран: состав двух списков, признак просрочки и честные счётчики.
 *
 * Отдельно закреплено решение о том, КОГО зовут при заведении объекта:
 * монтажёра среди получателей properties.moderate быть не должно — он монтирует,
 * а не одобряет (разделение введено 16.08.2026), и уведомление о новой карточке
 * ему не шлётся намеренно (см. комментарий у notifyPendingReview).
 */

const runId = Date.now();
const password = "testpass123";

let districtId: string;
let plainAgentToken: string;
let editorAgentId: string;
let editorToken: string;
let marketingAgentId: string;
const propertyIds: string[] = [];
const agentIds: string[] = [];
let originalHandoffSettings: { videoHandoffEnabled: boolean; videoMontajerAgentId: string | null } | null = null;

async function login(phone: string) {
  const res = await request(app).post("/api/v1/auth/login").send({ phone, password });
  expect(res.status).toBe(200);
  return res.body.accessToken as string;
}

async function makeProperty(title: string, data: Record<string, unknown>) {
  const p = await prisma.property.create({
    data: {
      title: `${title} ${runId}`,
      type: "APARTMENT",
      areaSqm: 50,
      price: 40000,
      currency: "TJS",
      districtId,
      address: "Тестовая, 1",
      condition: "GOOD",
      ...data,
    },
  });
  propertyIds.push(p.id);
  return p;
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  districtId = (await prisma.district.create({ data: { name: `Тест-район-монтаж-${runId}` } })).id;

  const agent = await prisma.agent.create({
    data: { fullName: "Агент-теста монтажа", phone: `+992973${runId}`, role: "AGENT", passwordHash },
  });
  agentIds.push(agent.id);
  plainAgentToken = await login(agent.phone);

  const editor = await prisma.agent.create({
    data: { fullName: "Монтажёр очереди", phone: `+992974${runId}`, role: "EDITOR", passwordHash },
  });
  editorAgentId = editor.id;
  agentIds.push(editor.id);
  editorToken = await login(editor.phone);

  const marketing = await prisma.agent.create({
    data: { fullName: "Маркетолог очереди", phone: `+992975${runId}`, role: "MARKETING", passwordHash },
  });
  marketingAgentId = marketing.id;
  agentIds.push(marketing.id);

  // На монтаже, в сроке.
  await makeProperty("Монтаж в сроке", {
    status: "EDITING",
    stageEnteredAt: new Date(),
    intakeAgentId: agent.id,
  });

  // На монтаже, срок вышел (по умолчанию 2 дня на этап EDITING).
  await makeProperty("Монтаж просрочен", {
    status: "EDITING",
    stageEnteredAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000),
    intakeAgentId: agent.id,
  });

  // Ещё снимают видео — придёт к монтажёру следующим.
  await makeProperty("Ожидает видео", {
    status: "AWAITING_VIDEO",
    stageEnteredAt: new Date(),
    intakeAgentId: agent.id,
  });

  // Чужой этап и уже проданное — в очередь монтажа попадать не должны.
  await makeProperty("Ожидает фото", { status: "AWAITING_PHOTOS", stageEnteredAt: new Date() });
  await makeProperty("Уже в продаже", { status: "AVAILABLE" });
});

afterAll(async () => {
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: agentIds } } });
  await prisma.district.delete({ where: { id: districtId } }).catch(() => {});
  if (originalHandoffSettings) {
    await prisma.settings.update({ where: { id: "singleton" }, data: originalHandoffSettings });
  }
});

describe("GET /marketing/editor-queue", () => {
  it("обычному агенту — 403", async () => {
    const res = await request(app)
      .get("/api/v1/marketing/editor-queue")
      .set("Authorization", `Bearer ${plainAgentToken}`);
    expect(res.status).toBe(403);
  });

  it("монтажёру — объекты на монтаже, с просрочкой и ответственным агентом", async () => {
    const res = await request(app)
      .get("/api/v1/marketing/editor-queue")
      .set("Authorization", `Bearer ${editorToken}`);
    expect(res.status).toBe(200);

    const titles = res.body.inEditing.map((r: { title: string }) => r.title);
    expect(titles).toContain(`Монтаж в сроке ${runId}`);
    expect(titles).toContain(`Монтаж просрочен ${runId}`);
    // Чужие этапы и объекты вне конвейера — не его работа.
    expect(titles).not.toContain(`Ожидает фото ${runId}`);
    expect(titles).not.toContain(`Ожидает видео ${runId}`);
    expect(titles).not.toContain(`Уже в продаже ${runId}`);

    const overdue = res.body.inEditing.find((r: { title: string }) => r.title === `Монтаж просрочен ${runId}`);
    expect(overdue.pipeline.overdue).toBe(true);
    expect(overdue.pipeline.owner).toBe("EDITOR");
    expect(overdue.responsibleAgent.fullName).toBe("Агент-теста монтажа");

    const inTime = res.body.inEditing.find((r: { title: string }) => r.title === `Монтаж в сроке ${runId}`);
    expect(inTime.pipeline.overdue).toBe(false);
  });

  it("«Скоро на монтаж» — только этап «Ожидает видео»", async () => {
    const res = await request(app)
      .get("/api/v1/marketing/editor-queue")
      .set("Authorization", `Bearer ${editorToken}`);
    expect(res.status).toBe(200);

    const titles = res.body.upcoming.map((r: { title: string }) => r.title);
    expect(titles).toContain(`Ожидает видео ${runId}`);
    expect(titles).not.toContain(`Монтаж в сроке ${runId}`);
    expect(titles).not.toContain(`Ожидает фото ${runId}`);
  });

  it("счётчики совпадают со списками", async () => {
    const res = await request(app)
      .get("/api/v1/marketing/editor-queue")
      .set("Authorization", `Bearer ${editorToken}`);
    expect(res.status).toBe(200);
    expect(res.body.counts.inEditing).toBeGreaterThanOrEqual(2);
    expect(res.body.counts.overdue).toBeGreaterThanOrEqual(1);
    expect(res.body.counts.upcoming).toBeGreaterThanOrEqual(1);
    expect(res.body.inEditing.length).toBeLessThanOrEqual(res.body.counts.inEditing);
  });

  it("маркетингу и директору тоже открыта — это общая очередь этапа, а не личная", async () => {
    const marketing = await prisma.agent.findUniqueOrThrow({ where: { id: marketingAgentId } });
    const token = await login(marketing.phone);
    const res = await request(app).get("/api/v1/marketing/editor-queue").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
  });
});

/**
 * Видимость и отмена очереди хендоффа (владелец 19.09.2026, разбор
 * зависшей очереди №104/106/107 — «чтобы админ и монтажёр и директор видели
 * очередь и могли отменять»). `videoHandoffQueuePosition` — то самое поле,
 * которое отличает «просто на монтаже» от «висит у бота»: раньше конвейер
 * не показывал эту под-очередь вовсе, и объект мог застрять в ней НЕЗАМЕТНО
 * (см. [[royalhome-video-handoff-queue-deadlock-19-09]]).
 */
describe("Очередь хендоффа в /editor-queue: позиция и отмена", () => {
  it("объект, отправленный монтажёру, — videoHandoffQueuePosition: 1 в списке /editor-queue", async () => {
    const settings = await prisma.settings.findUnique({
      where: { id: "singleton" },
      select: { videoHandoffEnabled: true, videoMontajerAgentId: true },
    });
    originalHandoffSettings = settings
      ? { videoHandoffEnabled: settings.videoHandoffEnabled, videoMontajerAgentId: settings.videoMontajerAgentId }
      : null;
    await prisma.settings.upsert({
      where: { id: "singleton" },
      update: { videoHandoffEnabled: true, videoMontajerAgentId: editorAgentId },
      create: { id: "singleton", videoHandoffEnabled: true, videoMontajerAgentId: editorAgentId },
    });

    const property = await makeProperty("В хендоффе", { status: "EDITING", stageEnteredAt: new Date() });
    await queueVideoHandoff(property.id);

    const res = await request(app)
      .get("/api/v1/marketing/editor-queue")
      .set("Authorization", `Bearer ${editorToken}`);
    expect(res.status).toBe(200);
    const row = res.body.inEditing.find((r: { id: string }) => r.id === property.id);
    expect(row.videoHandoffQueuePosition).toBe(1);

    await prisma.property.update({ where: { id: property.id }, data: { videoHandoffStatus: "NONE", videoHandoffSentAt: null } });
  });

  it("объект вне хендоффа — videoHandoffQueuePosition: null", async () => {
    const res = await request(app)
      .get("/api/v1/marketing/editor-queue")
      .set("Authorization", `Bearer ${editorToken}`);
    const row = res.body.inEditing.find((r: { title: string }) => r.title === `Монтаж в сроке ${runId}`);
    expect(row.videoHandoffQueuePosition).toBeNull();
  });

  it("POST /marketing/video-handoff/:id/cancel — обычному агенту 403", async () => {
    const property = await makeProperty("Отмена-403", { status: "EDITING", stageEnteredAt: new Date() });
    const res = await request(app)
      .post(`/api/v1/marketing/video-handoff/${property.id}/cancel`)
      .set("Authorization", `Bearer ${plainAgentToken}`);
    expect(res.status).toBe(403);
  });

  it("POST /marketing/video-handoff/:id/cancel — объект не в очереди — 409, честная ошибка", async () => {
    const property = await makeProperty("Отмена-409", { status: "EDITING", stageEnteredAt: new Date() });
    const res = await request(app)
      .post(`/api/v1/marketing/video-handoff/${property.id}/cancel`)
      .set("Authorization", `Bearer ${editorToken}`);
    expect(res.status).toBe(409);
    expect(res.body.error).toContain("не в очереди монтажа");
  });

  it("POST /marketing/video-handoff/:id/cancel — монтажёр снимает объект, держащий его же место, сам получает уведомление", async () => {
    await prisma.agent.update({ where: { id: editorAgentId }, data: { telegramChatId: `chat-${runId}` } });
    const property = await makeProperty("Отмена-200", { status: "EDITING", stageEnteredAt: new Date() });
    await queueVideoHandoff(property.id);
    sendMessage.mockClear();

    const res = await request(app)
      .post(`/api/v1/marketing/video-handoff/${property.id}/cancel`)
      .set("Authorization", `Bearer ${editorToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    const updated = await prisma.property.findUniqueOrThrow({ where: { id: property.id }, select: { videoHandoffStatus: true } });
    expect(updated.videoHandoffStatus).toBe("RECEIVED");
    expect(sendMessage).toHaveBeenCalledTimes(1);

    await prisma.agent.update({ where: { id: editorAgentId }, data: { telegramChatId: null } });
  });

  /**
   * «Снять и придержать очередь» + «Возобновить» (24.09.2026, №133/134/135) —
   * через HTTP: тело holdQueue, состояние очереди для окна подтверждения,
   * пауза/возобновление. Пауза возвращается прямой записью в finally, чтобы
   * возобновление не выдало место чужому объекту общей базы.
   */
  it("holdQueue через HTTP — место свободно, следующий ждёт; queue-state говорит «пауза»; resume снимает паузу", async () => {
    const holder = await makeProperty("Придержать-держатель", { status: "EDITING", stageEnteredAt: new Date() });
    const next = await makeProperty("Придержать-следующий", { status: "EDITING", stageEnteredAt: new Date() });
    try {
      await queueVideoHandoff(holder.id);
      await queueVideoHandoff(next.id);

      const before = await request(app).get("/api/v1/marketing/video-handoff/queue-state").set("Authorization", `Bearer ${editorToken}`);
      expect(before.status).toBe(200);
      expect(before.body.holder?.id).toBe(holder.id);
      expect(before.body.paused).toBe(false);

      const bad = await request(app)
        .post(`/api/v1/marketing/video-handoff/${holder.id}/cancel`)
        .set("Authorization", `Bearer ${editorToken}`)
        .send({ holdQueue: "да" });
      expect(bad.status).toBe(400);

      const res = await request(app)
        .post(`/api/v1/marketing/video-handoff/${holder.id}/cancel`)
        .set("Authorization", `Bearer ${editorToken}`)
        .send({ holdQueue: true });
      expect(res.status).toBe(200);
      const nextRow = await prisma.property.findUniqueOrThrow({ where: { id: next.id }, select: { videoHandoffStatus: true } });
      expect(nextRow.videoHandoffStatus).toBe("QUEUED");

      const paused = await request(app).get("/api/v1/marketing/video-handoff/queue-state").set("Authorization", `Bearer ${editorToken}`);
      expect(paused.body.paused).toBe(true);
      expect(paused.body.holder).toBeNull();

      // Повторное снятие того же — уже не в очереди, 409, а не «снято».
      const again = await request(app)
        .post(`/api/v1/marketing/video-handoff/${holder.id}/cancel`)
        .set("Authorization", `Bearer ${editorToken}`)
        .send({ holdQueue: true });
      expect(again.status).toBe(409);

      const forbidden = await request(app).post("/api/v1/marketing/video-handoff/queue/resume").set("Authorization", `Bearer ${plainAgentToken}`);
      expect(forbidden.status).toBe(403);

      // Свой — в голову очереди, чужие строки общей базы не трогаем.
      // Порядок очереди — videoHandoffQueueOrder (lib/videoHandoff.ts::orderedQueue).
      await prisma.property.update({ where: { id: next.id }, data: { videoHandoffSentAt: new Date(0), videoHandoffQueueOrder: -1 } });
      const resumed = await request(app).post("/api/v1/marketing/video-handoff/queue/resume").set("Authorization", `Bearer ${editorToken}`);
      expect(resumed.status).toBe(200);
      expect(resumed.body.paused).toBe(false);
      const nextAfter = await prisma.property.findUniqueOrThrow({ where: { id: next.id }, select: { videoHandoffStatus: true } });
      expect(nextAfter.videoHandoffStatus).toBe("SENT_TO_EDITOR");
    } finally {
      await settleBackgroundHandoffDispatches();
      await prisma.settings.update({ where: { id: "singleton" }, data: { videoHandoffQueuePaused: false } });
      await prisma.property.updateMany({
        where: { id: { in: [holder.id, next.id] } },
        data: { videoHandoffStatus: "NONE", videoHandoffSentAt: null },
      });
    }
  });
});

describe("кого зовут при заведении объекта", () => {
  it("монтажёра нет среди получателей properties.moderate — он монтирует, а не одобряет", async () => {
    const moderators = await findAgentsWithPermission("properties.moderate");
    expect(moderators).not.toContain(editorAgentId);
    // Маркетинг снова среди модераторов: право вернули 04.09.2026 вместе с
    // удалением автомонтажа (см. packages/shared/permissions.ts).
    expect(moderators).toContain(marketingAgentId);
  });

  it("монтажёр получает пуш только на своём этапе (properties.aiListing)", async () => {
    const editors = await findAgentsWithPermission("properties.aiListing");
    expect(editors).toContain(editorAgentId);
  });
});
