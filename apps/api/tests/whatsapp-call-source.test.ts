import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * ЗВОНКИ ИЗ WHATSAPP НА СТАНЦИИ (18.11.2026).
 *
 * Шлюз SIP заводит голосовой звонок WhatsApp на станцию аппаратом `whatsapp-gw`:
 * канал `PJSIP/whatsapp-gw-…`, контекст `from-trunk-whatsapp`, номер уже приведён
 * станцией к девяти цифрам (+992) или оставлен с «+» (иностранный). CRM обязана:
 *  - принять такой канал во входящие (префикс `from-trunk`);
 *  - записать звонок с правильным номером и `source = "whatsapp"`;
 *  - обычный звонок с линии оставить `phone`;
 *  - в хронологии написать «из WhatsApp», НЕ ломая начало «Входящий звонок…», по
 *    которому noContact.ts и callRecordings.ts узнают входящий;
 *  - карточку незнакомого звонившего завести с источником WHATSAPP.
 */

const sendPushToAgent = vi.fn(async () => 1);
vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent,
  sendPushToAgents: sendPushToAgent,
}));

/**
 * Бренд номера — из строки канала (accounts.ts::whatsappLineBrand). Строку WHATSAPP в
 * общей базе тестов не заводим: соседние файлы, идущие параллельно, считают «нет
 * строк канала — работаем на Настройках». Правило выбора имени проверяется чистой
 * функцией whatsappLineBrandFrom ниже, а здесь — только что звонок его спрашивает.
 */
vi.mock("../src/messengers/accounts.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/messengers/accounts.js")>();
  return {
    ...real,
    whatsappLineBrand: vi.fn(async (id: string | null | undefined) => (id && id === process.env.TEST_WA_LINE_ID ? "Арван" : null)),
  };
});

const { prisma } = await import("../src/db.js");
const { waitFor } = await import("./helpers/waitFor.js");
const { handleAriEvent } = await import("../src/lib/telephony/ariEvents.js");
const { classifyInboundChannel, isInboundContext, resetIncomingCalls, toCrmPhone } = await import(
  "../src/lib/telephony/incomingCalls.js"
);
const { resetCalls } = await import("../src/lib/telephony/callTracker.js");
const {
  WHATSAPP_GATEWAY_CHANNEL_PREFIX,
  clientSourceForCall,
  inboundCallNotePrefix,
  incomingCallSourceFromChannel,
  whatsappLineFromChannel,
} = await import("../src/lib/telephony/callSource.js");
const { whatsappLineBrandFrom } = await import("../src/messengers/accounts.js");
const { INCOMING_CALL_NOTE_PREFIX } = await import("../src/lib/noContact.js");

const runId = Date.now();
let seq = 0;
/** Уникальный мобильный номер станции: 9 цифр (как после нормализации `from-trunk-whatsapp`). */
const mobile = () => `9${String(runId + ++seq * 7919).slice(-8)}`;
const channelIds: string[] = [];
const phones: string[] = [];

function waChannel(id: string, number: string, exten = "6501414") {
  channelIds.push(id);
  return {
    id,
    name: `${WHATSAPP_GATEWAY_CHANNEL_PREFIX}${String(++seq).padStart(8, "0")}`,
    state: "Ring",
    caller: { number, name: "WhatsApp" },
    dialplan: { context: "from-trunk-whatsapp", exten },
  };
}
/** Второй номер WhatsApp (26.11.2026): шлюз набирает станцию его phone_number_id. Уникален на прогон. */
const LINE_ID = `9${String(runId).padStart(15, "0").slice(-15)}`;
process.env.TEST_WA_LINE_ID = LINE_ID;
function lineChannel(id: string, number: string) {
  channelIds.push(id);
  return {
    id,
    name: `SIP/out-${String(++seq).padStart(8, "0")}`,
    state: "Ring",
    caller: { number },
    dialplan: { context: "from-trunk-sip-out", exten: "6501414" },
  };
}

let saved: { incomingAutoCreateClient: boolean; missedCallSmsEnabled: boolean; missedCallCallbackTaskEnabled: boolean } | null = null;

beforeAll(async () => {
  const row = await prisma.settings.upsert({ where: { id: "singleton" }, update: {}, create: { id: "singleton" } });
  saved = {
    incomingAutoCreateClient: row.incomingAutoCreateClient,
    missedCallSmsEnabled: row.missedCallSmsEnabled,
    missedCallCallbackTaskEnabled: row.missedCallCallbackTaskEnabled,
  };
  // СМС здесь не проверяется (см. missed-call-followup.test.ts) — выключена, чтобы не уходить в провайдера.
  // Задача по незнакомому пропущенному включена: она и заводит карточку на неотвеченном звонке.
  await prisma.settings.update({
    where: { id: "singleton" },
    data: { incomingAutoCreateClient: true, missedCallSmsEnabled: false, missedCallCallbackTaskEnabled: true },
  });
});

afterEach(() => {
  resetIncomingCalls();
  resetCalls();
});

afterAll(async () => {
  if (saved) await prisma.settings.update({ where: { id: "singleton" }, data: saved });
  const calls = await prisma.incomingCall.findMany({ where: { channelId: { in: channelIds } }, select: { clientId: true } });
  const clientIds = [
    ...new Set([
      ...calls.flatMap((c) => (c.clientId ? [c.clientId] : [])),
      ...(await prisma.client.findMany({ where: { phone: { in: phones } }, select: { id: true } })).map((c) => c.id),
    ]),
  ];
  await prisma.incomingCall.deleteMany({ where: { channelId: { in: channelIds } } });
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.$disconnect();
});

describe("источник звонка — одна дверь", () => {
  it("канал шлюза — WhatsApp, всё остальное — линия", () => {
    expect(incomingCallSourceFromChannel("PJSIP/whatsapp-gw-00000012")).toBe("whatsapp");
    expect(incomingCallSourceFromChannel("SIP/out-00000012")).toBe("phone");
    expect(incomingCallSourceFromChannel("PJSIP/rh-web-1001-00000012")).toBe("phone");
    // Похожее, но не наш аппарат: без дефиса после имени это другой endpoint.
    expect(incomingCallSourceFromChannel("PJSIP/whatsapp-gwx-00000012")).toBe("phone");
    expect(incomingCallSourceFromChannel(undefined)).toBe("phone");
    expect(clientSourceForCall("whatsapp")).toBe("WHATSAPP");
    expect(clientSourceForCall("phone")).toBe("PHONE_CALL");
    expect(clientSourceForCall(undefined)).toBe("PHONE_CALL");
  });

  it("контекст шлюза — входящий; канал шлюза проходит отбор кандидатов", () => {
    expect(isInboundContext("from-trunk-whatsapp")).toBe(true);
    expect(
      classifyInboundChannel({
        id: "x",
        name: "PJSIP/whatsapp-gw-00000012",
        state: "Ring",
        caller: { number: "900000001", name: "WhatsApp" },
        dialplan: { context: "from-trunk-whatsapp", exten: "6501414" },
      } as never)
    ).toEqual({ inbound: true });
  });

  it("начало записи в хронологии остаётся «Входящий звонок…» — по нему узнают входящий noContact.ts и callRecordings.ts", () => {
    for (const source of ["phone", "whatsapp"]) {
      expect(inboundCallNotePrefix(source, true).startsWith(INCOMING_CALL_NOTE_PREFIX)).toBe(true);
      expect(inboundCallNotePrefix(source, false).startsWith(INCOMING_CALL_NOTE_PREFIX)).toBe(true);
      // Тот же текст, что держит callRecordings.ts (константа там закрытая, сверяем строкой).
      expect(inboundCallNotePrefix(source, true).startsWith("Входящий звонок клиента")).toBe(true);
    }
    expect(inboundCallNotePrefix("phone", true)).toBe("Входящий звонок клиента");
    expect(inboundCallNotePrefix("whatsapp", true)).toBe("Входящий звонок клиента из WhatsApp");
    expect(inboundCallNotePrefix("whatsapp", false)).toBe("Входящий звонок из WhatsApp");
    // Второй номер (26.11.2026): бренд дописывается в конец, начало не меняется.
    expect(inboundCallNotePrefix("whatsapp", true, "Арван")).toBe("Входящий звонок клиента из WhatsApp (Арван)");
    expect(inboundCallNotePrefix("whatsapp", false, "Арван")).toBe("Входящий звонок из WhatsApp (Арван)");
    expect(inboundCallNotePrefix("whatsapp", true, "  ")).toBe("Входящий звонок клиента из WhatsApp");
    // Бренд у звонка с линии не печатается: он бывает только у WhatsApp.
    expect(inboundCallNotePrefix("phone", true, "Арван")).toBe("Входящий звонок клиента");
  });

  it("линия WhatsApp: phone_number_id из номера, который набрал шлюз; основной номер и линия — null", () => {
    const ch = (name: string, exten?: string) => ({ name, dialplan: exten === undefined ? undefined : { exten } });
    expect(whatsappLineFromChannel(ch("PJSIP/whatsapp-gw-00000012", "1476112588909838"))).toBe("1476112588909838");
    // Основной номер шлюз набирает городским — линии нет.
    expect(whatsappLineFromChannel(ch("PJSIP/whatsapp-gw-00000012", "6501414"))).toBeNull();
    // Досинхронизация подхватила канал уже в маршруте (очередь) — бренд не угадываем.
    expect(whatsappLineFromChannel(ch("PJSIP/whatsapp-gw-00000012", "1000"))).toBeNull();
    expect(whatsappLineFromChannel(ch("PJSIP/whatsapp-gw-00000012"))).toBeNull();
    // Длинный номер у ОБЫЧНОЙ линии — не WhatsApp.
    expect(whatsappLineFromChannel(ch("SIP/out-00000012", "1476112588909838"))).toBeNull();
    expect(whatsappLineFromChannel(ch("PJSIP/whatsapp-gw-00000012", "12345678901234567890123"))).toBeNull();
    expect(whatsappLineFromChannel(ch("PJSIP/whatsapp-gw-00000012", "147611258890983x"))).toBeNull();
    expect(whatsappLineFromChannel(undefined)).toBeNull();
  });

  it("бренд линии: имя компании строки WhatsApp, без него — название; чужой канал и незнакомый id — null", () => {
    const rows = [
      { channel: "WHATSAPP", externalId: "1476112588909838", brandName: " Арван ", title: "Arvan · +992 87 791 4444" },
      { channel: "WHATSAPP", externalId: "1111111111111111", brandName: null, title: "Второй номер" },
      { channel: "INSTAGRAM", externalId: "2222222222222222", brandName: "Чужой", title: "IG" },
    ];
    expect(whatsappLineBrandFrom(rows, "1476112588909838")).toBe("Арван");
    expect(whatsappLineBrandFrom(rows, "1111111111111111")).toBe("Второй номер");
    expect(whatsappLineBrandFrom(rows, "2222222222222222")).toBeNull();
    expect(whatsappLineBrandFrom(rows, "3333333333333333")).toBeNull();
    expect(whatsappLineBrandFrom(rows, null)).toBeNull();
  });

  it("номер: девять цифр станции → +992…, иностранный с «+» остаётся как есть", () => {
    expect(toCrmPhone("900000001")).toBe("+992900000001");
    expect(toCrmPhone("+79161234567")).toBe("+79161234567");
  });
});

describe("звонок через шлюз на событиях станции", () => {
  it("местный номер: запись журнала с +992 и source=whatsapp, карточка с источником WHATSAPP", async () => {
    const n = mobile();
    phones.push(`+992${n}`);
    const id = `wa-src-${runId}-a`;
    await handleAriEvent({ type: "ChannelCreated", channel: waChannel(id, n) });
    const row = await waitFor(() => prisma.incomingCall.findUnique({ where: { channelId: id } }));
    expect(row?.phone).toBe(`+992${n}`);
    expect(row?.source).toBe("whatsapp");
    await handleAriEvent({ type: "ChannelDestroyed", channel: waChannel(id, n) });
    await waitFor(async () => (await prisma.incomingCall.findUnique({ where: { channelId: id } }))?.clientId);
    const call = await prisma.incomingCall.findUnique({ where: { channelId: id }, select: { client: { select: { source: true } } } });
    expect(call?.client?.source).toBe("WHATSAPP");
  });

  it("иностранный номер: «+» сохраняется, source=whatsapp", async () => {
    const foreign = `+7916${String(runId).slice(-7)}`;
    phones.push(foreign);
    const id = `wa-src-${runId}-b`;
    await handleAriEvent({ type: "ChannelCreated", channel: waChannel(id, foreign) });
    const row = await waitFor(() => prisma.incomingCall.findUnique({ where: { channelId: id } }));
    expect(row?.phone).toBe(foreign);
    expect(row?.source).toBe("whatsapp");
    await handleAriEvent({ type: "ChannelDestroyed", channel: waChannel(id, foreign) });
  });

  it("обычный звонок с линии остаётся phone, карточка — PHONE_CALL", async () => {
    const n = mobile();
    phones.push(`+992${n}`);
    const id = `wa-src-${runId}-c`;
    await handleAriEvent({ type: "ChannelCreated", channel: lineChannel(id, n) });
    const row = await waitFor(() => prisma.incomingCall.findUnique({ where: { channelId: id } }));
    expect(row?.source).toBe("phone");
    await handleAriEvent({ type: "ChannelDestroyed", channel: lineChannel(id, n) });
    await waitFor(async () => (await prisma.incomingCall.findUnique({ where: { channelId: id } }))?.clientId);
    const call = await prisma.incomingCall.findUnique({ where: { channelId: id }, select: { client: { select: { source: true } } } });
    expect(call?.client?.source).toBe("PHONE_CALL");
  });

  it("пропущенный звонок клиента из WhatsApp: в хронологии «Входящий звонок клиента из WhatsApp: …»", async () => {
    const n = mobile();
    const phone = `+992${n}`;
    phones.push(phone);
    const client = await prisma.client.create({ data: { fullName: `Клиент WA ${runId}`, phone, source: "WHATSAPP" } });
    const id = `wa-src-${runId}-d`;
    await handleAriEvent({ type: "ChannelCreated", channel: waChannel(id, n) });
    await waitFor(() => prisma.incomingCall.findUnique({ where: { channelId: id } }));
    await handleAriEvent({ type: "ChannelDestroyed", channel: waChannel(id, n) });
    const note = await waitFor(() => prisma.interaction.findFirst({ where: { clientId: client.id, type: "CALL" }, select: { notes: true } }));
    expect(note?.notes).toBe("Входящий звонок клиента из WhatsApp: до оператора не дозвонился");
    expect((await prisma.incomingCall.findUnique({ where: { channelId: id } }))?.waPhoneNumberId).toBeNull();
  });

  it("звонок на второй номер (26.11.2026): линия записана, в хронологии «…из WhatsApp (Арван)»", async () => {
    const n = mobile();
    const phone = `+992${n}`;
    phones.push(phone);
    const client = await prisma.client.create({ data: { fullName: `Клиент Арван ${runId}`, phone, source: "WHATSAPP" } });
    const id = `wa-src-${runId}-e`;
    await handleAriEvent({ type: "ChannelCreated", channel: waChannel(id, n, LINE_ID) });
    const row = await waitFor(() => prisma.incomingCall.findUnique({ where: { channelId: id } }));
    expect(row?.source).toBe("whatsapp");
    expect(row?.waPhoneNumberId).toBe(LINE_ID);
    // Конец звонка приходит, когда станция уже увела канал в маршрут городского номера.
    await handleAriEvent({ type: "ChannelDestroyed", channel: waChannel(id, n) });
    const note = await waitFor(() => prisma.interaction.findFirst({ where: { clientId: client.id, type: "CALL" }, select: { notes: true } }));
    expect(note?.notes).toBe("Входящий звонок клиента из WhatsApp (Арван): до оператора не дозвонился");
  });
});
