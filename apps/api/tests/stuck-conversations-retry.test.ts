import bcrypt from "bcrypt";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { headOfQueueRunAt } from "./helpers/queueHead.js";
import { waitFor } from "./helpers/waitFor.js";
import { createCustomerMessengerFixture, type CustomerMessengerFixture } from "./helpers/customerMessengerFixture.js";

/**
 * ЗАПАС ПО ЧАСАМ, А НЕ ПО ТИКАМ.
 *
 * Потолки ожидания в этом файле стоят в ТИКАХ, а предел vitest — в СЕКУНДАХ, и
 * друг про друга они не знают: один `runBackgroundJobsTick()` выполняет партию
 * ЦЕЛИКОМ, до десяти заданий, среди которых бывают тяжёлые чужие
 * (`clip-compress` и прочий ffmpeg, оставленные прошедшими файлами этого же
 * процесса). На засорённой очереди нескольких тиков хватает, чтобы перебрать
 * двадцать секунд, и тест падает «Test timed out in 20000ms» при исправном
 * коде — в одиночку тот же файл проходит за секунды. Живые падения 24.09.2026:
 * `stuck-work.test.ts` (#855), `background-jobs.test.ts`.
 *
 * Гасить проверку нельзя, ускорить чужую партию отсюда невозможно — значит
 * нужен честный запас по времени, и даётся он всему файлу, а не отдельным
 * тестам: до очереди дотягиваются и те, что зовут её через помощников.
 */
vi.setConfig({ testTimeout: 90_000 });


/**
 * «ПОВТОРИТЬ ВСЕМ ЗАВИСШИМ» (18.08.2026, жалоба владельца после дня с перебоями
 * Gemini: «ИИ сегодня многим не ответил, замолчал»).
 *
 * При сбое ИИ клиент не получает вообще никакого сообщения, а фоновая очередь
 * повторов (ai/aiRetryQueue.ts) живёт только в памяти процесса — рестарт
 * контейнера или просто «не дождались 13 часов» теряют её без следа. Раздел
 * «Ошибки» → «Зависшие диалоги» находит диалоги, где последняя реплика сегодня
 * — от клиента, и проигрывает их заново на уже сохранённой истории.
 *
 * Главное, что здесь может сломаться молча:
 *  - реплика клиента задваивается в истории (processMessengerTurn обычно сам её
 *    сохраняет — здесь это запрещено флагом skipSaveIncoming);
 *  - диалог, на который уже ответили (хоть бот, хоть агент вручную), уходит на
 *    второй, ненужный ответ;
 *  - диалог на паузе или после «не пишите мне» получает сообщение, которого
 *    просить не имел права никто.
 */

const { sendMessage, callAiText } = vi.hoisted(() => ({
  sendMessage: vi.fn(async () => "reply-mid-1"),
  callAiText: vi.fn(),
}));
vi.mock("../src/messengers/meta.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sendMessage,
  showReadAndTyping: vi.fn(async () => undefined),
}));

vi.mock("../src/ai/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/client.js")>()),
  callAiText,
}));

const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");
// Обработчики фоновой очереди регистрируются ТОЛЬКО worker-процессом
// (jobs/handlers.ts — импортируется намеренно узко, см. докстринг registry.ts).
// Без этого импорта runBackgroundJobsTick() находит задание "ai-reply-retry" без
// обработчика и молча откладывает его — тест ждал бы синхронного ответа, которого
// в новой архитектуре очереди (чертёж Б2, 27.08.2026) для этого пути больше нет.
await import("../src/jobs/handlers.js");
const { runBackgroundJobsTick } = await import("../src/jobs/runner.js");

const runId = Date.now().toString(36);
const password = "testpass123";
let directorToken = "";
let directorId = "";
let facebook: CustomerMessengerFixture;

type SettingsSnapshot = {
  botEnabled: boolean;
  botFacebookEnabled: boolean;
  botReplyDelaySec: number;
  botReplyMaxWaitSec: number;
};
const SELECT = { botEnabled: true, botFacebookEnabled: true, botReplyDelaySec: true, botReplyMaxWaitSec: true } as const;
let savedSettings: SettingsSnapshot;

const conversationIds: string[] = [];

async function login(phone: string) {
  const res = await request(app).post("/api/v1/auth/login").send({ phone, password });
  expect(res.status).toBe(200);
  return res.body.accessToken as string;
}

/** Диалог с последней репликой клиента — тот самый «завис». */
async function makeStuckConversation(subscriberId: string, overrides: Record<string, unknown> = {}) {
  const native = await facebook.ensureConversation(subscriberId);
  const conv = await prisma.botConversation.update({
    where: { id: native.id },
    data: {
      messages: [{ role: "user", content: "Ассалому алейкум, наход хона доред?" }],
      // Старше пяти минут: свежую реплику ещё обрабатывает живой ход (28.09.2026).
      lastMessageAt: new Date(Date.now() - 6 * 60 * 1000),
      ...overrides,
    },
  });
  conversationIds.push(conv.id);
  return conv;
}

beforeAll(async () => {
  facebook = await createCustomerMessengerFixture("FACEBOOK");
  const passwordHash = await bcrypt.hash(password, 10);
  const director = await prisma.agent.create({
    data: { fullName: "Тест Директор зависшие", phone: `+992963${runId}`, role: "DIRECTOR", passwordHash },
  });
  directorId = director.id;
  directorToken = await login(director.phone);

  savedSettings = await prisma.settings.upsert({
    where: { id: "singleton" },
    update: {},
    create: { id: "singleton" },
    select: SELECT,
  });
  await prisma.settings.update({
    where: { id: "singleton" },
    data: { botEnabled: true, botFacebookEnabled: true, botReplyDelaySec: 0, botReplyMaxWaitSec: 5 },
  });
});

afterAll(async () => {
  await facebook.dispose();
  await prisma.auditLog.deleteMany({ where: { agentId: directorId } });
  await prisma.agent.deleteMany({ where: { id: directorId } });
  await prisma.settings.update({ where: { id: "singleton" }, data: savedSettings });
  await prisma.$disconnect();
});

beforeEach(() => {
  sendMessage.mockClear();
  callAiText.mockReset();
  callAiText.mockResolvedValue({ reply: ["Хуб, чӣ гуна хона мекобед?"], ready: false, confident: true, topic: "other", openQuestion: "", clientAnsweredOpenQuestion: false });
});

afterEach(async () => {
  await facebook.cleanupConversations();
  conversationIds.length = 0;
});

describe("предпросмотр зависших диалогов", () => {
  it("диалог без ответа сегодня попадает в список", async () => {
    const conv = await makeStuckConversation(`stuck-${runId}-a`);

    const res = await request(app).get("/api/v1/errors/stuck-conversations").set("Authorization", `Bearer ${directorToken}`);

    expect(res.status).toBe(200);
    expect(res.body.items.map((i: { id: string }) => i.id)).toContain(conv.id);
  });

  it("диалог, на который уже ответил бот, в списке не появляется", async () => {
    const conv = await makeStuckConversation(`stuck-${runId}-b`, {
      messages: [
        { role: "user", content: "Салом" },
        { role: "assistant", content: "Салом! Чӣ гуна хона мекобед?", by: { kind: "bot" } },
      ],
    });

    const res = await request(app).get("/api/v1/errors/stuck-conversations").set("Authorization", `Bearer ${directorToken}`);

    expect(res.body.items.map((i: { id: string }) => i.id)).not.toContain(conv.id);
  });

  it("диалог на паузе (оператор уже занимается) в списке не появляется", async () => {
    const conv = await makeStuckConversation(`stuck-${runId}-c`, {
      pausedUntil: new Date(Date.now() + 60 * 60 * 1000),
    });

    const res = await request(app).get("/api/v1/errors/stuck-conversations").set("Authorization", `Bearer ${directorToken}`);

    expect(res.body.items.map((i: { id: string }) => i.id)).not.toContain(conv.id);
  });

  it("диалог человека, попросившего не писать («не пишите мне»), в списке не появляется", async () => {
    const conv = await makeStuckConversation(`stuck-${runId}-d`, { optedOutAt: new Date() });

    const res = await request(app).get("/api/v1/errors/stuck-conversations").set("Authorization", `Bearer ${directorToken}`);

    expect(res.body.items.map((i: { id: string }) => i.id)).not.toContain(conv.id);
  });

  it("рядовому агенту (без права auditLog.view) список недоступен", async () => {
    const passwordHash = await bcrypt.hash(password, 10);
    const agent = await prisma.agent.create({
      data: { fullName: "Тест Агент зависшие", phone: `+992964${runId}`, role: "AGENT", passwordHash },
    });
    const agentToken = await login(agent.phone);

    const res = await request(app).get("/api/v1/errors/stuck-conversations").set("Authorization", `Bearer ${agentToken}`);
    expect(res.status).toBe(403);

    await prisma.agent.deleteMany({ where: { id: agent.id } });
  });
});

describe("повтор зависших диалогов", () => {
  /**
   * КНОПКА СТАВИТ В ОЧЕРЕДЬ, А НЕ ОТВЕЧАЕТ САМА (аудит №4, 27.08.2026,
   * routes/errorLog.ts). Раньше POST .../retry звал обработку синхронно/в фоне
   * процесса; теперь — enqueueBackgroundJob(type:"ai-reply-retry"), и настоящий
   * ответ приходит только когда джоб-раннер разберёт очередь. Тест продвигает
   * очередь вручную тем же способом, что и tests/background-jobs.test.ts.
   */
  it("клиент получает ответ, а его собственная реплика не задваивается в истории", async () => {
    const conv = await makeStuckConversation(`stuck-${runId}-retry-1`);

    const res = await request(app)
      .post("/api/v1/errors/stuck-conversations/retry")
      .set("Authorization", `Bearer ${directorToken}`);
    expect(res.status).toBe(200);
    expect(res.body.queued).toBeGreaterThanOrEqual(1);

    // Кнопка повторяет ВСЕ зависшие диалоги базы, а не только заведённый здесь:
    // на общей базе (CI, прод) рядом лежат чужие. Ищем свой вызов по собеседнику,
    // а не берём нулевой — иначе тест проверяет случайного соседа по прогону.
    const ownCall = () => sendMessage.mock.calls.find((c) => c[1] === `stuck-${runId}-retry-1`);
    /**
     * Очередь разбирается партиями по BATCH_SIZE=10 (jobs/runner.ts::claimBatch), а
     * кнопка ставит в очередь ВСЕ зависшие диалоги базы. На стенде и на проде их
     * рядом десятки, наш — самый свежий, то есть последний в очереди.
     *
     * ПУСТОЙ ТИК — НЕ ПРИЗНАК ТОГО, ЧТО ДО НАС ДОШЛО (24.09.2026). Здесь стоял
     * выход из ожидания по `done === 0` («в очереди не осталось ни ждущих, ни
     * зависших»), и на общей базе он врал: тик соседнего шарда мог забрать наше
     * задание себе, а `background-jobs.test.ts` — просто удалить его вместе со
     * всеми чужими PENDING. Ожидание завершалось успешно, а `ownCall()` так и
     * оставался пустым: падало «expected undefined to be defined» на коде,
     * который в одиночку проходит 7 из 7. Оба источника закрыты, но ждать теперь
     * нужно того, что проверяем, а не косвенного признака.
     *
     * Задание ставится «в отрыве» (`void Promise.all` в routes/errorLog.ts),
     * поэтому сперва дожидаемся самой строки. Дальше на каждом заходе двигаем
     * СВОЁ задание в голову очереди: партия идёт `ORDER BY "runAt"`, и одного
     * сдвига в прошлое хватает, чтобы наш тик взял его раньше чужих — включая
     * случай, когда неудачная попытка отложила его бэкоффом. Чужие строки не
     * трогаем (класс #854/#855), а величина сдвига — из helpers/queueHead.ts.
     */
    const jobKey = `ai-reply-retry:${conv.id}`;
    await waitFor(() => prisma.backgroundJob.findFirst({ where: { dedupeKey: jobKey } }), {
      timeoutMs: 15_000,
      label: "задание повтора появилось в очереди",
    });
    await waitFor(async () => {
      await prisma.backgroundJob.updateMany({
        where: { dedupeKey: jobKey, status: "PENDING" },
        data: { runAt: headOfQueueRunAt() },
      });
      await runBackgroundJobsTick();
      return Boolean(ownCall());
    }, { timeoutMs: 60_000, label: "очередь дошла до нашего диалога" });
    expect(ownCall()).toBeDefined();
    // Текст могут слегка нормализовать (см. normalizeReplyBubbles) — проверяем
    // получателя и суть ответа, а не побуквенное совпадение с мокнутым callAiText.
    const call = ownCall()!;
    expect(call[0]).toBe("FACEBOOK");
    expect(String(call[2])).toContain("хона мекобед");

    const after = await prisma.botConversation.findUnique({ where: { id: conv.id }, select: { messages: true } });
    const messages = (after?.messages ?? []) as { role: string; content: string }[];
    // Ровно два: исходная реплика клиента (была одна) + новый ответ бота — не три.
    expect(messages).toHaveLength(2);
    expect(messages.filter((m) => m.role === "user")).toHaveLength(1);
    expect(messages[1].role).toBe("assistant");
    expect(messages[1].content).toContain("хона мекобед");
    // Запас по часам, а не по тикам: каждый тик может увезти чужую тяжёлую
    // партию целиком (см. докстринг ожидания выше), а предел vitest — 20 с.
  }, 90_000);

  it("диалог, отвеченный между предпросмотром и нажатием кнопки, второго ответа не получает", async () => {
    // Список берётся ЗАНОВО в момент запуска повтора (не тот, что видел
    // предпросмотр раньше) — имитируем «уже ответили» до вызова retry.
    const conv = await makeStuckConversation(`stuck-${runId}-retry-2`);
    await prisma.botConversation.update({
      where: { id: conv.id },
      data: { messages: [{ role: "user", content: "Салом" }, { role: "assistant", content: "Салом!", by: { kind: "bot" } }] },
    });

    await request(app).post("/api/v1/errors/stuck-conversations/retry").set("Authorization", `Bearer ${directorToken}`);
    // Продвигаем очередь по-настоящему (если бы джоб ошибочно подхватил диалог,
    // это и обнаружится здесь) — предпросмотр не видит этот диалог (уже отвечен),
    // значит и enqueue для него в /retry не случится, но проверяем сам факт.
    await runBackgroundJobsTick();

    expect(sendMessage.mock.calls.some((c) => c[1] === `stuck-${runId}-retry-2`)).toBe(false);
    const after = await prisma.botConversation.findUnique({ where: { id: conv.id }, select: { messages: true } });
    expect(after?.messages).toHaveLength(2);
  });
});
