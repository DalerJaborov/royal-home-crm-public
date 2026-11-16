import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ВХОДЯЩИЙ ИЗВЕСТНОГО КЛИЕНТА — СРАЗУ ЕГО АГЕНТУ (решение владельца 16.08.2026,
 * отмена правила «входящие только оператору» от 08.08.2026).
 *
 * Что здесь стерегут тесты — не «работает ли перевод», а ЦЕНА ОШИБКИ. Этот код
 * стоит на единственном пути, по которому в агентство приходят живые клиенты, и у
 * него ровно два способа навредить:
 *
 *  1. увести звонок туда, где никто не возьмёт трубку (мёртвый аппарат, чужой
 *     агент, лид, который агент не принимал) — клиент слушает тишину вместо
 *     очереди, где сидит человек;
 *  2. увести звонок дважды или увести уже отвеченный — оборванный разговор.
 *
 * Поэтому проверяется в первую очередь то, чего CRM делать НЕ должна. Станция здесь
 * поддельная: сам протокол AMI проверяется отдельно (ami-client.test.ts), а тут
 * важно, какие действия и с какими полями CRM отправляет — и в каких случаях не
 * отправляет вовсе.
 */

/**
 * Что «ответит» поддельная станция на действия AMI.
 *
 * `dialplanPresent` — есть ли в `extensions_custom.conf` секция контекста;
 * `dialplanReadable` — отвечает ли станция на чтение файла вообще (нет прав, лёг
 * туннель, файла не существует). Оба «нет» обязаны означать одно: не переводим.
 */
let dialplanPresent = true;
let dialplanReadable = true;
let redirectOk = true;
const amiSent: { action: string; fields: Record<string, string | number> }[] = [];

/**
 * Ответ `GetConfig` в том виде, в каком его отдаёт станция: один пакет, ключи
 * пронумерованы — `Category-NNNNNN` для секции, `Line-NNNNNN-MMMMMM` для строки.
 * `parseAmiPacket` приводит ключи к нижнему регистру, поэтому здесь они такие же.
 */
function getConfigPacket(withRouteContext: boolean): Record<string, string> {
  const packet: Record<string, string> = {
    response: "Success",
    "category-000000": "from-internal-custom",
    "line-000000-000000": "exten => 1000,1,Queue(1000,t)",
  };
  if (withRouteContext) {
    packet["category-000001"] = "royalhome-agent-route";
    packet["line-000001-000000"] = "exten => agent,1,NoOp(RoyalHome)";
    packet["line-000001-000001"] = "same => n,Queue(1000,t)";
  }
  return packet;
}

/**
 * redirectChannelToAgent шлёт Setvar/Redirect через withAmiConnection (одна
 * AMI-сессия на всю цепочку, 06.09.2026), а проверка диалплана — по-прежнему
 * напрямую через amiAction: у них разные сигнатуры (amiAction принимает creds
 * первым аргументом, send() из withAmiConnection — нет), поэтому за ответом
 * станции стоит общая функция `respond`, а не одна и та же на оба места.
 */
function respond(action: string, fields: Record<string, string | number> = {}): unknown {
  amiSent.push({ action, fields });
  if (action === "GetConfig") {
    if (!dialplanReadable) return { ok: false, error: "Permission denied" };
    return { ok: true, packets: [getConfigPacket(dialplanPresent)] };
  }
  if (action === "Redirect" && !redirectOk) return { ok: false, error: "No such channel" };
  return { ok: true, packets: [{ response: "Success" }] };
}

vi.mock("../src/lib/telephony/amiClient.js", () => ({
  loadAmiCredentials: async () => ({ host: "127.0.0.1", port: 5038, username: "crm", password: "x" }),
  amiAction: async (_creds: unknown, action: string, fields?: Record<string, string | number>) => respond(action, fields),
  // Повтор для ЧТЕНИЙ (20.09.2026, amiClient.ts): подставному AMI повторять
  // нечего — станция здесь отвечает детерминированно, — но экспорт обязан
  // существовать, иначе dialplanContext.ts зовёт undefined и перевод срывается
  // там, где на живой станции он проходит.
  amiActionRetrying: async (_creds: unknown, action: string, fields?: Record<string, string | number>) =>
    respond(action, fields),
  withAmiConnection: async (
    _creds: unknown,
    run: (send: (action: string, fields?: Record<string, string | number>) => Promise<unknown>) => Promise<unknown>
  ) => run((action, fields) => Promise.resolve(respond(action, fields))),
}));

/**
 * У ARI подменяется ТОЛЬКО чтение доступов. Подбор цели (resolveAgentDialTarget,
 * agentDeviceOnline) остаётся настоящим: ровно им же звонит агенту кнопка
 * «Позвонить» в карточке клиента, и подменять его здесь значило бы проверять
 * подделку вместо того единственного, ради чего он переиспользуется.
 * Станция отвечает через подставной fetch (см. setEndpoints).
 */
vi.mock("../src/lib/telephony/ariClient.js", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/telephony/ariClient.js")>(
    "../src/lib/telephony/ariClient.js"
  );
  return { ...actual, loadAriCredentials: async () => ({ url: "http://pbx.test", username: "crm", password: "x" }) };
});

const { prisma } = await import("../src/db.js");
const {
  decideRoute,
  resetDialplanCache,
  routeIncomingToAssignedAgent,
  setRetryIntervalForTest,
  ROUTE_CONTEXT,
  ROUTE_EXTEN,
  WAIT_CONTEXT,
  WAIT_EXTEN,
} = await import("../src/lib/telephony/inboundRouting.js");
const { startIncomingCall, awaitIncomingReady, resetIncomingCalls } = await import(
  "../src/lib/telephony/incomingCalls.js"
);
const { trackCall, resetCalls } = await import("../src/lib/telephony/callTracker.js");

const runId = Date.now();
const ext = { first: "1901", second: "1902" };
let agentA = "";
let agentB = "";
let clientId = "";
let clientPhone = "";
const agentMobile = `+9929${String(runId).slice(-8)}`;

/** Что станция отвечает на GET /ari/endpoints. */
let endpoints: { technology: string; resource: string; state: string }[] = [];

function setEndpoints(list: { technology: string; resource: string; state: string }[]): void {
  endpoints = list;
}

beforeAll(async () => {
  vi.stubGlobal("fetch", async (url: string) => {
    if (String(url).endsWith("/ari/endpoints")) {
      return { ok: true, status: 200, json: async () => endpoints } as unknown as Response;
    }
    return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
  });

  const a = await prisma.agent.create({
    data: {
      fullName: `Агент А ${runId}`,
      phone: agentMobile,
      role: "AGENT",
      passwordHash: "x",
      sipExtension: ext.first,
    },
  });
  agentA = a.id;
  const b = await prisma.agent.create({
    data: {
      fullName: `Агент Б ${runId}`,
      phone: `+9928${String(runId).slice(-8)}`,
      role: "AGENT",
      passwordHash: "x",
      sipExtension: ext.second,
    },
  });
  agentB = b.id;

  clientPhone = `+9927${String(runId).slice(-8)}`;
  const client = await prisma.client.create({
    data: {
      fullName: `Клиент маршрутизации ${runId}`,
      phone: clientPhone,
      source: "PHONE_CALL",
      assignedAgentId: agentA,
      acceptedAt: new Date(),
    },
  });
  clientId = client.id;
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await prisma.incomingCall.deleteMany({ where: { phone: clientPhone } });
  await prisma.client.deleteMany({ where: { id: clientId } });
  await prisma.agent.deleteMany({ where: { id: { in: [agentA, agentB] } } });
  await prisma.settings.update({
    where: { id: "singleton" },
    data: { incomingRouteToAssignedAgent: false, asteriskAgentDialMode: "mobile" },
  });
  // Модуль живёт в общем процессе со всеми файлами (vitest.config.ts,
  // fileParallelism: false) — вернуть умолчание, иначе следующий файл
  // унаследует укороченный интервал повторов этого.
  setRetryIntervalForTest(null);
});

beforeEach(async () => {
  amiSent.length = 0;
  dialplanPresent = true;
  dialplanReadable = true;
  redirectOk = true;
  resetDialplanCache();
  resetIncomingCalls();
  resetCalls();
  // Реальные пять секунд на попытку умножить на до тридцати повторов ни один
  // тест ждать не обязан — интервал повторов здесь на два порядка короче.
  setRetryIntervalForTest(30);
  // Аппарат агента на связи, режим «авто» — то есть штатная обстановка рабочего дня.
  setEndpoints([{ technology: "SIP", resource: ext.first, state: "online" }]);
  await prisma.settings.update({
    where: { id: "singleton" },
    data: { incomingRouteToAssignedAgent: true, incomingRouteRingSeconds: 25, asteriskAgentDialMode: "auto" },
  });
  await prisma.client.update({
    where: { id: clientId },
    data: {
      assignedAgentId: agentA,
      acceptedAt: new Date(),
      deletedAt: null,
      status: "NEW",
      workStatus: "ACTIVE",
    },
  });
});

afterEach(async () => {
  await prisma.incomingCall.deleteMany({ where: { phone: clientPhone } });
});

/** Строка журнала входящих — её заводит настоящий путь звонка до перевода. */
async function seedCall(channelId: string): Promise<string> {
  const record = await prisma.incomingCall.create({
    data: { channelId, phone: clientPhone, clientId, startedAt: new Date() },
  });
  return record.id;
}

async function route(
  channelId: string,
  options: { answered?: boolean; clientId?: string | null } = {}
): Promise<{ decision: string | null; routedToId: string | null }> {
  const recordId = await seedCall(channelId);
  await routeIncomingToAssignedAgent({
    channelId,
    channelName: `SIP/out-${channelId}`,
    phone: clientPhone,
    clientId: options.clientId === null ? undefined : (options.clientId ?? clientId),
    recordId,
    isAnswered: () => !!options.answered,
  });
  const row = await prisma.incomingCall.findUnique({
    where: { id: recordId },
    select: { routeDecision: true, routedToId: true },
  });
  return { decision: row?.routeDecision ?? null, routedToId: row?.routedToId ?? null };
}

const redirects = (): { action: string; fields: Record<string, string | number> }[] =>
  amiSent.filter((a) => a.action === "Redirect");

const varSent = (name: string): string | undefined => {
  const packet = amiSent.filter((a) => a.action === "Setvar").find((a) => a.fields.Variable === name);
  return packet ? String(packet.fields.Value) : undefined;
};

/** Заготовка карточки для чистой функции решения. */
function candidateClient(over: Partial<Parameters<typeof decideRoute>[0]["client"] & object> = {}) {
  return {
    deletedAt: null,
    status: "NEW",
    workStatus: "ACTIVE",
    acceptedAt: new Date(),
    assignedAgent: { id: agentA, isActive: true, sipExtension: ext.first, phone: agentMobile },
    ...over,
  };
}

describe("решение о переводе — чистая функция", () => {
  const base = {
    enabled: true,
    matchCount: 1,
    dial: { target: ext.first, viaMobile: false },
    busy: false,
    answered: false,
  };

  it("переводит клиента с принятым ответственным", () => {
    expect(decideRoute({ ...base, client: candidateClient() })).toMatchObject({
      routed: true,
      extension: ext.first,
    });
  });

  it.each([
    ["выключено настройкой", { ...base, enabled: false, client: candidateClient() }, "disabled"],
    ["оператор уже снял трубку", { ...base, answered: true, client: candidateClient() }, "already_answered"],
    ["номера нет в базе", { ...base, matchCount: 0, client: null }, "no_client"],
    ["несколько карточек с этим номером", { ...base, matchCount: 2, client: candidateClient() }, "ambiguous_phone"],
    ["карточка в Корзине", { ...base, client: candidateClient({ deletedAt: new Date() }) }, "client_deleted"],
    ["нет ответственного", { ...base, client: candidateClient({ assignedAgent: null }) }, "no_agent"],
    ["лид не принят агентом", { ...base, client: candidateClient({ acceptedAt: null }) }, "lead_not_accepted"],
    ["сделка закрыта", { ...base, client: candidateClient({ status: "DEAL_CLOSED" }) }, "client_closed"],
    ["клиент потерян", { ...base, client: candidateClient({ status: "LOST" }) }, "client_closed"],
    [
      "ответственный отключён",
      { ...base, client: candidateClient({ assignedAgent: { id: agentA, isActive: false, sipExtension: ext.first, phone: null } }) },
      "agent_inactive",
    ],
    [
      "у ответственного нет внутреннего номера",
      { ...base, client: candidateClient({ assignedAgent: { id: agentA, isActive: true, sipExtension: null, phone: null } }) },
      "no_extension",
    ],
    ["звонить некуда", { ...base, dial: null, client: candidateClient() }, "agent_offline"],
    ["ответственный уже разговаривает", { ...base, busy: true, client: candidateClient() }, "agent_busy"],
  ])("не переводит: %s", (_name, candidate, reason) => {
    expect(decideRoute(candidate as Parameters<typeof decideRoute>[0])).toEqual({ routed: false, reason });
  });

  it("остывший и недоступный клиент переводится: его собственный звонок — самый ценный", () => {
    expect(decideRoute({ ...base, client: candidateClient({ status: "UNRESPONSIVE" }) })).toMatchObject({
      routed: true,
    });
    expect(decideRoute({ ...base, client: candidateClient({ status: "COLD" }) })).toMatchObject({ routed: true });
  });

  it("неактивный клиент (слот освобождён) переводится своему агенту — его звонок и есть возврат", () => {
    expect(decideRoute({ ...base, client: candidateClient({ workStatus: "INACTIVE" }) })).toMatchObject({
      routed: true,
    });
  });
});

describe("перевод входящего на ответственного", () => {
  it("выключенная настройка не трогает станцию вовсе", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { incomingRouteToAssignedAgent: false } });
    const result = await route(`ch-off-${runId}`);
    expect(result.decision).toBe("disabled");
    expect(amiSent).toEqual([]);
  });

  // Приём переведён на прямой аппарат (владелец 21.08.2026). До 29.08.2026 перевод
  // в этом режиме не запускался вовсе: запасной путь диалплана заканчивался общей
  // очередью операторов, а их из приёма как раз сняли. Починено со стороны станции
  // (запасной путь royalhome-agent-route берёт тот же AstDB-таргет, что и обычный
  // приём в этом режиме) — CRM теперь переводит звонок агенту как обычно.
  it("переводит агенту и тогда, когда приём переведён на прямой аппарат", async () => {
    await prisma.settings.update({
      where: { id: "singleton" },
      data: { incomingPrimaryTarget: "extension", incomingPrimaryExtension: "1021" },
    });
    try {
      const result = await route(`ch-direct-${runId}`);
      expect(result).toEqual({ decision: "routed", routedToId: agentA });
      expect(redirects()).toHaveLength(1);
    } finally {
      await prisma.settings.update({
        where: { id: "singleton" },
        data: { incomingPrimaryTarget: "queue", incomingPrimaryExtension: null },
      });
    }
  });

  it("звонок клиента с принятым ответственным уходит на его трубку", async () => {
    const result = await route(`ch-ok-${runId}`);
    expect(result).toEqual({ decision: "routed", routedToId: agentA });
    expect(redirects()).toHaveLength(1);
    expect(redirects()[0].fields).toMatchObject({ Context: ROUTE_CONTEXT, Exten: ROUTE_EXTEN, Priority: 1 });
    expect(varSent("RH_ROUTE_TARGET")).toBe(ext.first);
    expect(varSent("RH_ROUTE_MOBILE")).toBe("0");
    expect(varSent("RH_ROUTE_TIMEOUT")).toBe("25");
    /**
     * Решение владельца 04.09.2026 (отменяет "voicemail" от 29.08.2026): не
     * ответил агент за routeRingSeconds — просто отбой, без автоответчика и
     * без очереди операторов. Своему клиенту чужой оператор не нужен.
     */
    // 22.09.2026: отбой сменён на голосовую почту (+ «перезвонить» агенту).
    expect(varSent("RH_ROUTE_FALLBACK")).toBe("voicemail");
  });

  it("0 в настройке — станции уходит буквальная строка \"0\" (без ограничения, владелец 20.08.2026)", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { incomingRouteRingSeconds: 0 } });
    const result = await route(`ch-unlimited-${runId}`);
    expect(result).toEqual({ decision: "routed", routedToId: agentA });
    expect(varSent("RH_ROUTE_TIMEOUT")).toBe("0");
  });

  it("после передачи клиента звонит НОВЫЙ агент, а не прежний", async () => {
    setEndpoints([
      { technology: "SIP", resource: ext.first, state: "online" },
      { technology: "SIP", resource: ext.second, state: "online" },
    ]);
    await prisma.client.update({ where: { id: clientId }, data: { assignedAgentId: agentB } });

    const result = await route(`ch-transfer-${runId}`);
    expect(result).toEqual({ decision: "routed", routedToId: agentB });
    expect(varSent("RH_ROUTE_TARGET")).toBe(ext.second);
    expect(varSent("RH_ROUTE_TARGET")).not.toBe(ext.first);
  });

  it("нет ответственного — звонок остаётся в очереди", async () => {
    await prisma.client.update({ where: { id: clientId }, data: { assignedAgentId: null } });
    const result = await route(`ch-noagent-${runId}`);
    expect(result).toEqual({ decision: "no_agent", routedToId: null });
    expect(redirects()).toEqual([]);
  });

  it("лид агенту предложен, но не принят — звонок остаётся в очереди", async () => {
    await prisma.client.update({ where: { id: clientId }, data: { acceptedAt: null } });
    const result = await route(`ch-unaccepted-${runId}`);
    expect(result.decision).toBe("lead_not_accepted");
    expect(redirects()).toEqual([]);
  });

  it("карточка в Корзине — звонок остаётся в очереди", async () => {
    await prisma.client.update({ where: { id: clientId }, data: { deletedAt: new Date() } });
    const result = await route(`ch-deleted-${runId}`);
    expect(result.decision).toBe("client_deleted");
    expect(redirects()).toEqual([]);
  });

  it("незнакомый номер — звонок остаётся в очереди", async () => {
    const result = await route(`ch-unknown-${runId}`, { clientId: null });
    expect(result.decision).toBe("no_client");
    expect(redirects()).toEqual([]);
  });

  /**
   * Ночь, браузер закрыт, Zoiper не запущен. Это самый частый случай ночного
   * звонка, и именно здесь перевод обязан не превратиться в 25 секунд тишины.
   */
  it("трубки нет на связи — звоним агенту на мобильный, как из карточки клиента", async () => {
    setEndpoints([{ technology: "SIP", resource: ext.first, state: "offline" }]);
    const result = await route(`ch-mobile-${runId}`);
    expect(result).toEqual({ decision: "routed_mobile", routedToId: agentA });
    expect(varSent("RH_ROUTE_MOBILE")).toBe("1");
    // Местные девять цифр — в этом виде транк агентства и набирает.
    expect(varSent("RH_ROUTE_TARGET")).toBe(agentMobile.replace("+992", ""));
  });

  /**
   * "agent_offline" может пройти само (аппарат вернётся на связь), поэтому
   * это retryable-причина (04.09.2026): CRM не сдаётся сразу и не отдаёт
   * звонок в общую очередь — паркует его в WAIT_CONTEXT и ждёт до конца
   * incomingRouteRingSeconds (здесь — 1 с, чтобы тест не ждал реальные 25).
   * Аппарат за это время не ожил ни разу — звонок так и не переведён, но НИ
   * РАЗУ не ушёл в royalhome-agent-route/очередь: то, ради чего тест написан.
   */
  it("режим «только внутренний» и мёртвый аппарат — паркуем и ждём, а не в очередь", async () => {
    await prisma.settings.update({
      where: { id: "singleton" },
      data: { asteriskAgentDialMode: "extension", incomingRouteRingSeconds: 1 },
    });
    setEndpoints([{ technology: "SIP", resource: ext.first, state: "offline" }]);
    const result = await route(`ch-deadext-${runId}`);
    expect(result.decision).toBe("agent_offline");
    expect(redirects().some((r) => r.fields.Context === ROUTE_CONTEXT)).toBe(false);
    expect(redirects().some((r) => r.fields.Context === WAIT_CONTEXT && r.fields.Exten === WAIT_EXTEN)).toBe(true);
  });

  it("на станции нет контекста запасного пути — не переводим ничего", async () => {
    dialplanPresent = false;
    const result = await route(`ch-nodialplan-${runId}`);
    expect(result.decision).toBe("no_dialplan");
    expect(redirects()).toEqual([]);
    // Спрашивали именно чтением файла диалплана: `ShowDialPlan` этому пользователю
    // AMI станция не даёт, и проверка на нём не подтвердилась бы никогда.
    expect(amiSent.filter((a) => a.action === "GetConfig")).toHaveLength(1);
    expect(amiSent.find((a) => a.action === "GetConfig")?.fields).toMatchObject({
      Filename: "extensions_custom.conf",
    });
  });

  /**
   * Прав на чтение файла нет, туннель лёг, станция молчит — ответа нет вовсе.
   *
   * ПЕРЕПИСАНО 20.09.2026. Раньше «не знаю» приравнивалось к «контекста нет»:
   * решение `no_dialplan`, перевода нет, и — главное — этот ответ запоминался
   * на минуту, из-за чего КАЖДЫЙ следующий звонок в эту минуту тоже не уходил
   * своему агенту. На живых звонках это дало четыре `no_dialplan` из десяти при
   * полностью исправной станции: контекст на ней был, а чтение конфигурации
   * занимает 161 мс при таймауте в 5 секунд.
   *
   * Теперь неответ станции — отдельный случай `dialplan_unknown`: он не
   * кэшируется и входит в RETRYABLE_REASONS, то есть звонок ждёт в зале ожидания
   * и пробует снова, пока не кончится routeRingSeconds. Перевода по-прежнему нет
   * (контекст мог и правда отсутствовать), но одна заминка связи больше не
   * решает судьбу следующей минуты звонков.
   */
  it("станция не дала прочитать файл диалплана — ждём и пробуем снова, но не переводим", async () => {
    // 1 секунда вместо 25, чтобы тест не ждал весь зал ожидания вживую.
    await prisma.settings.update({ where: { id: "singleton" }, data: { incomingRouteRingSeconds: 1 } });
    dialplanReadable = false;
    const result = await route(`ch-noconfig-${runId}`);
    expect(result.decision).toBe("dialplan_unknown");
    // В зал ожидания канал уводится (это Redirect в WAIT_CONTEXT), а вот
    // перевода на самого агента не происходит.
    expect(redirects().some((r) => r.fields.Context === ROUTE_CONTEXT)).toBe(false);
    await prisma.settings.update({ where: { id: "singleton" }, data: { incomingRouteRingSeconds: 25 } });
  });

  it("оператор снял трубку раньше — перевода нет", async () => {
    const result = await route(`ch-answered-${runId}`, { answered: true });
    expect(result.decision).toBe("already_answered");
    expect(redirects()).toEqual([]);
  });

  /**
   * "redirect_failed" — тоже retryable (04.09.2026), но здесь сама станция
   * не принимает Redirect ВООБЩЕ (та же неисправность, что и в первой
   * попытке) — попытка запарковать канал в зал ожидания оказывается второй
   * неудачной командой Redirect подряд, и цикл ожидания на этом и
   * заканчивается: ждать смысла нет, если станция саму команду перевода не
   * исполняет. Звонок при этом по-прежнему НЕ уходит в общую очередь.
   */
  it("станция отказала в переводе — не переведён, парковка тоже не удалась (та же неисправность)", async () => {
    redirectOk = false;
    const result = await route(`ch-refused-${runId}`);
    expect(result).toEqual({ decision: "redirect_failed", routedToId: null });
    // Один Redirect — сам перевод, второй — попытка запарковать в ожидание;
    // оба отказали одной и той же неисправностью станции.
    expect(redirects()).toHaveLength(2);
  });

  /**
   * 06.09.2026: до этой правки отказ парковки (строка выше) проглатывался молча —
   * ни строки в ErrorLog, ни следа вообще. Разбор двух реальных двойных звонков
   * (05.09 и 02.09) показал, что это именно так и терялось: вторая попытка
   * маршрутизации проваливалась незаметно для директора.
   */
  it("отказ парковки в зал ожидания оставляет след в ErrorLog, а не тонет молча", async () => {
    redirectOk = false;
    await route(`ch-refused-logged-${runId}`);
    const entry = await prisma.errorLog.findFirst({
      where: { source: "telephony", message: { contains: "Парковка в зал ожидания сорвалась" } },
      orderBy: { createdAt: "desc" },
    });
    expect(entry).not.toBeNull();
    expect(entry?.message).toContain("No such channel");
  });

  it("повторная доставка события не переводит звонок второй раз", async () => {
    const channelId = `ch-twice-${runId}`;
    const recordId = await seedCall(channelId);
    const request = {
      channelId,
      channelName: `SIP/out-${channelId}`,
      phone: clientPhone,
      clientId,
      recordId,
      isAnswered: () => false,
    };
    await routeIncomingToAssignedAgent(request);
    await routeIncomingToAssignedAgent(request);
    expect(redirects()).toHaveLength(1);
  });
});

/**
 * ЗАЛ ОЖИДАНИЯ СВОЕГО АГЕНТА (владелец 04.09.2026): «клиент должен попасть
 * только к своему агенту и ждать, сколько надо, пока агент не освободится» —
 * а не падать в общий приём из-за того, что агент СЕЙЧАС занят другим
 * разговором. См. заголовок waitAndRetry в inboundRouting.ts.
 */
describe("ожидание освободившегося агента", () => {
  it("агент был занят — освободился до конца ожидания, перевод довели до конца", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { incomingRouteRingSeconds: 2 } });
    trackCall({
      channelId: `agent-busy-${runId}`,
      agentId: agentA,
      clientId,
      clientShortId: 1,
      clientName: "Другой клиент",
      dialingTo: agentMobile,
    });

    const donePromise = route(`ch-wait-freed-${runId}`);
    // Агент «вешает трубку» текущего разговора чуть позже первой попытки —
    // ровно тот случай, ради которого всё и написано: секунда терпения вместо
    // немедленной сдачи в общую очередь.
    //
    // Запас 200мс вместо прежних 60мс (найдено 13.09.2026, разбор связанности
    // тестов): при интервале повторов 30мс запас был меньше двух тиков, и под
    // нагрузкой соседних файлов в общем процессе (vitest.config.ts,
    // fileParallelism: false — все тесты в одном Node-процессе, событийный цикл
    // общий) агент успевал освободиться раньше, чем событие первой попытки
    // вообще фиксировалось — WAIT_CONTEXT не записывался, тест падал только в
    // связке, никогда поодиночке. 200мс — это 6+ тиков интервала, запас на
    // случайную задержку цикла, а не только на идеальные условия.
    setTimeout(() => resetCalls(), 200);

    const result = await donePromise;
    expect(result).toEqual({ decision: "routed", routedToId: agentA });
    // Хотя бы одна парковка в зал ожидания — первая попытка не могла пройти,
    // пока агент был занят.
    expect(redirects().some((r) => r.fields.Context === WAIT_CONTEXT)).toBe(true);
    expect(redirects().some((r) => r.fields.Context === ROUTE_CONTEXT && r.fields.Exten === ROUTE_EXTEN)).toBe(true);
  });

  it("ноль секунд ожидания — это «без ограничения», а не «не ждать вовсе»", async () => {
    /**
     * Разбор 20.09.2026 (жалоба владельца «входящие агенту не доходят»). Ноль в
     * «сколько ждать» владелец выбрал 20.08.2026 в значении «пока клиент сам не
     * положит трубку», а код считал его концом ожидания: канал парковали музыкой
     * и не пробовали перевод НИ РАЗУ. На проде это выглядело так: клиент ждал
     * 33 секунды, пока агент договорит, и клал трубку, хотя агент освободилась.
     */
    await prisma.settings.update({ where: { id: "singleton" }, data: { incomingRouteRingSeconds: 0 } });
    trackCall({
      channelId: `agent-busy-zero-${runId}`,
      agentId: agentA,
      clientId,
      clientShortId: 1,
      clientName: "Другой клиент",
      dialingTo: agentMobile,
    });

    const donePromise = route(`ch-wait-zero-${runId}`);
    // Тот же запас 200мс, что и у соседнего теста, и по той же причине.
    setTimeout(() => resetCalls(), 200);

    const result = await donePromise;
    expect(result).toEqual({ decision: "routed", routedToId: agentA });
    expect(redirects().some((r) => r.fields.Context === WAIT_CONTEXT)).toBe(true);
  });

  it("агент так и не освободился — время ожидания истекает, в очередь звонок не уходит", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { incomingRouteRingSeconds: 1 } });
    trackCall({
      channelId: `agent-stuck-${runId}`,
      agentId: agentA,
      clientId,
      clientShortId: 1,
      clientName: "Другой клиент",
      dialingTo: agentMobile,
    });

    const result = await route(`ch-wait-timeout-${runId}`);
    expect(result.decision).toBe("agent_busy");
    expect(redirects()).toEqual([{ action: "Redirect", fields: expect.objectContaining({ Context: WAIT_CONTEXT }) }]);
  });

  it("клиент положил трубку во время ожидания — повтор прекращается, а не переводит уже брошенный звонок", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { incomingRouteRingSeconds: 2 } });
    trackCall({
      channelId: `agent-busy-hangup-${runId}`,
      agentId: agentA,
      clientId,
      clientShortId: 1,
      clientName: "Другой клиент",
      dialingTo: agentMobile,
    });
    let answered = false;
    setTimeout(() => {
      answered = true;
    }, 60);

    const channelId = `ch-wait-hangup-${runId}`;
    const recordId = await seedCall(channelId);
    const result = await routeIncomingToAssignedAgent({
      channelId,
      channelName: `SIP/out-${channelId}`,
      phone: clientPhone,
      clientId,
      recordId,
      isAnswered: () => answered,
    });
    expect(result.reason).toBe("already_answered");
    expect(redirects().some((r) => r.fields.Context === ROUTE_CONTEXT)).toBe(false);
  });
});

/**
 * СВОЙ КЛИЕНТ ОПЕРАТОРУ НИКОГДА (владелец 22.09.2026). За четыре дня 37 звонков
 * клиентов агентов ушли в очередь оператора через releaseChannelToOperator.
 */
describe("свой клиент мимо оператора", () => {
  const verdict = (): string | undefined => varSent("RH_CRM_VERDICT");

  async function live(channelId: string): Promise<void> {
    await startIncomingCall({
      id: channelId,
      name: `SIP/out-${channelId}`,
      caller: { number: clientPhone.replace("+992", "") },
      dialplan: { context: "ext-queues", exten: "1000" },
    } as never);
    await awaitIncomingReady(channelId);
  }

  it("лид не принят — звонок на мобильный назначенного агента, дальше автоответчик, не очередь", async () => {
    await prisma.client.update({ where: { id: clientId }, data: { acceptedAt: null } });
    await live(`ch-hold-unacc-${runId}`);
    expect(verdict()).toBeUndefined();
    expect(redirects().at(-1)?.fields.Context).toBe(ROUTE_CONTEXT);
    expect(varSent("RH_ROUTE_TARGET")).toBe(agentMobile.replace("+992", ""));
    expect(varSent("RH_ROUTE_MOBILE")).toBe("1");
    expect(varSent("RH_ROUTE_FALLBACK")).toBe("voicemail");
  });

  it("станция отказала в переводе — вердикт known_client, а не «звонок не наш»", async () => {
    redirectOk = false;
    await prisma.settings.update({ where: { id: "singleton" }, data: { incomingRouteRingSeconds: 1 } });
    await live(`ch-hold-fail-${runId}`);
    expect(verdict()).toBe("known_client");
  });

  it("на станции нет контекста — вердикт known_client, перевода нет", async () => {
    dialplanPresent = false;
    await live(`ch-hold-nodp-${runId}`);
    expect(redirects()).toEqual([]);
    expect(verdict()).toBe("known_client");
  });

  /**
   * ЗАМОРОЖЕННЫЙ/УВОЛЕННЫЙ АГЕНТ — ОПЕРАТОРУ, КАК НЕЗНАКОМЫЙ НОМЕР (владелец
   * 24.09.2026, ночная проверка №221/З2-2). До этой правки такой звонок шёл
   * ЭТИМ ЖЕ путём «свой клиент мимо оператора» — на пустой мобильный (агент
   * заморожен/уволен, звонить некуда) и сразу в автоответчик, минуя оператора
   * целиком. Владелец решил: у такого клиента СЕЙЧАС нет работающего
   * ответственного — ровно как у клиента без агента вовсе (тест ниже), и
   * звонок обязан попасть оператору, а не автоответчику.
   */
  it("замороженный агент — оператору, а не в автоответчик", async () => {
    await prisma.agent.update({ where: { id: agentA }, data: { frozenAt: new Date() } });
    try {
      await live(`ch-hold-frozen-${runId}`);
      expect(redirects()).toEqual([]);
      expect(verdict()).toBe("agent_frozen");
    } finally {
      await prisma.agent.update({ where: { id: agentA }, data: { frozenAt: null } });
    }
  });

  it("уволенный агент (isActive=false) — оператору, а не в автоответчик", async () => {
    await prisma.agent.update({ where: { id: agentA }, data: { isActive: false } });
    try {
      await live(`ch-hold-fired-${runId}`);
      expect(redirects()).toEqual([]);
      expect(verdict()).toBe("agent_inactive");
    } finally {
      await prisma.agent.update({ where: { id: agentA }, data: { isActive: true } });
    }
  });

  it("нет ответственного — прежний путь: вердикт оператору", async () => {
    await prisma.client.update({ where: { id: clientId }, data: { assignedAgentId: null } });
    await live(`ch-hold-noagent-${runId}`);
    expect(redirects()).toEqual([]);
    expect(verdict()).toBe("no_agent");
  });
});

describe("живой путь звонка", () => {
  it("событие станции доводит звонок до перевода — с именем канала для AMI", async () => {
    const channelId = `ch-live-${runId}`;
    await startIncomingCall({
      id: channelId,
      name: "SIP/out-00000042",
      caller: { number: clientPhone.replace("+992", "") },
      dialplan: { context: "ext-queues", exten: "1000" },
    } as never);
    await awaitIncomingReady(channelId);

    expect(redirects()).toHaveLength(1);
    expect(redirects()[0].fields.Channel).toBe("SIP/out-00000042");
    const row = await prisma.incomingCall.findUnique({
      where: { channelId },
      select: { routeDecision: true, routedToId: true },
    });
    expect(row).toMatchObject({ routeDecision: "routed", routedToId: agentA });
  });
});

/**
 * КЛИЕНТ АГЕНТА РОБОТУ НЕ ДОСТАЁТСЯ (владелец 11.10.2026: «робот НЕ отвечает
 * клиентам агента — даже если агент не отвечает, он сам перезвонит»). С 02.10 по
 * 11.10 при включённом консультанте агенту своего клиента звонили не дольше
 * ожидания консультанта (knownClientRingSeconds), чтобы звонок успел дойти до
 * робота. Теперь режим консультанта на перевод своего клиента не влияет вовсе:
 * полное routeRingSeconds и запасной путь "voicemail" (диалплан в нём робота не
 * зовёт — tests/dialplan-custom-text.test.ts).
 */
describe("свой агент и консультант на телефоне", () => {
  const rtpHostBefore = process.env.LIVE_VOICE_RTP_HOST;
  const rtpPortBefore = process.env.LIVE_VOICE_RTP_PORT;

  beforeAll(() => {
    process.env.LIVE_VOICE_RTP_HOST = "10.9.0.1";
    // Станция зовёт консультанта только при заданной ПАРЕ хост+порт (configuredRtpHost).
    process.env.LIVE_VOICE_RTP_PORT = "40800";
  });

  afterEach(async () => {
    await prisma.settings.update({
      where: { id: "singleton" },
      data: { liveVoiceEnabled: false, liveVoiceInboundMode: "off", liveVoiceInboundWaitSeconds: 30 },
    });
  });

  afterAll(() => {
    if (rtpHostBefore === undefined) delete process.env.LIVE_VOICE_RTP_HOST;
    else process.env.LIVE_VOICE_RTP_HOST = rtpHostBefore;
    if (rtpPortBefore === undefined) delete process.env.LIVE_VOICE_RTP_PORT;
    else process.env.LIVE_VOICE_RTP_PORT = rtpPortBefore;
  });

  it("консультант выключен (режим off) — агенту звонят routeRingSeconds, как раньше", async () => {
    await prisma.settings.update({
      where: { id: "singleton" },
      data: { incomingRouteRingSeconds: 150, liveVoiceEnabled: true, liveVoiceInboundMode: "off", liveVoiceInboundWaitSeconds: 20 },
    });
    const result = await route(`ch-ai-off-${runId}`);
    expect(result).toEqual({ decision: "routed", routedToId: agentA });
    expect(varSent("RH_ROUTE_TIMEOUT")).toBe("150");
  });

  it("консультант берёт входящие — агенту своего клиента всё равно полное время, дальше голосовая почта", async () => {
    for (const mode of ["no_answer", "always"] as const) {
      amiSent.length = 0;
      await prisma.settings.update({
        where: { id: "singleton" },
        data: { incomingRouteRingSeconds: 150, liveVoiceEnabled: true, liveVoiceInboundMode: mode, liveVoiceInboundWaitSeconds: 20 },
      });
      const result = await route(`ch-ai-on-${mode}-${runId}`);
      expect(result).toEqual({ decision: "routed", routedToId: agentA });
      expect(varSent("RH_ROUTE_TIMEOUT")).toBe("150");
      // Не взял — голосовая почта (робот в этой ветке диалплана не подключается); оператору никогда.
      expect(varSent("RH_ROUTE_FALLBACK")).toBe("voicemail");
    }
  });

  it("запасной путь мимо оператора (лид не принят) — мобильный агента тоже полное время и голосовая почта", async () => {
    await prisma.settings.update({
      where: { id: "singleton" },
      data: { incomingRouteRingSeconds: 150, liveVoiceEnabled: true, liveVoiceInboundMode: "always", liveVoiceInboundWaitSeconds: 25 },
    });
    await prisma.client.update({ where: { id: clientId }, data: { acceptedAt: null } });
    const channelId = `ch-ai-hold-${runId}`;
    await startIncomingCall({
      id: channelId,
      name: `SIP/out-${channelId}`,
      caller: { number: clientPhone.replace("+992", "") },
      dialplan: { context: "ext-queues", exten: "1000" },
    } as never);
    await awaitIncomingReady(channelId);
    expect(redirects().at(-1)?.fields.Context).toBe(ROUTE_CONTEXT);
    expect(varSent("RH_ROUTE_MOBILE")).toBe("1");
    expect(varSent("RH_ROUTE_TIMEOUT")).toBe("150");
    expect(varSent("RH_ROUTE_FALLBACK")).toBe("voicemail");
  });
});
