import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";

/**
 * POST /properties/:id/publish-now (21.09.2026, расстановка публикаций по
 * времени) — кнопка «Опубликовать сейчас» в карточке объекта. Ролик уже принят
 * от монтажёра и ждёт своего слота; кнопка сдвигает уже стоящее фоновое задание
 * на текущий момент, САМА НИЧЕГО НЕ ПУБЛИКУЯ — иначе у публикации появился бы
 * второй путь, и объект мог уйти в соцсети дважды (у задания нет защиты от
 * повтора кроме статуса приёмки, который после успеха не меняется).
 *
 * Поэтому проверяем именно состояние очереди и карточки, а не поход в сеть.
 */

const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");
const { videoHandoffPublishDedupeKey, VIDEO_HANDOFF_PUBLISH_JOB_TYPE, VIDEO_HANDOFF_PUBLISH_MAX_ATTEMPTS } = await import("../src/lib/videoHandoff.js");

const runId = Date.now();
const password = "testpass123";

let districtId: string;
let marketingToken: string;
let plainAgentToken: string;
const propertyIds: string[] = [];
let savedAutoPublish: boolean;

async function login(phone: string) {
  const res = await request(app).post("/api/v1/auth/login").send({ phone, password });
  expect(res.status).toBe(200);
  return res.body.accessToken as string;
}

/** Объект в том состоянии, в котором его оставляет приём ролика от монтажёра:
 *  файл на диске, статус RECEIVED, выбранный слот и задание, ждущее этот слот. */
async function receivedProperty(title: string, slotInHours = 4) {
  const slot = new Date(Date.now() + slotInHours * 60 * 60 * 1000);
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
      videoHandoffStatus: "RECEIVED",
      videoHandoffFinalPath: "/uploads/handoff/publish-now.mp4",
      videoHandoffReceivedAt: new Date(),
      scheduledPublishAt: slot,
    },
  });
  propertyIds.push(p.id);
  await prisma.backgroundJob.create({
    data: {
      type: VIDEO_HANDOFF_PUBLISH_JOB_TYPE,
      payload: { propertyId: p.id },
      dedupeKey: videoHandoffPublishDedupeKey(p.id),
      maxAttempts: VIDEO_HANDOFF_PUBLISH_MAX_ATTEMPTS,
      runAt: slot,
    },
  });
  return { property: p, slot };
}

function publishNow(id: string, token: string) {
  return request(app).post(`/api/v1/properties/${id}/publish-now`).set("Authorization", `Bearer ${token}`);
}

beforeAll(async () => {
  // Кнопка честно отказывает при выключенной автопубликации (24.09.2026) —
  // включаем на время файла и возвращаем как было.
  const settings = await prisma.settings.upsert({ where: { id: "singleton" }, update: {}, create: { id: "singleton" } });
  savedAutoPublish = settings.autoPublishEnabled;
  await prisma.settings.update({ where: { id: "singleton" }, data: { autoPublishEnabled: true } });
  const passwordHash = await bcrypt.hash(password, 10);
  districtId = (await prisma.district.create({ data: { name: `Тест-район-publish-now-${runId}` } })).id;
  const marketing = await prisma.agent.create({
    data: { fullName: "Маркетолог publish-now", phone: `+992976${runId}`, role: "MARKETING", passwordHash },
  });
  marketingToken = await login(marketing.phone);
  const plain = await prisma.agent.create({
    data: { fullName: "Обычный агент publish-now", phone: `+992977${runId}`, role: "AGENT", passwordHash },
  });
  plainAgentToken = await login(plain.phone);
});

afterAll(async () => {
  await prisma.settings.update({ where: { id: "singleton" }, data: { autoPublishEnabled: savedAutoPublish } });
  await prisma.backgroundJob.deleteMany({ where: { dedupeKey: { in: propertyIds.map(videoHandoffPublishDedupeKey) } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.agent.deleteMany({ where: { phone: { in: [`+992976${runId}`, `+992977${runId}`] } } });
  await prisma.district.delete({ where: { id: districtId } }).catch(() => {});
  await prisma.$disconnect();
});

describe("POST /properties/:id/publish-now", () => {
  it("успех — задание уезжает на ближайший тик, выбранный слот сдвигается следом", async () => {
    const { property, slot } = await receivedProperty("Ждёт слота");
    const before = Date.now();

    const res = await publishNow(property.id, marketingToken);

    expect(res.status).toBe(200);
    const job = await prisma.backgroundJob.findUniqueOrThrow({ where: { dedupeKey: videoHandoffPublishDedupeKey(property.id) } });
    expect(job.runAt.getTime()).toBeLessThan(slot.getTime());
    expect(job.runAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(job.status).toBe("PENDING");
    // Слот двигается вместе с заданием: из него считается отступ для СЛЕДУЮЩЕГО
    // ролика, и оставленный прежний час развёл бы очередь от времени, в которое
    // уже ничего не выйдет.
    const after = await prisma.property.findUniqueOrThrow({ where: { id: property.id }, select: { scheduledPublishAt: true } });
    expect(after.scheduledPublishAt!.getTime()).toBeLessThan(slot.getTime());
  });

  it("новый ролик уже вышедшего объекта, два нажатия подряд — одно и то же задание, второго выхода нет", async () => {
    // Вопрос владельца 24.09.2026 («Загрузить и выпустить сразу» в карточке):
    // если ролик стоит в очереди и нажали «Опубликовать сейчас», не выйдет ли
    // он дважды? Нет: кнопка переставляет то же задание (один ключ на объект),
    // а не заводит второе, и уже вышедшие площадки задание пропускает само.
    const { property, slot } = await receivedProperty("Замена ролика");
    await prisma.property.update({ where: { id: property.id }, data: { publishedChannels: ["YOUTUBE", "TIKTOK"] } });

    expect((await publishNow(property.id, marketingToken)).status).toBe(200);
    expect((await publishNow(property.id, marketingToken)).status).toBe(200);

    const jobs = await prisma.backgroundJob.findMany({
      where: { type: VIDEO_HANDOFF_PUBLISH_JOB_TYPE, payload: { path: ["propertyId"], equals: property.id } },
      select: { status: true, runAt: true },
    });
    expect(jobs).toHaveLength(1);
    expect(jobs[0].status).toBe("PENDING");
    expect(jobs[0].runAt.getTime()).toBeLessThan(slot.getTime());
  });

  it("ролик ещё не принят от монтажёра — 409, очередь не трогается", async () => {
    const { property, slot } = await receivedProperty("Ещё у монтажёра");
    await prisma.property.update({ where: { id: property.id }, data: { videoHandoffStatus: "SENT_TO_EDITOR" } });

    const res = await publishNow(property.id, marketingToken);

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("не принят");
    const job = await prisma.backgroundJob.findUniqueOrThrow({ where: { dedupeKey: videoHandoffPublishDedupeKey(property.id) } });
    expect(job.runAt.getTime()).toBe(slot.getTime());
  });

  it("публикация уже идёт — 409, второй раз не запускаем (иначе объект уйдёт в соцсети дважды)", async () => {
    const { property } = await receivedProperty("Уже публикуется");
    await prisma.backgroundJob.update({
      where: { dedupeKey: videoHandoffPublishDedupeKey(property.id) },
      data: { status: "RUNNING", lockedAt: new Date(), lockedBy: "тест" },
    });

    const res = await publishNow(property.id, marketingToken);

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("уже идёт");
  });

  it("обычный агент — не его кнопка", async () => {
    const { property, slot } = await receivedProperty("Права");

    const res = await publishNow(property.id, plainAgentToken);

    expect(res.status).toBe(403);
    const job = await prisma.backgroundJob.findUniqueOrThrow({ where: { dedupeKey: videoHandoffPublishDedupeKey(property.id) } });
    expect(job.runAt.getTime()).toBe(slot.getTime());
  });
});

function publishAt(id: string, token: string, at: unknown) {
  return request(app).post(`/api/v1/properties/${id}/publish-at`).set("Authorization", `Bearer ${token}`).send({ at });
}

function jobOf(propertyId: string) {
  return prisma.backgroundJob.findUniqueOrThrow({ where: { dedupeKey: videoHandoffPublishDedupeKey(propertyId) } });
}

describe("«Опубликовать сейчас» для застрявшего ролика (24.09.2026, очередь в «Расписании»)", () => {
  it("задание сдалось — ставится заново тем же ключом и уходит на ближайший тик", async () => {
    const { property } = await receivedProperty("Сдалось", -2);
    await prisma.backgroundJob.update({
      where: { dedupeKey: videoHandoffPublishDedupeKey(property.id) },
      data: { status: "GIVEN_UP", attempts: 6, lastError: "сеть" },
    });
    const before = Date.now();

    const res = await publishNow(property.id, marketingToken);

    expect(res.status).toBe(200);
    const job = await jobOf(property.id);
    expect(job.status).toBe("PENDING");
    expect(job.attempts).toBe(0);
    expect(job.runAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
  });

  it("задания нет вовсе — заводится, а не «обратитесь к разработчику»", async () => {
    const { property } = await receivedProperty("Без задания");
    await prisma.backgroundJob.deleteMany({ where: { dedupeKey: videoHandoffPublishDedupeKey(property.id) } });

    const res = await publishNow(property.id, marketingToken);

    expect(res.status).toBe(200);
    const job = await jobOf(property.id);
    expect(job.status).toBe("PENDING");
    expect(job.type).toBe(VIDEO_HANDOFF_PUBLISH_JOB_TYPE);
  });

  it("ролик уже вышел хоть где-то — второй раз из очереди не запускается", async () => {
    const { property } = await receivedProperty("Уже вышел");
    await prisma.backgroundJob.update({
      where: { dedupeKey: videoHandoffPublishDedupeKey(property.id) },
      data: { status: "DONE" },
    });
    await prisma.property.update({ where: { id: property.id }, data: { publishedChannels: ["TELEGRAM"] } });

    const res = await publishNow(property.id, marketingToken);

    expect(res.status).toBe(409);
    expect((await jobOf(property.id)).status).toBe("DONE");
  });

  it("автопубликация выключена — честный отказ, очередь не трогается", async () => {
    const { property, slot } = await receivedProperty("Автопубликация выкл");
    await prisma.settings.update({ where: { id: "singleton" }, data: { autoPublishEnabled: false } });
    try {
      const res = await publishNow(property.id, marketingToken);
      expect(res.status).toBe(409);
      expect(res.body.error).toContain("Автопубликация выключена");
      expect((await jobOf(property.id)).runAt.getTime()).toBe(slot.getTime());
    } finally {
      await prisma.settings.update({ where: { id: "singleton" }, data: { autoPublishEnabled: true } });
    }
  });
});

describe("POST /properties/:id/publish-at — «Перенести»", () => {
  it("переносит и задание, и час на карточке, с причиной «вручную»", async () => {
    const { property } = await receivedProperty("Перенос");
    const target = new Date(Date.now() + 26 * 60 * 60 * 1000);
    target.setUTCSeconds(0, 0);

    const res = await publishAt(property.id, marketingToken, target.toISOString());

    expect(res.status).toBe(200);
    expect((await jobOf(property.id)).runAt.getTime()).toBe(target.getTime());
    const after = await prisma.property.findUniqueOrThrow({
      where: { id: property.id },
      select: { scheduledPublishAt: true, scheduledPublishReason: true },
    });
    expect(after.scheduledPublishAt!.getTime()).toBe(target.getTime());
    expect(after.scheduledPublishReason).toContain("вручную");
  });

  it("время в прошлом — 409 с подсказкой про «Опубликовать сейчас»", async () => {
    const { property, slot } = await receivedProperty("Перенос в прошлое");

    const res = await publishAt(property.id, marketingToken, new Date(Date.now() - 60_000).toISOString());

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("Опубликовать сейчас");
    expect((await jobOf(property.id)).runAt.getTime()).toBe(slot.getTime());
  });

  it("дальше месяца — 409", async () => {
    const { property } = await receivedProperty("Перенос далеко");
    const res = await publishAt(property.id, marketingToken, new Date(Date.now() + 40 * 86_400_000).toISOString());
    expect(res.status).toBe(409);
  });

  it("публикация уже идёт — переносить поздно, задание не трогается", async () => {
    const { property, slot } = await receivedProperty("Перенос во время публикации");
    await prisma.backgroundJob.update({
      where: { dedupeKey: videoHandoffPublishDedupeKey(property.id) },
      data: { status: "RUNNING", lockedAt: new Date(), lockedBy: "тест" },
    });

    const res = await publishAt(property.id, marketingToken, new Date(Date.now() + 3 * 3_600_000).toISOString());

    expect(res.status).toBe(409);
    expect((await jobOf(property.id)).runAt.getTime()).toBe(slot.getTime());
  });

  it("без времени — 400; обычный агент — 403", async () => {
    const { property } = await receivedProperty("Перенос проверки");
    expect((await publishAt(property.id, marketingToken, "завтра")).status).toBe(400);
    expect((await publishAt(property.id, plainAgentToken, new Date(Date.now() + 3_600_000 * 3).toISOString())).status).toBe(403);
  });
});

describe("GET /marketing/publish-schedule — состояние каждой строки очереди", () => {
  it("ждёт, публикуется, застряло — экран прячет кнопки у идущей публикации", async () => {
    const waiting = await receivedProperty("Очередь ждёт", 5);
    const running = await receivedProperty("Очередь публикуется", 6);
    const stuck = await receivedProperty("Очередь застряла", 7);
    await prisma.backgroundJob.update({
      where: { dedupeKey: videoHandoffPublishDedupeKey(running.property.id) },
      data: { status: "RUNNING", lockedAt: new Date(), lockedBy: "тест" },
    });
    await prisma.backgroundJob.update({
      where: { dedupeKey: videoHandoffPublishDedupeKey(stuck.property.id) },
      data: { status: "GIVEN_UP" },
    });

    const res = await request(app).get("/api/v1/marketing/publish-schedule").set("Authorization", `Bearer ${marketingToken}`);

    expect(res.status).toBe(200);
    const state = (id: string) =>
      (res.body.upcoming as { propertyId: string; jobState: string }[]).find((r) => r.propertyId === id)?.jobState;
    expect(state(waiting.property.id)).toBe("waiting");
    expect(state(running.property.id)).toBe("publishing");
    expect(state(stuck.property.id)).toBe("stuck");
  });
});
