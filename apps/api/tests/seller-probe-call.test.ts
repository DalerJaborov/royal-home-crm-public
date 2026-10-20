import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const originateLiveVoiceScenarioCall = vi.fn(async () => ({ ok: true, channelId: `chan-seller-${Math.random()}` }));
vi.mock("../src/lib/telephony/liveVoiceBridge.js", () => ({
  originateLiveVoiceScenarioCall,
  startLiveVoiceListener: () => {},
  restartLiveVoiceListener: () => {},
}));

/** Чёрный список живёт на станции (AMI); в тесте станции нет — подменяем ответ. */
const isNumberBlocked = vi.fn(async () => ({ ok: true as const, blocked: false }));
vi.mock("../src/lib/telephony/stationBlacklist.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isNumberBlocked,
  setNumberBlocked: vi.fn(),
}));

const parseSellerProbeCall = vi.fn(async () => null as unknown);
vi.mock("../src/ai/sellerProbeCallParse.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  parseSellerProbeCall,
}));

const { prisma } = await import("../src/db.js");
const { finishSellerProbeCall, runSellerProbeCallTick } = await import("../src/lib/sellerProbeCall.js");
const { buildSellerProbeCallPrompt } = await import("../src/ai/sellerProbeCallPersona.js");
const { normalizeSellerProbeParse } = await import("../src/ai/sellerProbeCallParse.js");

/**
 * ЗВОНОК СОБСТВЕННИКУ ПОКАЗАННОГО ОБЪЕКТА (порог 5.2).
 *
 * Здесь важнее всего три вещи, и все три — прямые решения владельца: звонок
 * уходит только когда сошлись признаки; разговор идёт про НАШИ расходы на
 * рекламу, а не про честность собственника; «не дозвонились» становится
 * сигналом ТОЛЬКО если номер вписывал агент руками.
 */

const runId = Date.now();
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = new Date("2026-09-16T07:00:00Z");
const SHOWING_AT = new Date(NOW.getTime() - 4 * DAY);

let agentId: string;
let buyerId: string;
let sellerId: string;
let propertyId: string;
let districtId: string;
let previousSettings: { postShowingCallEnabled: boolean; liveVoiceEnabled: boolean } | null = null;
let phoneSeq = 0;
let sellerPhone = "";

function phone(): string {
  phoneSeq++;
  return `+9928${String(runId).slice(-6)}${String(phoneSeq).padStart(2, "0")}`;
}

/** Показ, по которому покупатель промолчал, и сошедшиеся признаки по продавцу. */
async function makeSuspiciousShowing(): Promise<string> {
  const showing = await prisma.interaction.create({
    data: {
      clientId: buyerId,
      agentId,
      type: "SHOWING",
      propertyId,
      notes: "Показ",
      nextActionDate: SHOWING_AT,
      createdAt: new Date(SHOWING_AT.getTime() - HOUR),
    },
  });
  const call = await prisma.postShowingCall.create({
    data: {
      showingId: showing.id,
      clientId: buyerId,
      agentId,
      propertyId,
      scheduledFor: new Date(SHOWING_AT.getTime() + 2 * HOUR),
      status: "GIVEN_UP",
      attempts: 2,
      createdAt: new Date(SHOWING_AT.getTime() + 2 * HOUR),
    },
  });

  // Собственник отвечал до показа и замолчал после; агент вёл его и бросил;
  // объект ушёл с продажи уже после показа — три признака плюс четвёртый.
  await prisma.client.update({
    where: { id: sellerId },
    data: { lastClientMessageAt: new Date(SHOWING_AT.getTime() - DAY) },
  });
  await prisma.interaction.create({
    data: {
      clientId: sellerId,
      agentId,
      type: "CALL",
      notes: "Предупредил о показе",
      createdAt: new Date(SHOWING_AT.getTime() - 2 * HOUR),
    },
  });
  await prisma.property.update({
    where: { id: propertyId },
    data: { status: "WITHDRAWN", stageEnteredAt: new Date(SHOWING_AT.getTime() + DAY) },
  });
  return call.id;
}

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Тест-район-звонок-продавцу-${runId}` } })).id;
  agentId = (
    await prisma.agent.create({ data: { fullName: "Ноза Агентова", phone: phone(), role: "AGENT", passwordHash: "x" } })
  ).id;
  buyerId = (
    await prisma.client.create({
      data: {
        fullName: `Покупатель ${runId}`,
        phone: phone(),
        source: "PHONE_CALL",
        kind: "BUYER",
        assignedAgentId: agentId,
        acceptedAt: new Date(),
      },
    })
  ).id;
  sellerPhone = phone();
  sellerId = (
    await prisma.client.create({
      data: {
        fullName: `Собственник Рахимов ${runId}`,
        phone: sellerPhone,
        source: "WALK_IN",
        kind: "SELLER",
        assignedAgentId: agentId,
        acceptedAt: new Date(),
      },
    })
  ).id;
  propertyId = (
    await prisma.property.create({
      data: {
        title: `Двухкомнатная на Айни ${runId}`,
        type: "APARTMENT",
        areaSqm: 70,
        price: 60000,
        currency: "TJS",
        districtId,
        address: "Айни 1",
        condition: "GOOD",
        status: "AVAILABLE",
        sellerClientId: sellerId,
      },
    })
  ).id;
  const settings = await prisma.settings.upsert({ where: { id: "singleton" }, update: {}, create: { id: "singleton" } });
  previousSettings = {
    postShowingCallEnabled: settings.postShowingCallEnabled,
    liveVoiceEnabled: settings.liveVoiceEnabled,
  };
});

afterAll(async () => {
  if (previousSettings) await prisma.settings.update({ where: { id: "singleton" }, data: previousSettings });
  await prisma.pendingDirectorAlert.deleteMany({ where: { excludeAgentId: agentId } });
  await prisma.sellerProbeCall.deleteMany({ where: { agentId } });
  await prisma.postShowingCall.deleteMany({ where: { clientId: buyerId } });
  await prisma.interaction.deleteMany({ where: { clientId: { in: [buyerId, sellerId] } } });
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.client.deleteMany({ where: { id: { in: [buyerId, sellerId] } } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.$disconnect();
});

beforeEach(async () => {
  isNumberBlocked.mockReset();
  isNumberBlocked.mockResolvedValue({ ok: true, blocked: false });
  originateLiveVoiceScenarioCall.mockClear();
  originateLiveVoiceScenarioCall.mockResolvedValue({ ok: true, channelId: `chan-seller-${Math.random()}` });
  await prisma.pendingDirectorAlert.deleteMany({ where: { excludeAgentId: agentId } });
  await prisma.sellerProbeCall.deleteMany({ where: { agentId } });
  await prisma.postShowingCall.deleteMany({ where: { clientId: buyerId } });
  await prisma.interaction.deleteMany({ where: { clientId: { in: [buyerId, sellerId] } } });
  await prisma.property.update({
    where: { id: propertyId },
    data: { status: "AVAILABLE", deletedAt: null, stageEnteredAt: new Date(SHOWING_AT.getTime() - 10 * DAY) },
  });
  await prisma.client.update({ where: { id: sellerId }, data: { lastClientMessageAt: null, source: "WALK_IN", phone: sellerPhone } });
  await prisma.settings.update({
    where: { id: "singleton" },
    data: { postShowingCallEnabled: true, liveVoiceEnabled: true },
  });
});

describe("когда звоним собственнику", () => {
  it("признаки сошлись — набираем, и видно, по каким именно", async () => {
    await makeSuspiciousShowing();

    expect(await runSellerProbeCallTick(NOW)).toBe(1);
    expect(originateLiveVoiceScenarioCall).toHaveBeenCalledTimes(1);

    const probe = await prisma.sellerProbeCall.findFirstOrThrow({ where: { agentId } });
    expect(probe.status).toBe("CALLING");
    expect(probe.signals.length).toBeGreaterThanOrEqual(3);
    expect(probe.signals).toContain("both_silent");
  });

  // №172 (ночная проверка 24.09): «звоним» ставилось после набора — рестарт
  // между ними давал собственнику второй звонок. Теперь проверка занята ДО набора.
  it("в момент набора проверка уже занята; линия занята — занятие откатывается", async () => {
    await makeSuspiciousShowing();
    let statusDuringDial: string | null = null;
    originateLiveVoiceScenarioCall.mockImplementationOnce(async () => {
      statusDuringDial = (await prisma.sellerProbeCall.findFirst({ where: { agentId } }))?.status ?? null;
      return { ok: true, channelId: `chan-seller-claim-${runId}` };
    });
    expect(await runSellerProbeCallTick(NOW)).toBe(1);
    expect(statusDuringDial).toBe("CALLING");
    expect(await prisma.sellerProbeCall.findFirstOrThrow({ where: { agentId } })).toMatchObject({
      status: "CALLING",
      channelId: `chan-seller-claim-${runId}`,
      attempts: 1,
    });

    // Линия живого голоса занята — попытку не тратим, проверка снова ждёт.
    await prisma.sellerProbeCall.updateMany({
      where: { agentId },
      data: { status: "PENDING", channelId: null, attempts: 0, lastAttemptAt: null },
    });
    originateLiveVoiceScenarioCall.mockImplementationOnce(async () => ({ ok: false, busy: true }) as never);
    expect(await runSellerProbeCallTick(NOW)).toBe(0);
    expect(await prisma.sellerProbeCall.findFirstOrThrow({ where: { agentId } })).toMatchObject({
      status: "PENDING",
      attempts: 0,
      lastAttemptAt: null,
    });
  });

  it("рубильник опроса выключен — проверки продавца тоже нет", async () => {
    await makeSuspiciousShowing();
    await prisma.settings.update({ where: { id: "singleton" }, data: { postShowingCallEnabled: false } });

    expect(await runSellerProbeCallTick(NOW)).toBe(0);
    expect(originateLiveVoiceScenarioCall).not.toHaveBeenCalled();
  });

  it("признаков мало — собственника не трогаем вовсе", async () => {
    const showing = await prisma.interaction.create({
      data: { clientId: buyerId, agentId, type: "SHOWING", propertyId, notes: "Показ", nextActionDate: SHOWING_AT },
    });
    await prisma.postShowingCall.create({
      data: {
        showingId: showing.id,
        clientId: buyerId,
        agentId,
        propertyId,
        scheduledFor: new Date(SHOWING_AT.getTime() + 2 * HOUR),
        status: "GIVEN_UP",
        attempts: 2,
        createdAt: new Date(SHOWING_AT.getTime() + 2 * HOUR),
      },
    });

    expect(await runSellerProbeCallTick(NOW)).toBe(0);
    expect(await prisma.sellerProbeCall.count({ where: { agentId } })).toBe(0);
  });

  it("повторный проход второй проверки по тому же показу не заводит", async () => {
    await makeSuspiciousShowing();
    await runSellerProbeCallTick(NOW);
    await runSellerProbeCallTick(new Date(NOW.getTime() + HOUR));

    expect(await prisma.sellerProbeCall.count({ where: { agentId } })).toBe(1);
  });

  it("ночью и после 19:00 не набираем", async () => {
    await makeSuspiciousShowing();
    // 21:00 по Душанбе.
    expect(await runSellerProbeCallTick(new Date("2026-09-16T16:00:00Z"))).toBe(0);
    expect(originateLiveVoiceScenarioCall).not.toHaveBeenCalled();
  });
});

describe("что бот говорит собственнику", () => {
  const prompt = () =>
    buildSellerProbeCallPrompt({ sellerName: "Рахим", propertyLabel: "двухкомнатную на Айни" });

  it("спрашивает про НАШУ рекламу, а не про его честность", () => {
    expect(prompt()).toContain("продолжаем рекламировать");
    expect(prompt()).toContain("ещё в продаже");
  });

  it("не называет агента и не выдаёт, что идёт проверка", () => {
    expect(prompt()).toContain("не называй имён наших сотрудников");
    expect(prompt()).toContain("не намекай, что что-то проверяешь");
  });

  it("не устраивает допрос «кому продали»", () => {
    expect(prompt()).toContain("не спрашивай, КОМУ он продал");
  });
});

describe("что делаем с ответом", () => {
  async function startedProbe(): Promise<{ id: string; channelId: string }> {
    await makeSuspiciousShowing();
    await runSellerProbeCallTick(NOW);
    const row = await prisma.sellerProbeCall.findFirstOrThrow({ where: { agentId } });
    return { id: row.id, channelId: row.channelId! };
  }

  it("звук со станции не дошёл — попытка возвращается, номер мёртвым не становится", async () => {
    const { NO_STATION_AUDIO_REASON } = await import("../src/lib/telephony/liveVoiceAudioPath.js");
    const probe = await startedProbe();
    await finishSellerProbeCall(
      { channelId: probe.channelId, transcript: [], reason: NO_STATION_AUDIO_REASON, clientSpoke: false },
      NOW
    );
    const row = await prisma.sellerProbeCall.findUniqueOrThrow({ where: { id: probe.id } });
    expect(row).toMatchObject({ status: "PENDING", attempts: 0, deadNumber: false });
    expect(row.scheduledFor.getTime()).toBeGreaterThan(NOW.getTime());
  });

  it("«ещё в продаже» — круг закрыт, владельца не будим", async () => {
    const probe = await startedProbe();
    parseSellerProbeCall.mockResolvedValueOnce({
      outcome: "STILL_SELLING",
      confidence: 0.95,
      quote: null,
      summary: "В продаже",
    });

    await finishSellerProbeCall(
      {
        channelId: probe.channelId,
        transcript: ["Клиент: да, продаём ещё"],
        reason: "model_ended_call: answered",
        clientSpoke: true,
      },
      NOW
    );

    expect((await prisma.sellerProbeCall.findUniqueOrThrow({ where: { id: probe.id } })).outcome).toBe("STILL_SELLING");
    expect(await prisma.pendingDirectorAlert.count({ where: { tag: `seller-probe-${probe.id}` } })).toBe(0);
  });

  it("«уже продал» — владельцу, с дословной фразой и без дубля самому агенту", async () => {
    const probe = await startedProbe();
    parseSellerProbeCall.mockResolvedValueOnce({
      outcome: "SOLD_ELSEWHERE",
      confidence: 0.93,
      quote: "ой, не надо рекламировать, я уже продал",
      summary: "Продал",
    });

    await finishSellerProbeCall(
      {
        channelId: probe.channelId,
        transcript: ["Клиент: ой, не надо рекламировать, я уже продал"],
        reason: "model_ended_call: answered",
        clientSpoke: true,
      },
      NOW
    );

    const alert = await prisma.pendingDirectorAlert.findFirst({ where: { tag: `seller-probe-${probe.id}` } });
    expect(alert).not.toBeNull();
    expect(alert?.body).toContain("уже продал");
    expect(alert?.excludeAgentId).toBe(agentId);
  });

  it("«продал» без дословной фразы обвинением не становится", () => {
    expect(normalizeSellerProbeParse({ outcome: "SOLD_ELSEWHERE", confidence: 0.99 }).outcome).toBe("UNCLEAR");
  });

  // Аудит 02.10.2026, №8: пропуск необязательного поля не делает ответ непонятным.
  it("уверенность не названа — «ещё в продаже» засчитывается, явно низкая — нет", () => {
    expect(normalizeSellerProbeParse({ outcome: "STILL_SELLING", summary: "продаёт" }).outcome).toBe("STILL_SELLING");
    expect(normalizeSellerProbeParse({ outcome: "STILL_SELLING", confidence: 0.4 }).outcome).toBe("UNCLEAR");
    expect(normalizeSellerProbeParse({ outcome: "SOLD_ELSEWHERE", quote: "продал уже" }).outcome).toBe("UNCLEAR");
  });

  // Аудит №21: «снимем с рекламы» робот обещает — исполнить это должен человек.
  it("«передумал продавать» — руководителю делом «снять с рекламы», не тревогой про агента", async () => {
    const probe = await startedProbe();
    parseSellerProbeCall.mockResolvedValueOnce({
      outcome: "OWNER_CHANGED_MIND",
      confidence: 0.9,
      quote: "передумали, не продаём",
      summary: "Передумал",
    });
    await finishSellerProbeCall(
      {
        channelId: probe.channelId,
        transcript: ["Клиент: передумали, не продаём"],
        reason: "model_ended_call: answered",
        clientSpoke: true,
      },
      NOW
    );
    const alert = await prisma.pendingDirectorAlert.findFirst({ where: { tag: `seller-probe-changed-mind-${probe.id}` } });
    expect(alert).not.toBeNull();
    expect(alert?.body).toContain("снимите его с рекламы");
    expect(alert?.excludeAgentId).toBe(agentId);
    expect(await prisma.pendingDirectorAlert.count({ where: { tag: `seller-probe-${probe.id}` } })).toBe(0);
  });
});

/**
 * АУДИТ СЦЕНАРНЫХ ЗВОНКОВ 02.10.2026 (№3, №4, №6, №12, №14). «Мёртвым» номер
 * становится только тогда, когда НИ В ОДНОЙ попытке трубку не сняли; сбой на
 * нашей стороне не тратит попытку больше одного раза и номер не хоронит.
 */
describe("живой номер не объявляется мёртвым", () => {
  const RETRY_AT = new Date(NOW.getTime() + 5 * HOUR + 60_000);

  async function current(): Promise<{ id: string; channelId: string }> {
    const row = await prisma.sellerProbeCall.findFirstOrThrow({ where: { agentId } });
    return { id: row.id, channelId: row.channelId! };
  }

  async function finish(reason: string, at: Date, clientSpoke = false): Promise<void> {
    const { channelId } = await current();
    await finishSellerProbeCall({ channelId, transcript: clientSpoke ? ["Клиент: алло"] : [], reason, clientSpoke }, at);
  }

  async function twoAttempts(first: string, second: string, clientSpoke = false) {
    await makeSuspiciousShowing();
    await runSellerProbeCallTick(NOW);
    await finish(first, NOW, clientSpoke);
    await runSellerProbeCallTick(RETRY_AT);
    expect((await prisma.sellerProbeCall.findFirstOrThrow({ where: { agentId } })).attempts).toBe(2);
    await finish(second, RETRY_AT, clientSpoke);
    return prisma.sellerProbeCall.findFirstOrThrow({ where: { agentId } });
  }

  it("два автоответчика — попытки кончились, но номер живой: ни deadNumber, ни аларма", async () => {
    const probe = await twoAttempts("model_ended_call: voicemail", "model_ended_call: voicemail");
    expect(probe).toMatchObject({ status: "GIVEN_UP", deadNumber: false });
    expect(await prisma.pendingDirectorAlert.count({ where: { tag: `seller-probe-dead-${probe.id}` } })).toBe(0);
  });

  it("автоответчик оператора, названный репликами «клиента», а не моделью, — номер живой, не разговор", async () => {
    await makeSuspiciousShowing();
    await runSellerProbeCallTick(NOW);
    const { channelId } = await current();
    await finishSellerProbeCall(
      {
        channelId,
        transcript: ["Бот: Алло", "Клиент: Абонент недоступен, оставьте сообщение после сигнала."],
        reason: "model_ended_call: answered",
        clientSpoke: true,
      },
      NOW
    );
    const probe = await prisma.sellerProbeCall.findFirstOrThrow({ where: { agentId } });
    expect(probe.status).not.toBe("DONE");
    expect(probe.deadNumber).toBe(false);
    expect(probe.attempts).toBe(1);
  });

  it("«перезвоните позже», потом недозвон — номер живой: ни deadNumber, ни аларма", async () => {
    await makeSuspiciousShowing();
    await runSellerProbeCallTick(NOW);
    await finish("model_ended_call: call_back_later", NOW, true);
    await runSellerProbeCallTick(RETRY_AT);
    await finish("no_answer", RETRY_AT);
    const probe = await prisma.sellerProbeCall.findFirstOrThrow({ where: { agentId } });
    expect(probe).toMatchObject({ status: "GIVEN_UP", deadNumber: false });
    expect(await prisma.pendingDirectorAlert.count({ where: { tag: `seller-probe-dead-${probe.id}` } })).toBe(0);
  });

  it("обе попытки — трубку не сняли вовсе: вот это мёртвый номер, и сигнал про ручную карточку", async () => {
    const probe = await twoAttempts("no_answer", "no_answer");
    expect(probe).toMatchObject({ status: "GIVEN_UP", deadNumber: true });
    expect(await prisma.pendingDirectorAlert.count({ where: { tag: `seller-probe-dead-${probe.id}` } })).toBe(1);
  });

  it("трубку взял не собственник — вторая попытка, пометка, номер живой", async () => {
    parseSellerProbeCall.mockClear();
    await makeSuspiciousShowing();
    await runSellerProbeCallTick(NOW);
    await finish("model_ended_call: wrong_person", NOW, true);
    const probe = await prisma.sellerProbeCall.findFirstOrThrow({ where: { agentId } });
    expect(probe).toMatchObject({ status: "NO_ANSWER", attempts: 1, deadNumber: false, outcome: null });
    expect(probe.skipReason).toContain("wrong_person");
    expect(probe.skipReason).toContain("line_alive");
    expect(parseSellerProbeCall).not.toHaveBeenCalled();
  });

  it("сбой модели — попытка возвращается; второй немой звонок — проверка закрыта без deadNumber и аларма", async () => {
    const { NO_STATION_AUDIO_REASON } = await import("../src/lib/telephony/liveVoiceAudioPath.js");
    await makeSuspiciousShowing();
    await runSellerProbeCallTick(NOW);
    await finish("gemini_error", NOW, true);
    let probe = await prisma.sellerProbeCall.findFirstOrThrow({ where: { agentId } });
    expect(probe).toMatchObject({ status: "PENDING", attempts: 0, deadNumber: false });

    const later = new Date(NOW.getTime() + 2 * HOUR);
    await runSellerProbeCallTick(later);
    expect((await prisma.sellerProbeCall.findFirstOrThrow({ where: { agentId } })).status).toBe("CALLING");
    await finish(NO_STATION_AUDIO_REASON, later);

    probe = await prisma.sellerProbeCall.findFirstOrThrow({ where: { agentId } });
    expect(probe).toMatchObject({ status: "SKIPPED", skipReason: "station_down", deadNumber: false });
    expect(await prisma.pendingDirectorAlert.count({ where: { tag: `seller-probe-dead-${probe.id}` } })).toBe(0);
  });

  it("сторож зависших не трогает разговор на 16-й минуте, а на 21-й считает итог потерянным нами", async () => {
    await makeSuspiciousShowing();
    await runSellerProbeCallTick(NOW);
    await runSellerProbeCallTick(new Date(NOW.getTime() + 16 * 60_000));
    expect((await prisma.sellerProbeCall.findFirstOrThrow({ where: { agentId } })).status).toBe("CALLING");

    await runSellerProbeCallTick(new Date(NOW.getTime() + 21 * 60_000));
    const probe = await prisma.sellerProbeCall.findFirstOrThrow({ where: { agentId } });
    expect(probe).toMatchObject({ status: "PENDING", attempts: 0, deadNumber: false });
  });
});

describe("номер молчит", () => {
  it("карточку заводил агент руками — сигнал владельцу", async () => {
    await makeSuspiciousShowing();
    // Номер, который станция набрать не может (02.10.2026: «мёртвым» номер
    // делает сам номер, а не любой отказ станции — см. «станция моргнула» ниже).
    await prisma.client.update({ where: { id: sellerId }, data: { phone: "+992 12-34" } });

    await runSellerProbeCallTick(NOW);
    expect(originateLiveVoiceScenarioCall).not.toHaveBeenCalled();

    const probe = await prisma.sellerProbeCall.findFirstOrThrow({ where: { agentId } });
    expect(probe.deadNumber).toBe(true);
    const alert = await prisma.pendingDirectorAlert.findFirst({ where: { tag: `seller-probe-dead-${probe.id}` } });
    expect(alert).not.toBeNull();
    expect(alert?.body).toContain("Карточку заводил сотрудник руками");
  });

  it("номер пришёл из канала — тот же отказ ничего не значит", async () => {
    await makeSuspiciousShowing();
    await prisma.client.update({ where: { id: sellerId }, data: { source: "INSTAGRAM", phone: "+992 12-34" } });

    await runSellerProbeCallTick(NOW);

    const probe = await prisma.sellerProbeCall.findFirstOrThrow({ where: { agentId } });
    expect(probe.deadNumber).toBe(true);
    expect(await prisma.pendingDirectorAlert.count({ where: { tag: `seller-probe-dead-${probe.id}` } })).toBe(0);
  });
});

/**
 * ОТКАЗ СТАНЦИИ — НЕ ПРИГОВОР НОМЕРУ (02.10.2026, аудит фона №3). Раньше любой
 * отказ набора закрывал проверку как GIVEN_UP + deadNumber и поднимал директору
 * «номер вписан вручную» — станция моргнула, агент ложно обвинён.
 */
describe("станция моргнула", () => {
  for (const error of [
    "Не удалось соединиться с Asterisk",
    "Телефония не настроена",
    "Живой голос выключен — включите тумблер в Настройках",
    "HTTP 503",
  ]) {
    it(`«${error}» — проверка ждёт следующей попытки, номер не мёртвый, тревоги нет`, async () => {
      await makeSuspiciousShowing();
      originateLiveVoiceScenarioCall.mockResolvedValue({ ok: false, error } as never);

      expect(await runSellerProbeCallTick(NOW)).toBe(0);

      const probe = await prisma.sellerProbeCall.findFirstOrThrow({ where: { agentId } });
      expect(probe).toMatchObject({ status: "PENDING", deadNumber: false, attempts: 0 });
      expect(probe.scheduledFor.getTime()).toBeGreaterThanOrEqual(NOW.getTime() + HOUR);
      expect(await prisma.pendingDirectorAlert.count({ where: { tag: `seller-probe-dead-${probe.id}` } })).toBe(0);
    });
  }

  it("через час станция ожила — звоним как обычно", async () => {
    await makeSuspiciousShowing();
    originateLiveVoiceScenarioCall.mockResolvedValueOnce({ ok: false, error: "Не удалось соединиться с Asterisk" } as never);
    await runSellerProbeCallTick(NOW);
    expect(await runSellerProbeCallTick(new Date(NOW.getTime() + HOUR))).toBe(1);
    const probe = await prisma.sellerProbeCall.findFirstOrThrow({ where: { agentId } });
    expect(probe).toMatchObject({ status: "CALLING", attempts: 1, deadNumber: false });
  });
});

/**
 * ОДИН ЗВОНОК ЗА ТИК (02.10.2026, аудит фона №4): порт RTP у моста один —
 * вторая беседа, набранная в тот же тик, обрывается на «алло».
 */
describe("один звонок за тик", () => {
  /** Вторая проверка рядом с той, что тик заведёт сам из makeSuspiciousShowing, —
   *  по другому звонку покупателю, срок пораньше. */
  async function addSecondProbe(): Promise<void> {
    const showing2 = await prisma.interaction.create({
      data: { clientId: buyerId, agentId, type: "SHOWING", propertyId, notes: "Показ 2", nextActionDate: SHOWING_AT },
    });
    const call2 = await prisma.postShowingCall.create({
      data: { showingId: showing2.id, clientId: buyerId, agentId, propertyId, scheduledFor: SHOWING_AT, status: "GIVEN_UP", attempts: 2 },
    });
    await prisma.sellerProbeCall.create({
      data: {
        postShowingCallId: call2.id,
        propertyId,
        sellerClientId: sellerId,
        agentId,
        scheduledFor: new Date(NOW.getTime() - HOUR),
        signals: [],
      },
    });
  }

  it("две проверки к сроку — набирается одна, вторая ждёт следующего тика", async () => {
    await makeSuspiciousShowing();
    await addSecondProbe();

    expect(await runSellerProbeCallTick(NOW)).toBe(1);
    expect(originateLiveVoiceScenarioCall).toHaveBeenCalledTimes(1);
    const statuses = (await prisma.sellerProbeCall.findMany({ where: { agentId } })).map((p) => p.status).sort();
    expect(statuses).toEqual(["CALLING", "PENDING"]);
  });

  it("линия занята — дальше в этом тике не набираем, попытки не тратятся", async () => {
    await makeSuspiciousShowing();
    await addSecondProbe();
    originateLiveVoiceScenarioCall.mockResolvedValue({ ok: false, busy: true, error: "занята" } as never);

    expect(await runSellerProbeCallTick(NOW)).toBe(0);
    expect(originateLiveVoiceScenarioCall).toHaveBeenCalledTimes(1);
    const probes = await prisma.sellerProbeCall.findMany({ where: { agentId } });
    expect(probes).toHaveLength(2);
    for (const p of probes) expect(p).toMatchObject({ status: "PENDING", attempts: 0, deadNumber: false });
  });
});

describe("объект удалён", () => {
  /**
   * Ночная проверка 24.09.2026: объект успел уйти в Корзину между тем, как
   * сошлись признаки, и тем, как настал час звонка — без фикса робот всё
   * равно звонит собственнику про объект, которого в системе больше нет.
   */
  it("объект в Корзине — собственнику не звоним, проверка закрыта как SKIPPED", async () => {
    await makeSuspiciousShowing();
    // Объект не просто снят с продажи (WITHDRAWN, как в makeSuspiciousShowing),
    // а удалён в Корзину целиком — тот самый случай из находки.
    await prisma.property.update({ where: { id: propertyId }, data: { deletedAt: new Date(SHOWING_AT.getTime() + DAY) } });

    expect(await runSellerProbeCallTick(NOW)).toBe(0);
    expect(originateLiveVoiceScenarioCall).not.toHaveBeenCalled();

    const probe = await prisma.sellerProbeCall.findFirstOrThrow({ where: { agentId } });
    expect(probe.status).toBe("SKIPPED");
    expect(probe.skipReason).toBe("property_gone");
  });
});

/**
 * АУДИТ ЗВОНКОВ РОБОТА 02.10.2026, А4 — «не беспокойте», чёрный список, воскресенье; А3 — цитата.
 */
describe("кому и когда звонить собственнику нельзя (А4)", () => {
  it("собственник написал «не беспокойте» — проверка закрыта, не набираем, тревоги нет", async () => {
    await makeSuspiciousShowing();
    const conv = await prisma.botConversation.create({
      data: { channel: "WHATSAPP", subscriberId: `dnc-seller-${runId}`, clientId: sellerId, optedOutAt: new Date() },
    });
    try {
      expect(await runSellerProbeCallTick(NOW)).toBe(0);
      expect(originateLiveVoiceScenarioCall).not.toHaveBeenCalled();
      const probe = await prisma.sellerProbeCall.findFirstOrThrow({ where: { agentId } });
      expect(probe).toMatchObject({ status: "SKIPPED", skipReason: "do_not_contact", deadNumber: false });
      expect(await prisma.pendingDirectorAlert.count({ where: { excludeAgentId: agentId } })).toBe(0);
    } finally {
      await prisma.botConversation.deleteMany({ where: { id: conv.id } });
    }
  });

  it("номер в чёрном списке станции — не набираем", async () => {
    await makeSuspiciousShowing();
    isNumberBlocked.mockResolvedValue({ ok: true, blocked: true });

    expect(await runSellerProbeCallTick(NOW)).toBe(0);
    expect(originateLiveVoiceScenarioCall).not.toHaveBeenCalled();
    expect((await prisma.sellerProbeCall.findFirstOrThrow({ where: { agentId } })).skipReason).toBe("blacklisted");
  });

  it("общий выходной в воскресенье (Настройки) — не набираем", async () => {
    await makeSuspiciousShowing();
    const sundayNoon = new Date("2026-09-20T07:00:00Z");
    await prisma.settings.update({ where: { id: "singleton" }, data: { companyDaysOff: [0] } });
    try {
      expect(await runSellerProbeCallTick(sundayNoon)).toBe(0);
      expect(originateLiveVoiceScenarioCall).not.toHaveBeenCalled();
    } finally {
      await prisma.settings.update({ where: { id: "singleton" }, data: { companyDaysOff: [] } });
    }
  });
});

describe("цитата собственника сверяется с расшифровкой (А3)", () => {
  async function started(): Promise<{ id: string; channelId: string }> {
    await makeSuspiciousShowing();
    await runSellerProbeCallTick(NOW);
    const row = await prisma.sellerProbeCall.findFirstOrThrow({ where: { agentId } });
    return { id: row.id, channelId: row.channelId! };
  }

  it("«продал» с цитатой, которой в расшифровке нет, — исход «непонятно», директору тревоги нет", async () => {
    const probe = await started();
    parseSellerProbeCall.mockImplementationOnce(async (t: unknown) =>
      normalizeSellerProbeParse(
        { outcome: "SOLD_ELSEWHERE", confidence: 0.95, quote: "я уже продал через знакомого", summary: "Продал" },
        t as string[]
      )
    );
    await finishSellerProbeCall(
      {
        channelId: probe.channelId,
        transcript: ["Бот: Квартира ещё в продаже?", "Клиент: да, пока в продаже"],
        reason: "model_ended_call: answered",
        clientSpoke: true,
      },
      NOW
    );
    const row = await prisma.sellerProbeCall.findUniqueOrThrow({ where: { id: probe.id } });
    expect(row.outcome).toBe("UNCLEAR");
    expect(row.quote).toBeNull();
    expect(row.summary).toContain("цитата не подтверждена");
    expect(await prisma.pendingDirectorAlert.count({ where: { tag: `seller-probe-${probe.id}` } })).toBe(0);
  });

  it("«передумал» с выдуманной цитатой тоже не ставит руководителю задачу", async () => {
    const probe = await started();
    parseSellerProbeCall.mockImplementationOnce(async (t: unknown) =>
      normalizeSellerProbeParse(
        { outcome: "OWNER_CHANGED_MIND", confidence: 0.9, quote: "мы передумали продавать", summary: "Передумал" },
        t as string[]
      )
    );
    await finishSellerProbeCall(
      {
        channelId: probe.channelId,
        transcript: ["Клиент: перезвоните позже, сейчас занят"],
        reason: "model_ended_call: answered",
        clientSpoke: true,
      },
      NOW
    );
    expect((await prisma.sellerProbeCall.findUniqueOrThrow({ where: { id: probe.id } })).outcome).toBe("UNCLEAR");
    expect(await prisma.pendingDirectorAlert.count({ where: { tag: `seller-probe-changed-mind-${probe.id}` } })).toBe(0);
  });

  it("настоящая цитата проходит, аларм уходит", async () => {
    const probe = await started();
    parseSellerProbeCall.mockImplementationOnce(async (t: unknown) =>
      normalizeSellerProbeParse(
        { outcome: "SOLD_ELSEWHERE", confidence: 0.95, quote: "Я уже продал, спасибо", summary: "Продал" },
        t as string[]
      )
    );
    await finishSellerProbeCall(
      {
        channelId: probe.channelId,
        transcript: ["Клиент: ой, я уже продал спасибо"],
        reason: "model_ended_call: answered",
        clientSpoke: true,
      },
      NOW
    );
    expect((await prisma.sellerProbeCall.findUniqueOrThrow({ where: { id: probe.id } })).outcome).toBe("SOLD_ELSEWHERE");
    expect(await prisma.pendingDirectorAlert.count({ where: { tag: `seller-probe-${probe.id}` } })).toBe(1);
  });
});
