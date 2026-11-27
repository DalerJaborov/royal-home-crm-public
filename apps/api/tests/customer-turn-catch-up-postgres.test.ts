import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import { createCustomerCoreGoldenFixture, reply } from "./helpers/customerCoreGoldenFixture.js";
import { consumeCustomerInboxTicket } from "../src/lib/customerIngressProducer.js";
import { runCustomerTurnCatchUpTick, resumeHeldCustomerTurn, runCustomerCatchUpTurn, CATCH_UP_MAX_AGE_HOURS, CATCH_UP_MAX_ATTEMPTS } from "../src/lib/customerTurnCatchUp.js";
import { findStuckConversations } from "../src/lib/stuckConversations.js";
import { dispatchCustomerOutboxPart } from "../src/lib/customerDeliveryDispatcher.js";
import { decodeCustomerOutboxPayload } from "../src/lib/customerOutbox.js";

// БОТ САМ ДОГОНЯЕТ ПОСЛЕ ПАУЗЫ (27.11.2026) — живой случай прода на НАСТОЯЩЕМ ядре: подписанный вход, FINAL,
// принципал, пин, модель (сценарий), очередь отправки. Синтетические только ответ модели и отправка в Meta.
//
// Прод 27.11, переписка af7e2c0a: 12:31 сотрудник ответил руками (бот на паузе 10 минут), 12:35–12:36 клиент написал
// три сообщения, пауза кончилась в 12:41 — и бот не ответил никогда: ход удержан (original_context_changed), а после
// паузы его срок (120 секунд от получения) давно истёк. Повтор «зависших» для переписки ядра ничего не делал.
let f: Awaited<ReturnType<typeof createCustomerCoreGoldenFixture>>;
const catchUpKeys: string[] = [];
beforeAll(async () => { f = await createCustomerCoreGoldenFixture(); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); f?.assertIoClean(); });
afterAll(async () => {
  await prisma.backgroundJob.deleteMany({ where: { dedupeKey: { in: catchUpKeys.map((key) => `customer-inbox-catch-up:${key}`) } } });
  await f?.cleanup();
}, 90_000);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const job = (eventKey: string) => prisma.backgroundJob.findUnique({ where: { dedupeKey: `customer-inbox-catch-up:${eventKey}` } });
const ticket = (eventKey: string) => prisma.customerPropertyIngressTicket.findUniqueOrThrow({ where: { eventKey },
  select: { conversationId: true, processingState: true, errorCode: true, resumedAt: true } });
/** The customer's words of the turn whose FIRST model generation is bodies[from]. */
const turnUserText = (from: number) => {
  const body = f.bodies[from] as { contents: Array<{ role: string; parts: Array<{ text?: string }> }> };
  return body.contents.filter((entry) => entry.role === "user").at(-1)?.parts.map((part) => part.text ?? "").join("") ?? "";
};
/** What CRM does when a staff member replies by hand: the staff line in the chat and the bot paused (conversationDelivery.ts). */
async function staffRepliesAndPauses(conversationId: string, pauseMs: number): Promise<Date> {
  const until = new Date(Date.now() + pauseMs);
  await prisma.$executeRaw`UPDATE "BotConversation" SET "messages" = "messages" || jsonb_build_array(jsonb_build_object(
      'role','assistant','content','Ассалому алайкум! Бубахшед, ки дертар ҷавоб медиҳем.','by',jsonb_build_object('kind','manual'),
      'at', to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))),
    "pausedUntil" = ${until}, "botPausedAt" = ${new Date()} WHERE "id" = ${conversationId}`;
  return until;
}
async function waitPast(until: Date) { await sleep(Math.max(0, until.getTime() - Date.now()) + 700); }

it("ручной ответ → клиент пишет во время паузы → пауза кончилась → бот отвечает ровно один раз, на всю пачку", async () => {
  const owner = await f.owner();
  // Клиент пришёл раньше, и бот ему ответил.
  const first = await f.capture(owner, "Мехоҳам хонаамро фурӯшам");
  f.script([[reply([], "property")]]);
  await f.deliver(first);
  const conversationId = (await ticket(first)).conversationId!;

  // Сотрудник ответил руками — бот на паузе. Клиент тут же пишет два сообщения.
  const until = await staffRepliesAndPauses(conversationId, 6_000);
  const physicalBefore = f.physical.length;
  const b1 = await f.capture(owner, "Тарафи поени корвон нархи хонаҳо чанд аст");
  const b2 = await f.capture(owner, "Сексия 40 квадрат");
  catchUpKeys.push(b1, b2);
  expect((await consumeCustomerInboxTicket(b1)).status).toBe("held");
  expect(await consumeCustomerInboxTicket(b2)).toEqual({ status: "held", reason: "original_context_changed" });
  expect(f.physical.length).toBe(physicalBefore); // на паузе бот молчит
  // Пока пауза идёт, сторож ход не трогает.
  await runCustomerTurnCatchUpTick({ minAge: "0 seconds" });
  expect(await job(b2)).toBeNull();

  await waitPast(until);
  // Переписка ядра — не задача старого повтора «зависших»: его задание здесь только крутилось впустую (прод, af7e2c0a).
  expect((await findStuckConversations()).map((row) => row.id)).not.toContain(conversationId);

  // Прошло больше двух минут от получения: срок хода по исходным часам истёк (это и был прод).
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + 130_000);
  expect(await consumeCustomerInboxTicket(b2)).toEqual({ status: "held", reason: "expired" });
  expect(f.physical.length).toBe(physicalBefore);

  // Сторож ставит ОДНО задание на последний неотвеченный ход; второй тик — ничего.
  expect((await runCustomerTurnCatchUpTick({ minAge: "0 seconds" })).queued).toBeGreaterThanOrEqual(1);
  expect(await job(b2)).toMatchObject({ type: "customer-inbox-consume", status: "PENDING", payload: { version: 1, eventKey: b2, resume: true } });
  expect((await ticket(b2)).resumedAt).toBeNull(); // часы хода ставит само задание, когда до него дошла очередь
  await runCustomerTurnCatchUpTick({ minAge: "0 seconds" });
  expect(await prisma.backgroundJob.count({ where: { dedupeKey: { in: [`customer-inbox-catch-up:${b1}`, `customer-inbox-catch-up:${b2}`] } } })).toBe(1);

  // Задание (customerInboxConsume.ts → runCustomerCatchUpTurn) возобновляет ход и планирует ОДИН ответ, и модель видит
  // оба сообщения пачки как текущие слова клиента.
  f.script([[reply([], "property")]]);
  const bodiesBefore = f.bodies.length;
  const planned = await runCustomerCatchUpTurn(b2);
  expect((await ticket(b2)).resumedAt).not.toBeNull();
  if (!planned) throw new Error("catch-up turn did not run");
  expect(planned.status, JSON.stringify(planned)).toBe("planned");
  if (planned.status !== "planned") throw new Error("not planned");
  expect(planned.partIds).toHaveLength(1);
  expect(turnUserText(bodiesBefore)).toBe("Тарафи поени корвон нархи хонаҳо чанд аст\nСексия 40 квадрат");
  // Отправка — уже по настоящим часам: аренду части считают часы базы, а сдвинутые часы теста её «просрочили» бы.
  vi.useRealTimers();
  expect(await dispatchCustomerOutboxPart(planned.partIds[0])).toEqual({ status: "accepted" });
  const sent = decodeCustomerOutboxPayload(await prisma.customerOutboxPart.findUniqueOrThrow({ where: { id: planned.partIds[0] } }));
  if (sent.kind !== "text") throw new Error("text expected");
  const delivered = { text: sent.text };
  expect(f.physical.slice(physicalBefore)).toEqual([delivered.text]);
  // Повторная отправка той же части ничего не шлёт.
  expect(await dispatchCustomerOutboxPart(planned.partIds[0])).toEqual({ status: "accepted" });

  // Ответ есть — сторож больше ничего не делает, повтор задания не отвечает второй раз.
  expect((await runCustomerTurnCatchUpTick({ minAge: "0 seconds" })).queued).toBe(0);
  expect(await runCustomerCatchUpTurn(b2)).toBeNull();
  expect(await consumeCustomerInboxTicket(b2)).toEqual({ status: "unchanged", reason: "already_planned" });
  expect(f.physical.slice(physicalBefore)).toEqual([delivered.text]);
}, 90_000);

it("два сторожа одновременно: ход возобновляется ровно один раз, второй раз база не даёт", async () => {
  const owner = await f.owner();
  const opener = await f.capture(owner, "Салом, хона мефурӯшед?");
  f.script([[reply([], "property")]]);
  await f.deliver(opener);
  const conversationId = (await ticket(opener)).conversationId!;
  const until = await staffRepliesAndPauses(conversationId, 4_000);
  const asked = await f.capture(owner, "Хонаи дуҳуҷрагӣ дар Сино ҳаст?");
  catchUpKeys.push(asked);
  expect(await consumeCustomerInboxTicket(asked)).toEqual({ status: "held", reason: "original_context_changed" });
  await waitPast(until);

  const [a, b] = await Promise.all([runCustomerTurnCatchUpTick({ minAge: "0 seconds" }), runCustomerTurnCatchUpTick({ minAge: "0 seconds" })]);
  expect(a.queued + b.queued).toBeGreaterThanOrEqual(1);
  expect(await prisma.backgroundJob.count({ where: { dedupeKey: `customer-inbox-catch-up:${asked}` } })).toBe(1);
  // Два исполнителя одного хода одновременно — часы ставит ровно один.
  const resumes = await Promise.all([resumeHeldCustomerTurn(asked), resumeHeldCustomerTurn(asked)]);
  expect(resumes.filter((r) => r === "resumed")).toHaveLength(1);
  expect(resumes.filter((r) => r === "not_eligible")).toHaveLength(1);
  expect((await ticket(asked)).resumedAt).not.toBeNull();
  expect(await resumeHeldCustomerTurn(asked)).toBe("not_eligible");
  // База сама не даёт второй раз поставить часы хода (триггер customer_ticket_resume_once).
  await expect(prisma.$executeRaw`UPDATE "CustomerPropertyIngressTicket" SET "resumedAt" = now() WHERE "eventKey" = ${asked}`).rejects.toThrow();
}, 90_000);

it("клиент просил не писать или сотрудник уже ответил после клиента — сторож молчит", async () => {
  const owner = await f.owner();
  const opener = await f.capture(owner, "Салом, хона мефурӯшед?");
  f.script([[reply([], "property")]]);
  await f.deliver(opener);
  const conversationId = (await ticket(opener)).conversationId!;
  const until = await staffRepliesAndPauses(conversationId, 3_000);
  const asked = await f.capture(owner, "Нархаш чанд?");
  catchUpKeys.push(asked);
  expect((await consumeCustomerInboxTicket(asked)).status).toBe("held");
  await waitPast(until);
  // Сотрудник ответил ещё раз уже ПОСЛЕ клиента (пауза не продлевалась): отвечать боту не на что.
  await prisma.$executeRaw`UPDATE "BotConversation" SET "messages" = "messages" || jsonb_build_array(jsonb_build_object(
      'role','assistant','content','Нарх 450 000 сомонӣ.','by',jsonb_build_object('kind','manual'))) WHERE "id" = ${conversationId}`;
  await runCustomerTurnCatchUpTick({ minAge: "0 seconds" });
  expect(await job(asked)).toBeNull();
  // Задание, поставленное ДО ответа сотрудника, в момент исполнения сверяет условия заново — и тоже молчит.
  expect(await runCustomerCatchUpTurn(asked)).toBeNull();
  expect((await ticket(asked)).resumedAt).toBeNull();
}, 90_000);

/** Переписка ядра: бот ответил клиенту, сотрудник ответил руками (короткая пауза), клиент написал на паузе — ход удержан. */
async function heldDuringPause(text: string, pauseMs = 3_000) {
  const owner = await f.owner();
  const opener = await f.capture(owner, "Салом, хона мефурӯшед?");
  f.script([[reply([], "property")]]);
  await f.deliver(opener);
  const conversationId = (await ticket(opener)).conversationId!;
  const until = await staffRepliesAndPauses(conversationId, pauseMs);
  const asked = await f.capture(owner, text);
  catchUpKeys.push(asked);
  expect((await consumeCustomerInboxTicket(asked)).status).toBe("held");
  await waitPast(until);
  return { conversationId, asked };
}
const setSwitch = (on: boolean) => prisma.settings.update({ where: { id: "singleton" }, data: { botCatchUpEnabled: on } });

it("«Бессрочно», «не пишите мне» и выключенный рубильник: бот не догоняет; всё снято — догоняет", async () => {
  const { conversationId, asked } = await heldDuringPause("Нархи хонаи дуҳуҷрагӣ чанд аст?");
  const tick = () => runCustomerTurnCatchUpTick({ minAge: "0 seconds" });

  // Сотрудник поставил «Бессрочно» (пресет — 10 лет вперёд, conversationDelivery.ts).
  await prisma.botConversation.update({ where: { id: conversationId }, data: { pausedUntil: new Date(Date.now() + 10 * 365 * 24 * 3_600_000) } });
  await tick();
  expect(await job(asked)).toBeNull();

  // Пауза снята, но клиент просил не писать.
  await prisma.botConversation.update({ where: { id: conversationId }, data: { pausedUntil: new Date(Date.now() - 1_000), optedOutAt: new Date() } });
  await tick();
  expect(await job(asked)).toBeNull();

  // «Не пишите» снято, но рубильник «Бот сам догоняет после паузы» выключен: ни задания, ни хода.
  await prisma.botConversation.update({ where: { id: conversationId }, data: { optedOutAt: null } });
  await setSwitch(false);
  try {
    await tick();
    expect(await job(asked)).toBeNull();
    expect(await runCustomerCatchUpTurn(asked)).toBeNull();
    expect((await ticket(asked)).resumedAt).toBeNull();
  } finally {
    await setSwitch(true);
  }

  // Всё снято — сторож ставит задание (значит, мешало именно перечисленное выше).
  await tick();
  expect(await job(asked)).toMatchObject({ status: "PENDING", maxAttempts: CATCH_UP_MAX_ATTEMPTS });
}, 120_000);

it("граница окна: сообщение старше окна бот не догоняет, а отдаёт человеку; в окне — догоняет", async () => {
  expect(CATCH_UP_MAX_AGE_HOURS).toBe(3);
  const { asked } = await heldDuringPause("Хонаи сеҳуҷрагӣ дар Шоҳмансур ҳаст?");
  await sleep(1_200);
  // Окно в одну секунду (в бою — три часа): сообщение уже за границей — задания нет, переписка уходит человеку.
  const outside = await runCustomerTurnCatchUpTick({ minAge: "0 seconds", maxAge: "1 second" });
  expect(await job(asked)).toBeNull();
  expect(outside.reported).toBeGreaterThanOrEqual(1);
  // То же сообщение в окне часа — задание ставится.
  await runCustomerTurnCatchUpTick({ minAge: "0 seconds", maxAge: "1 hour" });
  expect(await job(asked)).toMatchObject({ status: "PENDING" });
}, 120_000);

it("сбой базы при возобновлении — не «условия изменились»: задание падает и повторяет попытку, потом возобновляет", async () => {
  const { asked } = await heldDuringPause("Нархаш чанд аст?");
  vi.spyOn(prisma, "$transaction").mockRejectedValueOnce(new Error("deadlock detected"));
  // Исключение — очередь повторит задание (до CATCH_UP_MAX_ATTEMPTS раз, потом человеку через onGiveUp).
  await expect(runCustomerCatchUpTurn(asked)).rejects.toThrow(/повторит/);
  expect((await ticket(asked)).resumedAt).toBeNull();
  vi.restoreAllMocks();
  // Следующая попытка проходит: часы хода поставлены ровно один раз.
  expect(await resumeHeldCustomerTurn(asked)).toBe("resumed");
  expect((await ticket(asked)).resumedAt).not.toBeNull();
}, 120_000);
