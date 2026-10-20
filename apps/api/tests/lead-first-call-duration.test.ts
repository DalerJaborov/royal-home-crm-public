import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import { prisma } from "../src/db.js";
import * as scoreJournal from "../src/lib/scoreJournal.js";
import {
  collectFirstCallFacts,
  decideFirstCall,
  firstCallStatus,
  rewardFirstCallIfOnTime,
  firstCallCandidateWindow,
} from "../src/leads.js";

/**
 * Первый звонок ЗАСЧИТЫВАЕТСЯ ЛЮБОЙ ПОПЫТКОЙ (закон о владении клиентом П-2,
 * 17.09.2026, `docs/law/lead-ownership.md`, `services/leads/ownershipPolicy.ts`
 * ::hasContactAttempt) — дозвонился агент или нет. ДО этой правки лид уходил
 * дальше (`keepLead: false`), если разговор был короче `leadCallMinSeconds»,
 * даже когда агент реально звонил, — то же нарушение П-3, что и у остальных 11
 * механизмов (`docs/audit/recon-17-09/02-auto-transfer-mechanisms.md`, №4).
 *
 * Правило проверяется тремя слоями, потому что ломается оно в разных местах:
 * решение (кого наказывать и у кого забирать лид), сбор фактов (что вообще
 * считается звонком агента) и начисление балла за звонок вовремя. Длительность
 * разговора решение по-прежнему НЕ читает: `talked`/порог секунд остались
 * только в сборе фактов (`collectFirstCallFacts`) и в награде за звонок вовремя
 * (`rewardFirstCallIfOnTime`) — это отдельные, не затронутые законом П-2 части.
 *
 * Настройки агентства здесь НЕ меняются: они одни на всю базу, а тестовые файлы
 * идут параллельно — включив телефонию глобально, этот файл ронял бы соседний
 * lead-call-timeout.test.ts, который проверяет поведение без АТС.
 */

describe("Решение по первому звонку", () => {
  it("П-2: любая попытка (дозвонился или нет) закрывает обязанность — лид остаётся, штрафа нет", () => {
    expect(decideFirstCall({ telephonyOn: true, stationBlind: false, attempted: false, tried: true })).toEqual({
      keepLead: true,
      penalize: false,
    });
  });

  it("не сделал ни одной попытки — штраф, лид уходит дальше", () => {
    const v = decideFirstCall({ telephonyOn: true, stationBlind: false, attempted: false, tried: false });
    expect(v).toEqual({ keepLead: false, penalize: true });
  });

  it("без АТС: записанная попытка (звонок в хронологии) спасает от штрафа и передачи", () => {
    // «attempted» — переработка 12.08.2026: раньше сигналом было закрытое окно
    // «Итог разговора» (kind="call", снято вместе со всем окном); теперь тот же
    // смысл несёт факт tried из collectFirstCallFacts (Interaction type=CALL),
    // который телефонии не требует — ручная запись через AddInteractionModal тоже
    // считается.
    expect(decideFirstCall({ telephonyOn: false, stationBlind: false, attempted: true, tried: false })).toEqual({
      keepLead: true,
      penalize: false,
    });
    expect(decideFirstCall({ telephonyOn: false, stationBlind: false, attempted: false, tried: false })).toEqual({
      keepLead: false,
      penalize: true,
    });
  });

  it("станция ослепла (stationBlind) — как без АТС: смотрим только на attempted", () => {
    expect(decideFirstCall({ telephonyOn: true, stationBlind: true, attempted: true, tried: false })).toEqual({
      keepLead: true,
      penalize: false,
    });
    expect(decideFirstCall({ telephonyOn: true, stationBlind: true, attempted: false, tried: false })).toEqual({
      keepLead: false,
      penalize: true,
    });
  });
});

describe("Окно кандидатов первого звонка — нижняя граница (17.09.2026)", () => {
  const now = new Date("2026-09-17T10:00:00.000Z");

  /**
   * ФОРМУЛА ПО БРИФУ: W = max(leadCallMinutes + leadPoolAfterMinutes, 60) * 4 минут.
   * По умолчанию (15+25=40) пол в 60 минут срабатывает: max(40,60)*4 = 240 минут.
   * Пояснительный пример в брифе («40 → 160 мин») это правило игнорирует — 160 это
   * 40*4 БЕЗ пола 60. Владелец недоступен для уточнения; взята буквальная формула
   * из текста задания (она точнее сформулирована, чем пример в скобках), решение
   * задокументировано здесь и в отчёте.
   */
  it("по умолчанию верхняя граница — leadCallMinutes назад, нижняя — 240 минут назад", () => {
    const { from, to } = firstCallCandidateWindow({ leadCallMinutes: 15, leadPoolAfterMinutes: 25 }, now);
    expect(to.getTime()).toBe(now.getTime() - 15 * 60_000);
    expect(from.getTime()).toBe(now.getTime() - 240 * 60_000);
  });

  it("нет строки настроек — те же значения по умолчанию (15/25)", () => {
    const { from, to } = firstCallCandidateWindow(null, now);
    expect(to.getTime()).toBe(now.getTime() - 15 * 60_000);
    expect(from.getTime()).toBe(now.getTime() - 240 * 60_000);
  });

  it("маленький цикл не сжимает окно меньше часового пола", () => {
    // 5+5=10 минут цикла — без max(...,60) окно было бы всего 40 минут.
    const { from, to } = firstCallCandidateWindow({ leadCallMinutes: 5, leadPoolAfterMinutes: 5 }, now);
    expect(to.getTime()).toBe(now.getTime() - 5 * 60_000);
    expect(from.getTime()).toBe(now.getTime() - 240 * 60_000);
  });

  it("большой цикл настроек честно растягивает окно (пол не действует)", () => {
    // 60+60=120 минут цикла — max(120,60)=120, *4=480 минут.
    // Часы раздачи круглосуточные: в первые часы дня окно отодвигается к вечеру
    // (widenAfterNight), а здесь проверяется сама формула.
    const { from, to } = firstCallCandidateWindow(
      { leadCallMinutes: 60, leadPoolAfterMinutes: 60, workHoursStart: "00:00", workHoursEnd: "24:00" },
      now
    );
    expect(to.getTime()).toBe(now.getTime() - 60 * 60_000);
    expect(from.getTime()).toBe(now.getTime() - 480 * 60_000);
  });
});

const runId = Date.now();
let savedHours: { workHoursStart: string; workHoursEnd: string } | null = null;
let agentId: string;
let otherAgentId: string;
const clientIds: string[] = [];
const incomingIds: string[] = [];

async function seedLead(name: string, acceptedMinutesAgo: number) {
  const client = await prisma.client.create({
    data: {
      fullName: `${name} ${runId}`,
      phone: `+9929${Math.floor(Math.random() * 10_000_000)}`,
      source: "PHONE_CALL",
      assignedAgentId: agentId,
      assignedAt: new Date(Date.now() - acceptedMinutesAgo * 60_000),
      acceptedAt: new Date(Date.now() - acceptedMinutesAgo * 60_000),
    },
  });
  clientIds.push(client.id);
  return client;
}

/** Звонок в хронологии — так его пишет lib/telephony/callTracker.ts. */
async function seedCall(
  clientId: string,
  opts: { seconds: number | null; minutesAgo: number; agent?: string }
) {
  const call = await prisma.interaction.create({
    data: {
      clientId,
      agentId: opts.agent ?? agentId,
      type: "CALL",
      notes: opts.seconds ? `Звонок через CRM, разговор ${opts.seconds} сек` : "Звонок через CRM: клиент не ответил",
      recordingDurationSec: opts.seconds,
    },
  });
  return prisma.interaction.update({
    where: { id: call.id },
    data: { createdAt: new Date(Date.now() - opts.minutesAgo * 60_000) },
  });
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash("testpass123", 10);
  agentId = (
    await prisma.agent.create({
      data: { fullName: "Агент длительности", phone: `+992972${runId}`, role: "AGENT", passwordHash },
    })
  ).id;
  otherAgentId = (
    await prisma.agent.create({
      data: { fullName: "Коллега длительности", phone: `+992973${runId}`, role: "AGENT", passwordHash },
    })
  ).id;
  savedHours = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { workHoursStart: true, workHoursEnd: true },
  });
  // Срок первого звонка стоит вне часов раздачи (23.09.2026, closedMsBeforeDue):
  // без круглосуточного окна этот файл зелёный только днём по Душанбе.
  //
  // Круглосуточное окно — это «00:00–24:00», и только оно. Прежнее «00:00–23:59»
  // круглосуточным НЕ было: минута 23:59:00–23:59:59 по Душанбе (18:59 UTC)
  // оставалась закрытой, и карточка, принятая в эту минуту, получала срок,
  // сдвинутый до полуночи. Файл падал ровно одну минуту в сутки — поймано
  // 24.09.2026 полным прогоном в 19:39 UTC («difference is 50464, expected 50»).
  //
  // Почему именно «24:00», а не «00:00–00:00»: настройку читают ДВЕ функции с
  // противоположным смыслом у start === end. `closedMsBeforeDue`
  // (services/leads/shared.ts) читает его как «ограничений нет», а
  // `isWithinDushanbeWindow` (lib/dushanbeTime.ts) — как «окно нулевой длины,
  // никогда», и раздача лидов (services/leads/reassignment.ts) не случится ни
  // разу. «00:00–24:00» устраивает обе: паузы нет и окно открыто всегда.
  //
  // Через Настройки такое значение не ввести — схема роута
  // (routes/settings.ts) допускает только 00:00–23:59. Это значение для тестов,
  // в умолчания продукта его не переносить.
  await prisma.settings.update({ where: { id: "singleton" }, data: { workHoursStart: "00:00", workHoursEnd: "24:00" } });
});

afterAll(async () => {
  await prisma.incomingCall.deleteMany({ where: { id: { in: incomingIds } } });
  await prisma.royalScoreEvent.deleteMany({ where: { agentId: { in: [agentId, otherAgentId] } } });
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: [agentId, otherAgentId] } } });
  if (savedHours) await prisma.settings.update({ where: { id: "singleton" }, data: savedHours });
});

describe("Что считается звонком агента", () => {
  it("разговор длиннее порога — обязанность закрыта", async () => {
    const lead = await seedLead("Поговорил", 20);
    await seedCall(lead.id, { seconds: 45, minutesAgo: 18 });

    const facts = await collectFirstCallFacts([lead], 30, 15);
    expect(facts.get(lead.id)).toEqual({ talked: true, tried: true, talkedLate: false });
  });

  it("разговор короче порога — попытка есть, разговора нет", async () => {
    const lead = await seedLead("Алло-перезвоню", 20);
    await seedCall(lead.id, { seconds: 8, minutesAgo: 18 });

    expect(await collectFirstCallFacts([lead], 30, 15).then((f) => f.get(lead.id))).toEqual({
      talked: false,
      tried: true,
      talkedLate: false,
    });
  });

  it("недозвон — тоже попытка, но не разговор", async () => {
    const lead = await seedLead("Не ответил", 20);
    await seedCall(lead.id, { seconds: null, minutesAgo: 18 });

    expect(await collectFirstCallFacts([lead], 30, 15).then((f) => f.get(lead.id))).toEqual({
      talked: false,
      tried: true,
      talkedLate: false,
    });
  });

  it("разговор ПОСЛЕ отведённого срока в срок не засчитывается, но виден как talkedLate", async () => {
    const lead = await seedLead("Опоздал", 60);
    // Принят час назад, поговорил полчаса назад — срок 15 минут давно вышел.
    await seedCall(lead.id, { seconds: 90, minutesAgo: 30 });

    // tried=false — для крона обязанность вовремя НЕ закрыта (штраф и передача
    // лида решаются строго по сроку). talkedLate=true — для экрана агента
    // разговор всё-таки был, и «срочно позвоните» ему больше не показывают
    // (19.09.2026).
    expect(await collectFirstCallFacts([lead], 30, 15).then((f) => f.get(lead.id))).toEqual({
      talked: false,
      tried: false,
      talkedLate: true,
    });
  });

  it("недозвон ПОСЛЕ срока не засчитывается вообще — набрать в гудок не значит поговорить", async () => {
    // Вопрос владельца 19.09.2026: «почему теперь позже 15 минут можно
    // звонить?». Внутри срока попытку засчитываем (клиент мог не взять трубку,
    // Fair Play), после срока — только состоявшийся разговор.
    const lead = await seedLead("Гудок после срока", 60);
    await seedCall(lead.id, { seconds: null, minutesAgo: 30 });

    expect(await collectFirstCallFacts([lead], 30, 15).then((f) => f.get(lead.id))).toBeUndefined();
  });

  it("входящий звонок клиента обязанность агента не закрывает — говорил оператор", async () => {
    const lead = await seedLead("Сам позвонил", 20);
    const call = await seedCall(lead.id, { seconds: 120, minutesAgo: 18 });
    const incoming = await prisma.incomingCall.create({
      data: {
        channelId: `test-in-${runId}-${clientIds.length}`,
        phone: lead.phone,
        answered: true,
        talkSeconds: 120,
        clientId: lead.id,
        interactionId: call.id,
      },
    });
    incomingIds.push(incoming.id);

    expect(await collectFirstCallFacts([lead], 30, 15).then((f) => f.get(lead.id))).toBeUndefined();
  });

  it("звонок другого агента чужую обязанность не закрывает", async () => {
    const lead = await seedLead("Чужой звонок", 20);
    await seedCall(lead.id, { seconds: 90, minutesAgo: 18, agent: otherAgentId });

    expect(await collectFirstCallFacts([lead], 30, 15).then((f) => f.get(lead.id))).toBeUndefined();
  });
});

describe("firstCallStatus — срок и статус для Главной агента и карточки клиента", () => {
  // Настройки без телефонии (asterisk* пусты) — тот же профиль, что у стенда
  // тестов по умолчанию (см. шапку файла: телефония не включается глобально,
  // чтобы не ронять lead-call-timeout.test.ts).
  const settings = { leadCallMinutes: 15, leadCallMinSeconds: 30, asteriskAriUrl: null, asteriskAriUsername: null, asteriskAriPassword: null };

  it("срок ещё не наступил, попыток не было — done=false, dueAt = acceptedAt + 15 мин", async () => {
    const lead = await seedLead("Ждём звонка", 5);
    const status = await firstCallStatus([lead], settings);
    const entry = status.get(lead.id);
    expect(entry?.done).toBe(false);
    expect(entry?.tried).toBe(false);
    expect(entry!.dueAt.getTime()).toBeCloseTo(lead.acceptedAt!.getTime() + 15 * 60_000, -2);
  });

  it("без АТС ручная запись попытки закрывает обязанность — done=true", async () => {
    const lead = await seedLead("Записал попытку без АТС", 5);
    await seedCall(lead.id, { seconds: null, minutesAgo: 3 });
    const entry = (await firstCallStatus([lead], settings)).get(lead.id);
    expect(entry?.done).toBe(true);
    expect(entry?.tried).toBe(true);
  });

  it("поздний НЕДОЗВОН «срочно позвоните» не гасит — разговора не было", async () => {
    const lead = await seedLead("Гудок после срока, экран", 60);
    await seedCall(lead.id, { seconds: null, minutesAgo: 30 });
    const entry = (await firstCallStatus([lead], settings)).get(lead.id);
    expect(entry?.done).toBe(false);
  });

  it("поздний разговор гасит «срочно позвоните» на экране агента — done=true", async () => {
    // Жалоба владельца 19.09.2026 по клиенту 00059: карточка висела в «Моём
    // фокусе» как срочный обзвон, хотя агент с клиентом уже поговорил — просто
    // позже отведённых пятнадцати минут.
    const lead = await seedLead("Поговорил, но поздно", 60);
    await seedCall(lead.id, { seconds: 90, minutesAgo: 30 });
    const entry = (await firstCallStatus([lead], settings)).get(lead.id);
    expect(entry?.done).toBe(true);
    expect(entry?.tried).toBe(true);
  });

  it("карточка без acceptedAt в ответ не попадает — срока ещё нет", async () => {
    const lead = await prisma.client.create({
      data: {
        fullName: `Не принят ${runId}`,
        phone: `+9929${Math.floor(Math.random() * 10_000_000)}`,
        source: "PHONE_CALL",
        assignedAgentId: agentId,
        assignedAt: new Date(),
        acceptedAt: null,
      },
    });
    clientIds.push(lead.id);
    const status = await firstCallStatus([lead], settings);
    expect(status.has(lead.id)).toBe(false);
  });
});

describe("Срок первого звонка стоит, пока станция лежит (23.09.2026)", () => {
  // Телефония «включена» — иначе firstCallPauses честно ничего не продлевает.
  const settings = { leadCallMinutes: 15, leadCallMinSeconds: 30, asteriskAriUrl: "http://pbx.test", asteriskAriUsername: "u", asteriskAriPassword: "p" };
  const outageIds: string[] = [];
  afterAll(async () => {
    await prisma.stationOutage.deleteMany({ where: { id: { in: outageIds } } });
  });

  it("простой после приёма сдвигает срок ровно на своё время; без простоя срок прежний", async () => {
    const lead = await seedLead("Простой станции", 40);
    const before = (await firstCallStatus([lead], settings)).get(lead.id)!;
    expect(before.dueAt.getTime()).toBeCloseTo(lead.acceptedAt!.getTime() + 15 * 60_000, -2);

    // Станция лежала с 10-й по 40-ю минуту после приёма (30 минут) и уже поднялась.
    const startedAt = new Date(lead.acceptedAt!.getTime() + 10 * 60_000);
    const endedAt = new Date(lead.acceptedAt!.getTime() + 40 * 60_000);
    const outage = await prisma.stationOutage.create({ data: { startedAt, endedAt, lastError: "тест" } });
    outageIds.push(outage.id);

    const after = (await firstCallStatus([lead], settings)).get(lead.id)!;
    expect(after.dueAt.getTime()).toBeCloseTo(lead.acceptedAt!.getTime() + 45 * 60_000, -2);
    expect(after.done).toBe(false);
  });
});

describe("Балл за первый звонок вовремя", () => {
  it("вызов завершается только после записи события", async () => {
    const lead = await seedLead("Ожидание записи балла", 5);
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const original = scoreJournal.recordScoreEvent;
    const record = vi.spyOn(scoreJournal, "recordScoreEvent").mockImplementationOnce(async (input) => {
      entered();
      await gate;
      await original(input);
    });
    let completed = false;
    const reward = rewardFirstCallIfOnTime(lead.id, agentId, 60).then(() => { completed = true; });
    try {
      await started;
      await Promise.resolve();
      expect(completed).toBe(false);
      release();
      await reward;
      expect(await prisma.royalScoreEvent.count({
        where: { agentId, kind: "call_on_time", sourceId: { startsWith: `call-ontime-${lead.id}-` } },
      })).toBe(1);
    } finally {
      release();
      await reward;
      record.mockRestore();
    }
  });

  it("разговор дольше порога и в срок — балл начислен один раз", async () => {
    const lead = await seedLead("Балл", 5);

    await rewardFirstCallIfOnTime(lead.id, agentId, 60);
    await rewardFirstCallIfOnTime(lead.id, agentId, 60);

    const events = await prisma.royalScoreEvent.findMany({
      where: { agentId, kind: "call_on_time", sourceId: { startsWith: `call-ontime-${lead.id}-` } },
    });
    expect(events).toHaveLength(1);
  });

  it("короткий разговор балла не даёт", async () => {
    const lead = await seedLead("Короткий", 5);

    await rewardFirstCallIfOnTime(lead.id, agentId, 7);

    const event = await prisma.royalScoreEvent.findFirst({
      where: { agentId, sourceId: { startsWith: `call-ontime-${lead.id}-` } },
    });
    expect(event).toBeNull();
  });

  it("разговор после срока балла не даёт", async () => {
    const lead = await seedLead("Поздний", 90);

    await rewardFirstCallIfOnTime(lead.id, agentId, 120);

    const event = await prisma.royalScoreEvent.findFirst({
      where: { agentId, sourceId: { startsWith: `call-ontime-${lead.id}-` } },
    });
    expect(event).toBeNull();
  });

  it("звонок по чужому лиду балла не даёт", async () => {
    const lead = await seedLead("Чужой лид", 5);

    await rewardFirstCallIfOnTime(lead.id, otherAgentId, 60);

    const event = await prisma.royalScoreEvent.findFirst({
      where: { agentId: otherAgentId, sourceId: { startsWith: `call-ontime-${lead.id}-` } },
    });
    expect(event).toBeNull();
  });
});
