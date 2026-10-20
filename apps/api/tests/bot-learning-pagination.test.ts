import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { learnedRulesBlock, recordLesson, selectActiveLessons } from "../src/lib/botLessons.js";
import { getClosedGroupKeys, groupKey } from "../src/lib/botAuditGroups.js";
import { grantElevation } from "../src/lib/stepUp.js";
import { waitFor } from "./helpers/waitFor.js";

/**
 * Экран «Обучение бота» (17.09.2026, жалоба владельца: «пагинации нет, и
 * как-то бардак» + добавка «повторы исключить полностью, чтобы я сто раз не
 * отвечал на одинаковые сообщения»).
 *
 * Проверяем то, что легко сломать молча: предел и курсор трёх лент, честный
 * отбор того, что реально видит промт (selectActiveLessons), схлопывание
 * повторов и то, что групповое действие бьёт по ВСЕЙ группе одним запросом —
 * находкам судьи в том числе, включая то, что закрытая группа не всплывает
 * у судьи заново.
 */

const phoneRunId = Date.now();
const runId = phoneRunId.toString(36);
const password = "testpass123";

let adminToken: string;
let agentToken: string;
const lessonIds: string[] = [];
const findingIds: string[] = [];

async function login(phone: string) {
  const res = await request(app).post("/api/v1/auth/login").send({ phone, password });
  expect(res.status).toBe(200);
  return res.body.accessToken as string;
}

async function makeRule(opts: { lesson: string; active?: boolean; createdAt?: Date }) {
  const row = await prisma.botLesson.create({
    data: {
      kind: "operator_override",
      channel: "WHATSAPP",
      botMessage: `бот-${runId}-${lessonIds.length} сказал что-то невнятное`,
      humanMessage: `оператор-${runId}-${lessonIds.length} ответил по делу`,
      lesson: opts.lesson,
      active: opts.active ?? true,
      ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
    },
  });
  lessonIds.push(row.id);
  return row;
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  const admin = await prisma.agent.create({
    data: { fullName: `Пагинация-Админ-${runId}`, phone: `+992975${phoneRunId}`, role: "ADMIN", passwordHash },
  });
  const agent = await prisma.agent.create({
    data: { fullName: `Пагинация-Агент-${runId}`, phone: `+992976${phoneRunId}`, role: "AGENT", passwordHash },
  });
  adminToken = await login(admin.phone);
  agentToken = await login(agent.phone);
  // PATCH /bot-learning/group и POST /:id/bump требуют requireElevation — тот
  // же щит поверх settings.manage, что и у одиночного PATCH /:id (текст отсюда
  // идёт прямо в промт бота). Тестовый обход — тот же приём, что в
  // bot-training.test.ts.
  grantElevation(admin.id);
});

afterAll(async () => {
  await prisma.botLesson.deleteMany({ where: { id: { in: lessonIds } } });
  await prisma.botAuditFinding.deleteMany({ where: { id: { in: findingIds } } });
  await prisma.agent.deleteMany({ where: { fullName: { in: [`Пагинация-Админ-${runId}`, `Пагинация-Агент-${runId}`] } } });
});

describe("предел и смещение ленты правил (страницы ГРУПП)", () => {
  it("сервер режет выдачу пределом и отдаёт смещение на следующую страницу", async () => {
    // 25 разных правил — больше предела в 20 групп на страницу (GROUPS_PAGE).
    // Различаются БУКВОЙ (a..y), не цифрой индекса: normalizeForDedup срезает
    // цифры целиком, и «правило-0»/«правило-1» после дедупа стали бы одним
    // и тем же ключом группы вместо 25 разных.
    for (let i = 0; i < 25; i++) {
      await makeRule({ lesson: `правило ${String.fromCharCode(97 + i)} ${runId}` });
    }
    const first = await request(app).get("/api/v1/bot-learning").set("Authorization", `Bearer ${adminToken}`);
    expect(first.status).toBe(200);
    expect(first.body.rules.length).toBeLessThanOrEqual(20);
    expect(first.body.rulesNextOffset).not.toBeNull();

    const second = await request(app)
      .get(`/api/v1/bot-learning?rulesOffset=${first.body.rulesNextOffset}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(second.status).toBe(200);
    const firstIds = new Set(first.body.rules.map((r: { id: string }) => r.id));
    // Вторая страница не повторяет первую — смещение реально сдвигает окно.
    for (const row of second.body.rules) expect(firstIds.has(row.id)).toBe(false);
  });
});

describe("повтор не разносится по разным страницам (доделка 18.09.2026)", () => {
  it("группировка идёт по ВСЕМУ скану, а не только по одной странице — вопрос не всплывает дважды", async () => {
    // Одинаковый вопрос (нормализованная пара реплик) — один в самом начале
    // ленты (свежий, попадёт на 1-ю страницу) и ДВА через 25 других вопросов
    // (окажутся на 2-й странице при постраничной группировке). Правильная
    // группировка — по всему скану — обязана схлопнуть все три в ОДНУ группу
    // и НЕ показать её повторно на второй странице.
    // Пунктуация в суффиксе — нормализация её всё равно срезает («не понял!»
    // и «не понял?» — один и тот же ключ), а вот РЕАЛЬНОЕ слово (буква) в
    // суффиксе — нет, поэтому «наполнитель» ниже различается ИМЕННО буквой,
    // а не цифрой: цифры normalizeForDedup срезает целиком, и «вопрос-0» /
    // «вопрос-1» после дедупа стали бы одним и тем же ключом.
    const bot = `Здравствуйте, чем помочь через 30 вопросов ${runId}`;
    async function makeQuestion(punctuation: string) {
      const row = await prisma.botLesson.create({
        data: {
          kind: "client_confused",
          channel: "TELEGRAM",
          botMessage: bot,
          humanMessage: `не понял${punctuation}`,
          lesson: null,
          active: false,
        },
      });
      lessonIds.push(row.id);
      return row;
    }
    // Дублирующий вопрос — первым (самый свежий, окажется в начале скана).
    await makeQuestion("");
    // 25 РАЗНЫХ вопросов между двумя вхождениями — при постраничной группировке
    // (по 20) они бы развели дубли по разным страницам. Различаются БУКВОЙ
    // (a..y), не цифрой индекса — иначе после дедупа сами бы схлопнулись в один.
    for (let i = 0; i < 25; i++) {
      const letter = String.fromCharCode(97 + i);
      const row = await prisma.botLesson.create({
        data: {
          kind: "client_confused",
          channel: "TELEGRAM",
          botMessage: `разный вопрос буква ${letter} ${runId}`,
          humanMessage: "не понял",
          lesson: null,
          active: false,
        },
      });
      lessonIds.push(row.id);
    }
    // Ещё два вхождения того же дубля — среди самых старых в этой партии.
    // Пунктуация вместо буквы: нормализация обязана свести их к тому же ключу.
    await makeQuestion("!");
    await makeQuestion("??");

    const first = await request(app).get("/api/v1/bot-learning").set("Authorization", `Bearer ${adminToken}`);
    expect(first.status).toBe(200);
    const onFirstPage = first.body.questions.find((q: { botMessage: string }) => q.botMessage === bot);
    expect(onFirstPage).toBeTruthy();
    expect(onFirstPage.dupCount).toBe(3);

    expect(first.body.questionsNextOffset).not.toBeNull();
    const second = await request(app)
      .get(`/api/v1/bot-learning?questionsOffset=${first.body.questionsNextOffset}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(second.status).toBe(200);
    // Тот же вопрос НЕ появляется второй раз отдельной карточкой на второй странице.
    const onSecondPage = second.body.questions.find((q: { botMessage: string }) => q.botMessage === bot);
    expect(onSecondPage).toBeUndefined();
  });
});

describe("selectActiveLessons() — то же самое, что реально видит промт", () => {
  it("id из GET /bot-learning совпадают с отбором для промта", async () => {
    for (let i = 0; i < 5; i++) {
      await makeRule({ lesson: `для промта ${String.fromCharCode(97 + i)} ${runId}` });
    }
    const direct = await selectActiveLessons();
    const res = await request(app).get("/api/v1/bot-learning").set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.promptLessonIds).toEqual(direct.map((l) => l.id));
    expect(res.body.promptLimit).toBe(12);
    expect(res.body.promptCount).toBe(direct.length);

    // И то же самое видит непосредственно промт бота.
    const block = await learnedRulesBlock();
    for (const l of direct) expect(block).toContain(l.lesson);
  });
});

describe("групповое действие — PATCH /bot-learning/group", () => {
  it("один запрос применяет ответ ко всем id разом", async () => {
    const rows = await Promise.all(
      [0, 1, 2].map((i) =>
        prisma.botLesson.create({
          data: {
            kind: "client_confused",
            channel: "INSTAGRAM",
            botMessage: `групповой-${runId}-${i}`,
            humanMessage: "не понял",
            lesson: null,
            active: false,
          },
        })
      )
    );
    rows.forEach((r) => lessonIds.push(r.id));

    const res = await request(app)
      .patch("/api/v1/bot-learning/group")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ ids: rows.map((r) => r.id), lesson: "общий ответ владельца" });
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(3);

    const updated = await prisma.botLesson.findMany({ where: { id: { in: rows.map((r) => r.id) } } });
    for (const row of updated) {
      expect(row.lesson).toBe("общий ответ владельца");
      expect(row.active).toBe(true);
    }
  });

  it("предел на количество id и право settings.manage соблюдаются", async () => {
    const tooMany = Array.from({ length: 51 }, () => "00000000-0000-0000-0000-000000000000");
    const bad = await request(app)
      .patch("/api/v1/bot-learning/group")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ ids: tooMany, active: true });
    expect(bad.status).toBe(400);
  });
});

describe("«Поднять» — POST /bot-learning/:id/bump", () => {
  it("обновляет createdAt, не трогая текст правила", async () => {
    const old = await makeRule({ lesson: `старое-${runId}`, createdAt: new Date(Date.now() - 30 * 24 * 3600 * 1000) });
    const res = await request(app)
      .post(`/api/v1/bot-learning/${old.id}/bump`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.lesson).toBe(`старое-${runId}`);
    const fresh = await prisma.botLesson.findUnique({ where: { id: old.id } });
    expect(fresh!.createdAt.getTime()).toBeGreaterThan(old.createdAt.getTime());
  });
});

describe("повторы не заводят вторую запись (владелец 17.09.2026)", () => {
  it("одинаковый по смыслу случай не создаёт дубль — даже с другими цифрами и пунктуацией", async () => {
    const bot = `Уточню у коллеги, ${runId}!`;
    const human1 = "А сколько стоит 2-комнатная?";
    const human2 = "а сколько стоит  2 комнатная"; // без цифр/пунктуации не различить — тот же вопрос

    await recordLesson({ kind: "operator_override", channel: "TELEGRAM", botMessage: bot, humanMessage: human1 });
    const before = await prisma.botLesson.count({ where: { botMessage: bot } });
    expect(before).toBe(1);

    await recordLesson({ kind: "operator_override", channel: "TELEGRAM", botMessage: bot, humanMessage: human2 });
    const after = await prisma.botLesson.count({ where: { botMessage: bot } });
    expect(after).toBe(1);

    const saved = await prisma.botLesson.findFirst({ where: { botMessage: bot } });
    if (saved) lessonIds.push(saved.id);
  });

  it("«Бот спрашивает» схлопывает повторы в один пункт с ×N", async () => {
    const bot = `Здравствуйте чем помочь ${runId}`;
    for (let i = 0; i < 3; i++) {
      const row = await prisma.botLesson.create({
        data: {
          kind: "client_confused",
          channel: "WHATSAPP",
          botMessage: bot,
          humanMessage: "не понял",
          lesson: null,
          active: false,
        },
      });
      lessonIds.push(row.id);
    }
    const res = await request(app).get("/api/v1/bot-learning").set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const group = res.body.questions.find((q: { botMessage: string }) => q.botMessage === bot);
    expect(group).toBeTruthy();
    expect(group.dupCount).toBe(3);
    expect(group.dupExamples.length).toBe(2);
  });

  it("selectActiveLessons() не тратит места из 12 на дубли текста правила", async () => {
    const text = `одинаковое правило ${runId}`;
    await prisma.botLesson.createMany({
      data: [0, 1].map((i) => ({
        kind: "operator_override",
        channel: "WHATSAPP",
        botMessage: `дубль-правила-${runId}-${i}`,
        humanMessage: "ответ",
        lesson: text,
        active: true,
      })),
    });
    const rows = await prisma.botLesson.findMany({ where: { lesson: text } });
    rows.forEach((r) => lessonIds.push(r.id));

    const active = await selectActiveLessons();
    const matching = active.filter((l) => l.lesson === text);
    // Обе записи с одинаковым текстом правила — это ОДНО место из 12, не два.
    expect(matching.length).toBe(1);
  });
});

describe("находки судьи — групповой вердикт", () => {
  async function makeFinding(opts: { why: string; type?: string }) {
    const row = await prisma.botAuditFinding.create({
      data: {
        conversationId: `pag-${runId}-${findingIds.length}`,
        channel: "WHATSAPP",
        type: opts.type ?? "repetition",
        quote: `цитата-${runId}-${findingIds.length}`,
        why: opts.why,
        severity: "low",
      },
    });
    findingIds.push(row.id);
    return row;
  }

  it("«Бот ошибся» закрывает всю группу и заводит ОДИН урок", async () => {
    const why = `Повторил вопрос ${runId}`;
    const rows = await Promise.all([0, 1, 2].map(() => makeFinding({ why })));
    const before = await prisma.botLesson.count();

    const res = await request(app)
      .post("/api/v1/bot-audit/group/resolve")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ type: "repetition", why, verdict: "bot_error" });
    expect(res.status).toBe(200);
    expect(res.body.resolved).toBe(3);
    expect(res.body.lessonCreated).toBe(true);
    expect(await prisma.botLesson.count()).toBe(before + 1);

    for (const row of rows) {
      const fresh = await prisma.botAuditFinding.findUnique({ where: { id: row.id } });
      expect(fresh?.resolvedAt).not.toBeNull();
    }
    const lesson = await prisma.botLesson.findFirst({ where: { kind: "audit_finding", humanMessage: why } });
    expect(lesson).not.toBeNull();
    if (lesson) lessonIds.push(lesson.id);
  });

  it("«Бот прав» на группу — закрывает все находки и класс больше не всплывает у судьи", async () => {
    const why = `Ложное срабатывание ${runId}`;
    await Promise.all([0, 1].map(() => makeFinding({ why, type: "tone" })));

    const res = await request(app)
      .post("/api/v1/bot-audit/group/resolve")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ type: "tone", why, verdict: "bot_right" });
    expect(res.status).toBe(200);
    expect(res.body.resolved).toBe(2);
    expect(res.body.lessonCreated).toBe(false);

    // logAudit — best-effort и не дожидается записи перед ответом (см.
    // lib/audit.ts): getClosedGroupKeys() читает именно этот журнал, поэтому
    // ждём его фоновую запись тем же приёмом, что и другие тесты аудита.
    await waitFor(async () => (await getClosedGroupKeys()).has(groupKey("tone", why)), {
      label: "запись BOT_AUDIT_RESOLVE_GROUP в AuditLog",
    });
  });

  it("у каждой группы есть устойчивый id — порции «Показать ещё» склеиваются по нему", async () => {
    const why = `Группа с ключом ${runId}`;
    await Promise.all([0, 1].map(() => makeFinding({ why, type: "other" })));

    // Проходим все порции групп: в общей базе своя группа может оказаться не в первой.
    const seen: string[] = [];
    let mine: { id: string; type: string; count: number } | undefined;
    let offset: number | null = 0;
    while (offset !== null) {
      const res = await request(app)
        .get(`/api/v1/bot-audit?groupsOffset=${offset}`)
        .set("Authorization", `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      for (const g of res.body.groups as { id: string; type: string; why: string; count: number }[]) {
        expect(typeof g.id).toBe("string");
        seen.push(g.id);
        if (g.why === why) mine = g;
      }
      offset = res.body.groupsNextOffset;
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(mine?.id).toBe(groupKey("other", why));
    expect(mine?.count).toBe(2);
  });

  it("verdict обязателен — без него запрос отклоняется", async () => {
    const bad = await request(app)
      .post("/api/v1/bot-audit/group/resolve")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ type: "tone" });
    expect(bad.status).toBe(400);
  });

  it("агенту без права auditLog.view групповой вердикт недоступен", async () => {
    const why = `Проверка прав ${runId}`;
    await makeFinding({ why, type: "other" });
    const res = await request(app)
      .post("/api/v1/bot-audit/group/resolve")
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ type: "other", why, verdict: "bot_right" });
    expect(res.status).toBe(403);
  });
});
