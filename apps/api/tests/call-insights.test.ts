import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

/**
 * НОЧНОЙ РАЗБОР РАЗГОВОРОВ: до 25.09.2026 до файла не дотягивался ни один тест.
 *
 * `ai/callInsights.ts` — из списка файлов сервера без тестов (CLAUDE.md, замер
 * 22.09.2026), и он из тех, где поломку видно позже всего: задача ночная,
 * отказ она глотает нарочно (расписание не должно падать из-за модели), а
 * результат читает руководитель раз в неделю.
 *
 * Часы уведены в 2031 год (`toFake: ["Date"]`) по той же причине, что в
 * `ad-alerts.test.ts`: разбор выбирает `callAnalysis` за последние N суток ПО
 * ВСЕЙ таблице, а в неё пишут полтора десятка соседних тестов. Их строки
 * получают `createdAt` настоящим временем, поэтому в окне 2031 года остаются
 * только собственные — чужое не удаляется и не правится. Свои строки кладутся с
 * явным `createdAt`, а не с умолчанием базы.
 */

const callAiText = vi.fn();
vi.mock("../src/ai/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/client.js")>()),
  callAiText,
}));

const { prisma } = await import("../src/db.js");
const { buildCallInsights } = await import("../src/ai/callInsights.js");

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2031, 4, 10, 6, 0, 0);

const runId = Date.now();
/**
 * Метка БЕЗ ЦИФР. `sanitizeStyleText` затирает шесть и больше цифр подряд («****»),
 * поэтому `runId` внутри текста вопроса до базы доезжает уже стёртым, и урок
 * ищется по другой строке, чем сохранён.
 */
const MARK = Array.from({ length: 6 }, () => "абвгдежзиклмн"[Math.floor(Math.random() * 13)]).join("");
const AGENT_NAME = `Агент разбора ${runId}`;
let agentId = "";
let clientId = "";
const analysisIds: string[] = [];
const interactionIds: string[] = [];
/** Записи разбора, которые лежали в базе ДО нас: не читаем и не удаляем. */
const foreignInsightIds = new Set<string>();
/** Наши: только их читает проверка и только их убирает уборка. */
const myInsightIds = new Set<string>();
const lessonQuestions: string[] = [];

/** Разбор разговора внутри окна: `daysAgo` отсчитывается от выдуманного «сейчас». */
async function makeAnalysis(daysAgo: number, extra: Record<string, unknown> = {}) {
  const interaction = await prisma.interaction.create({
    data: { clientId, agentId, type: "CALL", notes: `Звонок ${analysisIds.length}` },
  });
  interactionIds.push(interaction.id);
  const analysis = await prisma.callAnalysis.create({
    data: {
      interactionId: interaction.id,
      agentId,
      score: 70,
      foundNeed: true,
      presentedValue: false,
      handledObjection: false,
      agreedNextStep: true,
      objections: ["дорого"],
      agreements: ["перезвонит в понедельник"],
      summary: `Разговор ${analysisIds.length}`,
      createdAt: new Date(NOW - daysAgo * DAY_MS),
      ...extra,
    },
  });
  analysisIds.push(analysis.id);
  return analysis;
}

/** Сколько угодно разборов одним заходом — для проверки предела выборки. */
async function makeManyAnalyses(count: number) {
  const interactions = Array.from({ length: count }, (_, i) => ({
    id: randomUUID(),
    clientId,
    agentId,
    type: "CALL" as const,
    notes: `Массовый звонок ${i}`,
  }));
  await prisma.interaction.createMany({ data: interactions });
  interactionIds.push(...interactions.map((i) => i.id));
  const analyses = interactions.map((interaction, i) => ({
    id: randomUUID(),
    interactionId: interaction.id,
    agentId,
    score: 60,
    objections: [],
    agreements: [],
    summary: `Массовый разбор ${i}`,
    createdAt: new Date(NOW - (i % 20) * DAY_MS),
  }));
  await prisma.callAnalysis.createMany({ data: analyses });
  analysisIds.push(...analyses.map((a) => a.id));
}

/** Только те разборы, что появились из-за нашего вызова: чужих не читаем. */
async function insightsFromCall() {
  const rows = await prisma.callInsight.findMany({
    where: { id: { notIn: [...foreignInsightIds, ...myInsightIds] } },
  });
  for (const r of rows) myInsightIds.add(r.id);
  return rows;
}

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
  // Чужие разборы этой таблицы лежат на настоящем «сегодня» — за пять лет от окна.
  for (const row of await prisma.callInsight.findMany({ select: { id: true } })) foreignInsightIds.add(row.id);

  const agent = await prisma.agent.create({
    data: { fullName: AGENT_NAME, phone: `+99274${String(runId).slice(-7)}`, role: "AGENT", passwordHash: "x" },
  });
  agentId = agent.id;
  const client = await prisma.client.create({
    data: {
      fullName: `Клиент разбора ${runId}`,
      phone: `+99275${String(runId).slice(-7)}`,
      source: "PHONE_CALL",
      assignedAgentId: agent.id,
      acceptedAt: new Date(),
    },
  });
  clientId = client.id;
});

beforeEach(async () => {
  callAiText.mockReset();
  await insightsFromCall(); // запись, оставшуюся от прошлой проверки, забираем себе
  await prisma.callAnalysis.deleteMany({ where: { id: { in: analysisIds } } });
  await prisma.interaction.deleteMany({ where: { id: { in: interactionIds } } });
  analysisIds.length = 0;
  interactionIds.length = 0;
});

afterAll(async () => {
  await prisma.callAnalysis.deleteMany({ where: { id: { in: analysisIds } } });
  await prisma.interaction.deleteMany({ where: { clientId } });
  await prisma.client.deleteMany({ where: { id: clientId } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.callInsight.deleteMany({ where: { id: { in: [...myInsightIds] } } });
  await prisma.botLesson.deleteMany({ where: { botMessage: { in: lessonQuestions } } });
  vi.useRealTimers();
  await prisma.$disconnect();
});

const FULL_REPLY = {
  strengths: ["быстро перезваниваем"],
  weaknesses: ["не отрабатываем цену"],
  clientDemand: ["двушки в Сино"],
  recommendations: ["дать агентам ответ про рассрочку"],
};

describe("сколько разговоров нужно для разбора", () => {
  it("семь разборов — модель не зовётся вовсе", async () => {
    for (let i = 0; i < 7; i++) await makeAnalysis(i + 1);

    const res = await buildCallInsights();
    expect(res).toEqual({ ok: false, reason: "разговоров пока мало (7)" });
    expect(callAiText).not.toHaveBeenCalled();
    expect(await insightsFromCall()).toEqual([]);
  });

  it("разборы старше окна не считаются", async () => {
    for (let i = 0; i < 7; i++) await makeAnalysis(i + 1);
    for (let i = 0; i < 5; i++) await makeAnalysis(31 + i); // за пределами 30 суток

    expect(await buildCallInsights()).toEqual({ ok: false, reason: "разговоров пока мало (7)" });
    expect(callAiText).not.toHaveBeenCalled();
  });

  it("окно можно сузить аргументом", async () => {
    // Полусутки — чтобы ни одна строка не легла ровно на границу окна.
    for (let i = 0; i < 8; i++) await makeAnalysis(i + 0.5); // 0,5-7,5 суток назад

    expect(await buildCallInsights(5)).toEqual({ ok: false, reason: "разговоров пока мало (5)" });
  });
});

describe("что уходит в модель и что ложится в базу", () => {
  it("восемь разборов — в запрос уходят агент, счёт, шаги, возражения и договорённости", async () => {
    for (let i = 0; i < 8; i++) await makeAnalysis(i + 1);
    callAiText.mockResolvedValue(FULL_REPLY);

    expect(await buildCallInsights()).toEqual({ ok: true });
    expect(callAiText).toHaveBeenCalledTimes(1);
    const { endpoint, user, schema } = callAiText.mock.calls[0][0];
    expect(endpoint).toBe("call-insights");
    expect(user).toContain("за 30 дней (8 штук)");
    expect(user).toContain(AGENT_NAME);
    expect(user).toContain("потребность+ ценность− возражение− договорённость+");
    expect(user).toContain("возражения: дорого");
    expect(user).toContain("договорились: перезвонит в понедельник");
    expect(schema.required).toEqual(["strengths", "weaknesses", "recommendations"]);
  });

  it("выводы сохраняются с обрезкой списков", async () => {
    for (let i = 0; i < 8; i++) await makeAnalysis(i + 1);
    callAiText.mockResolvedValue({
      strengths: ["с1", "с2", "с3", "с4", "с5", "с6"],
      weaknesses: ["  ", "слабость"],
      clientDemand: ["д1", "д2", "д3", "д4", "д5", "д6", "д7"],
      recommendations: ["действие", 42, null],
    });

    expect(await buildCallInsights()).toEqual({ ok: true });
    const [insight] = await insightsFromCall();
    expect(insight.days).toBe(30);
    expect(insight.calls).toBe(8);
    expect(insight.strengths).toEqual(["с1", "с2", "с3", "с4"]);
    expect(insight.weaknesses).toEqual(["слабость"]);
    expect(insight.demand).toEqual(["д1", "д2", "д3", "д4", "д5"]);
    expect(insight.actions).toEqual(["действие"]);
  });

  it("в запрос уходит не больше двухсот разборов", async () => {
    await makeManyAnalyses(205);
    callAiText.mockResolvedValue(FULL_REPLY);

    expect(await buildCallInsights()).toEqual({ ok: true });
    const [insight] = await insightsFromCall();
    expect(insight.calls).toBe(200);
    expect(callAiText.mock.calls[0][0].user.split("\n").filter((l: string) => l.includes("Массовый разбор"))).toHaveLength(200);
  });

  it("модель не ответила — ночная задача молчит и ничего не пишет", async () => {
    for (let i = 0; i < 8; i++) await makeAnalysis(i + 1);
    callAiText.mockResolvedValue(null);

    expect(await buildCallInsights()).toEqual({ ok: false, reason: "модель не ответила" });
    expect(await insightsFromCall()).toEqual([]);
  });

  it("модель ответила пустыми списками — запись не заводится", async () => {
    for (let i = 0; i < 8; i++) await makeAnalysis(i + 1);
    callAiText.mockResolvedValue({ strengths: [], weaknesses: [], clientDemand: ["двушки"], recommendations: [] });

    expect(await buildCallInsights()).toEqual({ ok: false, reason: "выводов нет" });
    expect(await insightsFromCall()).toEqual([]);
  });

  it("отказ модели не бросается наружу — расписание не падает", async () => {
    for (let i = 0; i < 8; i++) await makeAnalysis(i + 1);
    callAiText.mockRejectedValue(new Error("модель недоступна"));

    expect(await buildCallInsights()).toEqual({ ok: false, reason: "ошибка разбора" });
    expect(await insightsFromCall()).toEqual([]);
  });
});

describe("ответы агентов в очередь обучения бота", () => {
  async function runWithAnswers(botAnswers: unknown) {
    for (let i = 0; i < 8; i++) await makeAnalysis(i + 1);
    callAiText.mockResolvedValue({ ...FULL_REPLY, botAnswers });
    return buildCallInsights();
  }

  it("пара «вопрос — ответ» ложится уроком телефонного канала", async () => {
    const question = `Есть ли рассрочка ${MARK}`;
    lessonQuestions.push(question);
    expect(await runWithAnswers([{ question, answer: "Да, застройщик даёт рассрочку на два года" }])).toEqual({ ok: true });

    const lesson = await prisma.botLesson.findFirst({ where: { botMessage: question } });
    expect(lesson).toMatchObject({ kind: "call_answer", channel: "PHONE", active: true });
    expect(lesson!.humanMessage).toContain("рассрочку на два года");
  });

  it("номер телефона из расшифровки не уезжает в промт бота", async () => {
    const question = `Как с вами связаться ${MARK}`;
    lessonQuestions.push(question);
    await runWithAnswers([{ question, answer: "Звоните мне на +992 900 11 22 33, отвечу сразу" }]);

    const lesson = await prisma.botLesson.findFirst({ where: { botMessage: question } });
    expect(lesson).toBeTruthy();
    expect(lesson!.humanMessage).not.toContain("900 11 22 33");
    expect(lesson!.humanMessage).not.toMatch(/\d{6}/);
  });

  it("тот же вопрос второй раз урок не заводит", async () => {
    const question = `Сколько стоит оформление ${MARK}`;
    lessonQuestions.push(question);
    await runWithAnswers([{ question, answer: "Оформление у нотариуса, около трёхсот сомони" }]);
    await runWithAnswers([{ question, answer: "Другой ответ на тот же вопрос клиента" }]);

    expect(await prisma.botLesson.count({ where: { botMessage: question } })).toBe(1);
  });

  it("пустые и неполные пары пропускаются", async () => {
    const question = `Годный вопрос ${MARK}`;
    lessonQuestions.push(question);
    await runWithAnswers([
      { question: "", answer: "ответ без вопроса" },
      { question: `Вопрос без ответа ${MARK}`, answer: "" },
      { question: 42, answer: "не строка" },
      { question, answer: "Настоящий ответ агента на настоящий вопрос" },
    ]);

    expect(await prisma.botLesson.count({ where: { botMessage: `Вопрос без ответа ${MARK}` } })).toBe(0);
    expect(await prisma.botLesson.count({ where: { botMessage: question } })).toBe(1);
  });

  it("без пар от модели очередь обучения не трогается", async () => {
    const before = await prisma.botLesson.count({ where: { kind: "call_answer" } });
    expect(await runWithAnswers(undefined)).toEqual({ ok: true });
    expect(await prisma.botLesson.count({ where: { kind: "call_answer" } })).toBe(before);
  });
});
