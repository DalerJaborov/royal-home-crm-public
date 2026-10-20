import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const sendPushToAgent = vi.fn(async () => 1);
vi.mock("../src/push.js", async (importOriginal) => ({
  // Подмена ДОПОЛНЯЕТ модуль, а не заменяет его целиком (19.09.2026):
  // фабрика без importOriginal убирает остальные экспорты у всего
  // процесса, и СОСЕДНИЙ тест падает на «No "…" export is defined».
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent, sendPushToAgents: sendPushToAgent,
}));

const { prisma } = await import("../src/db.js");
const { waitForSettled } = await import("./helpers/waitFor.js");
const { handleAriEvent } = await import("../src/lib/telephony/ariEvents.js");
const {
  isInboundChannel,
  isTrackedIncoming,
  resetIncomingCalls,
  toCrmPhone,
  extensionFromChannelName,
  awaitIncomingReady,
} = await import("../src/lib/telephony/incomingCalls.js");
const { trackCall, resetCalls } = await import("../src/lib/telephony/callTracker.js");

/**
 * Входящие звонки — те, что клиенты делают сами.
 *
 * Проверяется разбор событий станции без самой станции: образцы событий собраны по
 * журналу живой АТС (входящий приходит контекстом ext-queues с девятью цифрами в
 * определителе, наш исходящий — контекстом from-internal).
 *
 * Главное, что стерегут эти тесты, — граница между «дозвонился» и «нет». Очередь
 * отвечает на звонок сама, чтобы играть музыку ожидания, и в журнале станции
 * брошенный звонок выглядит отвеченным. Если считать так же, потерянные обращения
 * исчезнут из отчётности ровно в тот момент, когда они и нужны.
 */

const runId = Date.now();
const clientPhone = `+9929${String(runId).slice(-8)}`;
let agentId = "";
let clientId = "";
let directorId = "";

beforeAll(async () => {
  const agent = await prisma.agent.create({
    data: {
      fullName: `Агент входящих ${runId}`,
      phone: `+99295${String(runId).slice(-7)}`,
      role: "AGENT",
      passwordHash: "x",
    },
  });
  agentId = agent.id;
  const client = await prisma.client.create({
    data: {
      fullName: `Клиент входящих ${runId}`,
      phone: clientPhone,
      source: "PHONE_CALL",
      assignedAgentId: agent.id,
      acceptedAt: new Date(),
    },
  });
  clientId = client.id;

  /**
   * Свой директор — обязателен, а не «наверняка найдётся в базе».
   *
   * Про звонок с незнакомого номера notifyMissed уведомляет тех, у кого есть право
   * clients.assign, и ищет их ПО ВСЕЙ базе. Локально сидовый директор есть всегда,
   * а в CI база пустая — тест проходил или падал в зависимости от того, оставил ли
   * своего директора активным сосед по алфавиту среди файлов. Ровно на этом CI и
   * покраснел 10.08.2026, оставаясь зелёным на машине разработчика.
   */
  const director = await prisma.agent.create({
    data: {
      fullName: `Директор входящих ${runId}`,
      phone: `+99296${String(runId).slice(-7)}`,
      role: "DIRECTOR",
      passwordHash: "x",
    },
  });
  directorId = director.id;
});

afterEach(async () => {
  resetIncomingCalls();
  resetCalls();
  sendPushToAgent.mockClear();
  await prisma.incomingCall.deleteMany({ where: { phone: { in: [clientPhone, "+992777000111"] } } });
  await prisma.interaction.deleteMany({ where: { clientId } });
});

afterAll(async () => {
  // Настройки — singleton на всю базу: файл, оставивший свою правку, ломает соседей
  // (файлы идут по одному, но по очереди, а не в изоляции — см. vitest.config.ts).
  await prisma.settings.updateMany({ where: { id: "singleton" }, data: { incomingAutoCreateClient: true } });
  await prisma.client.deleteMany({ where: { phone: "+992777000111" } });
  await prisma.client.deleteMany({ where: { id: clientId } });
  await prisma.agent.deleteMany({ where: { id: { in: [agentId, directorId] } } });
  await prisma.$disconnect();
});

/** Событие создания канала — так входящий приходит с транка через очередь. */
function inboundChannel(id: string, callerNumber: string) {
  return {
    id,
    name: `SIP/out-${id}`,
    state: "Ring",
    caller: { number: callerNumber },
    dialplan: { context: "ext-queues", exten: "1000" },
  };
}

async function ring(channelId: string, callerNumber: string) {
  await handleAriEvent({ type: "ChannelCreated", channel: inboundChannel(channelId, callerNumber) });
}

/** Оператор снял трубку: каналы оказались в одном мосту. */
async function bridge(channelId: string, operatorChannel = "SIP/1001-00000012") {
  await handleAriEvent({
    type: "ChannelEnteredBridge",
    channel: { id: "op-1", name: operatorChannel, state: "Up", caller: {} },
    bridge: { id: "b1", channels: [channelId, "op-1"] },
  });
}

async function hangup(channelId: string) {
  await handleAriEvent({ type: "ChannelDestroyed", channel: inboundChannel(channelId, "0") });
}

describe("Что считается входящим звонком", () => {
  it("канал с транка через очередь — входящий", () => {
    expect(isInboundChannel(inboundChannel("c1", "930001001"))).toBe(true);
  });

  it("контекст транка FreePBX (from-trunk-sip-<имя>) — входящий", () => {
    /**
     * РЕАЛЬНЫЙ КОНТЕКСТ НАШЕЙ СТАНЦИИ, снятый с живой АТС 11.08.2026:
     * `context=from-trunk-sip-out` в sip_additional.conf. Список принимал только
     * голое «from-trunk», поэтому КАЖДЫЙ живой входящий звонок отсеивался, и в
     * `IncomingCall` с самого запуска телефонии не попало ни одного — при том, что
     * в журнале станции они есть. Вместе с ними молча не работали панель
     * оператора, уведомление о звонке и разбор разговора.
     */
    expect(
      isInboundChannel({
        id: "c-trunk",
        name: "SIP/out-00000030",
        state: "Ring",
        caller: { number: "992880001007" },
        dialplan: { context: "from-trunk-sip-out", exten: "6501414" },
      })
    ).toBe(true);
  });

  it("наш исходящий (контекст from-internal) входящим не считается", () => {
    expect(
      isInboundChannel({
        id: "c2",
        name: "SIP/out-00000021",
        state: "Ring",
        caller: { number: "6501414" },
        dialplan: { context: "from-internal", exten: "930001001" },
      })
    ).toBe(false);
  });

  it("Local-канал очереди до оператора входящим не считается — иначе звонок посчитался бы дважды", () => {
    expect(
      isInboundChannel({
        id: "c3",
        name: "Local/1001@from-queue-0000000f;1",
        state: "Ring",
        caller: { number: "930001001" },
        dialplan: { context: "ext-queues", exten: "1000" },
      })
    ).toBe(false);
  });

  it("служебный вызов без нормального номера пропускается", () => {
    expect(isInboundChannel(inboundChannel("c4", "s"))).toBe(false);
  });

  it("девять цифр станции приводятся к виду CRM", () => {
    expect(toCrmPhone("930001001")).toBe("+992930001001");
    expect(toCrmPhone("0930001001")).toBe("+992930001001");
    expect(toCrmPhone("992930001001")).toBe("+992930001001");
  });

  it("внутренний номер оператора берётся из имени канала", () => {
    expect(extensionFromChannelName("SIP/1001-00000012")).toBe("1001");
    expect(extensionFromChannelName("PJSIP/1004-0000004f")).toBe("1004");
    // Очередь дозванивается операторам Local-каналами — раньше номер здесь не
    // находился НИКОГДА, и answeredBy оставался пустым на каждом звонке через
    // очередь (см. extensionFromChannelName).
    expect(extensionFromChannelName("Local/1001@from-queue-0000000f;1")).toBe("1001");
    expect(extensionFromChannelName("Local/1002@from-queue-00000010;2")).toBe("1002");
    // Трубка в браузере CRM: без этой ветки ответ из самой CRM оставлял журнал
    // без оператора — «кто снял» пустое, разбор ни к кому не привязан.
    expect(extensionFromChannelName("PJSIP/rh-web-1001-00000012")).toBe("1001");
    expect(extensionFromChannelName(undefined)).toBeUndefined();
    // Нецифровой exten (маршрутный Local, не оператор) — не путать с номером.
    expect(extensionFromChannelName("Local/s@macro-dial-000001;1")).toBeUndefined();
  });
});

describe("Журнал входящих", () => {
  it("клиент без агента не дозвонился — задача общая, журнал ошибок не будится", async () => {
    // «Здоровье системы» 27.09.2026: каждый такой звонок писал «задача без
    // subjectAgentId (source=incoming-call)», хотя общая задача здесь по замыслу.
    await prisma.client.update({ where: { id: clientId }, data: { assignedAgentId: null } });
    try {
      const channelId = `in-${runId}-noagent`;
      await ring(channelId, clientPhone.slice(-9));
      await hangup(channelId);

      const interaction = await prisma.interaction.findFirst({ where: { clientId, type: "CALL" } });
      expect(interaction?.nextAction).toContain("Перезвонить");
      const noisy = await waitForSettled(
        () =>
          prisma.errorLog.count({
            where: { source: "timeline", message: { contains: `clientId=${clientId}` } },
          }),
        { intervalMs: 200 }
      );
      expect(noisy).toBe(0);
    } finally {
      await prisma.client.update({ where: { id: clientId }, data: { assignedAgentId: agentId } });
    }
  });

  it("звонок известного клиента, на который ответил оператор", async () => {
    const channelId = `in-${runId}-1`;
    await ring(channelId, clientPhone.slice(-9));
    await bridge(channelId);
    await hangup(channelId);

    const record = await prisma.incomingCall.findUnique({ where: { channelId } });
    expect(record?.answered).toBe(true);
    expect(record?.clientId).toBe(clientId);
    expect(record?.answeredBy).toBe("1001");
    // Дозвонился — перезванивать некому и незачем.
    expect(record?.callbackAgentId).toBeNull();

    const interaction = await prisma.interaction.findFirst({ where: { clientId, type: "CALL" } });
    expect(interaction?.notes).toContain("Входящий звонок клиента");
    expect(interaction?.nextAction).toBeNull();
  });

  it("клиент не дождался оператора — задача перезвонить ответственному агенту", async () => {
    const channelId = `in-${runId}-2`;
    await ring(channelId, clientPhone.slice(-9));
    await hangup(channelId);

    const record = await prisma.incomingCall.findUnique({ where: { channelId } });
    expect(record?.answered).toBe(false);
    expect(record?.callbackAgentId).toBe(agentId);

    const interaction = await prisma.interaction.findFirst({ where: { clientId, type: "CALL" } });
    expect(interaction?.nextAction).toContain("Перезвонить");
    /**
     * Исход НЕ ставится, и это исправление, а не упрощение.
     *
     * Раньше здесь писался `NO_ANSWER`, и CRM читала его задом наперёд:
     * clientAutoStatus.ts считает три таких подряд и объявляет клиента
     * «Недоступным», а routes/clients.ts шлёт руководству «агент не может
     * дозвониться». Человек трижды пытался дозвониться ДО НАС — и за это помечали
     * его самого, а виноватым выставляли агента. Исход описывает работу агента,
     * а тут агент не участвовал: что клиент не дозвонился, видно из текста записи
     * и из задачи «Перезвонить».
     */
    expect(interaction?.outcome).toBeNull();
    expect(sendPushToAgent).toHaveBeenCalled();
  });

  /**
   * ОТВЕТСТВЕННЫЙ УВОЛЕН ИЛИ ЗАМОРОЖЕН — «ПЕРЕЗВОНИТЬ» И ПУШ РУКОВОДСТВУ, А НЕ
   * ЕМУ (24.09.2026, ночная проверка №221/З2-2, решение владельца). Раньше
   * `callbackAgentId` ставился на assignedAgentId независимо от того, работает
   * ли этот человек сейчас — пропущенный звонок заводил задачу и пуш
   * уволенному/замороженному агенту.
   */
  it("агент клиента заморожен — перезвонить достаётся руководителям, а не ему", async () => {
    await prisma.agent.update({ where: { id: agentId }, data: { frozenAt: new Date() } });
    try {
      const channelId = `in-${runId}-frozen-missed`;
      await ring(channelId, clientPhone.slice(-9));
      await hangup(channelId);

      const record = await prisma.incomingCall.findUnique({ where: { channelId } });
      expect(record?.answered).toBe(false);
      expect(record?.callbackAgentId).toBeNull();

      const agentPushes = sendPushToAgent.mock.calls.filter(
        (c) => (c[1] as { title?: string })?.title === "📞 Пропущенный звонок клиента"
      );
      expect(agentPushes).toHaveLength(0);

      const supervisorPushes = sendPushToAgent.mock.calls.filter(
        (c) => (c[1] as { title?: string })?.title === "📞 Пропущенный звонок"
      );
      expect(supervisorPushes).toHaveLength(1);
      expect(Array.isArray(supervisorPushes[0][0])).toBe(true);
      expect(supervisorPushes[0][0]).toContain(directorId);
      expect(supervisorPushes[0][0]).not.toContain(agentId);
      expect(String((supervisorPushes[0][1] as { body?: string })?.body)).toContain("не работает");
    } finally {
      await prisma.agent.update({ where: { id: agentId }, data: { frozenAt: null } });
    }
  });

  it("агент клиента уволен (isActive=false) — перезвонить достаётся руководителям, а не ему", async () => {
    await prisma.agent.update({ where: { id: agentId }, data: { isActive: false } });
    try {
      const channelId = `in-${runId}-fired-missed`;
      await ring(channelId, clientPhone.slice(-9));
      await hangup(channelId);

      const record = await prisma.incomingCall.findUnique({ where: { channelId } });
      expect(record?.answered).toBe(false);
      expect(record?.callbackAgentId).toBeNull();

      const agentPushes = sendPushToAgent.mock.calls.filter(
        (c) => (c[1] as { title?: string })?.title === "📞 Пропущенный звонок клиента"
      );
      expect(agentPushes).toHaveLength(0);

      const supervisorPushes = sendPushToAgent.mock.calls.filter(
        (c) => (c[1] as { title?: string })?.title === "📞 Пропущенный звонок"
      );
      expect(supervisorPushes).toHaveLength(1);
      expect(supervisorPushes[0][0]).toContain(directorId);
      expect(supervisorPushes[0][0]).not.toContain(agentId);
    } finally {
      await prisma.agent.update({ where: { id: agentId }, data: { isActive: true } });
    }
  });

  it("ответ ОЧЕРЕДИ ответом не считается: без соединения с оператором звонок пропущен", async () => {
    const channelId = `in-${runId}-3`;
    await ring(channelId, clientPhone.slice(-9));
    // Мост из одного канала — человек слушает музыку ожидания, оператора нет.
    await handleAriEvent({
      type: "ChannelEnteredBridge",
      channel: inboundChannel(channelId, clientPhone.slice(-9)),
      bridge: { id: "b-hold", channels: [channelId] },
    });
    await hangup(channelId);

    const record = await prisma.incomingCall.findUnique({ where: { channelId } });
    expect(record?.answered).toBe(false);
  });

  /**
   * О ПРОПУЩЕННОМ звонке своего клиента агент узнавал пушем, а о СОСТОЯВШЕМСЯ — никак:
   * оставалась строка в хронологии, которую надо ещё найти. Клиент говорил с
   * оператором и о чём-то договаривался, а человек, ведущий сделку, не знал об этом.
   */
  describe("Ответственный агент узнаёт, что его клиент звонил в офис", () => {
    /** Пуш именно про состоявшийся разговор, а не про пропущенный. */
    function officeCallPushes() {
      return sendPushToAgent.mock.calls.filter((c) => String((c[1] as { title?: string })?.title ?? "").includes("звонил в офис"));
    }

    it("трубку снял оператор — пуш уходит ответственному агенту", async () => {
      const channelId = `in-${runId}-answered-push`;
      await ring(channelId, clientPhone.slice(-9));
      await bridge(channelId);
      await hangup(channelId);

      const pushes = officeCallPushes();
      expect(pushes).toHaveLength(1);
      expect(pushes[0][0]).toBe(agentId);
      /**
       * РОЛЬ ПЕРЕД ИМЕНЕМ (30.08.2026, просьба владельца: «перед именем должно быть
       * написано Покупатель или Продавец, а далее его имя»). Карточка в этой
       * заготовке названа «Клиент входящих …», и общий formatClientName заменяет
       * ведущее слово-заглушку («клиент») ролью — именно поэтому в пуше стоит
       * «Покупатель входящих …», а не «Покупатель Клиент входящих …».
       */
      const body = String((pushes[0][1] as { body?: string })?.body);
      expect(body).toContain(`Покупатель входящих ${runId}`);
      expect(body).not.toContain("Покупатель Клиент");
    });

    it("трубку снял сам ответственный — уведомлять его о собственном разговоре незачем", async () => {
      const ext = `9${String(runId).slice(-3)}`;
      await prisma.agent.update({ where: { id: agentId }, data: { sipExtension: ext } });
      try {
        const channelId = `in-${runId}-self-push`;
        await ring(channelId, clientPhone.slice(-9));
        await bridge(channelId, `SIP/${ext}-00000012`);
        await hangup(channelId);

        expect(officeCallPushes()).toHaveLength(0);
      } finally {
        await prisma.agent.update({ where: { id: agentId }, data: { sipExtension: null } });
      }
    });

    /**
     * ОТВЕТСТВЕННЫЙ УВОЛЕН ИЛИ ЗАМОРОЖЕН — ПУШ О СОСТОЯВШЕМСЯ РАЗГОВОРЕ ТОЖЕ
     * РУКОВОДСТВУ, А НЕ ЕМУ (24.09.2026, ночная проверка №221/З2-2, тот же
     * класс, что у пропущенного звонка выше). До этой правки такой сценарий
     * почти не возникал: звонок клиента отключённого агента уходил в
     * автоответчик раньше, чем до оператора (см. inboundRouting.ts,
     * OPERATOR_REASONS) — но раз оператор теперь может ответить на такой
     * звонок, «Ваш клиент звонил в офис» не должно уходить тому, кто клиентов
     * больше не ведёт.
     */
    it("ответственный агент заморожен — пуш о состоявшемся разговоре уходит руководителям", async () => {
      await prisma.agent.update({ where: { id: agentId }, data: { frozenAt: new Date() } });
      try {
        const channelId = `in-${runId}-frozen-answered`;
        await ring(channelId, clientPhone.slice(-9));
        await bridge(channelId);
        await hangup(channelId);

        expect(officeCallPushes()).toHaveLength(0);

        const supervisorPushes = sendPushToAgent.mock.calls.filter(
          (c) => (c[1] as { title?: string })?.title === "📞 Клиент говорил с оператором"
        );
        expect(supervisorPushes).toHaveLength(1);
        expect(Array.isArray(supervisorPushes[0][0])).toBe(true);
        expect(supervisorPushes[0][0]).toContain(directorId);
        expect(supervisorPushes[0][0]).not.toContain(agentId);
        expect(String((supervisorPushes[0][1] as { body?: string })?.body)).toContain("не работает");
      } finally {
        await prisma.agent.update({ where: { id: agentId }, data: { frozenAt: null } });
      }
    });

    it("ответственный агент уволен (isActive=false) — пуш о состоявшемся разговоре уходит руководителям", async () => {
      await prisma.agent.update({ where: { id: agentId }, data: { isActive: false } });
      try {
        const channelId = `in-${runId}-fired-answered`;
        await ring(channelId, clientPhone.slice(-9));
        await bridge(channelId);
        await hangup(channelId);

        expect(officeCallPushes()).toHaveLength(0);

        const supervisorPushes = sendPushToAgent.mock.calls.filter(
          (c) => (c[1] as { title?: string })?.title === "📞 Клиент говорил с оператором"
        );
        expect(supervisorPushes).toHaveLength(1);
        expect(supervisorPushes[0][0]).toContain(directorId);
        expect(supervisorPushes[0][0]).not.toContain(agentId);
      } finally {
        await prisma.agent.update({ where: { id: agentId }, data: { isActive: true } });
      }
    });

    it("у клиента нет ответственного — пуша нет: дёргать некого", async () => {
      const phone = `+9928${String(runId).slice(-8)}`;
      const orphan = await prisma.client.create({
        data: { fullName: `Ничей клиент ${runId}`, phone, source: "PHONE_CALL" },
      });
      try {
        const channelId = `in-${runId}-orphan-push`;
        await ring(channelId, phone.slice(-9));
        await bridge(channelId);
        await hangup(channelId);

        expect(officeCallPushes()).toHaveLength(0);
      } finally {
        await prisma.incomingCall.deleteMany({ where: { phone } });
        await prisma.interaction.deleteMany({ where: { clientId: orphan.id } });
        await prisma.client.delete({ where: { id: orphan.id } });
      }
    });

    it("ответили на МОБИЛЬНОМ (внутреннего номера нет) — запись в хронологии всё равно заводится", async () => {
      /**
       * Новая схема приёма (18.08.2026): неизвестные звонки уводятся с 6501414 на
       * мобильный через транк. Станция в этом случае сообщает канал транка,
       * внутреннего номера в нём нет, и `Agent.sipExtension` не совпадает ни с чем —
       * у самого мобильного владельца-Agent тоже нет, это номер компании.
       *
       * Без запасного автора запись в хронологии не заводится вовсе, а вместе с ней
       * теряются запись разговора и расшифровка — то есть отваливается ВСЯ цепочка
       * «поговорили → карточка сама → лид агенту». Списка операторов в Настройках
       * больше не существует (роль удалена 18.08.2026), поэтому автором становится
       * действующий руководитель — и именно эта ступень здесь и стережётся.
       */
      const channelId = `in-${runId}-mobile-operator`;
      try {
        await ring(channelId, clientPhone.slice(-9));
        // Канал транка вместо внутреннего аппарата — ровно то, что приходит при переадресации.
        await bridge(channelId, `SIP/out-00000099`);
        await hangup(channelId);

        const record = await prisma.incomingCall.findFirst({
          where: { channelId },
          select: { interactionId: true, answered: true },
        });
        expect(record?.answered).toBe(true);
        // Главное: запись есть, значит расшифровке будет к чему привязаться.
        expect(record?.interactionId).toBeTruthy();
      } finally {
        await prisma.incomingCall.deleteMany({ where: { channelId } });
      }
    });

    it("звонок уведён на МОБИЛЬНЫЙ ведущего агента (routed_mobile) — автор записи он, а не дежурный директор", async () => {
      /**
       * Починка 17.09.2026: звонок клиента, которого маршрутизация точно увела
       * ведущему агенту на мобильный (`routeDecision: 'routed_mobile'`,
       * `routedToId`), станция не сообщает как ответ внутреннего номера —
       * `answeredBy` пуст. До фикса это читалось так же, как «оператора не
       * нашли вовсе», и автором записи в хронологии (а через неё и
       * `CallAnalysis.agentId`) становился технический fallback — самый
       * старый действующий директор — хотя маршрут прямо называл, кто на
       * самом деле говорил с клиентом. На проде так три звонка Нозы и Умеда
       * 15-17.09 были подписаны Баходуром.
       *
       * Клиент — «ничей» (без assignedAgentId), чтобы проверить именно
       * routedToId, а не соседнюю ступень fallback (client.assignedAgentId).
       */
      const phone = `+9927${String(runId).slice(-8)}`;
      const orphan = await prisma.client.create({
        data: { fullName: `Уведённый на мобильный ${runId}`, phone, source: "PHONE_CALL" },
      });
      const routedAgent = await prisma.agent.create({
        data: {
          fullName: `Уведённый агент ${runId}`,
          phone: `+99297${String(runId).slice(-7)}`,
          role: "AGENT",
          passwordHash: "x",
        },
      });
      const channelId = `in-${runId}-routed-mobile`;
      try {
        await ring(channelId, phone.slice(-9));
        /**
         * Настоящая маршрутизация (inboundRouting.ts) тоже пишет решение в эту
         * строку АСИНХРОННО (entry.routing, отдельно от entry.ready) — для
         * этого «ничьего» клиента она сама решит "disabled"/"no_agent" и, не
         * дождись мы её, переписала бы наше решение гонкой. awaitIncomingReady
         * дожидается entry.routing (только для тестов), и лишь потом
         * подменяем решение на routed_mobile, как это в проде делает
         * настоящий перевод на мобильный ведущего агента.
         */
        await awaitIncomingReady(channelId);
        await prisma.incomingCall.update({
          where: { channelId },
          data: { routeDecision: "routed_mobile", routedToId: routedAgent.id },
        });
        // Канал транка вместо внутреннего аппарата — станция не отдаёт внутренний
        // номер при переадресации на мобильный, ровно как в проде.
        await bridge(channelId, `SIP/out-00000077`);
        await hangup(channelId);

        const record = await prisma.incomingCall.findFirst({
          where: { channelId },
          select: { interactionId: true },
        });
        expect(record?.interactionId).toBeTruthy();
        const interaction = await prisma.interaction.findUnique({
          where: { id: record!.interactionId! },
          select: { agentId: true },
        });
        expect(interaction?.agentId).toBe(routedAgent.id);
        expect(interaction?.agentId).not.toBe(directorId);
      } finally {
        await prisma.incomingCall.deleteMany({ where: { channelId } });
        await prisma.interaction.deleteMany({ where: { clientId: orphan.id } });
        await prisma.client.delete({ where: { id: orphan.id } });
        await prisma.agent.delete({ where: { id: routedAgent.id } });
      }
    });
  });

  it("незнакомый номер при выключенном автосоздании: только журнал, карточки нет", async () => {
    /**
     * Прежнее поведение CRM целиком — и оно осталось доступным настройкой.
     *
     * До 10.08.2026 карточка по незнакомому номеру не заводилась НИКОГДА: курьеры,
     * реклама и ошибшиеся номером не должны засорять базу. Владелец 10.08.2026
     * попросил обратного для рабочего места оператора, и умолчание поменялось —
     * но выключатель остался, потому что прежний довод никуда не делся: агентство,
     * которому звонят десять курьеров в день, вправе вернуть старое поведение.
     */
    await prisma.settings.upsert({
      where: { id: "singleton" },
      update: { incomingAutoCreateClient: false },
      create: { id: "singleton", incomingAutoCreateClient: false },
    });
    const channelId = `in-${runId}-4`;
    await ring(channelId, "777000111");
    await hangup(channelId);

    const record = await prisma.incomingCall.findUnique({ where: { channelId } });
    expect(record?.clientId).toBeNull();
    expect(record?.answered).toBe(false);
    // Молчать про такой звонок нельзя — уходит руководству.
    expect(sendPushToAgent).toHaveBeenCalled();

    const created = await prisma.client.findFirst({ where: { phone: "+992777000111" } });
    expect(created).toBeNull();
  });

  it("повторная доставка события не заводит второй звонок", async () => {
    const channelId = `in-${runId}-5`;
    await ring(channelId, clientPhone.slice(-9));
    await ring(channelId, clientPhone.slice(-9));
    await hangup(channelId);

    const count = await prisma.incomingCall.count({ where: { channelId } });
    expect(count).toBe(1);
  });

  it("повторная доставка ПОСЛЕ того, как звонок забыт, не воскрешает звонок в памяти", async () => {
    /**
     * Завершённый звонок живёт в памяти ещё полторы минуты, а потом забывается.
     * Событие ChannelCreated, доставленное станцией повторно уже после этого,
     * проверку «звонок уже есть в памяти» не проходило: заводилась НОВАЯ живая
     * запись, запись в базу падала на уникальном channelId — и её глотали молча.
     * Оставался звонок без recordId и без конца: панель оператора показывала
     * несуществующий разговор с бегущим таймером до получаса, а разобрать его было
     * нечего и негде.
     *
     * resetIncomingCalls() здесь заменяет ожидание тех самых полутора минут: он
     * делает ровно то же — забывает живой звонок, оставляя строку в базе.
     */
    const channelId = `in-${runId}-phantom`;
    await ring(channelId, clientPhone.slice(-9));
    await hangup(channelId);
    resetIncomingCalls();

    await ring(channelId, clientPhone.slice(-9));

    expect(isTrackedIncoming(channelId)).toBe(false);
    expect(await prisma.incomingCall.count({ where: { channelId } })).toBe(1);
  });

  /**
   * №222 (ночная проверка 24.09): рестарт API посреди разговора. Память живых
   * звонков пропадает, конец звонка находит пустоту — и строка журнала
   * оставалась без endedAt навсегда: на состоявшемся разговоре висел
   * «Пропущенный входящий». Досинхронизация после рестарта снова присылает
   * начало того же канала — раньше оно падало на уникальном channelId и только
   * убирало фантом из памяти; теперь заодно закрывает открытую строку, а ответ
   * оператора, записанный в момент соединения, не даёт счесть звонок пропущенным.
   */
  it("рестарт посреди разговора: повторное начало канала закрывает строку, отвеченный — не пропущенный", async () => {
    const channelId = `in-${runId}-restart`;
    await ring(channelId, clientPhone.slice(-9));
    await bridge(channelId);
    await awaitIncomingReady(channelId);
    // Рестарт процесса: память живых звонков пуста, строка в базе открыта.
    resetIncomingCalls();
    await hangup(channelId);
    expect((await prisma.incomingCall.findUniqueOrThrow({ where: { channelId } })).endedAt).toBeNull();

    // Досинхронизация после рестарта присылает начало того же канала.
    await ring(channelId, clientPhone.slice(-9));

    expect(isTrackedIncoming(channelId)).toBe(false);
    const row = await prisma.incomingCall.findUniqueOrThrow({ where: { channelId } });
    expect(row.endedAt).not.toBeNull();
    expect(row.answered).toBe(true);
    expect(row.answeredBy).toBe("1001");
  });

  it("сирота старше двух часов, которой нет в памяти, закрывается уборкой; без ответа — пропущенный, с ответом — нет", async () => {
    const mod = await import("../src/lib/telephony/incomingCalls.js");
    expect(typeof (mod as Record<string, unknown>).closeOrphanedIncomingCalls).toBe("function");
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60_000);
    await prisma.incomingCall.createMany({
      data: [
        { channelId: `in-${runId}-orphan-a`, phone: clientPhone, startedAt: threeHoursAgo, answeredBy: "1001" },
        { channelId: `in-${runId}-orphan-m`, phone: clientPhone, startedAt: threeHoursAgo },
        // Свежая открытая строка без памяти — ещё не сирота (предел два часа).
        { channelId: `in-${runId}-orphan-fresh`, phone: clientPhone, startedAt: new Date() },
      ],
    });

    const closed = await mod.closeOrphanedIncomingCalls();

    expect(closed).toBeGreaterThanOrEqual(2);
    const byId = async (suffix: string) => prisma.incomingCall.findUniqueOrThrow({ where: { channelId: `in-${runId}-orphan-${suffix}` } });
    expect(await byId("a")).toMatchObject({ answered: true });
    expect((await byId("a")).endedAt).not.toBeNull();
    expect(await byId("m")).toMatchObject({ answered: false });
    expect((await byId("m")).endedAt).not.toBeNull();
    expect((await byId("fresh")).endedAt).toBeNull();
  });

  it("гонка: конец очень короткого звонка обгоняет запись начала — итог не теряется", async () => {
    // В проде обработчик событий не дожидается предыдущего (`void handleAriEvent(...)`
    // в ariEvents.ts), поэтому у звонка «не туда попали и сразу бросили трубку» конец
    // успевает прийти раньше, чем начало допишется в базу. Воспроизводим тем же
    // способом: обе обработки запускаются без ожидания одна другой.
    const channelId = `in-${runId}-race`;
    const startPromise = handleAriEvent({
      type: "ChannelCreated",
      channel: inboundChannel(channelId, clientPhone.slice(-9)),
    });
    const endPromise = handleAriEvent({ type: "ChannelDestroyed", channel: inboundChannel(channelId, "0") });
    await Promise.all([startPromise, endPromise]);

    const record = await prisma.incomingCall.findUnique({ where: { channelId } });
    expect(record).not.toBeNull();
    // Итог обязан быть дописан, а не потерян: звонок не должен остаться «висящим»
    // без endedAt и вечно непринятым.
    expect(record?.endedAt).not.toBeNull();
    expect(record?.clientId).toBe(clientId);
    expect(record?.callbackAgentId).toBe(agentId);
  });

  it("исходящий звонок агента в журнал входящих не попадает", async () => {
    const channelId = `out-${runId}-6`;
    trackCall({
      channelId,
      agentId,
      clientId,
      clientShortId: 1,
      clientName: "Клиент",
      dialingTo: "930001001",
    });
    await handleAriEvent({ type: "ChannelCreated", channel: inboundChannel(channelId, clientPhone.slice(-9)) });

    const record = await prisma.incomingCall.findUnique({ where: { channelId } });
    expect(record).toBeNull();
  });
});
