import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Типы аргументов заданы явно: тесты уведомлений читают из mock.calls и адресата,
// и текст, а у vi.fn(async () => 1) вызовы типизированы пустым кортежем.
const sendPushToAgent = vi.fn(
  async (_to: string | string[], _payload: { title: string; body: string; url?: string; tag?: string }) => 1
);
vi.mock("../src/push.js", async (importOriginal) => ({
  // Подмена ДОПОЛНЯЕТ модуль, а не заменяет его целиком (19.09.2026):
  // фабрика без importOriginal убирает остальные экспорты у всего
  // процесса, и СОСЕДНИЙ тест падает на «No "…" export is defined».
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent, sendPushToAgents: sendPushToAgent,
}));

const { prisma } = await import("../src/db.js");
const { handleAriEvent } = await import("../src/lib/telephony/ariEvents.js");
const { awaitIncomingReady, finishIncomingCall, resetIncomingCalls } = await import(
  "../src/lib/telephony/incomingCalls.js"
);
const { incomingHoursOpen, loadIncomingSettings } = await import("../src/lib/telephony/incomingSettings.js");
const { dushanbeWallClock, dushanbeInputToDate } = await import("../src/lib/dushanbeTime.js");
const { maskClientPhone } = await import("../src/lib/clientPhone.js");
const { findStaffPhone } = await import("../src/lib/staffPhoneGuard.js");
const { qualifyIncomingCall } = await import("../src/lib/telephony/qualifyIncoming.js");
const { incomingInteractionIds } = await import("../src/lib/telephony/incomingInteractions.js");

/**
 * РАБОЧЕЕ МЕСТО ОПЕРАТОРА ВХОДЯЩИХ (решение владельца 10.08.2026).
 *
 * Проверяется то, что ломается молча и обнаруживается только на живом звонке:
 *
 *  1. Карточка заводится ОДИН раз. Повторная доставка события АТС — норма, а не
 *     сбой; вторая карточка на тот же звонок означает дубликат клиента, который
 *     потом сливают руками.
 *  2. Выключенное автосоздание действительно ничего не создаёт — иначе настройка
 *     существует только на экране.
 *  3. Квалификация покупателем отдаёт лид агенту обычной очередью, а «Другое» —
 *     не отдаёт никому: раздать агентам чужой мусор значит наказать их за него.
 *  4. Повторная квалификация (окно сохраняет по паузе ввода, то есть часто) не
 *     передаёт клиента новому агенту при каждом нажатии клавиши.
 *  5. Разбирать может только оператор из Настроек.
 */

const runId = Date.now();
/**
 * НОМЕР ЗВОНЯЩЕГО НЕ ИМЕЕТ ПРАВА СОВПАСТЬ С НОМЕРОМ СОТРУДНИКА (20.09.2026).
 *
 * Было: `String(runId).slice(-9)` — девять последних цифр метки времени, то есть
 * ПРОИЗВОЛЬНЫЕ цифры. Номера сотрудников этого же файла собираются как
 * `+99291…`, `+99292…` из семи последних цифр той же метки. Стоит девятой и
 * восьмой цифрам метки оказаться «9» и «1» — и номер звонящего совпадает с
 * номером оператора ЦЕЛИКОМ: `+992` + `910001034` против `+99291` + `0001034`.
 *
 * Дальше срабатывает штатная защита `findStaffPhone` (lib/staffPhoneGuard.ts):
 * звонит свой сотрудник — карточку не заводим. Двенадцать проверок этого файла
 * падают на исправном коде, и падают ДЕТЕРМИНИРОВАННО: цифры метки времени
 * меняются медленно, так что «91» держится примерно 2,8 часа подряд, а
 * повторная попытка CI (`retry: 1`) внутри этого окна даёт тот же результат.
 * Поймано 20.09.2026: прогон в 15:12 UTC уронил ровно эти двенадцать проверок,
 * при зелёном прогоне того же набора на `main` часом раньше.
 *
 * Стало: у звонящего фиксированные первые две цифры «55», которых нет ни у
 * одного сотрудника файла (там 91, 92, 93, 94, 98). Совпадение хвостов стало
 * невозможным, а не маловероятным.
 */
const callerDigits = `55${String(runId).slice(-7)}`;
const callerPhone = `+992${callerDigits}`;
let operatorId = "";
let agentId = "";

beforeAll(async () => {
  const operator = await prisma.agent.create({
    data: {
      fullName: `Оператор ${runId}`,
      phone: `+99291${String(runId).slice(-7)}`,
      role: "ADMIN",
      passwordHash: "x",
    },
  });
  operatorId = operator.id;
  // Свой агент — обязателен, а не «наверняка найдётся в базе»: pickAgentForLead ищет
  // среди ВСЕХ активных агентов, и в пустой базе CI выбирать было бы не из кого
  // (ровно на этом CI покраснел 10.08.2026 в соседнем тесте входящих).
  const agent = await prisma.agent.create({
    data: {
      fullName: `Агент очереди ${runId}`,
      phone: `+99292${String(runId).slice(-7)}`,
      role: "AGENT",
      passwordHash: "x",
    },
  });
  agentId = agent.id;

  /**
   * СТРАХОВКА НА БУДУЩЕЕ, А НЕ ПРОВЕРКА ПРОДУКТА.
   *
   * Если номер звонящего однажды снова окажется номером сотрудника, падение
   * случится ЗДЕСЬ, с понятным текстом, а не двенадцатью загадочными «карточка не
   * создалась» ниже: `findStaffPhone` — та самая защита, которая их и роняла.
   */
  expect(await findStaffPhone([callerPhone])).toBeNull();
});

beforeEach(async () => {
  await prisma.settings.upsert({
    where: { id: "singleton" },
    update: {
      incomingAutoCreateClient: true,
      incomingDefaultKind: "OTHER",
      incomingAssignOnQualify: true,
      // Уведомление о звонке и часы приёма возвращаем к умолчанию перед каждым
      // тестом: настройки — singleton на всю базу, и тест, оставивший «часы
      // выключены до 09:00», красил бы соседние файлы по времени суток.
      incomingPushEnabled: true,
      incomingHoursEnabled: false,
    },
    create: { id: "singleton" },
  });
});

afterEach(async () => {
  resetIncomingCalls();
  sendPushToAgent.mockClear();
  await prisma.incomingCall.deleteMany({ where: { phone: callerPhone } });
  const created = await prisma.client.findFirst({ where: { phone: callerPhone } });
  if (created) {
    await prisma.interaction.deleteMany({ where: { clientId: created.id } });
    await prisma.client.delete({ where: { id: created.id } });
  }
});

afterAll(async () => {
  // Настройки — singleton на всю базу: оставленная правка ломает соседние файлы.
  await prisma.settings.updateMany({
    where: { id: "singleton" },
    data: {
      incomingAutoCreateClient: true,
      incomingDefaultKind: "OTHER",
      incomingPushEnabled: true,
      incomingHoursEnabled: false,
    },
  });
  await prisma.agent.deleteMany({ where: { id: { in: [operatorId, agentId] } } });
  await prisma.$disconnect();
});

function inboundChannel(id: string) {
  return {
    id,
    name: `SIP/out-${id}`,
    state: "Ring",
    caller: { number: callerDigits },
    dialplan: { context: "ext-queues", exten: "1000" },
  };
}

async function ring(channelId: string) {
  await handleAriEvent({ type: "ChannelCreated", channel: inboundChannel(channelId) });
}

async function bridge(channelId: string) {
  await handleAriEvent({
    type: "ChannelEnteredBridge",
    channel: { id: "op-1", name: "SIP/1001-00000012", state: "Up", caller: {} },
    bridge: { id: "b1", channels: [channelId, "op-1"] },
  });
}

describe("Карточка по входящему звонку", () => {
  it("незнакомый номер заводит карточку, когда оператор снял трубку, — без ответственного", async () => {
    const channelId = `op-${runId}-1`;
    await ring(channelId);
    await bridge(channelId);
    await awaitIncomingReady(channelId);

    const client = await prisma.client.findFirst({ where: { phone: callerPhone } });
    expect(client).not.toBeNull();
    /**
     * В ИМЕНИ — МАСКА, А НЕ НОМЕР ЦЕЛИКОМ (изменено 20.08.2026).
     *
     * Раньше здесь ожидался `Входящий ${callerPhone}` — и это было настоящей
     * утечкой: правило `clients.viewPhone` закрывает ПОЛЕ `phone`, а имя карточки
     * не трогает, так что агент видел полный номер (живой случай у владельца).
     * Настоящий номер лежит в `phone` рядом и открывается тому, у кого есть право;
     * в имени остаются последние две цифры — отличить двух незнакомых звонивших.
     */
    expect(client?.fullName).toBe(`Входящий ${maskClientPhone(callerPhone)}`);
    expect(client?.fullName).not.toContain(callerPhone);
    expect(client?.phone).toBe(callerPhone);
    expect(client?.source).toBe("PHONE_CALL");
    // Ответственного нет НАМЕРЕННО: пока не спрошено, покупатель это или продавец,
    // распределять нечего, а назначенный агент запустил бы таймер первого звонка по
    // человеку, с которым прямо сейчас говорит оператор.
    expect(client?.assignedAgentId).toBeNull();

    const record = await prisma.incomingCall.findUnique({ where: { channelId } });
    expect(record?.clientId).toBe(client?.id);
    expect(record?.autoCreatedClient).toBe(true);
  });

  it("НЕПРИНЯТЫЙ звонок с незнакомого номера карточку не заводит", async () => {
    /**
     * Решение 09.08.2026 в силе: курьеры, реклама и ошибшиеся номером не должны
     * попадать в базу. Первая версия рабочего места оператора заводила карточку на
     * гудок — то есть складывала в базу КАЖДЫЙ непринятый звонок. Карточка нужна с
     * той секунды, когда начался разговор: пока трубку никто не снял, о звонящем не
     * известно ничего и разбирать нечего.
     */
    const channelId = `op-${runId}-11`;
    await ring(channelId);
    await handleAriEvent({ type: "ChannelDestroyed", channel: inboundChannel(channelId) });

    expect(await prisma.client.count({ where: { phone: callerPhone } })).toBe(0);
    // Сам звонок в журнале остаётся — потерянное обращение обязано быть видно.
    const record = await prisma.incomingCall.findUnique({ where: { channelId } });
    expect(record?.answered).toBe(false);
  });

  it("повторная доставка события не заводит вторую карточку", async () => {
    const channelId = `op-${runId}-2`;
    await ring(channelId);
    await ring(channelId);
    await bridge(channelId);
    await bridge(channelId);
    await awaitIncomingReady(channelId);

    const count = await prisma.client.count({ where: { phone: callerPhone } });
    expect(count).toBe(1);
  });

  it("выключенное автосоздание не создаёт карточек", async () => {
    await prisma.settings.update({
      where: { id: "singleton" },
      data: { incomingAutoCreateClient: false },
    });
    const channelId = `op-${runId}-3`;
    await ring(channelId);
    await bridge(channelId);
    await awaitIncomingReady(channelId);

    expect(await prisma.client.count({ where: { phone: callerPhone } })).toBe(0);
    const record = await prisma.incomingCall.findUnique({ where: { channelId } });
    // Сам звонок в журнале остаётся: настройка про карточки, а не про учёт звонков.
    expect(record).not.toBeNull();
    expect(record?.clientId).toBeNull();
  });
});

describe("Кто снял трубку", () => {
  /**
   * Внутренний номер снявшего — единственное, по чему у входящего звонка вообще
   * находится автор записи в хронологии (см. finishIncomingCall). Потеряется он —
   * и вместе с записью пропадут запись разговора, расшифровка и карточка.
   */
  it("внутренний номер снявшего не теряется, если оператор вошёл в мост первым", async () => {
    /**
     * События входа в мост приходят по одному на канал, и порядок не гарантирован.
     * Когда оператор оказывался первым, его имя канала было только в событии с
     * неполным мостом — и внутренний номер терялся: в журнале пустела колонка
     * «кто снял», а из хронологии пропадало «(1001)».
     */
    const channelId = `op-${runId}-23`;
    await ring(channelId);
    // Оператор в мосту один — клиент ещё не вошёл.
    await handleAriEvent({
      type: "ChannelEnteredBridge",
      channel: { id: "op-solo", name: "SIP/1001-000000cc", state: "Up", caller: {} },
      bridge: { id: "b-solo", channels: ["op-solo"] },
    });
    // Теперь входит клиент — событие уже про его канал, имени оператора в нём нет.
    await handleAriEvent({
      type: "ChannelEnteredBridge",
      channel: inboundChannel(channelId),
      bridge: { id: "b-solo", channels: ["op-solo", channelId] },
    });
    await awaitIncomingReady(channelId);

    await handleAriEvent({ type: "ChannelDestroyed", channel: inboundChannel(channelId) });
    const record = await prisma.incomingCall.findUniqueOrThrow({ where: { channelId } });
    expect(record.answeredBy).toBe("1001");
    expect(record.answered).toBe(true);
  });
});

describe("Разбор входящего звонка", () => {
  async function ringAndQualify(
    channelId: string,
    data: Parameters<typeof qualifyIncomingCall>[0]["data"]
  ) {
    await ring(channelId);
    // Разбирают только состоявшийся разговор — карточка появляется на ответе оператора.
    await bridge(channelId);
    await awaitIncomingReady(channelId);
    const record = await prisma.incomingCall.findUniqueOrThrow({ where: { channelId } });
    return qualifyIncomingCall({ callId: record.id, operatorId, data });
  }

  it("покупатель уходит агенту обычной очередью по KPI", async () => {
    const result = await ringAndQualify(`op-${runId}-5`, {
      kind: "BUYER",
      fullName: "Мадина",
      requirementsNotes: "Двушка в Сино до 400 тысяч",
      budgetMax: 400000,
    });
    expect("error" in result).toBe(false);

    const client = await prisma.client.findFirstOrThrow({ where: { phone: callerPhone } });
    expect(client.kind).toBe("BUYER");
    // Имя-заглушка заменено настоящим — ради этого окно и открывается.
    expect(client.fullName).toBe("Мадина");
    expect(client.requirementsNotes).toContain("Сино");
    expect(client.assignedAgentId).not.toBeNull();
    // Таймер первого звонка стартует от назначения, а не от начала разговора: агент
    // не отвечает за минуты, пока с клиентом говорил оператор.
    expect(client.assignedAt).not.toBeNull();
    expect(sendPushToAgent).toHaveBeenCalled();
  });

  it("«Другое» агентам не раздаётся — уходит в «Прочие обращения»", async () => {
    await ringAndQualify(`op-${runId}-6`, { kind: "OTHER", fullName: "Курьер" });

    const client = await prisma.client.findFirstOrThrow({ where: { phone: callerPhone } });
    expect(client.kind).toBe("OTHER");
    expect(client.assignedAgentId).toBeNull();
  });

  it("повторный разбор не передаёт клиента новому агенту", async () => {
    /**
     * Окно оператора сохраняет по ПАУЗЕ ВВОДА, то есть вызывает этот путь много раз
     * за разговор. Если бы каждый вызов заново искал агента, карточка кочевала бы
     * по очереди KPI на каждом слове, которое оператор дописывает в имени.
     */
    const channelId = `op-${runId}-7`;
    await ringAndQualify(channelId, { kind: "BUYER", fullName: "Ма" });
    const first = await prisma.client.findFirstOrThrow({ where: { phone: callerPhone } });

    const record = await prisma.incomingCall.findUniqueOrThrow({ where: { channelId } });
    await qualifyIncomingCall({
      callId: record.id,
      operatorId,
      data: { kind: "BUYER", fullName: "Мадина" },
    });

    const second = await prisma.client.findFirstOrThrow({ where: { phone: callerPhone } });
    expect(second.assignedAgentId).toBe(first.assignedAgentId);
    expect(second.fullName).toBe("Мадина");
  });

  it("разбор заводит карточку сам, если её не было", async () => {
    /**
     * Раньше здесь был отказ «автосоздание выключено», и он врал в двух случаях из
     * трёх: карточки могло не быть и потому, что звонок никто не снял, и потому,
     * что номер когда-то помечали «не по делу». Человек, ошибшийся номером год
     * назад, сегодня звонит покупать квартиру — записать его было НЕВОЗМОЖНО.
     * Раз оператор своими руками говорит «это покупатель», карточка нужна
     * независимо от того, почему её не завели раньше.
     */
    await prisma.settings.update({ where: { id: "singleton" }, data: { incomingAutoCreateClient: false } });
    const channelId = `op-${runId}-8`;
    await ring(channelId);
    await bridge(channelId);
    await awaitIncomingReady(channelId);
    expect(await prisma.client.count({ where: { phone: callerPhone } })).toBe(0);

    const record = await prisma.incomingCall.findUniqueOrThrow({ where: { channelId } });
    const result = await qualifyIncomingCall({
      callId: record.id,
      operatorId,
      data: { kind: "BUYER", fullName: "Пришёл сам" },
    });

    expect("error" in result).toBe(false);
    const client = await prisma.client.findFirstOrThrow({ where: { phone: callerPhone } });
    expect(client.kind).toBe("BUYER");
    expect(client.fullName).toBe("Пришёл сам");
    // Звонок связан с заведённой карточкой — иначе разбор не с чем было бы сверить.
    const after = await prisma.incomingCall.findUniqueOrThrow({ where: { channelId } });
    expect(after.clientId).toBe(client.id);
  });
});

describe("Разбор задним числом", () => {
  /**
   * Окно оператора живёт полторы минуты после того, как положили трубку. Если бы
   * этим срок и кончался, отвлёкшийся оператор терял бы услышанное навсегда — и это
   * дыра, которую слой 1 создал сам: раньше записывать было негде вовсе, теперь
   * место есть, но с коротким сроком. Журнал входящих обязан показать, что осталось
   * без разбора, и дать разобрать позже.
   */
  it("состоявшийся разговор без типа обращения считается неразобранным, разбор снимает признак", async () => {
    const channelId = `op-${runId}-9`;
    await ring(channelId);
    await bridge(channelId);
    await handleAriEvent({ type: "ChannelDestroyed", channel: inboundChannel(channelId) });

    const before = await prisma.incomingCall.findUniqueOrThrow({ where: { channelId } });
    expect(before.answered).toBe(true);
    expect(before.qualifiedAt).toBeNull();
    expect(before.clientId).not.toBeNull();

    // Живой записи в памяти уже нет — разбор идёт по журналу, как из раздела «Звонки».
    resetIncomingCalls();
    await qualifyIncomingCall({
      callId: before.id,
      operatorId,
      data: { kind: "SELLER", fullName: "Собственник" },
    });

    const after = await prisma.incomingCall.findUniqueOrThrow({ where: { channelId } });
    expect(after.qualifiedAt).not.toBeNull();
    expect(after.qualifiedById).toBe(operatorId);

    const client = await prisma.client.findFirstOrThrow({ where: { phone: callerPhone } });
    expect(client.kind).toBe("SELLER");
    expect(client.fullName).toBe("Собственник");
  });

  it("пропущенный звонок разбирать нечего — он не попадает в неразобранные", async () => {
    const channelId = `op-${runId}-10`;
    await ring(channelId);
    // Трубку никто не снял.
    await handleAriEvent({ type: "ChannelDestroyed", channel: inboundChannel(channelId) });

    const unqualified = await prisma.incomingCall.count({
      where: { channelId, answered: true, clientId: { not: null }, qualifiedAt: null },
    });
    expect(unqualified).toBe(0);
  });
});

describe("«Не по делу» — курьер, реклама, ошиблись номером", () => {
  /**
   * Требование владельца 10.08.2026: «чтобы вообще карточка не создавалась, если
   * вопрос не касается этого всего». Отдельный исход, а не тип «Другое»: аренда и
   * работа — настоящие обращения, их смотрит руководство, а курьер не клиент вовсе,
   * и карточка на него через месяц делает «Прочие обращения» нечитаемыми.
   */
  async function ringAnswerAndMark(channelId: string) {
    await ring(channelId);
    await bridge(channelId);
    await awaitIncomingReady(channelId);
    const record = await prisma.incomingCall.findUniqueOrThrow({ where: { channelId } });
    return qualifyIncomingCall({ callId: record.id, operatorId, data: { kind: "IRRELEVANT" } });
  }

  it("удаляет заведённую этим звонком карточку, но оставляет звонок в журнале", async () => {
    const channelId = `op-${runId}-12`;
    // Карточка при ответе завелась — иначе проверять было бы нечего.
    await ring(channelId);
    await bridge(channelId);
    await awaitIncomingReady(channelId);
    expect(await prisma.client.count({ where: { phone: callerPhone } })).toBe(1);

    const record = await prisma.incomingCall.findUniqueOrThrow({ where: { channelId } });
    const result = await qualifyIncomingCall({ callId: record.id, operatorId, data: { kind: "IRRELEVANT" } });

    expect(result).toMatchObject({ clientId: null, clientRemoved: true });
    expect(await prisma.client.count({ where: { phone: callerPhone } })).toBe(0);

    // Звонок остаётся: нагрузка на оператора должна считаться честно.
    const after = await prisma.incomingCall.findUniqueOrThrow({ where: { channelId } });
    expect(after.irrelevant).toBe(true);
    expect(after.qualifiedAt).not.toBeNull();
    expect(after.clientId).toBeNull();
  });

  it("после ДВУХ пометок номер считается служебным и карточку больше не получает", async () => {
    /**
     * Курьер звонит каждый день. Без этой памяти оператор помечал бы его ежедневно,
     * и разбор превратился бы в отписку — а обязательное действие, которое делают
     * не глядя, хуже отсутствующего.
     */
    await ringAnswerAndMark(`op-${runId}-13`);
    await ringAnswerAndMark(`op-${runId}-13b`);

    const channelId = `op-${runId}-14`;
    await ring(channelId);
    await bridge(channelId);
    await awaitIncomingReady(channelId);

    expect(await prisma.client.count({ where: { phone: callerPhone } })).toBe(0);
    // Но сам звонок записан — если курьеров стало двадцать в день, это должно быть видно.
    expect(await prisma.incomingCall.findUnique({ where: { channelId } })).not.toBeNull();
  });

  it("ОДНА пометка вернувшегося клиента не хоронит: карточка и конвейер работают", async () => {
    /**
     * Побочный эффект прежнего правила был тяжелее его пользы. Одна пометка «не по
     * делу» — это про ОДИН звонок (ошиблись номером, спрашивали не то), а не про
     * человека навсегда. Между тем без карточки у звонка нет `Interaction`, а без
     * него — ни записи разговора, ни расшифровки, ни разбора: вернувшийся клиент
     * молча выпадал из всего конвейера.
     */
    // Оператору выдан тот внутренний номер, который сообщает станция: без него у
    // записи не нашлось бы автора (у автосозданной карточки ответственного нет).
    await prisma.agent.update({ where: { id: operatorId }, data: { sipExtension: "1001" } });
    await ringAnswerAndMark(`op-${runId}-13c`);
    expect(await prisma.client.count({ where: { phone: callerPhone } })).toBe(0);

    const channelId = `op-${runId}-14c`;
    await ring(channelId);
    await bridge(channelId);
    await awaitIncomingReady(channelId);

    const client = await prisma.client.findFirstOrThrow({ where: { phone: callerPhone } });
    await handleAriEvent({ type: "ChannelDestroyed", channel: inboundChannel(channelId) });

    // Есть карточка — значит есть куда писать запись, а к ней привязывать разговор.
    const interaction = await prisma.interaction.findFirst({ where: { clientId: client.id } });
    expect(interaction).not.toBeNull();

    await prisma.agent.update({ where: { id: operatorId }, data: { sipExtension: null } });
  });

  it("карточку живого клиента не удаляет — помечается ЗВОНОК, а не человек", async () => {
    /**
     * Цена ошибки несимметрична: лишняя карточка это мусор, стёртая — потерянный
     * клиент вместе с историей. Поэтому удаляется только карточка, заведённая этим
     * же звонком и к которой ничего не успело прирасти.
     */
    const known = await prisma.client.create({
      data: {
        fullName: `Давний клиент ${runId}`,
        phone: `+99298${String(runId).slice(-7)}`,
        source: "PHONE_CALL",
        assignedAgentId: agentId,
      },
    });
    const call = await prisma.incomingCall.create({
      data: {
        channelId: `op-${runId}-15`,
        phone: known.phone,
        clientId: known.id,
        answered: true,
        // Ключевое: карточку завёл не этот звонок.
        autoCreatedClient: false,
      },
    });

    const result = await qualifyIncomingCall({ callId: call.id, operatorId, data: { kind: "IRRELEVANT" } });
    expect(result).toMatchObject({ clientRemoved: false });
    expect(await prisma.client.findUnique({ where: { id: known.id } })).not.toBeNull();

    await prisma.incomingCall.delete({ where: { id: call.id } });
    await prisma.client.delete({ where: { id: known.id } });
  });
});

describe("«Не по делу»: решение удалить не устаревает (CHANNEL-NEW-19)", () => {
  it("пока шла проверка нетронутости, карточку закрепили за агентом — она не удаляется", async () => {
    const stub = await prisma.client.create({
      data: { fullName: `Входящий +99297${String(runId).slice(-7)}`, phone: `+99297${String(runId).slice(-7)}`, source: "PHONE_CALL" },
    });
    const call = await prisma.incomingCall.create({
      data: { channelId: `op-${runId}-19`, phone: stub.phone, clientId: stub.id, answered: true, autoCreatedClient: true },
    });
    // Проверка «заглушка» читает карточку; сразу после этого чтения оператор назначает агента.
    const realFind = prisma.client.findUnique.bind(prisma.client);
    let raced = false;
    const spy = vi.spyOn(prisma.client, "findUnique").mockImplementation(((args: { where?: { id?: string }; select?: Record<string, boolean> }) => {
      const result = realFind(args as never);
      if (!raced && args?.where?.id === stub.id && args.select?.requirementsNotes) {
        raced = true;
        return result.then(async (row) => {
          await prisma.client.update({ where: { id: stub.id }, data: { assignedAgentId: agentId } });
          return row;
        });
      }
      return result;
    }) as never);
    try {
      const result = await qualifyIncomingCall({ callId: call.id, operatorId, data: { kind: "IRRELEVANT" } });
      expect(raced).toBe(true);
      expect(result).toMatchObject({ clientRemoved: false });
    } finally {
      spy.mockRestore();
    }
    const kept = await prisma.client.findUnique({ where: { id: stub.id }, select: { deletedAt: true, assignedAgentId: true } });
    expect(kept).toMatchObject({ deletedAt: null, assignedAgentId: agentId });
    // Звонок при этом помечен «не по делу», связь с карточкой не снята.
    const after = await prisma.incomingCall.findUniqueOrThrow({ where: { id: call.id } });
    expect(after.irrelevant).toBe(true);
    expect(after.clientId).toBe(stub.id);

    await prisma.incomingCall.delete({ where: { id: call.id } });
    await prisma.client.delete({ where: { id: stub.id } });
  });
});

describe("Входящий звонок — не работа агента", () => {
  /**
   * Входящий пишется в хронологию от имени ответственного агента: у Interaction
   * автор обязателен, а оператора в карточке клиента нет. Из-за этого агенту
   * засчитывалась «скорость первого ответа» за то, что клиент позвонил в офис
   * САМ, — вплоть до полного балла за звонок, на который агент не отвечал вовсе.
   */
  it("не засчитывается агенту как первый ответ на лид", async () => {
    const client = await prisma.client.create({
      data: {
        fullName: `Лид дня ${runId}`,
        phone: `+99294${String(runId).slice(-7)}`,
        source: "PHONE_CALL",
        assignedAgentId: agentId,
        // Назначен только что — окно скорости ответа открыто.
        assignedAt: new Date(Date.now() - 60 * 1000),
      },
    });
    const interaction = await prisma.interaction.create({
      data: { clientId: client.id, agentId, type: "CALL", notes: "Входящий звонок клиента" },
    });
    const call = await prisma.incomingCall.create({
      data: {
        channelId: `op-${runId}-30`,
        phone: client.phone,
        clientId: client.id,
        answered: true,
        interactionId: interaction.id,
      },
    });

    const ids = await incomingInteractionIds([interaction.id]);
    expect(ids.has(interaction.id)).toBe(true);

    // Обычная запись агента в это множество не попадает — иначе правило съело бы
    // настоящие ответы вместе с чужими звонками.
    const own = await prisma.interaction.create({
      data: { clientId: client.id, agentId, type: "CALL", notes: "Агент позвонил сам" },
    });
    const both = await incomingInteractionIds([interaction.id, own.id]);
    expect(both.has(own.id)).toBe(false);

    await prisma.incomingCall.delete({ where: { id: call.id } });
    await prisma.interaction.deleteMany({ where: { clientId: client.id } });
    await prisma.client.delete({ where: { id: client.id } });
  });

  it("клиента, который сам не дозвонился, не помечает «не ответил»", async () => {
    /**
     * `NO_ANSWER` читается CRM задом наперёд: три подряд — и клиент объявляется
     * «Недоступным», а руководству летит «агент не может дозвониться». Человек
     * трижды пытался дозвониться ДО НАС, и за это помечали его же, а виноватым
     * выставляли агента.
     */
    const client = await prisma.client.create({
      data: {
        fullName: `Недозвонившийся ${runId}`,
        phone: `+99293${String(runId).slice(-7)}`,
        source: "PHONE_CALL",
        assignedAgentId: agentId,
      },
    });
    const channelId = `op-${runId}-31`;
    await handleAriEvent({
      type: "ChannelCreated",
      channel: {
        id: channelId,
        name: `SIP/out-${channelId}`,
        state: "Ring",
        caller: { number: client.phone.slice(-9) },
        dialplan: { context: "ext-queues", exten: "1000" },
      },
    });
    await handleAriEvent({
      type: "ChannelDestroyed",
      channel: {
        id: channelId,
        name: `SIP/out-${channelId}`,
        state: "Down",
        caller: { number: client.phone.slice(-9) },
        dialplan: { context: "ext-queues", exten: "1000" },
      },
    });

    const interaction = await prisma.interaction.findFirstOrThrow({ where: { clientId: client.id } });
    expect(interaction.outcome).toBeNull();
    // Задача перезвонить при этом обязана остаться — именно она и есть польза.
    expect(interaction.nextAction).toContain("Перезвонить");

    await prisma.incomingCall.deleteMany({ where: { channelId } });
    await prisma.interaction.deleteMany({ where: { clientId: client.id } });
    await prisma.client.delete({ where: { id: client.id } });
  });

  it("состоявшийся разговор считается контактом клиента", async () => {
    /**
     * Без отметки контакта CRM «остужала» статус и слала агенту «вы забыли про
     * клиента» — про того, кто звонит в офис каждый день.
     */
    const channelId = `op-${runId}-32`;
    await ring(channelId);
    await bridge(channelId);
    await awaitIncomingReady(channelId);
    const before = await prisma.client.findFirstOrThrow({ where: { phone: callerPhone } });
    await prisma.client.update({
      where: { id: before.id },
      data: { assignedAgentId: agentId, lastContactAt: new Date(Date.now() - 5 * 86400000) },
    });

    await handleAriEvent({ type: "ChannelDestroyed", channel: inboundChannel(channelId) });

    const after = await prisma.client.findFirstOrThrow({ where: { phone: callerPhone } });
    expect(after.lastContactAt.getTime()).toBeGreaterThan(Date.now() - 60_000);
    const interaction = await prisma.interaction.findFirstOrThrow({ where: { clientId: after.id } });
    // Непустой исход нужен, чтобы «клиент проявил себя сам» вообще засчиталось.
    expect(interaction.outcome).toBe("NEUTRAL");
  });
});

describe("Разговор оператора попадает в общий конвейер", () => {
  /**
   * До 11.08.2026 входящие уходили из обработчика событий сразу, до выгрузки записи:
   * ни файла, ни расшифровки, ни разбора, ни обучения бота. А это самый чистый
   * материал «как у нас отвечают» — клиент позвонил сам, значит говорит по делу.
   *
   * Проверяется не сам конвейер (он общий с исходящими и покрыт своими тестами), а
   * стык: что у входящего вообще появляется запись в хронологии, к которой можно
   * привязать файл, и что автор у неё правильный.
   */
  it("автор записи — ОПЕРАТОР, даже когда у карточки нет ответственного", async () => {
    // Оператору выдан внутренний номер — тот самый, что сообщает станция.
    await prisma.agent.update({ where: { id: operatorId }, data: { sipExtension: "1001" } });

    const channelId = `op-${runId}-50`;
    await ring(channelId);
    await bridge(channelId);
    await awaitIncomingReady(channelId);
    const client = await prisma.client.findFirstOrThrow({ where: { phone: callerPhone } });
    // Ответственного нет по замыслу: тип обращения ещё не выбран.
    expect(client.assignedAgentId).toBeNull();

    await handleAriEvent({ type: "ChannelDestroyed", channel: inboundChannel(channelId) });

    const interaction = await prisma.interaction.findFirst({ where: { clientId: client.id } });
    // Раньше записи не было вовсе: писать её было некому, и вместе с ней терялась
    // запись разговора — привязывать файл было не к чему.
    expect(interaction).not.toBeNull();
    expect(interaction?.agentId).toBe(operatorId);
    expect(interaction?.type).toBe("CALL");

    // И звонок в журнале знает свою запись — по этой связи такие разговоры
    // отсеиваются везде, где считают работу агента.
    const record = await prisma.incomingCall.findUniqueOrThrow({ where: { channelId } });
    expect(record.interactionId).toBe(interaction!.id);

    await prisma.agent.update({ where: { id: operatorId }, data: { sipExtension: null } });
  });

  /**
   * Очередь 1000 дозванивается операторам НЕ их SIP-каналом напрямую, а
   * Local-каналом вида `Local/1001@from-queue-…;1` — это выяснилось только на
   * живой станции 12.08.2026 при разборе прод-факта «журнал входящих пуст».
   * extensionFromChannelName до этого требовал дефис сразу после номера и на
   * таком имени не совпадал НИКОГДА: answeredBy оставался пустым на каждом
   * звонке через очередь, а без него не находился ни оператор для Interaction,
   * ни он сам в журнале — звонок выглядел «ничейным» у всех операторов.
   */
  it("очередь дозванивается Local-каналом — оператор всё равно узнаётся", async () => {
    await prisma.agent.update({ where: { id: operatorId }, data: { sipExtension: "1001" } });

    const channelId = `op-${runId}-51`;
    await ring(channelId);
    await handleAriEvent({
      type: "ChannelEnteredBridge",
      channel: { id: "lq-1", name: "Local/1001@from-queue-000000aa;1", state: "Up", caller: {} },
      bridge: { id: "b-q", channels: [channelId, "lq-1"] },
    });
    await awaitIncomingReady(channelId);
    const client = await prisma.client.findFirstOrThrow({ where: { phone: callerPhone } });

    // answeredBy пишется в БД только на finishIncomingCall (ChannelDestroyed) —
    // до этого он живёт лишь в памяти процесса (live-карта), поэтому конец
    // звонка обязателен ДО чтения записи из базы.
    await handleAriEvent({ type: "ChannelDestroyed", channel: inboundChannel(channelId) });

    const record = await prisma.incomingCall.findUniqueOrThrow({ where: { channelId } });
    expect(record.answeredBy).toBe("1001");
    expect(record.answered).toBe(true);

    const interaction = await prisma.interaction.findFirst({ where: { clientId: client.id } });
    expect(interaction).not.toBeNull();
    expect(interaction?.agentId).toBe(operatorId);

    await prisma.agent.update({ where: { id: operatorId }, data: { sipExtension: null } });
  });

  /** То же, но Local-канал оператора входит в мост ПЕРВЫМ — путь rememberOperatorChannel
   *  (ariEvents.ts): имя оператора приходит в событии, где мост ещё неполный. */
  it("Local-канал оператора первым в мосте — имя не теряется", async () => {
    await prisma.agent.update({ where: { id: operatorId }, data: { sipExtension: "1002" } });

    const channelId = `op-${runId}-52`;
    await ring(channelId);
    await handleAriEvent({
      type: "ChannelEnteredBridge",
      channel: { id: "lq-2", name: "Local/1002@from-queue-000000bb;1", state: "Up", caller: {} },
      bridge: { id: "b-q2", channels: ["lq-2"] },
    });
    await handleAriEvent({
      type: "ChannelEnteredBridge",
      channel: inboundChannel(channelId),
      bridge: { id: "b-q2", channels: ["lq-2", channelId] },
    });
    await awaitIncomingReady(channelId);
    await handleAriEvent({ type: "ChannelDestroyed", channel: inboundChannel(channelId) });

    const record = await prisma.incomingCall.findUniqueOrThrow({ where: { channelId } });
    expect(record.answeredBy).toBe("1002");

    await prisma.agent.update({ where: { id: operatorId }, data: { sipExtension: null } });
  });

  it("итог звонка возвращается один раз — повторное событие конца записи не дублирует", async () => {
    /**
     * Станция шлёт и StasisEnd, и ChannelDestroyed. Если бы итог возвращался на
     * каждое, запись разговора выгружалась бы дважды: лишняя закачка файла и второй
     * платный разбор у Gemini на один и тот же разговор.
     */
    const channelId = `op-${runId}-51`;
    await ring(channelId);
    await bridge(channelId);
    await awaitIncomingReady(channelId);

    const first = await finishIncomingCall(channelId);
    const second = await finishIncomingCall(channelId);
    expect(first).not.toBeNull();
    expect(first?.answered).toBe(true);
    expect(second).toBeNull();
  });
});

/**
 * УВЕДОМЛЕНИЕ О ЗВОНКЕ И ЧАСЫ ПРИЁМА (решение владельца 11.08.2026).
 *
 * Проверяется ровно то, ради чего это делалось: оператор с ЗАКРЫТОЙ CRM обязан
 * узнать о звонке, пока он идёт, — окно оператора приходит опросом и в закрытом
 * приложении не существует. И обратное: настройка часов обязана действительно
 * закрывать рот CRM, иначе она есть только на экране.
 */
describe("Уведомление о входящем звонке", () => {
  it("на гудок НЕ пушим — телефон звонит сам (владелец 20.09.2026)", async () => {
    const channelId = `op-${runId}-push-1`;
    await ring(channelId);
    await awaitIncomingReady(channelId);

    expect(sendPushToAgent).not.toHaveBeenCalled();
    // Звонок при этом записан — молчит уведомление, а не журнал.
    expect(await prisma.incomingCall.findUnique({ where: { channelId } })).not.toBeNull();
  });

  it("пропущенный звонок незнакомого номера доходит до тех, кто разбирает ничейные", async () => {
    const channelId = `op-${runId}-push-missed`;
    await ring(channelId);
    await awaitIncomingReady(channelId);
    // Трубку никто не снял: bridge не вызываем вовсе.
    await finishIncomingCall(channelId);

    const call = sendPushToAgent.mock.calls.find(([ids]) => ids.includes(operatorId));
    expect(call, "уведомление о пропущенном не ушло").toBeDefined();
    const [, payload] = call!;
    expect(payload.title).toContain("Пропущенный");
    // Уведомление самодостаточно: прочитанное позже, оно всё равно говорит,
    // кто звонил и куда идти.
    expect(payload.body).toContain(callerDigits.slice(-4));
  });

  it("выключенное уведомление молчит, но звонок в журнал всё равно пишется", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { incomingPushEnabled: false } });
    const channelId = `op-${runId}-push-2`;
    await ring(channelId);
    await awaitIncomingReady(channelId);

    expect(sendPushToAgent).not.toHaveBeenCalled();
    expect(await prisma.incomingCall.findUnique({ where: { channelId } })).not.toBeNull();

    await prisma.settings.update({ where: { id: "singleton" }, data: { incomingPushEnabled: true } });
  });

  it("вне часов приёма CRM молчит, но звонок записан и не потерян", async () => {
    /**
     * Час выбираем от текущего времени Душанбе, а не «02:00–03:00»: тест, привязанный
     * к абсолютному времени, зелен двадцать три часа в сутки и краснеет ночью.
     */
    const wall = dushanbeWallClock();
    const hourAgo = String((wall.getUTCHours() + 23) % 24).padStart(2, "0");
    const twoHoursAgo = String((wall.getUTCHours() + 22) % 24).padStart(2, "0");
    await prisma.settings.update({
      where: { id: "singleton" },
      data: {
        incomingHoursEnabled: true,
        incomingHoursStart: `${twoHoursAgo}:00`,
        incomingHoursEnd: `${hourAgo}:00`,
      },
    });

    const channelId = `op-${runId}-hours-1`;
    await ring(channelId);
    await awaitIncomingReady(channelId);
    expect(sendPushToAgent).not.toHaveBeenCalled();

    // Молчание касается только уведомлений: сам звонок обязан остаться в журнале,
    // иначе «часы приёма» означали бы «ночных обращений не существует».
    const record = await prisma.incomingCall.findUnique({ where: { channelId } });
    expect(record).not.toBeNull();

    // И пропущенный вне часов тоже никого не будит.
    await handleAriEvent({ type: "ChannelDestroyed", channel: inboundChannel(channelId) });
    expect(sendPushToAgent).not.toHaveBeenCalled();

    await prisma.settings.update({ where: { id: "singleton" }, data: { incomingHoursEnabled: false } });
  });

  it("окно через полночь считается сменой, а не пустым интервалом", async () => {
    const settings = await loadIncomingSettings();
    const night = { ...settings, hoursEnabled: true, hoursStart: "22:00", hoursEnd: "02:00" };
    // 23:30 по Душанбе — внутри смены.
    expect(incomingHoursOpen(night, dushanbeInputToDate("2026-08-11", "23:30"))).toBe(true);
    // 01:00 — тоже (это ещё та же смена).
    expect(incomingHoursOpen(night, dushanbeInputToDate("2026-08-12", "01:00"))).toBe(true);
    // 12:00 — уже нет.
    expect(incomingHoursOpen(night, dushanbeInputToDate("2026-08-11", "12:00"))).toBe(false);

    // Одинаковые границы — круглосуточно, а не «нисколько»: пустая смена означала бы
    // оператора, который не получает уведомлений никогда, и понять это по двум
    // одинаковым полям в Настройках человек не может.
    const same = { ...settings, hoursEnabled: true, hoursStart: "09:00", hoursEnd: "09:00" };
    expect(incomingHoursOpen(same, dushanbeInputToDate("2026-08-11", "03:00"))).toBe(true);
  });
});
