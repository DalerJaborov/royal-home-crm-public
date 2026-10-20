import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { createCustomerMessengerFixture, type CustomerMessengerFixture } from "./helpers/customerMessengerFixture.js";

/**
 * ЩИТ ИСХОДЯЩИХ (владелец 17.09.2026) — см. lib/outboundShield.ts.
 *
 * Тест сторожит ДВЕ вещи сразу, и вторая не менее важна первой:
 *  1. бот не может ни зациклиться, ни завалить человека повторами;
 *  2. бот НЕ МОЛЧИТ живому клиенту. Владелец сказал прямо: «не нужно, чтобы
 *     из-за этой защиты бот молчал как рыба настоящим клиентам». Поэтому
 *     половина проверок ниже — про то, что сообщение ПРОШЛО: и через паузу
 *     щита, и через выбранный лимит темпа, и через общую паузу бота.
 */

const {
  admitOutbound,
  noteRealInbound,
  resetOutboundShieldCache,
  MAX_MESSAGES_WITHOUT_INBOUND,
  MAX_INITIATIVE_PER_HOUR,
  repeatBlockedTexts,
} = await import("../src/lib/outboundShield.js");
const { resetOwnAccountCache } = await import("../src/lib/ownAccountGuard.js");

const runId = Date.now().toString(36);
const CHANNEL = "INSTAGRAM";
let fixture: CustomerMessengerFixture;
beforeAll(async () => { fixture = await createCustomerMessengerFixture(CHANNEL); });
let n = 0;
/** Свой получатель на каждую проверку: состояние щита ключуется парой канал+получатель. */
const nextSubscriber = (): string => `shield-${runId}-${++n}`;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** Диалог, который щит будет ставить на паузу (пауза пишется в BotConversation). */
async function makeConversation(subscriberId: string): Promise<void> {
  await fixture.ensureConversation(subscriberId);
}

async function conversationPause(subscriberId: string): Promise<Date | null> {
  const row = await prisma.botConversation.findFirst({
    where: { endpointScopeId: fixture.transport.endpointScopeId, subscriberId },
    select: { pausedUntil: true },
  });
  return row?.pausedUntil ?? null;
}

async function alertsFor(subscriberId: string): Promise<number> {
  return prisma.pendingDirectorAlert.count({ where: { tag: `outbound-shield:${CHANNEL} ${subscriberId}` } });
}

/** Общая пауза — единственное состояние щита на всю систему: гасим перед каждой проверкой. */
beforeEach(async () => {
  await prisma.outboundShieldGlobal.deleteMany({});
  /**
   * Поминутные счётчики пульса — тоже состояние на всю систему. Не обнулив их,
   * проверка всплеска оставляла бы соседям переполненное окно, и они падали бы
   * на общей паузе вместо своего правила. (Само по себе это верное поведение
   * щита: общий пульс сильнее частных правил.)
   */
  await prisma.outboundShieldPulse.deleteMany({});
  resetOutboundShieldCache();
});

afterAll(async () => {
  await prisma.outboundShieldState.deleteMany({ where: { subscriberId: { startsWith: `shield-${runId}` } } });
  await fixture?.dispose();
  await prisma.pendingDirectorAlert.deleteMany({ where: { tag: { startsWith: "outbound-shield" } } });
  await prisma.messengerAccount.deleteMany({ where: { externalId: { startsWith: `shield-${runId}` } } });
  await prisma.outboundShieldGlobal.deleteMany({});
  await prisma.outboundShieldPulse.deleteMany({});
  resetOwnAccountCache();
});

describe("щит исходящих: бот не зацикливается", () => {
  it("инцидент 17.09: пятая инициатива подряд без входящего заблокирована, диалог на паузе, аларм один", async () => {
    const subscriberId = nextSubscriber();
    await makeConversation(subscriberId);
    const t0 = new Date("2026-09-17T08:00:00Z");

    for (let i = 0; i < MAX_MESSAGES_WITHOUT_INBOUND; i++) {
      const verdict = await admitOutbound({ transport: fixture.transport,
        channel: CHANNEL,
        subscriberId,
        // Тексты разные: проверяем ИМЕННО монолог, а не запрет повторов.
        text: `Напоминание номер ${i}, подскажите пожалуйста район поиска`,
        now: new Date(t0.getTime() + i * MINUTE),
      });
      expect(verdict.allowed, `ход ${i} обязан пройти`).toBe(true);
    }

    const fifth = await admitOutbound({ transport: fixture.transport,
      channel: CHANNEL,
      subscriberId,
      text: "Напоминание номер пять, подскажите пожалуйста район поиска",
      now: new Date(t0.getTime() + 5 * MINUTE),
    });
    expect(fifth.allowed).toBe(false);
    expect(fifth.allowed === false && fifth.reason).toBe("monologue");

    // Пауза — тем же механизмом, что и кнопка «Поставить на паузу» в CRM.
    const paused = await conversationPause(subscriberId);
    expect(paused).not.toBeNull();
    expect(paused!.getTime()).toBeGreaterThan(t0.getTime());

    // Шестая попытка тоже не проходит, но руководство будят ОДИН раз в сутки:
    // шесть кандидатов 17.09 иначе дали бы полсотни одинаковых уведомлений.
    const sixth = await admitOutbound({ transport: fixture.transport,
      channel: CHANNEL,
      subscriberId,
      text: "Ещё одно напоминание, совсем другими словами про район",
      now: new Date(t0.getTime() + 6 * MINUTE),
    });
    expect(sixth.allowed).toBe(false);
    expect(await alertsFor(subscriberId)).toBe(1);
  });

  it("дословный повтор через 10 минут блокируется, через 25 часов проходит", async () => {
    const subscriberId = nextSubscriber();
    await makeConversation(subscriberId);
    const t0 = new Date("2026-09-17T09:00:00Z");
    const text = "Ташаккур, рақаматонро қабул кардам, ҳамкоронам бо шумо тамос мегиранд";

    expect((await admitOutbound({ transport: fixture.transport, channel: CHANNEL, subscriberId, text, now: t0 })).allowed).toBe(true);

    const repeat = await admitOutbound({ transport: fixture.transport,
      channel: CHANNEL,
      subscriberId,
      // Регистр, пунктуация и эмодзи повтором быть не перестают.
      text: `${text.toUpperCase()}!!! 🙏`,
      now: new Date(t0.getTime() + 10 * MINUTE),
    });
    expect(repeat.allowed).toBe(false);
    expect(repeat.allowed === false && repeat.reason).toBe("repeat");

    // Сутки прошли — тот же текст снова законен (и пауза щита к этому времени истекла).
    const later = await admitOutbound({ transport: fixture.transport,
      channel: CHANNEL,
      subscriberId,
      text,
      now: new Date(t0.getTime() + 25 * HOUR),
    });
    expect(later.allowed).toBe(true);
  });

  it("настоящее входящее с идентификатором провайдера обнуляет счётчик монолога", async () => {
    const subscriberId = nextSubscriber();
    await makeConversation(subscriberId);
    const t0 = new Date("2026-09-17T10:00:00Z");

    for (let i = 0; i < MAX_MESSAGES_WITHOUT_INBOUND; i++) {
      await admitOutbound({ transport: fixture.transport,
        channel: CHANNEL,
        subscriberId,
        text: `Служебное сообщение ${i} про подбор квартиры`,
        now: new Date(t0.getTime() + i * MINUTE),
      });
    }

    // Запись БЕЗ идентификатора провайдера входящим не считается — ровно такую
    // подделку дописывал в историю сторож номеров 17.09.
    await noteRealInbound({ transport: fixture.transport, channel: CHANNEL, subscriberId, providerId: null, now: new Date(t0.getTime() + 5 * MINUTE) });
    const afterFake = await admitOutbound({ transport: fixture.transport,
      channel: CHANNEL,
      subscriberId,
      text: "Совсем новое служебное сообщение после поддельного входящего",
      now: new Date(t0.getTime() + 6 * MINUTE),
    });
    expect(afterFake.allowed).toBe(false);
    expect(afterFake.allowed === false && afterFake.reason).toBe("monologue");

    // А настоящее — считается и обнуляет счётчик.
    await noteRealInbound({ transport: fixture.transport,
      channel: CHANNEL,
      subscriberId,
      providerId: "mid.real.001",
      now: new Date(t0.getTime() + 7 * MINUTE),
    });
    const afterReal = await admitOutbound({ transport: fixture.transport,
      channel: CHANNEL,
      subscriberId,
      text: "Совсем новое служебное сообщение после настоящего входящего",
      now: new Date(t0.getTime() + 8 * MINUTE),
    });
    expect(afterReal.allowed).toBe(true);
  });

  it("получатель — наш собственный аккаунт: блок всегда, даже руке сотрудника", async () => {
    const subscriberId = nextSubscriber();
    await prisma.messengerAccount.create({
      data: { channel: CHANNEL, title: `Щит ${subscriberId}`, externalId: subscriberId, token: "x" },
    });
    resetOwnAccountCache();

    const asBot = await admitOutbound({ transport: fixture.transport, channel: CHANNEL, subscriberId, text: "Салом, чӣ хел шумо" });
    expect(asBot.allowed).toBe(false);
    expect(asBot.allowed === false && asBot.reason).toBe("own_account");

    const asStaff = await admitOutbound({ transport: fixture.transport, channel: CHANNEL, subscriberId, text: "Пишет сотрудник", origin: "staff" });
    expect(asStaff.allowed).toBe(false);
  });

  it("всплеск исходящих поднимает общую паузу бота", async () => {
    const subscriberId = nextSubscriber();
    await makeConversation(subscriberId);
    const now = new Date();
    const bucket = new Date(now);
    bucket.setUTCSeconds(0, 0);
    // Порог при пустой истории — нижняя планка 60 за 10 минут (см. PULSE_FLOOR).
    await prisma.outboundShieldPulse.upsert({
      where: { bucket },
      update: { count: 61 },
      create: { bucket, count: 61 },
    });

    const verdict = await admitOutbound({ transport: fixture.transport, channel: CHANNEL, subscriberId, text: "Сообщение, переполнившее пульс" });
    expect(verdict.allowed).toBe(true);

    const global = await prisma.outboundShieldGlobal.findUnique({ where: { id: 1 } });
    expect(global?.pausedUntil).toBeTruthy();
    expect(global!.pausedUntil!.getTime()).toBeGreaterThan(Date.now());

    // Следующая инициатива — уже не проходит.
    const next = await admitOutbound({ transport: fixture.transport, channel: CHANNEL, subscriberId: nextSubscriber(), text: "Следующая инициатива" });
    expect(next.allowed).toBe(false);
    expect(next.allowed === false && next.reason).toBe("global_pulse");
  });
});

describe("щит исходящих: бот НЕ молчит живому человеку", () => {
  it("ручное сообщение сотрудника не блокируется ничем", async () => {
    const subscriberId = nextSubscriber();
    await makeConversation(subscriberId);
    const t0 = new Date("2026-09-17T11:00:00Z");

    // Диалог уже загнан в монолог — боту дальше нельзя.
    for (let i = 0; i <= MAX_MESSAGES_WITHOUT_INBOUND; i++) {
      await admitOutbound({ transport: fixture.transport,
        channel: CHANNEL,
        subscriberId,
        text: `Автоматическое сообщение ${i} про подбор`,
        now: new Date(t0.getTime() + i * MINUTE),
      });
    }
    expect((await admitOutbound({ transport: fixture.transport, channel: CHANNEL, subscriberId, text: "ещё бот", now: t0 })).allowed).toBe(false);

    // А живому сотруднику — можно, и дважды одно и то же тоже можно.
    const staffText = "Здравствуйте, я Далер, веду вашу заявку — когда удобно посмотреть квартиру?";
    for (const shift of [7, 8, 9]) {
      const verdict = await admitOutbound({ transport: fixture.transport,
        channel: CHANNEL,
        subscriberId,
        text: staffText,
        origin: "staff",
        now: new Date(t0.getTime() + shift * MINUTE),
      });
      expect(verdict.allowed, "рука сотрудника проходит всегда").toBe(true);
      expect(verdict.allowed === true && verdict.kind).toBe("staff");
    }
  });

  it("диалог на паузе щита: человек написал — бот отвечает, пауза снята сама", async () => {
    const subscriberId = nextSubscriber();
    await makeConversation(subscriberId);
    const t0 = new Date("2026-09-17T12:00:00Z");

    for (let i = 0; i <= MAX_MESSAGES_WITHOUT_INBOUND; i++) {
      await admitOutbound({ transport: fixture.transport,
        channel: CHANNEL,
        subscriberId,
        text: `Напоминание ${i} о просмотре квартиры`,
        now: new Date(t0.getTime() + i * MINUTE),
      });
    }
    expect(await conversationPause(subscriberId)).not.toBeNull();

    // Человек вернулся — щит обязан отпустить диалог САМ, без кнопки.
    await noteRealInbound({ transport: fixture.transport,
      channel: CHANNEL,
      subscriberId,
      providerId: "mid.human.001",
      now: new Date(t0.getTime() + 10 * MINUTE),
    });
    expect(await conversationPause(subscriberId)).toBeNull();

    const reply = await admitOutbound({ transport: fixture.transport,
      channel: CHANNEL,
      subscriberId,
      text: "Конечно, покажу — завтра в 15:00 вам удобно?",
      now: new Date(t0.getTime() + 11 * MINUTE),
    });
    expect(reply.allowed).toBe(true);
    expect(reply.allowed === true && reply.kind).toBe("reply");
  });

  it("лимит темпа выбран инициативами — ответ на настоящее входящее всё равно уходит", async () => {
    const subscriberId = nextSubscriber();
    await makeConversation(subscriberId);
    const t0 = new Date("2026-09-17T13:00:00Z");
    let sent = 0;

    // Два захода по четыре инициативы, между ними настоящее входящее: иначе
    // раньше темпа сработает правило монолога. Входящее старше 10 минут —
    // значит следующие сообщения снова инициатива, а не ответ.
    for (const base of [11, 31]) {
      for (let i = 0; i < MAX_MESSAGES_WITHOUT_INBOUND; i++) {
        const verdict = await admitOutbound({ transport: fixture.transport,
          channel: CHANNEL,
          subscriberId,
          text: `Инициатива ${base}-${i}: подскажите, пожалуйста, ваш район`,
          now: new Date(t0.getTime() + (base + i) * MINUTE),
        });
        if (verdict.allowed) sent++;
      }
      await noteRealInbound({ transport: fixture.transport,
        channel: CHANNEL,
        subscriberId,
        providerId: `mid.${base}`,
        now: new Date(t0.getTime() + (base + 9) * MINUTE),
      });
    }
    expect(sent).toBe(MAX_INITIATIVE_PER_HOUR);

    // Лимит часа выбран: инициатива дальше не идёт…
    const initiative = await admitOutbound({ transport: fixture.transport,
      channel: CHANNEL,
      subscriberId,
      text: "Ещё одна инициатива сверх лимита часа",
      now: new Date(t0.getTime() + 55 * MINUTE),
    });
    expect(initiative.allowed).toBe(false);
    expect(initiative.allowed === false && initiative.reason).toBe("rate_hour");

    // …а ОТВЕТ живому человеку — идёт.
    await noteRealInbound({ transport: fixture.transport,
      channel: CHANNEL,
      subscriberId,
      providerId: "mid.human.002",
      now: new Date(t0.getTime() + 56 * MINUTE),
    });
    const reply = await admitOutbound({ transport: fixture.transport,
      channel: CHANNEL,
      subscriberId,
      text: "Да, конечно, сейчас подберу варианты и пришлю",
      now: new Date(t0.getTime() + 57 * MINUTE),
    });
    expect(reply.allowed, "ответ настоящему человеку обязан пройти").toBe(true);
    expect(reply.allowed === true && reply.kind).toBe("reply");
  });

  it("общая пауза: напоминание крона не уходит, ответ настоящему человеку уходит", async () => {
    const subscriberId = nextSubscriber();
    await makeConversation(subscriberId);
    const now = new Date();
    await prisma.outboundShieldGlobal.upsert({
      where: { id: 1 },
      update: { pausedUntil: new Date(now.getTime() + 30 * MINUTE), reason: "тест" },
      create: { id: 1, pausedUntil: new Date(now.getTime() + 30 * MINUTE), reason: "тест" },
    });

    const cronReminder = await admitOutbound({ transport: fixture.transport,
      channel: CHANNEL,
      subscriberId,
      text: "Напоминание от крона: вы не ответили на наше предложение",
    });
    expect(cronReminder.allowed).toBe(false);
    expect(cronReminder.allowed === false && cronReminder.reason).toBe("global_pulse");

    await noteRealInbound({ transport: fixture.transport, channel: CHANNEL, subscriberId, providerId: "mid.human.003" });
    const reply = await admitOutbound({ transport: fixture.transport,
      channel: CHANNEL,
      subscriberId,
      text: "Здравствуйте! Да, эта квартира ещё свободна",
    });
    expect(reply.allowed, "общая пауза не имеет права глушить ответ живому человеку").toBe(true);
    expect(reply.allowed === true && reply.kind).toBe("reply");
  });

  it("человек переспросил дважды — бот повторяет ответ, и только третий дословный повтор блокируется", async () => {
    const subscriberId = nextSubscriber();
    await makeConversation(subscriberId);
    const t0 = new Date("2026-09-17T14:00:00Z");
    const answer = "Эта квартира ещё свободна, показ можем устроить сегодня вечером";

    for (const shift of [0, 5, 10]) {
      await noteRealInbound({ transport: fixture.transport,
        channel: CHANNEL,
        subscriberId,
        providerId: `mid.ask.${shift}`,
        now: new Date(t0.getTime() + shift * MINUTE),
      });
      const verdict = await admitOutbound({ transport: fixture.transport,
        channel: CHANNEL,
        subscriberId,
        text: answer,
        now: new Date(t0.getTime() + shift * MINUTE + 1000),
      });
      if (shift < 10) expect(verdict.allowed, `ответ на переспрос (${shift}) обязан пройти`).toBe(true);
      else {
        expect(verdict.allowed).toBe(false);
        expect(verdict.allowed === false && verdict.reason).toBe("repeat");
      }
    }
    /**
     * Аудит ботов 10.10.2026 (P0-1): повтор в ОТВЕТЕ живому человеку не ставит
     * диалог на 6-часовую паузу — не ушло одно сообщение, разговор продолжается.
     */
    expect(await conversationPause(subscriberId)).toBeNull();
  });

  it("повтор в инициативе по-прежнему ставит паузу — петли кронов глушатся как раньше", async () => {
    const subscriberId = nextSubscriber();
    await makeConversation(subscriberId);
    const t0 = new Date("2026-09-17T15:00:00Z");
    const text = "Напоминаем о просмотре квартиры, подтвердите, пожалуйста, время";
    await admitOutbound({ transport: fixture.transport, channel: CHANNEL, subscriberId, text, now: t0 });
    const repeat = await admitOutbound({ transport: fixture.transport, channel: CHANNEL, subscriberId, text, now: new Date(t0.getTime() + MINUTE) });
    expect(repeat.allowed === false && repeat.reason).toBe("repeat");
    expect(await conversationPause(subscriberId)).not.toBeNull();
  });

  it("repeatBlockedTexts заранее говорит, что щит не выпустит, и сам ничего не считает", async () => {
    const subscriberId = nextSubscriber();
    await makeConversation(subscriberId);
    const t0 = new Date("2026-09-17T16:00:00Z");
    const answer = "Эта квартира ещё свободна, показ можем устроить сегодня вечером";
    for (const shift of [0, 5]) {
      await noteRealInbound({ transport: fixture.transport, channel: CHANNEL, subscriberId, providerId: `mid.peek.${shift}`, now: new Date(t0.getTime() + shift * MINUTE) });
      await admitOutbound({ transport: fixture.transport, channel: CHANNEL, subscriberId, text: answer, now: new Date(t0.getTime() + shift * MINUTE + 1000) });
    }
    await noteRealInbound({ transport: fixture.transport, channel: CHANNEL, subscriberId, providerId: "mid.peek.10", now: new Date(t0.getTime() + 10 * MINUTE) });
    const at = new Date(t0.getTime() + 10 * MINUTE + 1000);
    const other = "Да, торг возможен, обсудим при просмотре";
    // Спросили дважды — ответ не меняется: проверка заранее ничего не записывает.
    for (let i = 0; i < 2; i++) {
      expect(await repeatBlockedTexts(CHANNEL, subscriberId, [`${answer}!`, other], at, fixture.transport)).toEqual([`${answer}!`]);
    }
    // Незнакомый щиту диалог — ничего не блокируется.
    expect(await repeatBlockedTexts(CHANNEL, nextSubscriber(), [answer], at, fixture.transport)).toEqual([]);
  });
});
