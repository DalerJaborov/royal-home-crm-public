import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";

/**
 * Напоминания об оплатах подписок (владелец 10.11.2026, lib/paymentReminders.ts):
 * одно сообщение за 3 дня и одно в день оплаты, только тем, у кого finance.view,
 * сбой оплаты по журналу ошибок, «✅ Оплатил» — той же командой, что экран
 * расходов (POST /expenses/recurring/:id/pay), «⏰ Напомнить завтра» — один повтор.
 */
const { sendHtmlMessage, answerCallbackQuery } = vi.hoisted(() => {
  let id = 9000;
  return {
    sendHtmlMessage: vi.fn(async (_c: string, _h: string, _r?: number, _b?: unknown) => ({ message_id: ++id })),
    answerCallbackQuery: vi.fn(async (_id: string, _text?: string) => ({})),
  };
});
vi.mock("../src/telegram/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/telegram/api.js")>()),
  sendHtmlMessage, answerCallbackQuery,
}));

const { prisma } = await import("../src/db.js");
const { runPaymentReminders, handlePaymentReminderCallback, addDays, amountLines } = await import("../src/lib/paymentReminders.js");
const { dushanbeDateString } = await import("../src/lib/dushanbeTime.js");
const { waitForSettled } = await import("./helpers/waitFor.js");

const runId = String(Date.now()).slice(-7);
const today = dushanbeDateString();
const ag: Record<string, { id: string; chatId: string }> = {};
const templates: string[] = [];
let cb = 1;

async function mkAgent(key: string, n: number, role: string, permissions?: object, withTelegram = true) {
  const chatId = String(850_000_000 + Number(runId) * 10 + n);
  const link = withTelegram ? { telegramChatId: chatId, telegramUserId: chatId } : {};
  const a = await prisma.agent.create({ data: {
    fullName: `Оплаты ${key} ${runId}`, phone: `+99297${runId}${n}`, role: role as "AGENT",
    passwordHash: await bcrypt.hash("testpass123", 4), ...link,
    ...(permissions ? { permissions } : {}),
  } });
  ag[key] = { id: a.id, chatId };
}
async function mkTemplate(title: string, due: string, extra: Record<string, unknown> = {}) {
  const t = await prisma.recurringExpense.create({ data: {
    title: `${title} ${runId}`, category: "OFFICE", amount: 100, currency: "TJS", period: "MONTH",
    dayOfMonth: Number(due.slice(8, 10)), startsOn: today, ...extra,
  } as never });
  templates.push(t.id);
  return t;
}
const sentTo = (key: string) => sendHtmlMessage.mock.calls.filter((c) => c[0] === ag[key].chatId);
const textTo = (key: string) => sentTo(key).map((c) => String(c[1])).join("\n");
const press = (key: string, data: string) => handlePaymentReminderCallback({
  id: `pp-${runId}-${cb++}`, data, from: { id: Number(ag[key].chatId) },
  message: { chat: { id: Number(ag[key].chatId), type: "private" }, message_id: 1, text: "Оплаты" },
});
const run = (at = new Date()) => runPaymentReminders(at, { ignoreWorkHours: true });
const bell = (key: string, title: string) => prisma.notification.count({ where: { agentId: ag[key].id, kind: "payment", body: { contains: title } } });

beforeAll(async () => {
  await mkAgent("boss", 1, "DIRECTOR");
  await mkAgent("agent", 2, "AGENT");
  // Бухгалтер: видит финансы, но не ведёт их — «Оплатил» ему не положено.
  await mkAgent("viewer", 3, "AGENT", { granted: ["finance.view"] });
  // Финансы видит, Telegram не привязан — получает колокольчик и push CRM.
  await mkAgent("noTg", 4, "AGENT", { granted: ["finance.view"] }, false);
});
beforeEach(() => { sendHtmlMessage.mockClear(); answerCallbackQuery.mockClear(); });
afterAll(async () => {
  const ids = Object.values(ag).map((a) => a.id);
  await prisma.staffNotice.deleteMany({ where: { agentId: { in: ids } } });
  await prisma.expense.deleteMany({ where: { recurringId: { in: templates } } });
  await prisma.recurringExpense.deleteMany({ where: { id: { in: templates } } });
  await prisma.errorLog.deleteMany({ where: { message: { contains: runId } } });
  await waitForSettled(() => prisma.auditLog.count({ where: { entityId: { in: templates } } }));
  await prisma.auditLog.deleteMany({ where: { entityId: { in: templates } } });
  await prisma.notification.deleteMany({ where: { agentId: { in: ids } } });
  await prisma.agent.deleteMany({ where: { id: { in: ids } } });
});

describe("сумма", () => {
  it("доллары — по курсу CRM, карта — с запасом 2%", () => {
    const lines = amountLines({ amount: "20", currency: "USD", paymentMethod: "CARD" }, { usdToTjs: 11 } as never);
    expect(lines[0]).toBe("💰 $20 → ~220 с. по курсу CRM");
    expect(lines[1]).toBe("💳 На карте должно быть: ~225 с. (с запасом 2%)");
  });
});

describe("напоминания", () => {
  it("за 3 дня — одно сообщение тем, у кого finance.view; повтор тика ничего не шлёт", async () => {
    const t = await mkTemplate("ElevenLabs подписка", addDays(today, 3));
    await run();
    expect(textTo("boss")).toContain(t.title);
    expect(textTo("boss")).toContain("💳 <b>Оплаты подписок</b>");
    expect(textTo("boss")).toContain("Через 3 дн.");
    expect(textTo("viewer")).toContain(t.title);
    expect(sentTo("agent")).toHaveLength(0);
    // У директора есть «Оплатил», у бухгалтера — только «Напомнить завтра».
    const bossButtons = JSON.stringify(sentTo("boss").at(-1)?.[3]);
    expect(bossButtons).toContain(`pp:${t.id}:${addDays(today, 3)}`);
    expect(bossButtons).toContain("🔕 Не присылать такое");
    expect(JSON.stringify(sentTo("viewer").at(-1)?.[3])).not.toContain("pp:");
    sendHtmlMessage.mockClear();
    await run();
    expect(sentTo("boss")).toHaveLength(0);
  });

  it("в день оплаты — ещё одно сообщение, один раз", async () => {
    const t = await mkTemplate("Хостинг", today);
    await run();
    expect(textTo("boss")).toContain(t.title);
    expect(textTo("boss")).toContain("Сегодня — день оплаты");
    sendHtmlMessage.mockClear();
    await run();
    expect(textTo("boss")).not.toContain(t.title);
  });

  it("колокольчик CRM — всем: и с Telegram, и без него; выключившему — только он, как история", async () => {
    await prisma.agent.update({ where: { id: ag.viewer.id }, data: { pushMuted: ["payment"] } });
    const t = await mkTemplate("Домен", addDays(today, 2));
    await run();
    expect(sentTo("viewer")).toHaveLength(0);
    expect(await bell("viewer", t.title)).toBe(1);
    expect(textTo("boss")).toContain(t.title);
    expect(await bell("boss", t.title)).toBe(1);
    expect(await bell("noTg", t.title)).toBe(1);
    // Повтор тика колокольчик второй раз не пишет.
    await run();
    expect(await bell("viewer", t.title)).toBe(1);
    expect(await bell("noTg", t.title)).toBe(1);
    await prisma.agent.update({ where: { id: ag.viewer.id }, data: { pushMuted: [] } });
  });

  it("сбой оплаты по журналу ошибок — честно «проверьте в кабинете сервиса», без текста ошибки", async () => {
    await prisma.errorLog.create({ data: { source: "api", message: `ElevenLabs: 402 payment_required https://api.example/v1?key=SECRETKEY${runId} token=abc${runId}` } });
    await prisma.errorLog.create({ data: { source: "api", message: `Gemini 429: Your prepayment credits are depleted ${runId}` } });
    await run();
    expect(textTo("boss")).toContain("ElevenLabs: оплата не прошла");
    expect(textTo("boss")).toContain("Сервис ответил кодом 402");
    expect(textTo("boss")).toContain("Google Gemini: оплата не прошла");
    expect(textTo("boss")).toContain("кабинете сервиса");
    expect(textTo("boss")).not.toContain("SECRETKEY");
    expect(textTo("boss")).not.toContain("token=");
    sendHtmlMessage.mockClear();
    await run();
    expect(textTo("boss")).not.toContain("ElevenLabs: оплата не прошла");
  });

  it("вне рабочего окна — ничего", async () => {
    const night = new Date(`${today}T20:00:00.000Z`); // 01:00 по Душанбе следующего дня
    const result = await runPaymentReminders(night);
    expect(result.skipped).toBe("outside-work-hours");
  });
});

describe("кнопки", () => {
  it("«✅ Оплатил» — расход оплачен той же командой, что экран, с записью в журнале", async () => {
    const due = addDays(today, 1);
    const t = await mkTemplate("Сервис CRM", due);
    expect(await press("boss", `pp:${t.id}:${due}`)).toBe(true);
    const row = await prisma.expense.findFirst({ where: { recurringId: t.id, occurrenceDate: due } });
    expect(row?.status).toBe("PAID");
    await waitForSettled(() => prisma.auditLog.count({ where: { entityId: t.id } }));
    expect(await prisma.auditLog.count({ where: { entityId: t.id, agentId: ag.boss.id } })).toBe(1);
    expect(textTo("boss")).toContain(`✅ Оплачено: ${t.title} (`);
    expect(textTo("boss")).not.toContain("строка заведена");
    // Повторное нажатие — без второй записи в журнале.
    expect(await press("boss", `pp:${t.id}:${due}`)).toBe(true);
    expect(String(answerCallbackQuery.mock.calls.at(-1)?.[1])).toContain("Уже отмечено");
    await waitForSettled(() => prisma.auditLog.count({ where: { entityId: t.id } }));
    expect(await prisma.auditLog.count({ where: { entityId: t.id, agentId: ag.boss.id } })).toBe(1);
    // Оплаченный больше не напоминается.
    sendHtmlMessage.mockClear();
    await run();
    expect(textTo("boss")).not.toContain(t.title);
  });

  it("без права вести финансы «Оплатил» не проходит", async () => {
    const due = addDays(today, 1);
    const t = await mkTemplate("Касса", due);
    await press("viewer", `pp:${t.id}:${due}`);
    expect(String(answerCallbackQuery.mock.calls.at(-1)?.[1])).toContain("ведёт финансы");
    expect(await prisma.expense.count({ where: { recurringId: t.id, status: "PAID" } })).toBe(0);
    await press("agent", `pp:${t.id}:${due}`);
    expect(String(answerCallbackQuery.mock.calls.at(-1)?.[1])).toContain("Нет доступа");
  });

  it("«⏰ Напомнить завтра» — один повтор на следующий день", async () => {
    const due = addDays(today, 2);
    const t = await mkTemplate("Телефония", due);
    await run();
    expect(await press("boss", `pz:${t.id}:${due}`)).toBe(true);
    expect(String(answerCallbackQuery.mock.calls.at(-1)?.[1])).toContain("завтра");
    sendHtmlMessage.mockClear();
    await run(); // сегодня — повтора ещё нет
    expect(textTo("boss")).not.toContain(t.title);
    const tomorrow = new Date(Date.now() + 86_400_000);
    await run(tomorrow);
    expect(textTo("boss")).toContain("повтор, как просили");
    sendHtmlMessage.mockClear();
    await run(tomorrow);
    expect(textTo("boss")).not.toContain("повтор, как просили");
  });

  it("«⏰ Напомнить завтра» в САМ день оплаты — назавтра повтор о просроченном, а не тишина", async () => {
    const t = await mkTemplate("Облако", today);
    await run();
    expect(textTo("boss")).toContain(t.title);
    expect(await press("boss", `pz:${t.id}:${today}`)).toBe(true);
    sendHtmlMessage.mockClear();
    const tomorrow = new Date(Date.now() + 86_400_000);
    await run(tomorrow);
    expect(textTo("boss")).toContain(t.title);
    expect(textTo("boss")).toContain("Просрочено на 1 дн.");
    expect(textTo("boss")).toContain("повтор, как просили");
  });
});
