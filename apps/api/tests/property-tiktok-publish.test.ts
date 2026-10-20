import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";

/**
 * POST /properties/:id/tiktok-publish (17.09.2026) — ручная публикация готового
 * ролика в TikTok с карточки объекта. Нужна для демо-видео на ревью приложения
 * TikTok (реальный клик в интерфейсе) и для повторной отправки, когда объект
 * уже опубликован в остальных каналах. publishApprovedPost подменена — тест не
 * ходит в реальный TikTok, проверяется только маршрутизация/условия/запись.
 */

const { publishApprovedPost } = vi.hoisted(() => ({
  publishApprovedPost: vi.fn(async () => [{ channel: "TIKTOK", ok: true, note: undefined, error: undefined }]),
}));
vi.mock("../src/lib/socialPublish.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/socialPublish.js")>()),
  publishApprovedPost,
}));

const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");
const { deleteAgentsWithTraces } = await import("./helpers/cleanupAgents.js");
const { videoHandoffPublishDedupeKey, VIDEO_HANDOFF_PUBLISH_JOB_TYPE } = await import("../src/lib/videoHandoff.js");
const { tiktokPublishRetryDedupeKey, TIKTOK_PUBLISH_RETRY_JOB_TYPE } = await import("../src/jobs/tiktokPublishRetryPolicy.js");

const runId = Date.now();
const password = "testpass123";

let districtId: string;
let marketingToken: string;
let plainAgentToken: string;
let savedSettings: { tiktokRefreshToken: string | null; tiktokPrivacyLevel: string | null };
const propertyIds: string[] = [];
const agentIds: string[] = [];

async function login(phone: string) {
  const res = await request(app).post("/api/v1/auth/login").send({ phone, password });
  expect(res.status).toBe(200);
  return res.body.accessToken as string;
}

async function makeProperty(title: string, data: Record<string, unknown> = {}) {
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
  districtId = (await prisma.district.create({ data: { name: `Тест-район-tiktok-publish-${runId}` } })).id;

  const marketing = await prisma.agent.create({
    data: { fullName: "Маркетолог TikTok-теста", phone: `+992974${runId}`, role: "MARKETING", passwordHash },
  });
  agentIds.push(marketing.id);
  marketingToken = await login(marketing.phone);

  const plain = await prisma.agent.create({
    data: { fullName: "Обычный агент TikTok-теста", phone: `+992975${runId}`, role: "AGENT", passwordHash },
  });
  agentIds.push(plain.id);
  plainAgentToken = await login(plain.phone);

  const current = await prisma.settings.upsert({
    where: { id: "singleton" },
    update: {},
    create: { id: "singleton" },
  });
  savedSettings = { tiktokRefreshToken: current.tiktokRefreshToken, tiktokPrivacyLevel: current.tiktokPrivacyLevel };
});

afterAll(async () => {
  await prisma.settings.update({ where: { id: "singleton" }, data: savedSettings });
  await prisma.backgroundJob.deleteMany({
    where: { dedupeKey: { in: propertyIds.flatMap((id) => [videoHandoffPublishDedupeKey(id), tiktokPublishRetryDedupeKey(id)]) } },
  });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await deleteAgentsWithTraces(agentIds);
  await prisma.district.delete({ where: { id: districtId } }).catch(() => {});
  await prisma.$disconnect();
});

function publish(id: string, token: string) {
  return request(app).post(`/api/v1/properties/${id}/tiktok-publish`).set("Authorization", `Bearer ${token}`);
}

describe("POST /properties/:id/tiktok-publish", () => {
  it("нет videoHandoffFinalPath — 409, publishApprovedPost не вызывается", async () => {
    await prisma.settings.update({
      where: { id: "singleton" },
      data: { tiktokRefreshToken: "encrypted-doesnt-matter-for-this-check", tiktokPrivacyLevel: "SELF_ONLY" },
    });
    const p = await makeProperty("Без ролика");
    publishApprovedPost.mockClear();
    const res = await publish(p.id, marketingToken);
    expect(res.status).toBe(409);
    expect(res.body.error).toContain("ролик");
    expect(publishApprovedPost).not.toHaveBeenCalled();
  });

  it("TikTok не подключён (нет tiktokRefreshToken) — 409, понятный текст", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { tiktokRefreshToken: null } });
    const p = await makeProperty("Ролик есть, TikTok не подключён", { videoHandoffFinalPath: "/uploads/handoff/x.mp4" });
    publishApprovedPost.mockClear();
    const res = await publish(p.id, marketingToken);
    expect(res.status).toBe(409);
    expect(res.body.error).toContain("не подключён");
    expect(publishApprovedPost).not.toHaveBeenCalled();
  });

  it("уровень приватности не выбран — 409, понятный текст", async () => {
    await prisma.settings.update({
      where: { id: "singleton" },
      data: { tiktokRefreshToken: "encrypted-doesnt-matter", tiktokPrivacyLevel: null },
    });
    const p = await makeProperty("Ролик есть, приватность не выбрана", { videoHandoffFinalPath: "/uploads/handoff/y.mp4" });
    publishApprovedPost.mockClear();
    const res = await publish(p.id, marketingToken);
    expect(res.status).toBe(409);
    expect(res.body.error).toContain("приватности");
    expect(publishApprovedPost).not.toHaveBeenCalled();
  });

  it("успех — publishApprovedPost вызван с skipChannels без TIKTOK, publishedChannels содержит TIKTOK", async () => {
    await prisma.settings.update({
      where: { id: "singleton" },
      data: { tiktokRefreshToken: "encrypted-doesnt-matter", tiktokPrivacyLevel: "SELF_ONLY" },
    });
    const p = await makeProperty("Готов к TikTok", {
      videoHandoffFinalPath: "/uploads/handoff/z.mp4",
      publishedChannels: ["INSTAGRAM", "TELEGRAM"],
    });
    publishApprovedPost.mockClear();
    publishApprovedPost.mockResolvedValueOnce([{ channel: "TIKTOK", ok: true, note: undefined, error: undefined }]);
    const res = await publish(p.id, marketingToken);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    expect(publishApprovedPost).toHaveBeenCalledTimes(1);
    const call = publishApprovedPost.mock.calls[0][0] as { skipChannels: string[] };
    expect(call.skipChannels).not.toContain("TIKTOK");
    expect(call.skipChannels.sort()).toEqual(["FACEBOOK", "INSTAGRAM", "TELEGRAM", "THREADS", "YOUTUBE"]);

    const fresh = await prisma.property.findUnique({ where: { id: p.id }, select: { publishedChannels: true } });
    expect(fresh?.publishedChannels).toEqual(expect.arrayContaining(["INSTAGRAM", "TELEGRAM", "TIKTOK"]));
  });

  it("отказ TikTok (ok:false) — 200 с error, publishedChannels НЕ трогается", async () => {
    await prisma.settings.update({
      where: { id: "singleton" },
      data: { tiktokRefreshToken: "encrypted-doesnt-matter", tiktokPrivacyLevel: "SELF_ONLY" },
    });
    const p = await makeProperty("TikTok отказал", {
      videoHandoffFinalPath: "/uploads/handoff/w.mp4",
      publishedChannels: ["INSTAGRAM"],
    });
    publishApprovedPost.mockClear();
    publishApprovedPost.mockResolvedValueOnce([{ channel: "TIKTOK", ok: false, error: "TikTok отклонил публикацию: internal" }]);
    const res = await publish(p.id, marketingToken);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toContain("internal");
    const fresh = await prisma.property.findUnique({ where: { id: p.id }, select: { publishedChannels: true } });
    expect(fresh?.publishedChannels).toEqual(["INSTAGRAM"]);
  });

  it("успех с note (черновики) — прокидывается в ответ как есть", async () => {
    await prisma.settings.update({
      where: { id: "singleton" },
      data: { tiktokRefreshToken: "encrypted-doesnt-matter", tiktokPrivacyLevel: "SELF_ONLY" },
    });
    const p = await makeProperty("TikTok ушёл в черновики", { videoHandoffFinalPath: "/uploads/handoff/n.mp4" });
    publishApprovedPost.mockClear();
    publishApprovedPost.mockResolvedValueOnce([{ channel: "TIKTOK", ok: true, note: "ролик отправлен в черновики TikTok" }]);
    const res = await publish(p.id, marketingToken);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.note).toContain("черновики");
  });

  it("объект не найден — 404", async () => {
    const res = await publish("00000000-0000-0000-0000-000000000000", marketingToken);
    expect(res.status).toBe(404);
  });

  it("удалённый объект — 404, не 409", async () => {
    const p = await makeProperty("Удалённый", { videoHandoffFinalPath: "/uploads/handoff/d.mp4", deletedAt: new Date() });
    const res = await publish(p.id, marketingToken);
    expect(res.status).toBe(404);
  });

  it("роль без прав маркетинга (обычный агент) — 403", async () => {
    const p = await makeProperty("Чужие права", { videoHandoffFinalPath: "/uploads/handoff/e.mp4" });
    const res = await publish(p.id, plainAgentToken);
    expect(res.status).toBe(403);
  });
});

/**
 * БЕЗ ДУБЛЯ В TIKTOK (24.09.2026, владелец: «чтобы не было дубликата… со всех
 * сторон»). TikTok не даёт удалять вышедшее, поэтому второй ролик остался бы
 * там навсегда. Кнопка в карточке прячется у вышедшего, но карточка бывает
 * устаревшей — отказывает сервер.
 */
describe("POST /properties/:id/tiktok-publish — второй раз не публикует", () => {
  async function ready(title: string, data: Record<string, unknown> = {}) {
    await prisma.settings.update({
      where: { id: "singleton" },
      data: { tiktokRefreshToken: "encrypted-doesnt-matter", tiktokPrivacyLevel: "SELF_ONLY" },
    });
    return makeProperty(title, { videoHandoffFinalPath: "/uploads/handoff/dup.mp4", ...data });
  }

  it("TikTok уже в publishedChannels — 409, в TikTok не идём", async () => {
    const p = await ready("Уже в TikTok", { publishedChannels: ["TIKTOK"] });
    publishApprovedPost.mockClear();
    const res = await publish(p.id, marketingToken);
    expect(res.status).toBe(409);
    expect(res.body.error).toContain("уже вышел в TikTok");
    expect(publishApprovedPost).not.toHaveBeenCalled();
  });

  it("идёт публикация по расписанию — 409, ждём её", async () => {
    const p = await ready("Идёт публикация");
    await prisma.backgroundJob.create({
      data: { type: VIDEO_HANDOFF_PUBLISH_JOB_TYPE, payload: { propertyId: p.id }, maxAttempts: 3, dedupeKey: videoHandoffPublishDedupeKey(p.id), status: "RUNNING" },
    });
    publishApprovedPost.mockClear();
    const res = await publish(p.id, marketingToken);
    expect(res.status).toBe(409);
    expect(res.body.error).toContain("уже идёт");
    expect(publishApprovedPost).not.toHaveBeenCalled();
  });

  it("идёт отложенный повтор TikTok — 409", async () => {
    const p = await ready("Идёт повтор");
    await prisma.backgroundJob.create({
      data: { type: TIKTOK_PUBLISH_RETRY_JOB_TYPE, payload: { propertyId: p.id }, maxAttempts: 3, dedupeKey: tiktokPublishRetryDedupeKey(p.id), status: "RUNNING" },
    });
    publishApprovedPost.mockClear();
    const res = await publish(p.id, marketingToken);
    expect(res.status).toBe(409);
    expect(publishApprovedPost).not.toHaveBeenCalled();
  });

  it("публикация ждёт своего часа (PENDING) — не мешает, TikTok уходит сейчас", async () => {
    const p = await ready("Ждёт часа");
    await prisma.backgroundJob.create({
      data: { type: VIDEO_HANDOFF_PUBLISH_JOB_TYPE, payload: { propertyId: p.id }, maxAttempts: 3, dedupeKey: videoHandoffPublishDedupeKey(p.id), runAt: new Date(Date.now() + 3_600_000) },
    });
    publishApprovedPost.mockClear();
    const res = await publish(p.id, marketingToken);
    expect(res.status).toBe(200);
    expect(publishApprovedPost).toHaveBeenCalledTimes(1);
  });

  it("два нажатия подряд, пока первое ещё публикует, — в TikTok уходит один ролик", async () => {
    const p = await ready("Двойное нажатие");
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    publishApprovedPost.mockClear();
    publishApprovedPost.mockImplementationOnce(async () => {
      await gate;
      return [{ channel: "TIKTOK", ok: true, postId: "v_dup_1", note: undefined, error: undefined }];
    });
    const first = publish(p.id, marketingToken).then((r) => r);
    await vi.waitFor(() => expect(publishApprovedPost).toHaveBeenCalledTimes(1));
    const second = await publish(p.id, marketingToken);
    release();
    const firstRes = await first;

    expect(firstRes.status).toBe(200);
    expect(second.status).toBe(409);
    expect(publishApprovedPost).toHaveBeenCalledTimes(1);
    // Успех записан вместе с id поста — по нему карточка находит ссылку на ролик.
    const fresh = await prisma.property.findUniqueOrThrow({ where: { id: p.id }, select: { publishedChannels: true, publishedPostIds: true } });
    expect(fresh.publishedChannels).toContain("TIKTOK");
    expect((fresh.publishedPostIds as Record<string, string>).TIKTOK).toBe("v_dup_1");
    // И третье нажатие после ответа — уже «вышел».
    expect((await publish(p.id, marketingToken)).status).toBe(409);
  });
});
