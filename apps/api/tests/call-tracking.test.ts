import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import { waitForSettled } from "./helpers/waitFor.js";

/** Сколько раз обработчик событий АТС попытался выгрузить запись разговора — по
 *  этому счётчику видно, что дубль события конца звонка не запускает выгрузку заново. */
const ingestCalls: { channelId: string }[] = [];
vi.mock("../src/lib/telephony/callRecordings.js", () => ({
  ingestCallRecording: vi.fn(async (params: { channelId: string }) => {
    ingestCalls.push({ channelId: params.channelId });
    return { ok: false, reason: "мок теста" };
  }),
  rememberRecordingPath: () => {},
  forgetRecordingPath: () => {},
}));

/**
 * Что станция отвечает на вопрос «чем кончился дозвон клиенту» (переменные канала
 * DIALSTATUS и ANSWEREDTIME). Пусто — переменной нет: канал уже исчез или сборка её
 * не заполняет; тогда итог считается по пройденным стадиям, как раньше.
 */
let stationVariables: Record<string, string> = {};
vi.mock("../src/lib/telephony/ariClient.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/telephony/ariClient.js")>()),
  loadAriCredentials: async () => ({ url: "http://pbx.local", username: "crm", password: "x" }),
  readChannelVariable: async (_creds: unknown, _channelId: string, variable: string) =>
    stationVariables[variable] ?? null,
}));

const { handleAriEvent } = await import("../src/lib/telephony/ariEvents.js");
const { activeCallFor, getCall, hasLiveCall, markCallCancelled, resetCalls, talkSeconds, trackCall, callOutcomeRetry, finishCall } = await import(
  "../src/lib/telephony/callTracker.js"
);

/** Телефон клиента и то, как его набирает станция: в CRM номер международный, на
 *  станции — местные девять цифр (см. normalizeDialNumber в ariClient.ts). */
const CLIENT_PHONE = "+992900000000";
const CLIENT_DIALSTRING = "SIP/out/900000000";

/**
 * Живое состояние звонка: что показывает экран вызова, пока агент говорит.
 *
 * Проверяется разбор событий, которые шлёт АТС, — без самой АТС. Ради этого разбор
 * вынесен из сокета в чистую функцию: иначе единственным способом проверить логику
 * был бы живой звонок живому человеку.
 *
 * Ради чего всё: до 07.08.2026 CRM знала о звонке только то, что станция приняла
 * команду. Кнопка писала «Сохранено» и снова становилась активной — идёт ли разговор,
 * ответил ли клиент, сколько он длится, не знал никто.
 */

const runId = Date.now();
let agentId = "";
let clientId = "";

beforeAll(async () => {
  const agent = await prisma.agent.create({
    data: { fullName: `Агент звонка ${runId}`, phone: `+99293${String(runId).slice(-7)}`, role: "AGENT", passwordHash: "x" },
  });
  agentId = agent.id;
  const client = await prisma.client.create({
    data: {
      fullName: `Клиент звонка ${runId}`,
      phone: `+99294${String(runId).slice(-7)}`,
      source: "PHONE_CALL",
      assignedAgentId: agent.id,
      acceptedAt: new Date(),
    },
  });
  clientId = client.id;
});

afterEach(async () => {
  resetCalls();
  ingestCalls.length = 0;
  stationVariables = {};
  await prisma.interaction.deleteMany({ where: { clientId } });
});

afterAll(async () => {
  await prisma.client.deleteMany({ where: { id: clientId } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.$disconnect();
});

function startCall(channelId: string, interactionId?: string) {
  return trackCall({
    channelId,
    agentId,
    clientId,
    clientName: `Клиент звонка ${runId}`,
    dialingTo: "930001001",
    clientPhone: CLIENT_PHONE,
    interactionId,
  });
}

/** Запись в хронологии, которую CRM заводит при начале звонка (routes/clients.ts).
 *  Итог дописывается именно в неё — по id, а не поиском «последней подходящей»:
 *  иначе два звонка одному клиенту подряд перепутались бы между собой. */
async function startedInteraction() {
  return prisma.interaction.create({
    data: { clientId, agentId, type: "CALL", notes: "Звонок инициирован из CRM" },
  });
}

/**
 * Дождаться отметки, которую finishCall ставит НЕ ДОЖИДАЯСЬ результата.
 *
 * Обработчик событий АТС принципиально не стоит на записи в базу (`void ... .catch`),
 * поэтому «await handleAriEvent» не значит «запись уже в базе». Опрос вместо
 * фиксированной паузы: тест не замедляется на быстрой машине и не мигает на медленной.
 */
async function waitFor<T>(read: () => Promise<T | null | undefined>, timeoutMs = 5_000): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > until) throw new Error("отметка так и не появилась в базе");
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("Состояние звонка по событиям АТС", () => {
  it("сразу после команды: звоним самому агенту", () => {
    startCall("ch-1");
    expect(activeCallFor(agentId)?.state).toBe("ringing_agent");
    expect(hasLiveCall(agentId)).toBe(true);
  });

  it("агент снял трубку — станция набирает клиента", async () => {
    startCall("ch-2");
    await handleAriEvent({ type: "ChannelStateChange", channel: { id: "ch-2", name: "Local/…", state: "Up", caller: {} } });
    expect(getCall("ch-2")?.state).toBe("ringing_client");
    // Разговора ещё нет — таймер не должен идти.
    expect(talkSeconds(getCall("ch-2")!)).toBe(0);
  });

  it("клиент ответил — идёт разговор, время считается с этого момента", async () => {
    startCall("ch-3");
    await handleAriEvent({ type: "ChannelStateChange", channel: { id: "ch-3", name: "", state: "Up", caller: {} } });
    await handleAriEvent({ type: "Dial", dialstatus: "ANSWER", dialstring: CLIENT_DIALSTRING, channel: { id: "ch-3", name: "", state: "Up", caller: {} } });
    const call = getCall("ch-3")!;
    expect(call.state).toBe("talking");
    expect(call.answeredAt).toBeInstanceOf(Date);
  });

  it("разговор состоялся: в хронологии клиента появляется длительность", async () => {
    const interaction = await startedInteraction();
    startCall("ch-4", interaction.id);
    await handleAriEvent({ type: "Dial", dialstatus: "ANSWER", dialstring: CLIENT_DIALSTRING, channel: { id: "ch-4", name: "", state: "Up", caller: {} } });
    await handleAriEvent({ type: "ChannelDestroyed", channel: { id: "ch-4", name: "", state: "Down", caller: {} } });

    const call = getCall("ch-4")!;
    expect(call.state).toBe("ended");
    expect(call.outcome).toMatch(/Поговорили/);
    // Линия свободна — можно звонить следующему.
    expect(hasLiveCall(agentId)).toBe(false);

    const saved = await prisma.interaction.findFirst({ where: { clientId, type: "CALL" } });
    expect(saved?.notes).toMatch(/разговор/i);
    // Машиночитаемый исход рядом с текстом для человека: на нём держится гейт
    // перевода в Неактивные (lib/inactiveTrafficLight.ts).
    expect(saved?.callAttempt).toBe("TALKED");
  });

  it("CHANNEL-NEW-38: запись исхода упала на временном сбое — отказ в журнале, исход дописывается повтором", async () => {
    const interaction = await startedInteraction();
    startCall("ch-persist-retry", interaction.id);
    await handleAriEvent({ type: "Dial", dialstatus: "ANSWER", dialstring: CLIENT_DIALSTRING, channel: { id: "ch-persist-retry", name: "", state: "Up", caller: {} } });

    const savedDelay = callOutcomeRetry.delayMs;
    callOutcomeRetry.delayMs = 20;
    const realUpdate = prisma.interaction.update.bind(prisma.interaction);
    let failed = 0;
    const spy = vi.spyOn(prisma.interaction, "update").mockImplementation(((args: { where?: { id?: string } }) => {
      if (failed === 0 && args?.where?.id === interaction.id) {
        failed += 1;
        return Promise.reject(new Error("база временно недоступна"));
      }
      return realUpdate(args as never);
    }) as never);
    try {
      await handleAriEvent({ type: "ChannelDestroyed", channel: { id: "ch-persist-retry", name: "", state: "Down", caller: {} } });
      expect(failed).toBe(1);
      // Повтор сам доводит исход: callAttempt лежит в записи.
      const saved = await waitFor(() => prisma.interaction.findUnique({ where: { id: interaction.id } }).then((i) => (i?.callAttempt ? i : null)));
      expect(saved.callAttempt).toBe("TALKED");
      expect(saved.notes).toMatch(/разговор/i);
    } finally {
      spy.mockRestore();
      callOutcomeRetry.delayMs = savedDelay;
    }
  });

  /**
   * РЕАЛЬНЫЙ КОНТАКТ ПО ЗВОНКУ ГАСИТ БОТА (владелец 18.09.2026, отмена
   * hasActiveAssignedAgent от 05.09.2026) — см. `pauseConversationsAfterRealContact`
   * в lib/conversationDelivery.ts, вызывается из finishCall НЕ дожидаясь
   * результата (`void ... .catch`), поэтому проверка идёт через `waitFor`, а не
   * сразу после handleAriEvent.
   */
  it("состоявшийся разговор ставит боту ту же паузу, что и ручной ответ, и снимает просьбу живого агента", async () => {
    const conv = await prisma.botConversation.create({
      data: {
        channel: "INSTAGRAM",
        subscriberId: `call-pause-${runId}`,
        client: { connect: { id: clientId } },
      },
    });
    await prisma.client.update({ where: { id: clientId }, data: { agentAttentionRequestedAt: new Date() } });
    const interaction = await startedInteraction();
    startCall("ch-pause", interaction.id);
    await handleAriEvent({ type: "Dial", dialstatus: "ANSWER", dialstring: CLIENT_DIALSTRING, channel: { id: "ch-pause", name: "", state: "Up", caller: {} } });
    await handleAriEvent({ type: "ChannelDestroyed", channel: { id: "ch-pause", name: "", state: "Down", caller: {} } });

    const paused = await waitFor(() =>
      prisma.botConversation.findUnique({ where: { id: conv.id }, select: { pausedUntil: true } }).then((row) => row?.pausedUntil ?? null)
    );
    // «Бессрочно» — годы вперёд, не короткая 10-минутная пауза ручного разового ответа.
    expect(paused.getTime() - Date.now()).toBeGreaterThan(365 * 24 * 3_600_000);

    /**
     * Обе метки ставятся ОДНИМ `Promise.all` внутри pauseConversationsAfterRealContact,
     * но это три независимых UPDATE к разным таблицам — момент, когда наш опрос
     * ВЫШЕ впервые увидел `pausedUntil`, не гарантирует, что запись в `Client`
     * уже физически видна следующему отдельному запросу (найдено этой же
     * правкой: тест был зелёным в одиночном прогоне и валился в общем прогоне
     * под нагрузкой). Тот же приём `waitFor`, что и для паузы.
     */
    const attentionCleared = await waitFor(async () => {
      const c = await prisma.client.findUnique({ where: { id: clientId }, select: { agentAttentionRequestedAt: true } });
      return c && c.agentAttentionRequestedAt === null ? true : null;
    });
    expect(attentionCleared).toBe(true);

    await prisma.botConversation.deleteMany({ where: { id: conv.id } });
  });

  it("клиент не ответил — это тоже попадает в хронологию, а не теряется", async () => {
    const interaction = await startedInteraction();
    startCall("ch-5", interaction.id);
    // Агент снял трубку, клиент — нет, вызов завершился.
    await handleAriEvent({ type: "ChannelStateChange", channel: { id: "ch-5", name: "", state: "Up", caller: {} } });
    await handleAriEvent({ type: "ChannelDestroyed", channel: { id: "ch-5", name: "", state: "Down", caller: {} } });

    expect(getCall("ch-5")?.outcome).toBe("Клиент не ответил");
    const saved = await prisma.interaction.findFirst({ where: { clientId, type: "CALL" } });
    expect(saved?.notes).toMatch(/не ответил/i);
    /**
     * НЕДОЗВОН — ТОЖЕ СЛЕД РАБОТЫ (27.08.2026). Отличить его от «агент не снял
     * трубку» по тексту заметки можно лишь догадкой, а на этом различии стоит
     * гейт Неактивных: попытка дозвониться засчитывается, несостоявшийся звонок
     * агента — нет.
     */
    expect(saved?.callAttempt).toBe("NO_ANSWER");
  });

  /**
   * ГЛАВНЫЙ ДЕФЕКТ ИСХОДЯЩИХ, ЗАКРЫТЫЙ 18.08.2026: трубку снял АГЕНТ, а CRM
   * записывала разговор с КЛИЕНТОМ.
   *
   * Доказательство из CDR станции — пары плеч одного звонка:
   *   6501414 → 900001042 (агент)  ANSWERED  billsec 3   — есть звук
   *   6501414 → 70655300404 (клиент) BUSY    billsec 0   — файл 44 байта
   * В карточке при этом стояло «разговор 0:04», то есть ровно billsec плеча к
   * агенту. За семь дней в базе не нашлось НИ ОДНОГО исхода «Клиент не ответил»,
   * хотя на станции их десятки.
   */
  describe("два плеча звонка: ответ агента — ещё не разговор", () => {
    it("агент снял, клиент занят (BUSY) — исход «Клиент не ответил», записи не ищем", async () => {
      const interaction = await startedInteraction();
      startCall("ch-30", interaction.id);
      const call = getCall("ch-30")!;
      call.agentExtension = "1004";
      // Агент снял свою трубку — станция набирает клиента.
      await handleAriEvent({ type: "ChannelStateChange", channel: { id: "ch-30", name: "", state: "Up", caller: {} } });
      // Ответ АГЕНТА: dialstring — его мобильный, а не номер клиента.
      await handleAriEvent({
        type: "Dial",
        dialstatus: "ANSWER",
        dialstring: "Local/930001001@from-internal",
        channel: { id: "ch-30", name: "", state: "Up", caller: {} },
      });
      expect(getCall("ch-30")?.state).not.toBe("talking");

      stationVariables = { DIALSTATUS: "BUSY" };
      await handleAriEvent({ type: "ChannelDestroyed", channel: { id: "ch-30", name: "", state: "Down", caller: {} } });

      expect(getCall("ch-30")?.outcome).toBe("Клиент не ответил");
      // Записи у недозвона нет и быть не может — искать её на станции незачем.
      expect(ingestCalls.filter((c) => c.channelId === "ch-30")).toHaveLength(0);
      const saved = await prisma.interaction.findUnique({ where: { id: interaction.id } });
      expect(saved?.notes).toMatch(/клиент не ответил/i);
      expect(saved?.outcome).toBe("NO_ANSWER");
    });

    it("станция сказала NOANSWER — она сильнее того, что успели насчитать события", async () => {
      const interaction = await startedInteraction();
      startCall("ch-31", interaction.id);
      // Даже если разговор уже был объявлен (сборка Asterisk прислала свой Dial),
      // итог второго плеча знает только станция — и он отменяет догадку.
      await handleAriEvent({
        type: "Dial",
        dialstatus: "ANSWER",
        dialstring: CLIENT_DIALSTRING,
        channel: { id: "ch-31", name: "", state: "Up", caller: {} },
      });
      stationVariables = { DIALSTATUS: "NOANSWER" };
      await handleAriEvent({ type: "ChannelDestroyed", channel: { id: "ch-31", name: "", state: "Down", caller: {} } });

      expect(getCall("ch-31")?.outcome).toBe("Клиент не ответил");
      expect(ingestCalls.filter((c) => c.channelId === "ch-31")).toHaveLength(0);
    });

    it("агент снял, клиент ОТВЕТИЛ — разговор, длительность считается от ответа клиента", async () => {
      const interaction = await startedInteraction();
      startCall("ch-32", interaction.id);
      const call = getCall("ch-32")!;
      call.agentExtension = "1004";
      await handleAriEvent({ type: "ChannelStateChange", channel: { id: "ch-32", name: "", state: "Up", caller: {} } });
      await handleAriEvent({
        type: "Dial",
        dialstatus: "ANSWER",
        dialstring: CLIENT_DIALSTRING,
        channel: { id: "ch-32", name: "", state: "Up", caller: {} },
      });
      expect(getCall("ch-32")?.state).toBe("talking");

      stationVariables = { DIALSTATUS: "ANSWER", ANSWEREDTIME: "36" };
      await handleAriEvent({ type: "ChannelDestroyed", channel: { id: "ch-32", name: "", state: "Down", caller: {} } });

      expect(getCall("ch-32")?.outcome).toMatch(/Поговорили/);
      expect(getCall("ch-32")?.answerConfirmed).toBe(true);
      expect(ingestCalls.filter((c) => c.channelId === "ch-32")).toHaveLength(1);
    });

    it("Dial к агенту не пришёл вовсе, а разговор был — длительность берётся у станции", async () => {
      /**
       * Сборка Asterisk может не прислать ни одного пригодного Dial (нет dialstring).
       * Раньше это было лазейкой, через которую ответ агента становился разговором;
       * теперь такой звонок опирается на ANSWEREDTIME — точную длительность второго
       * плеча, а не на момент, когда трубку снял сотрудник.
       */
      const interaction = await startedInteraction();
      startCall("ch-33", interaction.id);
      const call = getCall("ch-33")!;
      call.agentExtension = "1004";
      await handleAriEvent({ type: "ChannelStateChange", channel: { id: "ch-33", name: "", state: "Up", caller: {} } });

      stationVariables = { DIALSTATUS: "ANSWER", ANSWEREDTIME: "42" };
      await handleAriEvent({ type: "ChannelDestroyed", channel: { id: "ch-33", name: "", state: "Down", caller: {} } });

      const finished = getCall("ch-33")!;
      expect(finished.outcome).toMatch(/Поговорили/);
      expect(talkSeconds(finished)).toBeGreaterThanOrEqual(41);
      expect(talkSeconds(finished)).toBeLessThanOrEqual(44);
    });

    it("DIALSTATUS ловится живым Varset — даже когда послезвонковый опрос отвечает 404", async () => {
      /**
       * Прод-факт 26.08.2026: наши исходящие не заходят в Stasis, к моменту
       * ChannelDestroyed канал уже уничтожен и GET variable отвечает 404 — журнал
       * заполняли записи «DIALSTATUS не прочитан, разговор засчитан по событию Dial».
       * Станция при этом объявляет DIALSTATUS живым событием Varset — его и ловим.
       * Здесь stationVariables пусты нарочно: опрос после смерти канала ничего не даёт.
       */
      const interaction = await startedInteraction();
      startCall("ch-40", interaction.id);
      await handleAriEvent({ type: "ChannelStateChange", channel: { id: "ch-40", name: "", state: "Up", caller: {} } });
      // Сборка без dialstring: плечо неопознано, разговор объявлен догадкой.
      await handleAriEvent({
        type: "Dial",
        dialstatus: "ANSWER",
        channel: { id: "ch-40", name: "", state: "Up", caller: {} },
      });
      await handleAriEvent({
        type: "ChannelVarset",
        variable: "DIALSTATUS",
        value: "NOANSWER",
        channel: { id: "ch-40", name: "", state: "Up", caller: {} },
      });
      stationVariables = {};
      await handleAriEvent({ type: "ChannelDestroyed", channel: { id: "ch-40", name: "", state: "Down", caller: {} } });

      expect(getCall("ch-40")?.outcome).toBe("Клиент не ответил");
      const saved = await prisma.interaction.findUnique({ where: { id: interaction.id } });
      expect(saved?.outcome).toBe("NO_ANSWER");
    });

    it("DIALSTATUS, объявленный на ВТОРОМ плече, тоже наш", async () => {
      /**
       * Асимметрия, найденная 27.08.2026: наш канал в событии Dial ищется по трём
       * идентификаторам (channel, peer, caller_id) — станция называет инициатором
       * то одно, то другое. А Varset искал только по channel.id, и переменная,
       * объявленная на плече к клиенту, выбрасывалась: исход снова становился
       * догадкой по Dial, а в журнал ложилось «DIALSTATUS не прочитан».
       */
      const interaction = await startedInteraction();
      startCall("ch-45", interaction.id);
      await handleAriEvent({ type: "ChannelStateChange", channel: { id: "ch-45", name: "", state: "Up", caller: {} } });
      // Станция называет обе стороны разом — отсюда и узнаём, что ch-45-leg наш.
      await handleAriEvent({
        type: "Dial",
        dialstatus: "ANSWER",
        channel: { id: "ch-45", name: "", state: "Up", caller: {} },
        peer: { id: "ch-45-leg", name: "", state: "Up", caller: {} },
      });
      // ...а переменную объявляет уже на плече к клиенту.
      await handleAriEvent({
        type: "ChannelVarset",
        variable: "DIALSTATUS",
        value: "NOANSWER",
        channel: { id: "ch-45-leg", name: "", state: "Up", caller: {} },
      });
      stationVariables = {};
      await handleAriEvent({ type: "ChannelDestroyed", channel: { id: "ch-45", name: "", state: "Down", caller: {} } });

      expect(getCall("ch-45")?.outcome).toBe("Клиент не ответил");
      const saved = await prisma.interaction.findUnique({ where: { id: interaction.id } });
      expect(saved?.outcome).toBe("NO_ANSWER");
      expect(saved?.callAttempt).toBe("NO_ANSWER");
    });

    it("чужой канал, никак не связанный с нашим звонком, исход не подменяет", async () => {
      const interaction = await startedInteraction();
      startCall("ch-46", interaction.id);
      await handleAriEvent({ type: "ChannelStateChange", channel: { id: "ch-46", name: "", state: "Up", caller: {} } });
      await handleAriEvent({
        type: "Dial",
        dialstatus: "ANSWER",
        dialstring: CLIENT_DIALSTRING,
        channel: { id: "ch-46", name: "", state: "Up", caller: {} },
      });
      // Соседний разговор на той же станции — к нашему звонку отношения не имеет.
      await handleAriEvent({
        type: "ChannelVarset",
        variable: "DIALSTATUS",
        value: "NOANSWER",
        channel: { id: "чужой-канал-соседнего-разговора", name: "", state: "Up", caller: {} },
      });
      stationVariables = {};
      await handleAriEvent({ type: "ChannelDestroyed", channel: { id: "ch-46", name: "", state: "Down", caller: {} } });

      expect(getCall("ch-46")?.outcome).toMatch(/Поговорили/);
    });

    it("первый Varset ANSWER — это ответ агента: побеждает ПОСЛЕДНИЙ DIALSTATUS", async () => {
      // В режиме «на мобильный» Dial выполняется дважды; немедленное применение
      // первого ANSWER вернуло бы баг 18.08 «ответ агента записан разговором».
      const interaction = await startedInteraction();
      startCall("ch-41", interaction.id);
      await handleAriEvent({ type: "ChannelStateChange", channel: { id: "ch-41", name: "", state: "Up", caller: {} } });
      await handleAriEvent({
        type: "ChannelVarset",
        variable: "DIALSTATUS",
        value: "ANSWER",
        channel: { id: "ch-41", name: "", state: "Up", caller: {} },
      });
      await handleAriEvent({
        type: "ChannelVarset",
        variable: "DIALSTATUS",
        value: "NOANSWER",
        channel: { id: "ch-41", name: "", state: "Up", caller: {} },
      });
      stationVariables = {};
      await handleAriEvent({ type: "ChannelDestroyed", channel: { id: "ch-41", name: "", state: "Down", caller: {} } });

      expect(getCall("ch-41")?.outcome).toBe("Клиент не ответил");
    });

    it("живые Varset ANSWER + ANSWEREDTIME дают разговор с длительностью от станции", async () => {
      const interaction = await startedInteraction();
      startCall("ch-42", interaction.id);
      const call = getCall("ch-42")!;
      call.agentExtension = "1004";
      await handleAriEvent({ type: "ChannelStateChange", channel: { id: "ch-42", name: "", state: "Up", caller: {} } });
      await handleAriEvent({
        type: "ChannelVarset",
        variable: "DIALSTATUS",
        value: "ANSWER",
        channel: { id: "ch-42", name: "", state: "Up", caller: {} },
      });
      await handleAriEvent({
        type: "ChannelVarset",
        variable: "ANSWEREDTIME",
        value: "42",
        channel: { id: "ch-42", name: "", state: "Up", caller: {} },
      });
      stationVariables = {};
      await handleAriEvent({ type: "ChannelDestroyed", channel: { id: "ch-42", name: "", state: "Down", caller: {} } });

      const finished = getCall("ch-42")!;
      expect(finished.outcome).toMatch(/Поговорили/);
      expect(finished.answerConfirmed).toBe(true);
      expect(talkSeconds(finished)).toBeGreaterThanOrEqual(41);
      expect(talkSeconds(finished)).toBeLessThanOrEqual(44);
    });

    it("Dial без dialstring + станция промолчала — РАЗГОВОР СОХРАНЯЕТСЯ", async () => {
      /**
       * Отсутствие доказательств — не доказательство недозвона. Сборка Asterisk не
       * прислала dialstring, переменные канала не прочитались (канал исчез, туннель
       * моргнул) — и всё же разговор был. Записать его недозвоном значит потерять
       * его насовсем: ни записи, ни балла, ни следа в учёте, и никто не заметит.
       * Поэтому здесь система деградирует в СВОЁ ПРЕЖНЕЕ поведение.
       */
      const interaction = await startedInteraction();
      startCall("ch-35", interaction.id);
      const call = getCall("ch-35")!;
      call.agentExtension = "1004";
      await handleAriEvent({ type: "ChannelStateChange", channel: { id: "ch-35", name: "", state: "Up", caller: {} } });
      await handleAriEvent({
        type: "Dial",
        dialstatus: "ANSWER",
        channel: { id: "ch-35", name: "", state: "Up", caller: {} },
      });
      expect(getCall("ch-35")?.state).toBe("talking");
      // Догадка, а не факт: доказательства ответа клиента нет.
      expect(getCall("ch-35")?.answerConfirmed).toBeFalsy();

      await handleAriEvent({ type: "ChannelDestroyed", channel: { id: "ch-35", name: "", state: "Down", caller: {} } });

      expect(getCall("ch-35")?.outcome).toMatch(/Поговорили/);
      expect(ingestCalls.filter((c) => c.channelId === "ch-35")).toHaveLength(1);
      const saved = await prisma.interaction.findUnique({ where: { id: interaction.id } });
      expect(saved?.notes).toMatch(/разговор/i);
      expect(saved?.outcome).not.toBe("NO_ANSWER");
    });

    /**
     * РАЗБОР 21.09.2026: «поговорили 0:36», когда клиент трубку не брал (1014 в
     * 12:16/12:34/12:37, 1013 в 16:16–16:31). По CDR у таких звонков есть только
     * плечо АГЕНТА: dialstring не пришёл ни разу, значит classifyDialLeg не может
     * отличить ответ агента от ответа клиента (см. предыдущий тест — это то же
     * самое "unknown"-плечо). Поведение НЕ МЕНЯЕТСЯ этим тестом: без надёжного
     * способа различить их звонок по-прежнему остаётся разговором (см. докстринг
     * в finishCall, callTracker.ts) — тест фиксирует ЭТО как намеренное, а не
     * забытое, и проверяет единственное, что 21.09.2026 реально поменялось:
     * сигнал в журнале теперь называет карточку клиента и длительность, а не
     * только channelId, по которому карточку было не найти без похода в CDR
     * станции.
     */
    it("0:36 без подтверждённого ответа клиента — исход сохранён, но сигнал в журнале указывает на карточку", async () => {
      // logSystemError дедуплицирует по dedupKey в окне 10 минут (systemError.ts) —
      // соседний тест выше уже завёл строку с тем же dedupKey ("Ответ клиента не
      // подтверждён станцией"), и без очистки наша запись была бы молча
      // подавлена как повтор той же поломки, а не отдельным сигналом.
      // СНАЧАЛА ДОЖДАТЬСЯ, ПОКА ЧУЖАЯ ЗАПИСЬ ПРИЗЕМЛИТСЯ, и только потом чистить:
      // соседний тест пишет свой сигнал через `void logSystemError` (в отрыве,
      // без await). Запоздав на миллисекунду, он ложится ПОСЛЕ нашей очистки —
      // и тогда уже наша запись гасится как повтор, а ждать её бесполезно:
      // в базе лежит строка про чужой канал. Класс «тест наперегонки с записью
      // в отрыве», CLAUDE.md.
      const signalCount = () =>
        prisma.errorLog.count({
          where: { source: "telephony", message: { startsWith: "Ответ клиента не подтверждён станцией" } },
        });
      await waitForSettled(signalCount);
      await prisma.errorLog.deleteMany({
        where: { source: "telephony", message: { startsWith: "Ответ клиента не подтверждён станцией" } },
      });
      // И сбрасываем «жаловаться не чаще раза в час» (unconfirmedAnswerLoggedAt в
      // callTracker.ts): afterEach чистит его между тестами ЭТОГО файла, но в
      // полном прогоне счётчик мог поставить соседний файл — тогда запись в
      // журнал не появлялась вовсе, и тест падал только в полном прогоне (22.09.2026).
      resetCalls();

      const interaction = await startedInteraction();
      startCall("ch-38", interaction.id);
      const call = getCall("ch-38")!;
      call.agentExtension = "1004";
      await handleAriEvent({ type: "ChannelStateChange", channel: { id: "ch-38", name: "", state: "Up", caller: {} } });
      await handleAriEvent({
        type: "Dial",
        dialstatus: "ANSWER",
        channel: { id: "ch-38", name: "", state: "Up", caller: {} },
      });
      expect(getCall("ch-38")?.answerConfirmed).toBeFalsy();
      // Симулируем ровно разобранный случай: агент "ответил" 36 секунд назад,
      // ответ клиента ничем не доказан.
      getCall("ch-38")!.answeredAt = new Date(Date.now() - 36_000);

      await handleAriEvent({ type: "ChannelDestroyed", channel: { id: "ch-38", name: "", state: "Down", caller: {} } });

      const finished = getCall("ch-38")!;
      expect(finished.outcome).toMatch(/Поговорили/);
      expect(finished.answerConfirmed).toBeFalsy();

      // Фильтр по channelId ОБЯЗАТЕЛЕН: соседний тест этого же describe (строкой
      // выше) заводит точно такой же по префиксу сигнал для своего канала, и оба
      // укладываются в одну и ту же миллисекунду createdAt — без этого
      // уточнения findFirst(orderBy: desc) мог вернуть чужую запись.
      const entry = await waitFor(() =>
        prisma.errorLog.findFirst({
          where: {
            source: "telephony",
            message: { contains: "Ответ клиента не подтверждён станцией" },
            AND: { message: { contains: "канал ch-38" } },
          },
          orderBy: { createdAt: "desc" },
        })
      );
      // Раньше в сообщении был только channelId. Теперь — имя клиента и
      // длительность, которую сигнал же и ставит под сомнение.
      expect(entry.message).toContain(`клиент ${`Клиент звонка ${runId}`}`);
      expect(entry.message).toMatch(/поговорили 0:3[4-8]/);
    });

    it("Dial без dialstring + станция сказала BUSY — догадка перебита недозвоном", async () => {
      const interaction = await startedInteraction();
      startCall("ch-36", interaction.id);
      const call = getCall("ch-36")!;
      call.agentExtension = "1004";
      await handleAriEvent({ type: "ChannelStateChange", channel: { id: "ch-36", name: "", state: "Up", caller: {} } });
      await handleAriEvent({
        type: "Dial",
        dialstatus: "ANSWER",
        channel: { id: "ch-36", name: "", state: "Up", caller: {} },
      });
      expect(getCall("ch-36")?.state).toBe("talking");

      stationVariables = { DIALSTATUS: "BUSY" };
      await handleAriEvent({ type: "ChannelDestroyed", channel: { id: "ch-36", name: "", state: "Down", caller: {} } });

      expect(getCall("ch-36")?.outcome).toBe("Клиент не ответил");
      expect(ingestCalls.filter((c) => c.channelId === "ch-36")).toHaveLength(0);
      const saved = await prisma.interaction.findUnique({ where: { id: interaction.id } });
      expect(saved?.outcome).toBe("NO_ANSWER");
    });

    it("длительность из ANSWEREDTIME в формате «1:05» — это 65 секунд, а не минута", async () => {
      const interaction = await startedInteraction();
      startCall("ch-37", interaction.id);
      await handleAriEvent({ type: "ChannelStateChange", channel: { id: "ch-37", name: "", state: "Up", caller: {} } });

      stationVariables = { DIALSTATUS: "ANSWER", ANSWEREDTIME: "1:05" };
      await handleAriEvent({ type: "ChannelDestroyed", channel: { id: "ch-37", name: "", state: "Down", caller: {} } });

      const finished = getCall("ch-37")!;
      expect(finished.outcome).toMatch(/Поговорили/);
      expect(talkSeconds(finished)).toBeGreaterThanOrEqual(64);
      expect(talkSeconds(finished)).toBeLessThanOrEqual(67);
    });

    it("ни Dial, ни ответа станции — итог считается по стадиям, как раньше", async () => {
      const interaction = await startedInteraction();
      startCall("ch-34", interaction.id);
      await handleAriEvent({ type: "ChannelStateChange", channel: { id: "ch-34", name: "", state: "Up", caller: {} } });
      // Переменных нет: канал исчез раньше, чем мы спросили. Обработка события от
      // этого падать не должна.
      await handleAriEvent({ type: "ChannelDestroyed", channel: { id: "ch-34", name: "", state: "Down", caller: {} } });
      expect(getCall("ch-34")?.outcome).toBe("Клиент не ответил");
    });
  });

  it("недозвон через CRM ставит исход и задачу перезвонить — как ручная отметка", async () => {
    /**
     * До 12.08.2026 недозвон через телефонию оставлял только строку в хронологии:
     * ни исхода, ни следующего шага. Тот же факт, отмеченный агентом руками
     * (POST /clients/:id/interactions), ставил NO_ANSWER и перезвон через 15 минут —
     * то есть последствие зависело от способа записи, а не от того, что случилось.
     */
    const interaction = await startedInteraction();
    startCall("ch-9", interaction.id);
    await handleAriEvent({ type: "ChannelStateChange", channel: { id: "ch-9", name: "", state: "Up", caller: {} } });
    await handleAriEvent({ type: "ChannelDestroyed", channel: { id: "ch-9", name: "", state: "Down", caller: {} } });

    const saved = await prisma.interaction.findUnique({ where: { id: interaction.id } });
    expect(saved?.outcome).toBe("NO_ANSWER");
    // Задача — из общей цепочки перезвонов (lib/noAnswerStreak.ts), поэтому в тексте
    // видно номер попытки: агент понимает, сколько их осталось до руководителя.
    expect(saved?.nextAction).toMatch(/^Перезвонить — клиент не ответил \(попытка 1 из \d+\)$/);
    const inMinutes = (saved!.nextActionDate!.getTime() - Date.now()) / 60_000;
    expect(inMinutes).toBeGreaterThan(13);
    expect(inMinutes).toBeLessThan(16);

    // Окна «Как прошёл звонок» у недозвона НЕТ (владелец проверил на живом звонке
    // 13.08.2026). Цепочку перезвонов запускает сам finishCall — задача выше тому
    // и доказательство, подтверждения агентом для неё больше не требуется.
    const window = await prisma.pendingSummary.findFirst({
      where: { kind: "call_result", subjectId: interaction.id },
    });
    expect(window).toBeNull();
  });

  /**
   * ОТМЕНА ВЫЗОВА (владелец 13.08.2026: «можно отменять звонки, если они случайно
   * пошли или я передумал»).
   *
   * Проверяется главное: отмена НЕ становится недозвоном. Спутать их дорого — три
   * случайных нажатия объявили бы живого клиента «Не отвечает», запустили цепочку
   * перезвонов и подняли руководителя.
   */
  describe("Отменённый вызов", () => {
    it("отмена до того, как телефон клиента зазвонил, не оставляет следа в карточке", async () => {
      const interaction = await startedInteraction();
      startCall("ch-20", interaction.id);
      // Агент нажал «Отменить», станция ещё звонила ему самому.
      expect(markCallCancelled("ch-20")).toBeTruthy();
      await handleAriEvent({ type: "ChannelDestroyed", channel: { id: "ch-20", name: "", state: "Down", caller: {} } });

      expect(getCall("ch-20")?.outcome).toBe("Вызов отменён");
      // Клиент этого звонка не видел — значит и в его истории события нет.
      const saved = await prisma.interaction.findUnique({ where: { id: interaction.id } });
      expect(saved).toBeNull();
      const window = await prisma.pendingSummary.findFirst({
        where: { kind: "call_result", subjectId: interaction.id },
      });
      expect(window).toBeNull();
    });

    it("отмена, когда телефон клиента уже звонил, оставляет честную запись — но не недозвон", async () => {
      const interaction = await startedInteraction();
      startCall("ch-21", interaction.id);
      await handleAriEvent({ type: "ChannelStateChange", channel: { id: "ch-21", name: "", state: "Up", caller: {} } });
      expect(markCallCancelled("ch-21")).toBeTruthy();
      await handleAriEvent({ type: "ChannelDestroyed", channel: { id: "ch-21", name: "", state: "Down", caller: {} } });

      const saved = await prisma.interaction.findUnique({ where: { id: interaction.id } });
      expect(saved?.notes).toMatch(/отменён агентом/i);
      // Клиент увидит пропущенный, но трубку он не «не поднял» — исхода нет,
      // задачи перезвонить нет, цепочка недозвонов не запускается.
      expect(saved?.outcome).toBeNull();
      expect(saved?.nextAction).toBeNull();
      expect(saved?.notes).not.toMatch(/клиент не ответил/i);
    });

    it("клиент успел ответить — отмена не отменяет состоявшийся разговор", async () => {
      const interaction = await startedInteraction();
      startCall("ch-22", interaction.id);
      await handleAriEvent({ type: "Dial", dialstatus: "ANSWER", dialstring: CLIENT_DIALSTRING, channel: { id: "ch-22", name: "", state: "Up", caller: {} } });
      // Нажатие пришло уже после ответа: связь состоялась, и стирать её нельзя.
      expect(markCallCancelled("ch-22")).toBeTruthy();
      await handleAriEvent({ type: "ChannelDestroyed", channel: { id: "ch-22", name: "", state: "Down", caller: {} } });

      expect(getCall("ch-22")?.outcome).toMatch(/Поговорили/);
      const saved = await prisma.interaction.findUnique({ where: { id: interaction.id } });
      expect(saved?.notes).toMatch(/разговор/i);
      /* Окно «Как прошёл звонок» здесь больше не проверяется: механизм
         обязательных окон удалён 13.09.2026. Проверяемое осталось прежним —
         состоявшийся разговор не стирается поздним нажатием «Отменить». */
    });

    it("повторное нажатие безвредно, а завершённый звонок отменить уже нельзя", async () => {
      const interaction = await startedInteraction();
      startCall("ch-23", interaction.id);
      expect(markCallCancelled("ch-23")).toBeTruthy();
      expect(markCallCancelled("ch-23")).toBeTruthy();
      await handleAriEvent({ type: "ChannelDestroyed", channel: { id: "ch-23", name: "", state: "Down", caller: {} } });
      // Звонок уже кончился — пометка не ложится, и запрос отменит ответ «звонка нет».
      expect(markCallCancelled("ch-23")).toBeUndefined();
    });
  });

  it("агент не снял свою трубку — клиенту не пишем ни недозвон, ни задачу", async () => {
    /**
     * Отслеживаемый канал — канал АГЕНТА: станция сначала звонит ему и только
     * после того, как он снял трубку, набирает клиента. Звонок, оборвавшийся до
     * стадии `ringing_client` (агент не взял, телефон выключен, SIP не
     * зарегистрирован), означает, что телефон клиента НЕ ЗВОНИЛ. Записать такому
     * клиенту NO_ANSWER — прямая порча данных: три подряд, и clientAutoStatus
     * объявит живого клиента «Не отвечает» за то, чего он не делал.
     */
    const interaction = await startedInteraction();
    startCall("ch-12", interaction.id);
    // Никакого ChannelStateChange/Up: агент трубку так и не снял.
    await handleAriEvent({ type: "ChannelDestroyed", channel: { id: "ch-12", name: "", state: "Down", caller: {} } });

    expect(getCall("ch-12")?.outcome).toBe("Агент не снял трубку");
    const saved = await prisma.interaction.findUnique({ where: { id: interaction.id } });
    expect(saved?.outcome).toBeNull();
    expect(saved?.nextAction).toBeNull();
    expect(saved?.nextActionDate).toBeNull();
    // В карточке это должно читаться честно, а не как отказ клиента.
    expect(saved?.notes).toMatch(/агент не снял трубку/i);
    expect(saved?.notes).not.toMatch(/клиент не ответил/i);
    // И то же самое машиночитаемо: попыткой связаться это не считается.
    expect(saved?.callAttempt).toBe("AGENT_NO_PICKUP");
  });

  it("состоявшийся разговор — это контакт: карточка перестаёт выглядеть заброшенной", async () => {
    /**
     * `lastContactAt` двигал только входящий звонок. Агент, работающий через
     * CRM-телефонию, для cardReminders/clientAutoStatus выглядел бросившим клиента,
     * которому звонит каждый день. `firstContactAt` при этом ставится ОДИН раз —
     * второй звонок его не двигает.
     */
    await prisma.client.update({
      where: { id: clientId },
      data: { firstContactAt: null, lastContactAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
    });

    const first = await startedInteraction();
    startCall("ch-10", first.id);
    await handleAriEvent({ type: "Dial", dialstatus: "ANSWER", dialstring: CLIENT_DIALSTRING, channel: { id: "ch-10", name: "", state: "Up", caller: {} } });
    await handleAriEvent({ type: "ChannelDestroyed", channel: { id: "ch-10", name: "", state: "Down", caller: {} } });

    const afterFirst = await waitFor(async () => {
      const c = await prisma.client.findUnique({ where: { id: clientId } });
      return c?.firstContactAt ? c : null;
    });
    expect(afterFirst.lastContactAt.getTime()).toBeGreaterThan(Date.now() - 60_000);
    expect(afterFirst.firstContactAt).toBeInstanceOf(Date);
    // Исход разговора ставит человек в окне «Как прошёл звонок», а не телефония.
    expect((await prisma.interaction.findUnique({ where: { id: first.id } }))?.outcome).toBeNull();

    resetCalls();
    const second = await startedInteraction();
    startCall("ch-11", second.id);
    await handleAriEvent({ type: "Dial", dialstatus: "ANSWER", dialstring: CLIENT_DIALSTRING, channel: { id: "ch-11", name: "", state: "Up", caller: {} } });
    await handleAriEvent({ type: "ChannelDestroyed", channel: { id: "ch-11", name: "", state: "Down", caller: {} } });

    const afterSecond = await prisma.client.findUnique({ where: { id: clientId } });
    expect(afterSecond?.firstContactAt?.getTime()).toBe(afterFirst?.firstContactAt?.getTime());
  });

  it("занята линия только у того, кто говорит: остальные звонят как обычно", () => {
    // Требование владельца 07.08.2026 дословно: «кнопка позвонить блокирует только
    // текущего агента, а не всех подряд». Разговор одного сотрудника не должен
    // останавливать работу отдела.
    startCall("ch-7");
    expect(hasLiveCall(agentId)).toBe(true);
    expect(hasLiveCall("другой-сотрудник")).toBe(false);
    expect(activeCallFor("другой-сотрудник")).toBeUndefined();
  });

  it("чужие события не трогают наш звонок: на станции идут и другие разговоры", async () => {
    startCall("ch-6");
    await handleAriEvent({ type: "ChannelDestroyed", channel: { id: "посторонний-канал", name: "", state: "Down", caller: {} } });
    expect(getCall("ch-6")?.state).toBe("ringing_agent");
    expect(hasLiveCall(agentId)).toBe(true);
  });

  it("дубль события конца звонка не выгружает запись повторно", async () => {
    // ChannelDestroyed и StasisEnd — два разных события ARI, а при обрыве и
    // переподключении сокета станция могла прислать одно из них ещё раз. Завершённый
    // звонок живёт в памяти ещё 20 секунд (агент смотрит итог на экране), поэтому
    // проверки «звонок есть в карте» не хватало: повторное событие запускало выгрузку
    // заново — лишняя закачка файла, второй платный разбор у Gemini и второе
    // предложение по карточке на один и тот же разговор.
    const interaction = await startedInteraction();
    startCall("ch-8", interaction.id);
    const call = getCall("ch-8")!;
    call.agentExtension = "1004";
    call.clientPhone = "+992900000000";
    await handleAriEvent({
      type: "Dial",
      dialstatus: "ANSWER",
      dialstring: CLIENT_DIALSTRING,
      channel: { id: "ch-8", name: "", state: "Up", caller: {} },
    });

    await handleAriEvent({ type: "ChannelDestroyed", channel: { id: "ch-8", name: "", state: "Down", caller: {} } });
    await handleAriEvent({ type: "StasisEnd", channel: { id: "ch-8", name: "", state: "Down", caller: {} } });
    await handleAriEvent({ type: "ChannelDestroyed", channel: { id: "ch-8", name: "", state: "Down", caller: {} } });

    expect(ingestCalls.filter((c) => c.channelId === "ch-8")).toHaveLength(1);
  });
});

/**
 * НАСТОЯЩАЯ ФОРМА СОБЫТИЯ Dial — С `caller`, А НЕ С `channel` (22.09.2026).
 *
 * Все проверки выше подают Dial с полем `channel`, которого у этого события в ARI
 * НЕТ ВООБЩЕ (схема самой станции: /var/lib/asterisk/rest-api/events.json → Dial:
 * caller, peer, forward, forwarded, dialstring, dialstatus). Тесты повторяли то же
 * неверное допущение, что и код, и потому годами оставались зелёными на сломанной
 * логике. Здесь события описаны так, как их шлёт живая станция.
 *
 * Разбор прода 21–22.09.2026 (CDR asteriskcdrdb, два плеча под одним linkedid):
 *   10:17:59  Local/000001017@from-internal-000002b5;2 → 000001017  ANSWERED (агент)
 *   10:17:59  Local/000001017@from-internal-000002b5;1 → 030001026  NO ANSWER (клиент)
 * а в CRM у этого звонка стояло «Звонок через CRM, разговор 0:10». Таких —
 * пятнадцать за двое суток, и у КАЖДОГО плечо к клиенту в CDR не ANSWERED.
 */
describe("подтверждение ответа КЛИЕНТА, а не агента (форма событий живой станции)", () => {
  /** Dial, которым сам originate дозванивается до АГЕНТА: наш канал назван `peer`,
   *  а dialstring — Local-канал с обязательным суффиксом `/n` (см. originateCall). */
  function agentLegDial(channelId: string, dialstatus: string) {
    return {
      type: "Dial",
      dialstatus,
      dialstring: "Local/000001017@from-internal/n",
      peer: { id: channelId, name: "Local/000001017@from-internal-000002b5;1", state: "Up", caller: {} },
    } as const;
  }

  /** Dial, которым станция набирает КЛИЕНТА: выполняется НА нашем канале, поэтому
   *  наш канал — `caller`, а `peer` — плечо провайдера. */
  function clientLegDial(channelId: string, dialstatus: string) {
    return {
      type: "Dial",
      dialstatus,
      dialstring: CLIENT_DIALSTRING,
      caller: { id: channelId, name: "Local/000001017@from-internal-000002b5;1", state: "Up", caller: {} },
      peer: { id: `${channelId}-out`, name: "SIP/out-00000458", state: "Down", caller: {} },
    } as const;
  }

  it("агент снял трубку, клиент не ответил — разговор НЕ засчитывается", async () => {
    const interaction = await startedInteraction();
    startCall("ch-40", interaction.id);
    // Агент поднял трубку: канал ожил, и станция объявила ANSWER на плече к агенту.
    await handleAriEvent({ type: "ChannelStateChange", channel: { id: "ch-40", name: "", state: "Up", caller: {} } });
    await handleAriEvent(agentLegDial("ch-40", "ANSWER"));
    expect(getCall("ch-40")?.answeredAt).toBeUndefined();
    // И только теперь — настоящий итог дозвона клиенту.
    await handleAriEvent(clientLegDial("ch-40", "NOANSWER"));
    await handleAriEvent({ type: "ChannelDestroyed", channel: { id: "ch-40", name: "", state: "Down", caller: {} } });

    const saved = await waitFor(() =>
      prisma.interaction.findFirst({ where: { id: interaction.id, callAttempt: { not: null } } })
    );
    // Звонок остаётся в хронологии попыткой, а не исчезает.
    expect(saved.callAttempt).toBe("NO_ANSWER");
    expect(saved.notes).toContain("клиент не ответил");
    // Записи у недозвона нет и выгружать нечего.
    expect(ingestCalls.filter((c) => c.channelId === "ch-40")).toHaveLength(0);
  });

  it("клиент действительно ответил — разговор засчитывается и подтверждён станцией", async () => {
    const interaction = await startedInteraction();
    startCall("ch-41", interaction.id);
    await handleAriEvent({ type: "ChannelStateChange", channel: { id: "ch-41", name: "", state: "Up", caller: {} } });
    await handleAriEvent(agentLegDial("ch-41", "ANSWER"));
    await handleAriEvent(clientLegDial("ch-41", "ANSWER"));
    expect(getCall("ch-41")?.answeredAt).toBeInstanceOf(Date);
    expect(getCall("ch-41")?.answerConfirmed).toBe(true);
    await handleAriEvent({ type: "ChannelDestroyed", channel: { id: "ch-41", name: "", state: "Down", caller: {} } });

    const saved = await waitFor(() =>
      prisma.interaction.findFirst({ where: { id: interaction.id, callAttempt: { not: null } } })
    );
    expect(saved.callAttempt).toBe("TALKED");
  });

  /**
   * ТРЕТИЙ СЛУЧАЙ — ПОДТВЕРЖДЕНИЯ НЕТ ВОВСЕ, И ПОВЕДЕНИЕ ОСТАЁТСЯ ПРЕЖНИМ.
   *
   * Решение владельца 21.09.2026: потерять настоящий разговор дороже, чем изредка
   * посчитать лишний. Если станция не назвала набранного номера ни на одном плече,
   * доказательств нет НИКАКИХ — разговор засчитывается, как и раньше, но помечается
   * неподтверждённым (`answerConfirmed === false`, отсюда строка утреннего отчёта).
   */
  it("станция не назвала набранного — разговор засчитан, но помечен неподтверждённым", async () => {
    const interaction = await startedInteraction();
    startCall("ch-42", interaction.id);
    await handleAriEvent({
      type: "Dial",
      dialstatus: "ANSWER",
      peer: { id: "ch-42", name: "Local/…;1", state: "Up", caller: {} },
    });
    expect(getCall("ch-42")?.answeredAt).toBeInstanceOf(Date);
    expect(getCall("ch-42")?.answerConfirmed).toBeFalsy();
    await handleAriEvent({ type: "ChannelDestroyed", channel: { id: "ch-42", name: "", state: "Down", caller: {} } });

    const saved = await waitFor(() =>
      prisma.interaction.findFirst({ where: { id: interaction.id, callAttempt: { not: null } } })
    );
    expect(saved.callAttempt).toBe("TALKED");
  });

  /**
   * DIALSTATUS, ПОЙМАННЫЙ ЖИВЬЁМ НА ПЛЕЧЕ ПРОВАЙДЕРА, — ЗАПАСНОЙ ПУТЬ.
   *
   * Переменная объявляется на канале `SIP/out-…`, а не на нашем. Своим мы его
   * узнаём по карте legOwner, которая теперь заполняется и из поля `caller`.
   */
  it("запасной путь: DIALSTATUS с плеча провайдера отменяет незаслуженный разговор", async () => {
    const interaction = await startedInteraction();
    startCall("ch-43", interaction.id);
    await handleAriEvent({ type: "ChannelStateChange", channel: { id: "ch-43", name: "", state: "Up", caller: {} } });
    // Плечо к клиенту названо, но без исхода — так станция объявляет начало дозвона.
    await handleAriEvent({
      type: "Dial",
      dialstatus: "ANSWER",
      peer: { id: "ch-43", name: "Local/…;1", state: "Up", caller: {} },
    });
    await handleAriEvent({
      type: "Dial",
      dialstatus: "NOANSWER",
      dialstring: CLIENT_DIALSTRING,
      caller: { id: "ch-43", name: "Local/…;1", state: "Up", caller: {} },
      peer: { id: "ch-43-out", name: "SIP/out-00000458", state: "Down", caller: {} },
    });
    await handleAriEvent({
      type: "ChannelVarset",
      variable: "DIALSTATUS",
      value: "NOANSWER",
      channel: { id: "ch-43-out", name: "SIP/out-00000458", state: "Down", caller: {} },
    });
    await handleAriEvent({ type: "ChannelDestroyed", channel: { id: "ch-43", name: "", state: "Down", caller: {} } });

    const saved = await waitFor(() =>
      prisma.interaction.findFirst({ where: { id: interaction.id, callAttempt: { not: null } } })
    );
    expect(saved.callAttempt).toBe("NO_ANSWER");
  });
});
