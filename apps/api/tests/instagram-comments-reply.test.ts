import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { waitFor } from "./helpers/waitFor.js";

/**
 * Ручной ответ на комментарий Instagram прямо из CRM (POST /instagram-comments/:id/reply,
 * владелец 15.09.2026) — там, где бот спасовал (ESCALATED), сотрудник больше не идёт
 * отвечать в само приложение Instagram.
 *
 * Graph API подменён: тест не ходит в Meta и не зависит от её доступности.
 */

const runId = Date.now().toString(36);
const password = "testpass123";

let directorToken = "";
let agentToken = "";
let directorId = "";
let agentId = "";

let graphCalls: { url: string; body: Record<string, unknown> }[] = [];
let graphOk = true;
/** Задержка ответа подменённой Meta: держит первый POST «в полёте», пока идёт второй. */
let graphDelayMs = 0;
/** Тело ответа подменённой Meta при отказе — разные тексты проверяют разные
 *  человекочитаемые сообщения (окно истекло / комментарий удалён / нет прав). */
let graphErrorText = "Invalid OAuth access token";

const savedIgToken = process.env.META_IG_TOKEN;

async function login(phone: string) {
  const res = await request(app).post("/api/v1/auth/login").send({ phone, password });
  expect(res.status).toBe(200);
  return res.body.accessToken as string;
}

async function makeComment(suffix: string, data: Record<string, unknown> = {}) {
  return prisma.instagramComment.create({
    data: {
      commentId: `reply-${runId}-${suffix}`,
      mediaId: `media-${runId}`,
      authorId: `author-${runId}`,
      authorName: `tester_${runId}`,
      text: `Комментарий ${suffix}`,
      replyDueAt: new Date(),
      ...data,
    },
  });
}

beforeAll(async () => {
  process.env.META_IG_TOKEN = "test-ig-token";
  const passwordHash = await bcrypt.hash(password, 10);

  const director = await prisma.agent.create({
    data: { fullName: "Тест Директор ответ", phone: `+992974${runId}`, role: "DIRECTOR", passwordHash },
  });
  directorId = director.id;
  const agent = await prisma.agent.create({
    data: { fullName: "Тест Агент ответ", phone: `+992975${runId}`, role: "AGENT", passwordHash },
  });
  agentId = agent.id;

  directorToken = await login(director.phone);
  agentToken = await login(agent.phone);
});

afterAll(async () => {
  await prisma.instagramComment.deleteMany({ where: { commentId: { startsWith: `reply-${runId}` } } });
  await prisma.auditLog.deleteMany({ where: { agentId: { in: [directorId, agentId] } } });
  await prisma.agent.deleteMany({ where: { id: { in: [directorId, agentId] } } });
  if (savedIgToken === undefined) delete process.env.META_IG_TOKEN;
  else process.env.META_IG_TOKEN = savedIgToken;
});

beforeEach(() => {
  graphCalls = [];
  graphOk = true;
  graphDelayMs = 0;
  graphErrorText = "Invalid OAuth access token";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown, init?: { body?: unknown }) => {
      graphCalls.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
      if (graphDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, graphDelayMs));
      const text = graphOk ? JSON.stringify({ id: `reply-id-${runId}` }) : graphErrorText;
      return {
        ok: graphOk,
        status: graphOk ? 200 : 400,
        text: async () => text,
        json: async () => JSON.parse(text),
      } as unknown as Response;
    })
  );
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await prisma.instagramComment.deleteMany({ where: { commentId: { startsWith: `reply-${runId}` } } });
});

describe("право на ручной ответ", () => {
  it("рядовой агент отвечать не может", async () => {
    const row = await makeComment("acl", { status: "ESCALATED" });
    const res = await request(app)
      .post(`/api/v1/instagram-comments/${row.id}/reply`)
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ text: "Ответ" });
    expect(res.status).toBe(403);
    expect(graphCalls).toHaveLength(0);
  });

  it("без входа — отказ", async () => {
    const row = await makeComment("noauth", { status: "ESCALATED" });
    const res = await request(app).post(`/api/v1/instagram-comments/${row.id}/reply`).send({ text: "Ответ" });
    expect(res.status).toBe(401);
  });
});

describe("валидация", () => {
  it("пустой текст отвергается", async () => {
    const row = await makeComment("empty", { status: "ESCALATED" });
    const res = await request(app)
      .post(`/api/v1/instagram-comments/${row.id}/reply`)
      .set("Authorization", `Bearer ${directorToken}`)
      .send({ text: "   " });
    expect(res.status).toBe(400);
    expect(graphCalls).toHaveLength(0);
  });

  it("слишком длинный текст отвергается", async () => {
    const row = await makeComment("toolong", { status: "ESCALATED" });
    const res = await request(app)
      .post(`/api/v1/instagram-comments/${row.id}/reply`)
      .set("Authorization", `Bearer ${directorToken}`)
      .send({ text: "a".repeat(2201) });
    expect(res.status).toBe(400);
    expect(graphCalls).toHaveLength(0);
  });

  it("чужой идентификатор — 404, а не 500", async () => {
    const res = await request(app)
      .post("/api/v1/instagram-comments/11111111-1111-1111-1111-111111111111/reply")
      .set("Authorization", `Bearer ${directorToken}`)
      .send({ text: "Ответ" });
    expect(res.status).toBe(404);
  });
});

describe("успешная публикация", () => {
  it("отвечает через Graph API, обновляет статус и помечает ответ ручным", async () => {
    const row = await makeComment("ok", { status: "ESCALATED", note: "спрашивают про рассрочку" });
    const res = await request(app)
      .post(`/api/v1/instagram-comments/${row.id}/reply`)
      .set("Authorization", `Bearer ${directorToken}`)
      .send({ text: "Рассрочка возможна, уточним детали в личных сообщениях" });
    expect(res.status).toBe(200);

    // Главное: ответ ушёл в Instagram, а не только в нашу таблицу.
    expect(graphCalls).toHaveLength(1);
    expect(graphCalls[0].url).toContain(encodeURIComponent(row.commentId));
    expect(graphCalls[0].body.message).toBe("Рассрочка возможна, уточним детали в личных сообщениях");

    const saved = await prisma.instagramComment.findUnique({ where: { id: row.id } });
    expect(saved!.status).toBe("REPLIED");
    expect(saved!.replyText).toBe("Рассрочка возможна, уточним детали в личных сообщениях");
    expect(saved!.repliedAt).not.toBeNull();
    // Отличаем от ответа бота тем же полем note, что и остальные исходы (manual_hide,
    // ai_down и т.п.) — без миграции схемы.
    expect(saved!.note).toBe("manual_reply");
  });

  it("попадает в журнал действий — это публичный ответ от имени компании", async () => {
    const row = await makeComment("audit", { status: "ESCALATED" });
    await request(app)
      .post(`/api/v1/instagram-comments/${row.id}/reply`)
      .set("Authorization", `Bearer ${directorToken}`)
      .send({ text: "Ответ для журнала" })
      .expect(200);

    const entry = await waitFor(
      () => prisma.auditLog.findFirst({ where: { action: "IG_COMMENT_REPLY", entityId: row.id } }),
      { label: "запись IG_COMMENT_REPLY в журнале действий" }
    );
    expect(entry).not.toBeNull();
    expect(entry!.agentId).toBe(directorId);
  });
});

describe("отказы Meta — понятный русский текст, а не общая ошибка", () => {
  it("комментарий удалён/недоступен — переиспользует isCommentGone", async () => {
    const row = await makeComment("gone", { status: "ESCALATED" });
    graphOk = false;
    graphErrorText =
      '{"error":{"message":"(#100) Object with ID \'x\' does not exist, cannot be loaded due to missing permissions, or does not support this operation","code":100}}';
    const res = await request(app)
      .post(`/api/v1/instagram-comments/${row.id}/reply`)
      .set("Authorization", `Bearer ${directorToken}`)
      .send({ text: "Ответ" });
    expect(res.status).toBe(502);
    expect(res.body.error).toContain("удалён или недоступен");

    const saved = await prisma.instagramComment.findUnique({ where: { id: row.id } });
    expect(saved!.status).toBe("ESCALATED");
    expect(saved!.replyText).toBeNull();
  });

  it("нет прав доступа — понятный текст про маркер", async () => {
    const row = await makeComment("perm", { status: "ESCALATED" });
    graphOk = false;
    graphErrorText = '{"error":{"message":"(#200) Permissions error, OAuthException","code":200}}';
    const res = await request(app)
      .post(`/api/v1/instagram-comments/${row.id}/reply`)
      .set("Authorization", `Bearer ${directorToken}`)
      .send({ text: "Ответ" });
    expect(res.status).toBe(502);
    expect(res.body.error).toContain("правам доступа");
  });

  it("окно ответа истекло — понятный текст, а не сырой JSON Meta", async () => {
    const row = await makeComment("window", { status: "ESCALATED" });
    graphOk = false;
    graphErrorText = '{"error":{"message":"This comment reply window has expired","code":190}}';
    const res = await request(app)
      .post(`/api/v1/instagram-comments/${row.id}/reply`)
      .set("Authorization", `Bearer ${directorToken}`)
      .send({ text: "Ответ" });
    expect(res.status).toBe(502);
    expect(res.body.error).toContain("Окно ответа");
  });
});

describe("защита от параллельной обработки", () => {
  it("комментарий в работе у бота трогать нельзя", async () => {
    const row = await makeComment("working", { status: "WORKING" });
    const res = await request(app)
      .post(`/api/v1/instagram-comments/${row.id}/reply`)
      .set("Authorization", `Bearer ${directorToken}`)
      .send({ text: "Ответ" });
    expect(res.status).toBe(409);
    expect(graphCalls).toHaveLength(0);
  });

  it("скрытый комментарий — сначала вернуть подписчикам", async () => {
    const row = await makeComment("hidden", { status: "HIDDEN", hiddenAt: new Date() });
    const res = await request(app)
      .post(`/api/v1/instagram-comments/${row.id}/reply`)
      .set("Authorization", `Bearer ${directorToken}`)
      .send({ text: "Ответ" });
    expect(res.status).toBe(409);
    expect(graphCalls).toHaveLength(0);
  });
});

describe("два одновременных ответа на один комментарий (старый путь без origin)", () => {
  it("публичный ответ уходит один раз, проигравший получает 409", async () => {
    const row = await makeComment("race", { status: "ESCALATED" });
    graphDelayMs = 300;
    const send = (text: string) =>
      request(app).post(`/api/v1/instagram-comments/${row.id}/reply`).set("Authorization", `Bearer ${directorToken}`).send({ text });
    const [a, b] = await Promise.all([send("Первый ответ"), send("Второй ответ")]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(graphCalls).toHaveLength(1);
    const saved = await prisma.instagramComment.findUnique({ where: { id: row.id } });
    expect(saved!.status).toBe("REPLIED");
  });

  it("отказ Meta возвращает прежний статус — ответ можно повторить", async () => {
    const row = await makeComment("revert", { status: "ESCALATED" });
    graphOk = false;
    const res = await request(app)
      .post(`/api/v1/instagram-comments/${row.id}/reply`)
      .set("Authorization", `Bearer ${directorToken}`)
      .send({ text: "Ответ" });
    expect(res.status).toBe(502);
    const saved = await prisma.instagramComment.findUnique({ where: { id: row.id } });
    expect(saved!.status).toBe("ESCALATED");
  });
});
