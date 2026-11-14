import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { backfillPhonesWithoutLead, runPhoneLeadWatchdogTick } from "../src/lib/phoneLeadWatchdog.js";

/**
 * КЛИЕНТ ДАЛ НОМЕР — КАРТОЧКА ОБЯЗАНА БЫТЬ (14.11.2026, владелец: «если таких много,
 * надо починить, чтобы такого никогда больше не было»).
 *
 * Сторож «номер есть — карточки нет» (lib/phoneLeadWatchdog.ts) — единственная дверь,
 * которая смотрит на ФАКТ, а не на причину. Разбор прода за 8–14.11 нашёл четыре дыры
 * в ней самой, каждая здесь держится отдельным тестом:
 *
 *  1. «done» без карточки (карточку удалили, диалог отвязали, стадия осталась):
 *     захват приёма не срабатывал НИКОГДА — бот сказал «Приняли ваш номер», а
 *     руководству пришла только тревога, карточки нет (живой Instagram 10.11);
 *  2. «одна попытка на диалог навсегда»: вернувшийся клиент со старым разобранным
 *     диалогом и НОВЫМ номером не проверялся больше никогда;
 *  3. соискатель работы в новом ядре: тема «job» живёт в CustomerInquiry, а не в
 *     leadDraft — сторож заводил карточку «Прочее» каждому кандидату (9 из 12);
 *  4. клиент нового ядра уходил в «Прочие обращения» без агента: ядро не пишет
 *     leadDraft.intent, приём видел «намерение не ясно».
 *
 * Модель не подменяем: приём из сторожа тихий (silent), ходов модели не делает.
 */

const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
const conversationIds: string[] = [];
const inquiryIds: string[] = [];
const scopeIds: string[] = [];

function phone(): string {
  return `9${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;
}

async function seed(input: {
  messages: Array<{ role: "user" | "assistant"; content: string; at?: string }>;
  leadDraft?: Record<string, unknown>;
  watchdogAttemptedAt?: Date;
  coreTopic?: "buyer" | "seller" | "job" | "unknown";
}): Promise<string> {
  const conv = await prisma.botConversation.create({
    data: {
      channel: "INSTAGRAM",
      subscriberId: `never-lost-${runId}-${Math.random().toString(36).slice(2, 8)}`,
      name: "Тест номера",
      messages: input.messages as never,
      leadDraft: (input.leadDraft ?? { stage: "chatting" }) as never,
      lastMessageAt: new Date(),
      ...(input.watchdogAttemptedAt ? { watchdogAttemptedAt: input.watchdogAttemptedAt } : {}),
    },
    select: { id: true },
  });
  conversationIds.push(conv.id);
  if (input.coreTopic) {
    // База сама заводит запрос ядра на каждый диалог (триггер); тема — то, что ядро пишет по ходу.
    const existing = await prisma.customerInquiry.findUnique({ where: { conversationId: conv.id }, select: { id: true } });
    if (existing) {
      await prisma.customerInquiry.update({ where: { id: existing.id }, data: { publicState: { topic: input.coreTopic } } });
      inquiryIds.push(existing.id);
    } else {
      const scopeId = randomUUID();
      await prisma.customerEndpointScope.create({ data: { id: scopeId, realmKey: "royal-home", channel: "INSTAGRAM",
        transportKey: `never-lost:${scopeId}`, kind: "NORMAL", scopeRevision: 1n } });
      scopeIds.push(scopeId);
      const inquiry = await prisma.customerInquiry.create({ data: { endpointScopeId: scopeId, peerId: `peer-${conv.id}`,
        conversationId: conv.id, publicState: { topic: input.coreTopic } } });
      inquiryIds.push(inquiry.id);
    }
  }
  return conv.id;
}

async function cardOf(conversationId: string) {
  const conv = await prisma.botConversation.findUnique({ where: { id: conversationId },
    select: { clientId: true, client: { select: { kind: true, status: true } } } });
  return conv;
}

beforeAll(async () => {
  await prisma.settings.upsert({ where: { id: "singleton" }, update: {}, create: { id: "singleton" } });
});

afterAll(async () => {
  const convs = await prisma.botConversation.findMany({ where: { id: { in: conversationIds } }, select: { clientId: true } });
  const clientIds = convs.map((c) => c.clientId).filter((c): c is string => !!c);
  await prisma.jobApplication.deleteMany({ where: { OR: [{ conversationId: { in: conversationIds } }, { customerInquiryId: { in: inquiryIds } }] } });
  await prisma.customerInquiry.deleteMany({ where: { id: { in: inquiryIds } } });
  await prisma.botConversation.deleteMany({ where: { id: { in: conversationIds } } });
  await prisma.customerEndpointScope.deleteMany({ where: { id: { in: scopeIds } } });
  if (clientIds.length > 0) {
    await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
    await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  }
});

describe("Номер от клиента не теряется", () => {
  it("стадия «done» без карточки (карточку удалили): номер оформляется, а не только тревога", async () => {
    const id = await seed({
      messages: [{ role: "user", content: `Салом, хона даркор. Рақамам ${phone()}`, at: new Date().toISOString() }],
      leadDraft: { stage: "done", intent: "buy", confident: true },
    });

    await runPhoneLeadWatchdogTick();

    expect((await cardOf(id))?.clientId).toBeTruthy();
  });

  it("вернувшийся клиент: новый номер после прошлой попытки сторожа оформляется", async () => {
    const attempted = new Date(Date.now() - 60 * 60_000);
    const id = await seed({
      messages: [
        { role: "user", content: "Салом, хона даркор", at: new Date(Date.now() - 2 * 60 * 60_000).toISOString() },
        { role: "user", content: `Рақамам ${phone()}`, at: new Date().toISOString() },
      ],
      leadDraft: { stage: "chatting", intent: "buy", confident: true },
      watchdogAttemptedAt: attempted,
    });

    await runPhoneLeadWatchdogTick();

    expect((await cardOf(id))?.clientId).toBeTruthy();
  });

  it("вернувшийся клиент без нового номера: старый номер (до прошлой попытки) не воскрешается", async () => {
    const attempted = new Date(Date.now() - 60 * 60_000);
    const id = await seed({
      messages: [
        { role: "user", content: `Рақамам ${phone()}`, at: new Date(Date.now() - 2 * 60 * 60_000).toISOString() },
        { role: "user", content: "Салом", at: new Date().toISOString() },
      ],
      leadDraft: { stage: "chatting", intent: "buy", confident: true },
      watchdogAttemptedAt: attempted,
    });

    await runPhoneLeadWatchdogTick();

    // Прошлую карточку удалил человек — по старой реплике сторож её не возвращает.
    expect((await cardOf(id))?.clientId).toBeNull();
  });

  it("соискатель работы в новом ядре: карточку клиента сторож не заводит", async () => {
    const id = await seed({
      messages: [{ role: "user", content: `Коргар даркор? Рақамам ${phone()}`, at: new Date().toISOString() }],
      coreTopic: "job",
    });

    await runPhoneLeadWatchdogTick();

    expect((await cardOf(id))?.clientId).toBeNull();
  });

  it("продавец из нового ядра: карточка продавца на распределение, а не «Прочее»", async () => {
    const id = await seed({
      messages: [
        { role: "user", content: "Мехоҳам хонаамро фурӯшам, 2 хонага дар Сино", at: new Date().toISOString() },
        { role: "user", content: `Рақамам ${phone()}`, at: new Date().toISOString() },
      ],
      coreTopic: "seller",
    });

    await runPhoneLeadWatchdogTick();

    const card = await cardOf(id);
    expect(card?.clientId).toBeTruthy();
    expect(card?.client?.kind).toBe("SELLER");
    expect(card?.client?.status).toBe("NEW");
  });

  it("покупатель из нового ядра без темы: намерение берётся из слов клиента", async () => {
    const id = await seed({
      messages: [
        { role: "user", content: "Здравствуйте, хочу купить двухкомнатную квартиру в Сино", at: new Date().toISOString() },
        { role: "user", content: `Мой номер ${phone()}`, at: new Date().toISOString() },
      ],
      coreTopic: "unknown",
    });

    await runPhoneLeadWatchdogTick();

    const card = await cardOf(id);
    expect(card?.clientId).toBeTruthy();
    expect(card?.client?.kind).toBe("BUYER");
  });
});

describe("Разовый добор потерянных номеров (scripts/phone-leads-backfill-14-11.ts)", () => {
  it("сухой прогон ничего не пишет; --apply заводит карточку и не воскрешает удалённую человеком", async () => {
    const lostPhone = phone();
    // Сторож уже пробовал (и провалился на «done» без карточки) — тик его больше не возьмёт.
    const lost = await seed({
      messages: [{ role: "user", content: `Хона мехарам. Рақамам ${lostPhone}`, at: new Date(Date.now() - 3 * 24 * 60 * 60_000).toISOString() }],
      leadDraft: { stage: "done", intent: "buy", confident: true },
      watchdogAttemptedAt: new Date(Date.now() - 3 * 24 * 60 * 60_000 + 60_000),
    });
    // Карточку по этому диалогу сторож уже заводил, потом её удалил человек.
    const removed = await seed({
      messages: [{ role: "user", content: `Хона мехарам. Рақамам ${phone()}`, at: new Date(Date.now() - 3 * 24 * 60 * 60_000).toISOString() }],
      leadDraft: { stage: "done", intent: "buy", confident: true },
      watchdogAttemptedAt: new Date(Date.now() - 3 * 24 * 60 * 60_000 + 60_000),
    });
    const log = await prisma.errorLog.create({ data: { source: "ai", message: `Заявка оформлена сторожем: номер +992•••••00 был в переписке (диалог ${removed}, Instagram), а карточки не было.` } });

    try {
      const dry = await backfillPhonesWithoutLead({ apply: false, windowHours: 14 * 24 });
      expect(dry.find((r) => r.conversationId === lost)?.action).toBe("accept");
      expect(dry.find((r) => r.conversationId === removed)?.action).toBe("skip");
      // В отчёте номер только под маской.
      expect(JSON.stringify(dry)).not.toContain(lostPhone);
      expect((await cardOf(lost))?.clientId).toBeNull();

      const applied = await backfillPhonesWithoutLead({ apply: true, windowHours: 14 * 24 });
      expect(applied.find((r) => r.conversationId === lost)?.outcome).toBe("accepted");
      expect((await cardOf(lost))?.clientId).toBeTruthy();
      expect((await cardOf(removed))?.clientId).toBeNull();
    } finally {
      await prisma.errorLog.delete({ where: { id: log.id } });
    }
  });
});
