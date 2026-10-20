import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const originateLiveVoiceScenarioCall = vi.fn(async () => ({ ok: true, channelId: `chan-${Math.random()}` }));
vi.mock("../src/lib/telephony/liveVoiceBridge.js", () => ({
  originateLiveVoiceScenarioCall,
  // Мост тянет за собой сокеты и ARI — в тесте расписания он не нужен вовсе,
  // проверяется РЕШЕНИЕ «звонить или нет», а не звук.
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

/** Разбор расшифровки — отдельный модуль со своими тестами; здесь важно не то,
 *  что скажет модель, а куда уйдёт её ответ. */
const parsePostShowingCall = vi.fn(async () => null as unknown);
vi.mock("../src/ai/postShowingCallParse.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  parsePostShowingCall,
}));

const { prisma } = await import("../src/db.js");
const { normalizePostShowingCallParse } = await import("../src/ai/postShowingCallParse.js");
const { waitFor } = await import("./helpers/waitFor.js");
const {
  alignToCallHours,
  isWithinPostShowingCallHours,
  finishPostShowingCall,
  postShowingCallDueAt,
  runPostShowingCallTick,
  showingWhenLabel,
} = await import("../src/lib/postShowingCall.js");

/**
 * РАСПИСАНИЕ РОБОЗВОНКА ПОСЛЕ ПОКАЗА (16.09.2026).
 *
 * Два правила здесь дороже остальных, и оба — прямые решения владельца:
 *  · звонить можно только до 19:00 (16.09) — поздний показ ждёт утра, а не
 *    сгорает и не будит человека в девять вечера;
 *  · звоним не после каждого показа, а только туда, где САМ КЛИЕНТ после показа
 *    ничего не сказал — иначе опрос превращается в поток автозвонков.
 */

const runId = Date.now();
let agentId: string;
let clientId: string;
let propertyId: string;
let districtId: string;
let previousSettings: { postShowingCallEnabled: boolean; liveVoiceEnabled: boolean } | null = null;

const HOUR = 60 * 60 * 1000;
/** Полдень 16.09.2026 по Душанбе (UTC+5) — «сейчас» для всех случаев. */
const NOON = new Date("2026-09-16T07:00:00Z");

/** `new Date(iso)` без суффикса зоны — по спецификации ЛОКАЛЬНОЕ время процесса,
 *  не UTC (в отличие от дат без времени). В Docker (TZ не задан → UTC) это
 *  случайно совпадало с ожиданием; на машине с системным поясом Душанбе
 *  (UTC+5) каждый `dushanbe(...)` уезжал на 5 часов, и «часы звонка» падали
 *  без единой строки кода в lib/postShowingCall.ts. Явный `Z` делает разбор
 *  детерминированным независимо от TZ процесса — тот же приём, что и в
 *  lib/dushanbeTime.ts (никогда через локальные часы процесса). */
function dushanbe(iso: string): Date {
  return new Date(new Date(`${iso}Z`).getTime() - 5 * HOUR);
}

async function makeShowing(at: Date, extra: Record<string, unknown> = {}) {
  return prisma.interaction.create({
    data: {
      clientId,
      agentId,
      type: "SHOWING",
      propertyId,
      notes: "Показ",
      nextAction: "Показ объекта",
      nextActionDate: at,
      ...extra,
    },
  });
}

async function resetState() {
  originateLiveVoiceScenarioCall.mockClear();
  await prisma.postShowingCall.deleteMany({ where: { clientId } });
  await prisma.interaction.deleteMany({ where: { clientId } });
  await prisma.client.update({ where: { id: clientId }, data: { lastClientMessageAt: null } });
}

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Тест-район-расписание-${runId}` } })).id;
  agentId = (
    await prisma.agent.create({
      data: { fullName: "Ноза Агентова", phone: `+992946${runId}`, role: "AGENT", passwordHash: "x" },
    })
  ).id;
  clientId = (
    await prisma.client.create({
      data: {
        fullName: `Далер Покупателев ${runId}`,
        phone: `+992947${runId}`.slice(0, 13),
        source: "PHONE_CALL",
        kind: "BUYER",
        assignedAgentId: agentId,
        acceptedAt: new Date(),
      },
    })
  ).id;
  propertyId = (
    await prisma.property.create({
      data: {
        title: `Объект расписания ${runId}`,
        type: "APARTMENT",
        areaSqm: 62,
        price: 50000,
        currency: "TJS",
        districtId,
        address: "Тест",
        condition: "GOOD",
        status: "AVAILABLE",
      },
    })
  ).id;
  const settings = await prisma.settings.upsert({
    where: { id: "singleton" },
    update: {},
    create: { id: "singleton" },
  });
  previousSettings = {
    postShowingCallEnabled: settings.postShowingCallEnabled,
    liveVoiceEnabled: settings.liveVoiceEnabled,
  };
});

afterAll(async () => {
  if (previousSettings) {
    await prisma.settings.update({ where: { id: "singleton" }, data: previousSettings });
  }
  await prisma.postShowingCall.deleteMany({ where: { clientId } });
  await prisma.interaction.deleteMany({ where: { clientId } });
  await prisma.client.deleteMany({ where: { id: clientId } });
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.$disconnect();
});

beforeEach(async () => {
  isNumberBlocked.mockReset();
  isNumberBlocked.mockResolvedValue({ ok: true, blocked: false });
  await resetState();
  await prisma.settings.update({
    where: { id: "singleton" },
    data: { postShowingCallEnabled: true, liveVoiceEnabled: true },
  });
});

describe("часы звонка", () => {
  it("показ днём — звонок через 2,5 часа того же дня", () => {
    const due = postShowingCallDueAt(dushanbe("2026-09-16T10:00:00"), "seed");
    const wall = new Date(due.getTime() + 5 * HOUR);
    expect(wall.toISOString().slice(0, 10)).toBe("2026-09-16");
    expect(wall.getUTCHours()).toBeGreaterThanOrEqual(12);
    expect(wall.getUTCHours()).toBeLessThan(13);
  });

  it("показ в 17:00 — «через 2,5 часа» это 19:30, звонок ждёт утра (решение владельца 16.09)", () => {
    const due = postShowingCallDueAt(dushanbe("2026-09-16T17:00:00"), "seed");
    const wall = new Date(due.getTime() + 5 * HOUR);
    expect(wall.toISOString().slice(0, 10)).toBe("2026-09-17");
    expect(wall.getUTCHours()).toBe(9);
  });

  it("18:59 ещё можно, 19:01 уже нет", () => {
    expect(alignToCallHours(dushanbe("2026-09-16T18:00:00"), "x").getTime()).toBeLessThan(
      dushanbe("2026-09-16T19:00:00").getTime()
    );
    const late = alignToCallHours(dushanbe("2026-09-16T19:30:00"), "x");
    expect(new Date(late.getTime() + 5 * HOUR).getUTCDate()).toBe(17);
  });

  it("час показа называется словами, а не датой", () => {
    expect(showingWhenLabel(dushanbe("2026-09-16T10:00:00"), NOON)).toBe("сегодня утром");
    expect(showingWhenLabel(dushanbe("2026-09-15T18:00:00"), NOON)).toBe("вчера вечером");
  });
});

describe("кому звоним", () => {
  it("рубильник выключен — ни записей, ни звонков", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { postShowingCallEnabled: false } });
    await makeShowing(new Date(NOON.getTime() - 3 * HOUR));

    expect(await runPostShowingCallTick(NOON)).toBe(0);
    expect(await prisma.postShowingCall.count({ where: { clientId } })).toBe(0);
    expect(originateLiveVoiceScenarioCall).not.toHaveBeenCalled();
  });

  it("состоявшийся показ, клиент молчит — звоним", async () => {
    await makeShowing(new Date(NOON.getTime() - 3 * HOUR));

    expect(await runPostShowingCallTick(NOON)).toBe(1);
    expect(originateLiveVoiceScenarioCall).toHaveBeenCalledTimes(1);
    const row = await prisma.postShowingCall.findFirstOrThrow({ where: { clientId } });
    expect(row.status).toBe("CALLING");
    expect(row.attempts).toBe(1);
  });

  /**
   * №172 (ночная проверка 24.09): отметка «звоним» ставилась ПОСЛЕ набора.
   * Рестарт процесса между набором и отметкой оставлял запись ждущей, и
   * следующий тик набирал того же человека второй раз. Теперь запись
   * занимается условно ДО набора (кто занял — тот звонит), а при отказе
   * станции занятие откатывается.
   */
  it("в момент набора запись уже занята — второй проход её не наберёт", async () => {
    await makeShowing(new Date(NOON.getTime() - 3 * HOUR));
    let statusDuringDial: string | null = null;
    originateLiveVoiceScenarioCall.mockImplementationOnce(async () => {
      const row = await prisma.postShowingCall.findFirst({ where: { clientId } });
      statusDuringDial = row?.status ?? null;
      return { ok: true, channelId: `chan-claim-${runId}` };
    });

    expect(await runPostShowingCallTick(NOON)).toBe(1);

    expect(statusDuringDial).toBe("CALLING");
    const row = await prisma.postShowingCall.findFirstOrThrow({ where: { clientId } });
    expect(row).toMatchObject({ status: "CALLING", channelId: `chan-claim-${runId}`, attempts: 1 });
  });

  it("станция не приняла набор — занятие откатывается, попытка не потрачена, звонок ждёт", async () => {
    await makeShowing(new Date(NOON.getTime() - 3 * HOUR));
    originateLiveVoiceScenarioCall.mockImplementationOnce(async () => ({ ok: false, error: "нет связи" }) as never);

    expect(await runPostShowingCallTick(NOON)).toBe(0);

    const row = await prisma.postShowingCall.findFirstOrThrow({ where: { clientId } });
    // Прежний статус (PENDING), а не «не дозвонились»: звонка не было (аудит №3, низкая).
    expect(row.status).toBe("PENDING");
    expect(row.attempts).toBe(0);
    expect(row.lastAttemptAt).toBeNull();
    expect(row.scheduledFor.getTime()).toBeGreaterThan(NOON.getTime());
  });

  it("показ ещё не состоялся — записи нет вовсе", async () => {
    await makeShowing(new Date(NOON.getTime() + 3 * HOUR));

    expect(await runPostShowingCallTick(NOON)).toBe(0);
    expect(await prisma.postShowingCall.count({ where: { clientId } })).toBe(0);
  });

  it("показ отменён — не звоним", async () => {
    await makeShowing(new Date(NOON.getTime() - 3 * HOUR), { declinedAt: new Date(NOON.getTime() - 4 * HOUR) });

    expect(await runPostShowingCallTick(NOON)).toBe(0);
    expect(originateLiveVoiceScenarioCall).not.toHaveBeenCalled();
  });

  it("клиент сам написал после показа — звонить не за чем, и причина записана", async () => {
    await makeShowing(new Date(NOON.getTime() - 3 * HOUR));
    await prisma.client.update({
      where: { id: clientId },
      data: { lastClientMessageAt: new Date(NOON.getTime() - 2 * HOUR) },
    });

    expect(await runPostShowingCallTick(NOON)).toBe(0);
    expect(originateLiveVoiceScenarioCall).not.toHaveBeenCalled();
    const row = await prisma.postShowingCall.findFirstOrThrow({ where: { clientId } });
    expect(row.status).toBe("SKIPPED");
    expect(row.skipReason).toBe("client_answered");
  });

  it("написал АГЕНТ, а не клиент — тишину это не снимает, звоним", async () => {
    await makeShowing(new Date(NOON.getTime() - 3 * HOUR));
    // Работа агента: и отметка «связывался», и его собственная запись в хронологии.
    await prisma.client.update({
      where: { id: clientId },
      data: { lastContactAt: new Date(NOON.getTime() - HOUR), lastAgentAttemptAt: new Date(NOON.getTime() - HOUR) },
    });
    await prisma.interaction.create({
      data: { clientId, agentId, type: "MESSAGE", notes: "Написал клиенту: «есть ещё варианты»" },
    });

    expect(await runPostShowingCallTick(NOON)).toBe(1);
  });

  it("разговор по АТС после показа — исход уже записан, звонить не за чем", async () => {
    await makeShowing(new Date(NOON.getTime() - 3 * HOUR));
    await prisma.interaction.create({
      data: {
        clientId,
        agentId,
        type: "CALL",
        notes: "Разговор через CRM",
        callAttempt: "TALKED",
        recordingDurationSec: 95,
      },
    });

    expect(await runPostShowingCallTick(NOON)).toBe(0);
    const row = await prisma.postShowingCall.findFirstOrThrow({ where: { clientId } });
    expect(row.skipReason).toBe("client_answered");
  });

  it("второй показ той же недели — второго звонка не будет", async () => {
    await makeShowing(new Date(NOON.getTime() - 3 * HOUR));
    expect(await runPostShowingCallTick(NOON)).toBe(1);

    const later = new Date(NOON.getTime() + 24 * HOUR);
    await makeShowing(new Date(later.getTime() - 3 * HOUR));
    expect(await runPostShowingCallTick(later)).toBe(0);

    const skipped = await prisma.postShowingCall.findFirst({ where: { clientId, status: "SKIPPED" } });
    expect(skipped?.skipReason).toBe("weekly_limit");
  });
});

describe("итог звонка", () => {
  async function startedCall(): Promise<{ id: string; channelId: string }> {
    await makeShowing(new Date(NOON.getTime() - 3 * HOUR));
    await runPostShowingCallTick(NOON);
    const row = await prisma.postShowingCall.findFirstOrThrow({ where: { clientId } });
    return { id: row.id, channelId: row.channelId! };
  }

  it("звук со станции не дошёл — не «не ответил»: попытка возвращается, звонок повторится", async () => {
    const { NO_STATION_AUDIO_REASON } = await import("../src/lib/telephony/liveVoiceAudioPath.js");
    const call = await startedCall();
    await finishPostShowingCall(
      { channelId: call.channelId, transcript: [], reason: NO_STATION_AUDIO_REASON, clientSpoke: false },
      NOON
    );
    const row = await prisma.postShowingCall.findUniqueOrThrow({ where: { id: call.id } });
    expect(row).toMatchObject({ status: "PENDING", attempts: 0 });
    expect(row.scheduledFor.getTime()).toBeGreaterThan(NOON.getTime());
  });

  it("автоответчик — не разговор: попытка есть, опроса нет", async () => {
    const call = await startedCall();

    await finishPostShowingCall(
      { channelId: call.channelId, transcript: [], reason: "model_ended_call: voicemail", clientSpoke: false },
      NOON
    );

    const row = await prisma.postShowingCall.findUniqueOrThrow({ where: { id: call.id } });
    expect(row.status).toBe("NO_ANSWER");
    expect(row.talkedAt).toBeNull();
  });

  it("автоответчик оператора, которого модель не назвала: по репликам «клиента» — тоже не разговор", async () => {
    const call = await startedCall();

    await finishPostShowingCall(
      {
        channelId: call.channelId,
        transcript: ["Бот: Алло, это Royal Home", "Клиент: Абонент временно недоступен, оставьте сообщение после сигнала."],
        reason: "model_ended_call: answered",
        clientSpoke: true,
      },
      NOON
    );

    const row = await prisma.postShowingCall.findUniqueOrThrow({ where: { id: call.id } });
    expect(row.status).toBe("NO_ANSWER");
    expect(row.talkedAt).toBeNull();
  });

  it("человек говорил, но модель ответа не дала — звонок НЕ становится «всё понравилось»", async () => {
    const call = await startedCall();

    await finishPostShowingCall(
      {
        channelId: call.channelId,
        transcript: ["Бот: Как прошёл просмотр?", "Клиент: Да не подошла, маленькая."],
        reason: "model_ended_call: answered",
        clientSpoke: true,
      },
      NOON
    );

    const row = await prisma.postShowingCall.findUniqueOrThrow({ where: { id: call.id } });
    expect(row.status).toBe("DONE");
    expect(row.talkedAt).not.toBeNull();
    expect(row.outcome).toBe("UNCLEAR");
  });

  it("жалоба на агента — руководителю, но НЕ в хронологию карточки и не самому агенту", async () => {
    const call = await startedCall();
    parsePostShowingCall.mockResolvedValueOnce({
      outcome: "AGENT_COMPLAINT",
      confidence: 0.92,
      quote: "он дал свой номер и сказал, давайте напрямую",
      redFlags: ["дал личный номер"],
      summary: "Предлагал вести дело мимо агентства",
    });
    const interactionsBefore = await prisma.interaction.count({ where: { clientId } });

    await finishPostShowingCall(
      {
        channelId: call.channelId,
        transcript: ["Клиент: он дал свой номер и сказал, давайте напрямую"],
        reason: "model_ended_call: answered",
        clientSpoke: true,
      },
      NOON
    );

    const row = await prisma.postShowingCall.findUniqueOrThrow({ where: { id: call.id } });
    expect(row.outcome).toBe("AGENT_COMPLAINT");
    expect(row.quote).toContain("свой номер");

    // Главное свойство всего механизма: агент об этом не узнаёт. В хронологии
    // карточки, которую он открывает, не появилось ни одной новой строки.
    expect(await prisma.interaction.count({ where: { clientId } })).toBe(interactionsBefore);

    const alert = await prisma.pendingDirectorAlert.findFirst({ where: { tag: `post-showing-call-${call.id}` } });
    expect(alert).not.toBeNull();
    expect(alert?.excludeAgentId).toBe(agentId);
    expect(alert?.body).toContain("свой номер");
    await prisma.pendingDirectorAlert.deleteMany({ where: { tag: `post-showing-call-${call.id}` } });
  });

  it("обычный исход руководителя не будит", async () => {
    const call = await startedCall();
    parsePostShowingCall.mockResolvedValueOnce({
      outcome: "NOT_SUITABLE",
      confidence: 0.9,
      quote: null,
      redFlags: [],
      summary: "Маленькая кухня",
    });

    await finishPostShowingCall(
      {
        channelId: call.channelId,
        transcript: ["Клиент: кухня маленькая"],
        reason: "model_ended_call: answered",
        clientSpoke: true,
      },
      NOON
    );

    expect(
      await prisma.pendingDirectorAlert.count({ where: { tag: `post-showing-call-${call.id}` } })
    ).toBe(0);
  });

  it("попросил перезвонить — вторая попытка, но не бесконечно", async () => {
    const call = await startedCall();

    await finishPostShowingCall(
      { channelId: call.channelId, transcript: [], reason: "model_ended_call: call_back_later", clientSpoke: true },
      NOON
    );
    expect((await prisma.postShowingCall.findUniqueOrThrow({ where: { id: call.id } })).status).toBe("NO_ANSWER");

    // Вторая попытка израсходована — дальше человека не тревожим.
    // Итог принимается только у звонка в CALLING: снова «набираем» ту же запись.
    await prisma.postShowingCall.update({ where: { id: call.id }, data: { attempts: 2, status: "CALLING" } });
    await finishPostShowingCall(
      { channelId: call.channelId, transcript: [], reason: "model_ended_call: voicemail", clientSpoke: false },
      NOON
    );
    expect((await prisma.postShowingCall.findUniqueOrThrow({ where: { id: call.id } })).status).toBe("GIVEN_UP");
  });
});

/**
 * ОДИН ЗВОНОК ЗА ТИК И «ЛИНИЯ ЗАНЯТА» (02.10.2026, аудит фона №4). Порт RTP у
 * моста один — пачка опросов, набранная разом, давала один разговор и обрывы
 * на «алло». «Занято» раньше уходило веткой отказа станции: в журнал и опрос
 * на пять часов позже.
 */
describe("линия живого голоса одна", () => {
  it("два опроса к сроку у разных покупателей — набирается один, второй ждёт", async () => {
    const otherId = (
      await prisma.client.create({
        data: {
          fullName: `Второй покупатель ${runId}`,
          phone: `+992948${String(runId).slice(-6)}`,
          source: "PHONE_CALL",
          kind: "BUYER",
          assignedAgentId: agentId,
          acceptedAt: new Date(),
        },
      })
    ).id;
    try {
      await makeShowing(new Date(NOON.getTime() - 3 * HOUR));
      await prisma.interaction.create({
        data: {
          clientId: otherId,
          agentId,
          type: "SHOWING",
          propertyId,
          notes: "Показ",
          nextAction: "Показ объекта",
          nextActionDate: new Date(NOON.getTime() - 3 * HOUR),
        },
      });

      expect(await runPostShowingCallTick(NOON)).toBe(1);
      expect(originateLiveVoiceScenarioCall).toHaveBeenCalledTimes(1);
      const rows = await prisma.postShowingCall.findMany({ where: { clientId: { in: [clientId, otherId] } } });
      expect(rows.map((r) => r.status).sort()).toEqual(["CALLING", "PENDING"]);
    } finally {
      await prisma.postShowingCall.deleteMany({ where: { clientId: otherId } });
      await prisma.interaction.deleteMany({ where: { clientId: otherId } });
      await prisma.client.deleteMany({ where: { id: otherId } });
    }
  });

  it("линия занята — попытка не тратится, статус прежний, повтор через минуты, а не через пять часов", async () => {
    await makeShowing(new Date(NOON.getTime() - 3 * HOUR));
    originateLiveVoiceScenarioCall.mockResolvedValueOnce({ ok: false, busy: true, error: "Линия живого голоса занята" } as never);

    expect(await runPostShowingCallTick(NOON)).toBe(0);
    const row = await prisma.postShowingCall.findFirstOrThrow({ where: { clientId } });
    expect(row).toMatchObject({ status: "PENDING", attempts: 0 });
    expect(row.scheduledFor.getTime()).toBeGreaterThan(NOON.getTime());
    expect(row.scheduledFor.getTime()).toBeLessThanOrEqual(NOON.getTime() + 10 * 60 * 1000);
  });
});

/**
 * АУДИТ СЦЕНАРНЫХ ЗВОНКОВ 02.10.2026 (№3, №4, №5, №12, №14): сбой на нашей
 * стороне — не «не дозвонились», попытка возвращается не больше раза, повтор не
 * гаснет собственной записью, «не тот человек» — вторая попытка, а сторож
 * зависших не срабатывает посреди разговора.
 */
describe("сбои на нашей стороне и «не тот человек»", () => {
  async function startedCall(): Promise<{ id: string; channelId: string }> {
    await makeShowing(new Date(NOON.getTime() - 3 * HOUR));
    await runPostShowingCallTick(NOON);
    const row = await prisma.postShowingCall.findFirstOrThrow({ where: { clientId } });
    return { id: row.id, channelId: row.channelId! };
  }

  it("после немого звонка повтор реально набирается, а не гаснет как weekly_limit своей же записью", async () => {
    const { NO_STATION_AUDIO_REASON } = await import("../src/lib/telephony/liveVoiceAudioPath.js");
    const call = await startedCall();
    await finishPostShowingCall(
      { channelId: call.channelId, transcript: [], reason: NO_STATION_AUDIO_REASON, clientSpoke: false },
      NOON
    );
    originateLiveVoiceScenarioCall.mockClear();

    await runPostShowingCallTick(new Date(NOON.getTime() + 2 * HOUR));

    expect(originateLiveVoiceScenarioCall).toHaveBeenCalledTimes(1);
    const row = await prisma.postShowingCall.findUniqueOrThrow({ where: { id: call.id } });
    expect(row).toMatchObject({ status: "CALLING", attempts: 1 });
    expect(row.skipReason).not.toBe("weekly_limit");
  });

  it("второй немой звонок по той же записи — попытку больше не возвращаем, запись закрыта без «не дозвонились»", async () => {
    const { NO_STATION_AUDIO_REASON } = await import("../src/lib/telephony/liveVoiceAudioPath.js");
    const call = await startedCall();
    await finishPostShowingCall(
      { channelId: call.channelId, transcript: [], reason: NO_STATION_AUDIO_REASON, clientSpoke: false },
      NOON
    );
    const later = new Date(NOON.getTime() + 2 * HOUR);
    await runPostShowingCallTick(later);
    const redialed = await prisma.postShowingCall.findUniqueOrThrow({ where: { id: call.id } });
    expect(redialed.status).toBe("CALLING");

    await finishPostShowingCall(
      { channelId: redialed.channelId!, transcript: [], reason: NO_STATION_AUDIO_REASON, clientSpoke: false },
      later
    );

    const row = await prisma.postShowingCall.findUniqueOrThrow({ where: { id: call.id } });
    expect(row).toMatchObject({ status: "SKIPPED", skipReason: "station_down" });
  });

  for (const reason of ["gemini_error", "gemini_closed", "listener_stopped", "rtp_socket_error", "start_failed: нет порта"]) {
    it(`«${reason}» — попытка возвращается, это не «не ответил» и не разговор`, async () => {
      parsePostShowingCall.mockClear();
      const call = await startedCall();
      await finishPostShowingCall(
        { channelId: call.channelId, transcript: ["Клиент: алло"], reason, clientSpoke: true },
        NOON
      );
      const row = await prisma.postShowingCall.findUniqueOrThrow({ where: { id: call.id } });
      expect(row).toMatchObject({ status: "PENDING", attempts: 0, talkedAt: null, outcome: null });
      expect(row.skipReason).toContain("attempt_returned");
      expect(parsePostShowingCall).not.toHaveBeenCalled();
    });
  }

  it("трубку взял не тот — опрос не засчитан, вторая попытка, пометка на записи", async () => {
    parsePostShowingCall.mockClear();
    const call = await startedCall();
    await finishPostShowingCall(
      {
        channelId: call.channelId,
        transcript: ["Клиент: его нет, это жена"],
        reason: "model_ended_call: wrong_person",
        clientSpoke: true,
      },
      NOON
    );
    const row = await prisma.postShowingCall.findUniqueOrThrow({ where: { id: call.id } });
    expect(row).toMatchObject({ status: "NO_ANSWER", attempts: 1, talkedAt: null, outcome: null });
    expect(row.skipReason).toContain("wrong_person");
    expect(row.scheduledFor.getTime()).toBeGreaterThan(NOON.getTime());
    expect(parsePostShowingCall).not.toHaveBeenCalled();
  });

  it("сторож зависших ждёт дольше потолка сессии (15 мин): на 16-й минуте разговор не трогает", async () => {
    const call = await startedCall();
    await runPostShowingCallTick(new Date(NOON.getTime() + 16 * 60 * 1000));
    expect((await prisma.postShowingCall.findUniqueOrThrow({ where: { id: call.id } })).status).toBe("CALLING");
  });

  it("итог потерян (21 мин в CALLING) — это наш сбой: попытка возвращается, не «не дозвонились»", async () => {
    const call = await startedCall();
    await runPostShowingCallTick(new Date(NOON.getTime() + 21 * 60 * 1000));
    const row = await prisma.postShowingCall.findUniqueOrThrow({ where: { id: call.id } });
    expect(row).toMatchObject({ status: "PENDING", attempts: 0 });
    expect(row.skipReason).toContain("attempt_returned");
  });
});

/**
 * АУДИТ ЗВОНКОВ РОБОТА 02.10.2026, А4 — «не беспокойте», чёрный список, воскресенье.
 */
describe("кому и когда звонить нельзя (А4)", () => {
  it("человек написал «не беспокойте» (BotConversation.optedOutAt) — запись закрыта, номер не набирается", async () => {
    await makeShowing(new Date(NOON.getTime() - 3 * HOUR));
    const conv = await prisma.botConversation.create({
      data: { channel: "WHATSAPP", subscriberId: `dnc-${runId}`, clientId, optedOutAt: new Date() },
    });
    try {
      expect(await runPostShowingCallTick(NOON)).toBe(0);
      expect(originateLiveVoiceScenarioCall).not.toHaveBeenCalled();
      const row = await prisma.postShowingCall.findFirstOrThrow({ where: { clientId } });
      expect(row).toMatchObject({ status: "SKIPPED", skipReason: "do_not_contact" });
    } finally {
      await prisma.botConversation.deleteMany({ where: { id: conv.id } });
    }
  });

  it("то же через досье собеседника: диалог привязан к досье, а досье — к клиенту", async () => {
    await makeShowing(new Date(NOON.getTime() - 3 * HOUR));
    const profile = await prisma.contactProfile.create({ data: { clientId } });
    const conv = await prisma.botConversation.create({
      data: { channel: "INSTAGRAM", subscriberId: `dnc2-${runId}`, contactProfileId: profile.id, optedOutAt: new Date() },
    });
    try {
      expect(await runPostShowingCallTick(NOON)).toBe(0);
      expect(originateLiveVoiceScenarioCall).not.toHaveBeenCalled();
      expect((await prisma.postShowingCall.findFirstOrThrow({ where: { clientId } })).skipReason).toBe("do_not_contact");
    } finally {
      await prisma.botConversation.deleteMany({ where: { id: conv.id } });
      await prisma.contactProfile.deleteMany({ where: { id: profile.id } });
    }
  });

  it("номер в чёрном списке станции — не набираем", async () => {
    await makeShowing(new Date(NOON.getTime() - 3 * HOUR));
    isNumberBlocked.mockResolvedValue({ ok: true, blocked: true });

    expect(await runPostShowingCallTick(NOON)).toBe(0);
    expect(originateLiveVoiceScenarioCall).not.toHaveBeenCalled();
    expect((await prisma.postShowingCall.findFirstOrThrow({ where: { clientId } })).skipReason).toBe("blacklisted");
  });

  it("станция не ответила на запрос чёрного списка — звонок не блокируем (нечем проверить)", async () => {
    await makeShowing(new Date(NOON.getTime() - 3 * HOUR));
    isNumberBlocked.mockResolvedValue({ ok: false, error: "станция не ответила" } as never);

    expect(await runPostShowingCallTick(NOON)).toBe(1);
    expect(originateLiveVoiceScenarioCall).toHaveBeenCalledTimes(1);
  });

  it("общий выходной в воскресенье (Настройки) — не набираем, даже если час давно настал", async () => {
    await makeShowing(dushanbe("2026-09-19T10:00:00"));
    const sundayNoon = dushanbe("2026-09-20T12:00:00");
    await prisma.settings.update({ where: { id: "singleton" }, data: { companyDaysOff: [0] } });
    try {
      expect(isWithinPostShowingCallHours(sundayNoon, [0])).toBe(false);
      expect(await runPostShowingCallTick(sundayNoon)).toBe(0);
      expect(originateLiveVoiceScenarioCall).not.toHaveBeenCalled();
    } finally {
      await prisma.settings.update({ where: { id: "singleton" }, data: { companyDaysOff: [] } });
    }
  });

  it("по умолчанию выходных нет (11.10.2026): в воскресенье робот звонит", () => {
    expect(isWithinPostShowingCallHours(dushanbe("2026-09-20T12:00:00"), [])).toBe(true);
  });

  it("звонок, выпавший на общий выходной (воскресенье), переносится на утро понедельника — и по часу показа, и по повтору", () => {
    const wall = (d: Date) => new Date(d.getTime() + 5 * HOUR);
    // 17:00 субботы + 2,5 ч = 19:30 → не воскресенье, а понедельник 09:00.
    const fromSaturday = alignToCallHours(new Date(dushanbe("2026-09-19T17:00:00").getTime() + 150 * 60_000), null, [0]);
    expect(wall(fromSaturday).toISOString().slice(0, 10)).toBe("2026-09-21");
    expect(wall(fromSaturday).getUTCHours()).toBe(9);
    // Воскресенье днём и воскресенье рано утром — тоже понедельник.
    expect(wall(alignToCallHours(dushanbe("2026-09-20T12:00:00"), null, [0])).toISOString()).toBe("2026-09-21T09:00:00.000Z");
    expect(wall(alignToCallHours(dushanbe("2026-09-20T06:00:00"), null, [0])).toISOString()).toBe("2026-09-21T09:00:00.000Z");
    // Суббота днём — рабочий день.
    expect(alignToCallHours(dushanbe("2026-09-19T12:00:00"), null, [0]).getTime()).toBe(dushanbe("2026-09-19T12:00:00").getTime());
    // Без выходных: суббота вечер → воскресенье утро, воскресенье днём — как есть.
    expect(wall(alignToCallHours(dushanbe("2026-09-19T20:00:00"), null, [])).toISOString()).toBe("2026-09-20T09:00:00.000Z");
    expect(alignToCallHours(dushanbe("2026-09-20T12:00:00"), null, []).getTime()).toBe(dushanbe("2026-09-20T12:00:00").getTime());
    expect(postShowingCallDueAt(dushanbe("2026-09-19T10:00:00"), "seed").getTime()).toBeGreaterThan(0);
  });
});

/**
 * А3 — выдуманная цитата не поднимает руководителя. Модель подменена настолько, насколько
 * нужно: её ответ идёт через настоящую нормализацию с расшифровкой, как в проде.
 */
describe("цитата в красном сигнале сверяется с расшифровкой (А3)", () => {
  async function startedCall(): Promise<{ id: string; channelId: string }> {
    await makeShowing(new Date(NOON.getTime() - 3 * HOUR));
    await runPostShowingCallTick(NOON);
    const row = await prisma.postShowingCall.findFirstOrThrow({ where: { clientId } });
    return { id: row.id, channelId: row.channelId! };
  }

  it("цитаты нет в словах клиента — исход «непонятно», сигнала руководителю нет, цитата не сохранена", async () => {
    const call = await startedCall();
    const transcript = ["Бот: Как всё прошло?", "Клиент: нормально, квартира маленькая"];
    parsePostShowingCall.mockImplementationOnce(async (t: unknown) =>
      normalizePostShowingCallParse(
        { outcome: "AGENT_COMPLAINT", confidence: 0.95, quote: "агент давил на меня и грубил", summary: "Жалоба" },
        t as string[]
      )
    );
    await finishPostShowingCall(
      { channelId: call.channelId, transcript, reason: "model_ended_call: answered", clientSpoke: true },
      NOON
    );
    const row = await prisma.postShowingCall.findUniqueOrThrow({ where: { id: call.id } });
    expect(row.outcome).toBe("UNCLEAR");
    expect(row.quote).toBeNull();
    expect(row.summary).toContain("цитата не подтверждена");
    expect(await prisma.pendingDirectorAlert.count({ where: { tag: `post-showing-call-${call.id}` } })).toBe(0);
  });

  it("цитата есть, но это слова БОТА, а не клиента, — тоже не подтверждена", async () => {
    const call = await startedCall();
    const transcript = ["Бот: Агент не давил на вас и не просил личный номер?", "Клиент: нет, всё нормально"];
    parsePostShowingCall.mockImplementationOnce(async (t: unknown) =>
      normalizePostShowingCallParse(
        { outcome: "BYPASS", confidence: 0.9, quote: "Агент не давил на вас и не просил личный номер", summary: "Обход" },
        t as string[]
      )
    );
    await finishPostShowingCall(
      { channelId: call.channelId, transcript, reason: "model_ended_call: answered", clientSpoke: true },
      NOON
    );
    expect((await prisma.postShowingCall.findUniqueOrThrow({ where: { id: call.id } })).outcome).toBe("UNCLEAR");
    expect(await prisma.pendingDirectorAlert.count({ where: { tag: `post-showing-call-${call.id}` } })).toBe(0);
  });

  it("настоящая цитата (с другими знаками препинания и регистром) проходит, сигнал уходит", async () => {
    const call = await startedCall();
    const transcript = ["Клиент: Он дал мне, свой номер,", "Клиент: и сказал — звоните напрямую"];
    parsePostShowingCall.mockImplementationOnce(async (t: unknown) =>
      normalizePostShowingCallParse(
        { outcome: "BYPASS", confidence: 0.9, quote: "он дал мне свой номер и сказал: звоните напрямую", summary: "Обход" },
        t as string[]
      )
    );
    await finishPostShowingCall(
      { channelId: call.channelId, transcript, reason: "model_ended_call: answered", clientSpoke: true },
      NOON
    );
    expect((await prisma.postShowingCall.findUniqueOrThrow({ where: { id: call.id } })).outcome).toBe("BYPASS");
    expect(await prisma.pendingDirectorAlert.count({ where: { tag: `post-showing-call-${call.id}` } })).toBe(1);
    await prisma.pendingDirectorAlert.deleteMany({ where: { tag: `post-showing-call-${call.id}` } });
  });
});

/**
 * В16 — станция не приняла набор: повтор через минуты, а не через пять часов, и одна запись
 * в журнале ошибок (общий ключ), а не новая на каждый отказ.
 */
describe("станция не приняла набор (В16)", () => {
  it("повтор через минуты, попытка не потрачена, в журнале ошибок общий ключ дедупликации", async () => {
    await makeShowing(new Date(NOON.getTime() - 3 * HOUR));
    originateLiveVoiceScenarioCall.mockResolvedValueOnce({ ok: false, error: "Asterisk не ответил" } as never);

    expect(await runPostShowingCallTick(NOON)).toBe(0);

    const row = await prisma.postShowingCall.findFirstOrThrow({ where: { clientId } });
    expect(row.attempts).toBe(0);
    expect(row.scheduledFor.getTime()).toBeGreaterThan(NOON.getTime());
    expect(row.scheduledFor.getTime()).toBeLessThanOrEqual(NOON.getTime() + 15 * 60 * 1000);

    const logged = await waitFor(() => prisma.errorLog.findFirst({ where: { dedupKey: "post-showing-originate" } }));
    expect(logged.message).toContain("станция не приняла набор");
    await prisma.errorLog.deleteMany({ where: { dedupKey: "post-showing-originate" } });
  });
});
