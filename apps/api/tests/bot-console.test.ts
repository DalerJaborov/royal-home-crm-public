import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { grantElevation } from "../src/lib/stepUp.js";
import { learnedRulesBlock } from "../src/lib/botLessons.js";
import { buildCommentSystem, DEFAULT_COMMENT_PROMPT } from "../src/messengers/comments.js";

/**
 * Окно «Бот»: что видно снаружи и кто вправе это менять.
 *
 * Главное здесь — не список как таковой, а то, что текст отсюда уходит прямо в
 * промт бота. Значит правка обязана требовать и права настроек, и свежего
 * подтверждения личности: иначе чужой человек за незапертым ноутбуком меняет то,
 * что бот говорит клиентам.
 */

const runId = Date.now();
const password = "testpass123";
const MARKER = `консоль-бота-${runId}`;

/** Комментарий-заглушка для сборки промта: сам текст здесь не важен, важно, чей
 *  промт лёг в основу — свой из Настроек или зашитый по умолчанию. */
const PROMPT_INPUT = { text: "Чанд сомон?", authorName: "tester", isThreadReply: false, answered: 0 };

let adminToken: string;
let agentToken: string;
let adminId: string;
let agentId: string;
let noElevationId: string;
let noElevationToken: string;
let ruleId: string;
let questionId: string;
let digestId: string;
let proposalId: string;

async function login(phone: string, elevate: boolean) {
  const res = await request(app).post("/api/v1/auth/login").send({ phone, password });
  expect(res.status).toBe(200);
  if (elevate) {
    const agent = await prisma.agent.findUnique({ where: { phone }, select: { id: true } });
    if (agent) grantElevation(agent.id);
  }
  return res.body.accessToken as string;
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  const admin = await prisma.agent.create({
    data: { fullName: "Бот-Админ", phone: `+992970${runId}`, role: "ADMIN", passwordHash },
  });
  adminId = admin.id;
  const agent = await prisma.agent.create({
    data: { fullName: "Бот-Агент", phone: `+992971${runId}`, role: "AGENT", passwordHash },
  });
  agentId = agent.id;
  const noElevation = await prisma.agent.create({
    data: { fullName: "Бот-Админ без элевации", phone: `+992972${runId}`, role: "ADMIN", passwordHash },
  });
  noElevationId = noElevation.id;

  adminToken = await login(admin.phone, true);
  agentToken = await login(agent.phone, false);
  noElevationToken = await login(noElevation.phone, false);

  // Разобранный случай (правило) и неразобранный (вопрос к владельцу).
  const rule = await prisma.botLesson.create({
    data: {
      kind: "operator_override",
      channel: "WHATSAPP",
      botMessage: `бот-${runId} сказал невнятное`,
      humanMessage: `человек-${runId} ответил по делу`,
      lesson: MARKER,
      active: true,
    },
  });
  ruleId = rule.id;
  const question = await prisma.botLesson.create({
    data: {
      kind: "client_confused",
      channel: "INSTAGRAM",
      botMessage: `бот-${runId} сказал непонятное`,
      humanMessage: "не понял",
      lesson: null,
    },
  });
  questionId = question.id;

  // Недельная сводка по оборванным перепискам и её предложение — ВЫКЛЮЧЕННОЕ.
  // periodStart уникален по схеме, поэтому берём момент прогона.
  const digest = await prisma.lostClientDigest.create({
    data: {
      periodStart: new Date(runId),
      periodEnd: new Date(runId + 7 * 24 * 60 * 60 * 1000),
      lostCount: 3,
      wonCount: 1,
      stageCounts: { budget: 2, phone: 1 },
      reasonCounts: { silent: 3 },
    },
  });
  digestId = digest.id;
  const proposal = await prisma.botLesson.create({
    data: {
      kind: "lost_client",
      channel: "ALL",
      botMessage: `сводка-${runId}`,
      humanMessage: "Номер не оставил никто из них",
      lesson: `предложение-${runId}`,
      active: false,
      digestId: digest.id,
    },
  });
  proposalId = proposal.id;
});

afterAll(async () => {
  await prisma.botLesson.deleteMany({ where: { id: { in: [ruleId, questionId, proposalId] } } });
  await prisma.lostClientDigest.deleteMany({ where: { id: digestId } });
  await prisma.agent.deleteMany({ where: { id: { in: [adminId, agentId, noElevationId] } } });
});

describe("Окно «Бот» — доступ", () => {
  it("рядовой агент список не получает", async () => {
    const res = await request(app)
      .get("/api/v1/bot-learning")
      .set("Authorization", `Bearer ${agentToken}`);
    expect(res.status).toBe(403);
  });

  it("без токена — отказ", async () => {
    const res = await request(app).get("/api/v1/bot-learning");
    expect(res.status).toBe(401);
  });

  it("правку без свежего подтверждения личности не принимаем (428)", async () => {
    const res = await request(app)
      .patch(`/api/v1/bot-learning/${ruleId}`)
      .set("Authorization", `Bearer ${noElevationToken}`)
      .send({ active: false });
    expect(res.status).toBe(428);
    expect(res.body.stepUpRequired).toBe(true);
  });
});

describe("Окно «Бот» — правила и вопросы", () => {
  it("правило попадает в ленту правил, неразобранный случай — в вопросы", async () => {
    const res = await request(app)
      .get("/api/v1/bot-learning")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const rule = res.body.rules.find((r: { id: string }) => r.id === ruleId);
    expect(rule?.lesson).toBe(MARKER);
    // Первоисточник обязан приходить вместе с правилом: без него выключать вслепую.
    expect(rule?.botMessage).toContain(`бот-${runId}`);
    expect(res.body.questions.some((q: { id: string }) => q.id === questionId)).toBe(true);
    expect(res.body.rules.some((r: { id: string }) => r.id === questionId)).toBe(false);
  });

  it("выключенное правило уходит из промта бота", async () => {
    expect(await learnedRulesBlock()).toContain(MARKER);

    const res = await request(app)
      .patch(`/api/v1/bot-learning/${ruleId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ active: false });
    expect(res.status).toBe(200);
    expect(res.body.active).toBe(false);

    expect(await learnedRulesBlock()).not.toContain(MARKER);
  });

  it("ответ владельца превращает вопрос в действующую подсказку", async () => {
    const answer = `отвечай коротко ${runId}`;
    const res = await request(app)
      .patch(`/api/v1/bot-learning/${questionId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ lesson: answer });
    expect(res.status).toBe(200);
    expect(res.body.lesson).toBe(answer);
    // Свой ответ включается сразу — он для того и написан.
    expect(res.body.active).toBe(true);
    expect(await learnedRulesBlock()).toContain(answer);

    const list = await request(app)
      .get("/api/v1/bot-learning")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(list.body.questions.some((q: { id: string }) => q.id === questionId)).toBe(false);
    expect(list.body.rules.some((r: { id: string }) => r.id === questionId)).toBe(true);
  });

  it("пустой ответ возвращает случай в вопросы и не пускает прочерк в промт", async () => {
    const res = await request(app)
      .patch(`/api/v1/bot-learning/${questionId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ lesson: "   " });
    expect(res.status).toBe(200);
    expect(res.body.active).toBe(false);

    const list = await request(app)
      .get("/api/v1/bot-learning")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(list.body.questions.some((q: { id: string }) => q.id === questionId)).toBe(true);
  });

  it("пустое тело правки отклоняется", async () => {
    const res = await request(app)
      .patch(`/api/v1/bot-learning/${ruleId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    expect(res.status).toBe(400);
  });
});

/**
 * Сводка «куда уходят клиенты». Проверяем ровно то, ради чего она отделена от
 * обычного обучения: предложение из слабого сигнала не действует, пока владелец
 * его не включил, и до этого момента не выдаёт себя за выученное правило.
 */
describe("Недельная сводка по оборванным перепискам", () => {
  it("рядовому агенту сводки не видны", async () => {
    const res = await request(app)
      .get("/api/v1/bot-learning/lost")
      .set("Authorization", `Bearer ${agentToken}`);
    expect(res.status).toBe(403);
  });

  it("сводка приходит с числами, примерами и выключенным предложением", async () => {
    const res = await request(app)
      .get("/api/v1/bot-learning/lost")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const digest = res.body.digests.find((d: { id: string }) => d.id === digestId);
    expect(digest).toBeDefined();
    expect(digest.lostCount).toBe(3);
    expect(digest.stageCounts.budget).toBe(2);
    expect(digest.proposals[0].id).toBe(proposalId);
    expect(digest.proposals[0].active).toBe(false);
  });

  it("невключённое предложение не выдаёт себя за выученное правило", async () => {
    const list = await request(app)
      .get("/api/v1/bot-learning")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(list.body.rules.some((r: { id: string }) => r.id === proposalId)).toBe(false);
    // И в «вопросах» ему тоже не место: правило есть, спрашивать нечего.
    expect(list.body.questions.some((q: { id: string }) => q.id === proposalId)).toBe(false);
    expect(await learnedRulesBlock()).not.toContain(`предложение-${runId}`);
  });

  it("после включения владельцем становится обычным действующим правилом", async () => {
    const res = await request(app)
      .patch(`/api/v1/bot-learning/${proposalId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ active: true });
    expect(res.status).toBe(200);

    expect(await learnedRulesBlock()).toContain(`предложение-${runId}`);
    const list = await request(app)
      .get("/api/v1/bot-learning")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(list.body.rules.some((r: { id: string }) => r.id === proposalId)).toBe(true);
  });
});

/**
 * Удаление правила. Выключенное правило остаётся в списке навсегда, поэтому
 * удаление нужно; но оно необратимо — вместе с правилом уходит первоисточник.
 * Значит требования те же, что у правки: право настроек и свежее подтверждение
 * личности, а чужому — отказ.
 */
describe("Удаление правила", () => {
  /** Отдельная запись на каждый прогон: удаление разрушительно, и трогать
   *  правило, на котором стоят соседние проверки, нельзя. */
  async function makeDisposableRule() {
    const rule = await prisma.botLesson.create({
      data: {
        kind: "operator_override",
        channel: "TELEGRAM",
        botMessage: `бот-удаляемое-${runId}`,
        humanMessage: `человек-удаляемое-${runId}`,
        lesson: `удаляемое-правило-${runId}`,
        active: true,
      },
    });
    return rule.id;
  }

  it("рядовой агент удалить не может", async () => {
    const id = await makeDisposableRule();
    const res = await request(app)
      .delete(`/api/v1/bot-learning/${id}`)
      .set("Authorization", `Bearer ${agentToken}`);
    expect(res.status).toBe(403);
    expect(await prisma.botLesson.findUnique({ where: { id } })).not.toBeNull();
    await prisma.botLesson.delete({ where: { id } });
  });

  it("без свежего подтверждения личности — 428, запись на месте", async () => {
    const id = await makeDisposableRule();
    const res = await request(app)
      .delete(`/api/v1/bot-learning/${id}`)
      .set("Authorization", `Bearer ${noElevationToken}`);
    expect(res.status).toBe(428);
    expect(await prisma.botLesson.findUnique({ where: { id } })).not.toBeNull();
    await prisma.botLesson.delete({ where: { id } });
  });

  it("удалённое правило исчезает и из списка, и из промта бота", async () => {
    const id = await makeDisposableRule();
    expect(await learnedRulesBlock()).toContain(`удаляемое-правило-${runId}`);

    const res = await request(app)
      .delete(`/api/v1/bot-learning/${id}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);

    expect(await prisma.botLesson.findUnique({ where: { id } })).toBeNull();
    expect(await learnedRulesBlock()).not.toContain(`удаляемое-правило-${runId}`);
    const list = await request(app).get("/api/v1/bot-learning").set("Authorization", `Bearer ${adminToken}`);
    expect(list.body.rules.some((r: { id: string }) => r.id === id)).toBe(false);
  });

  it("повторное удаление — 404, а не 500", async () => {
    const res = await request(app)
      .delete("/api/v1/bot-learning/11111111-1111-1111-1111-111111111111")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
  });
});

/**
 * Промт ответов на комментарии в Настройках. Главное здесь — что означает пустое
 * поле: «вернуть зашитый по умолчанию», а не «отвечай без инструкций». Очищенное
 * поле со вторым смыслом сломало бы ответы под постами молча.
 */
describe("Промт комментариев в Настройках", () => {
  const custom = `Отвечай только цифрами ${runId}`;

  it("свой текст сохраняется и помечается изменённым", async () => {
    const res = await request(app)
      .patch("/api/v1/settings")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ botCommentPrompt: custom });
    expect(res.status).toBe(200);
    expect(res.body.botCommentPrompt).toBe(custom);
    expect(res.body.botCommentPromptIsCustom).toBe(true);

    // И бот берёт именно его, а не зашитый.
    expect(buildCommentSystem(PROMPT_INPUT, {}, custom)).toContain(custom);
  });

  it("очистка возвращает зашитый по умолчанию, а не пустой промт", async () => {
    const res = await request(app)
      .patch("/api/v1/settings")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ botCommentPrompt: "   " });
    expect(res.status).toBe(200);
    expect(res.body.botCommentPromptIsCustom).toBe(false);
    expect(res.body.botCommentPrompt).toBe(DEFAULT_COMMENT_PROMPT);

    // В базе именно null: пустая строка означала бы «инструкций нет».
    const saved = await prisma.settings.findUnique({
      where: { id: "singleton" },
      select: { botCommentPrompt: true },
    });
    expect(saved?.botCommentPrompt).toBeNull();
  });

  it("рядовой агент промт комментариев не видит и не меняет", async () => {
    const read = await request(app).get("/api/v1/settings").set("Authorization", `Bearer ${agentToken}`);
    expect(read.status).toBe(200);
    expect(read.body.botCommentPrompt).toBeUndefined();

    const write = await request(app)
      .patch("/api/v1/settings")
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ botCommentPrompt: "что угодно" });
    expect(write.status).toBe(403);
  });
});

describe("Пауза и окно напоминаний в Настройках", () => {
  it("потолок ожидания ниже паузы не принимается", async () => {
    const res = await request(app)
      .patch("/api/v1/settings")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ botReplyDelaySec: 30, botReplyMaxWaitSec: 10 });
    expect(res.status).toBe(400);
  });

  it("конец окна напоминаний раньше начала не принимается", async () => {
    const res = await request(app)
      .patch("/api/v1/settings")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ followUpWindowStart: "21:00", followUpWindowEnd: "08:00" });
    expect(res.status).toBe(400);
  });

  it("осмысленные значения сохраняются", async () => {
    const before = await prisma.settings.findUnique({
      where: { id: "singleton" },
      select: {
        botReplyDelaySec: true,
        botReplyMaxWaitSec: true,
        followUpWindowStart: true,
        followUpWindowEnd: true,
        followUpEnabled: true,
      },
    });
    const res = await request(app)
      .patch("/api/v1/settings")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ botReplyDelaySec: 20, botReplyMaxWaitSec: 80, followUpWindowStart: "09:00", followUpWindowEnd: "19:00" });
    expect(res.status).toBe(200);
    expect(res.body.botReplyDelaySec).toBe(20);
    expect(res.body.followUpWindowEnd).toBe("19:00");
    // Возвращаем как было: настройки одни на всю базу, и следующий тест не должен
    // унаследовать чужие значения.
    if (before) {
      await prisma.settings.update({ where: { id: "singleton" }, data: before });
    }
  });
});
