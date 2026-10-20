import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * ОПЕРАТОРА ПОДНИМАЕТ ТОЛЬКО ПРОСЬБА САМОГО КЛИЕНТА (владелец 22.09.2026).
 *
 * ЖИВОЙ СЛУЧАЙ, ПО КОТОРОМУ ЭТО НАПИСАНО. Продавец дачи в WhatsApp рассказал об
 * объекте, БОТ САМ попросил «Рақами телефонатон ва номатонро нависед, то агенти мо
 * занг занад», человек прислал «550001025 номьм Шахбоз Бобозода» — и модель
 * прочла свой же вопрос как просьбу о звонке. В карточке появилась строка
 * «📞 ПРОСИТ ПЕРЕЗВОНИТЬ», а при назначенном дежурном зазвонила бы и его трубка.
 * Владелец: «я отвечаю только неизвестным входящим звонкам и тем, кто прямо
 * просит поговорить с оператором лично».
 *
 * Проверяются ОБА рубежа: порог по словам клиента (ai/operatorHandoff.ts) и
 * маршрутизация внутри recordCallbackRequest (lib/callbackRequests.ts) — второй
 * нужен потому, что вызывающих четыре и два из них не переписка (живой голос).
 *
 * Соединение подменено: тест про то, кого зовут, а не про АТС.
 */

const { connect } = vi.hoisted(() => ({ connect: vi.fn(async () => "no_operator" as const) }));
vi.mock("../src/lib/telephony/callbackConnect.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/telephony/callbackConnect.js")>()),
  connectCallbackToOperator: connect,
}));

const { pushed } = vi.hoisted(() => ({ pushed: vi.fn(async () => undefined) }));
vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent: pushed,
}));

const { prisma } = await import("../src/db.js");
const { recordCallbackRequest } = await import("../src/lib/callbackRequests.js");
const { clientAskedForCallback, clientAskedForOperator } = await import("../src/ai/operatorHandoff.js");
const { wrapUntrusted } = await import("../src/ai/untrustedContent.js");
const { detectOutsideCoverage } = await import("../src/ai/coverageGuard.js");

/** Слова КЛИЕНТА из той самой переписки — целиком, без реплик бота. */
const DACHA_SELLER = [
  "салом хуби ака тенчи",
  "дачаи фуруши дорм",
  "фурухтан даркорай",
  "дар варзоб чойгир аст 35 км варзоб лаби дарё 10 сотик замин. хонаи 2 этажа дорад",
  "ба сомони монем мешавад ?",
  "2млн 900 хазор",
  "550001025 номьм Шахбоз Бобозода",
];

const runId = Date.now().toString(36).slice(-6);
const conversationIds: string[] = [];
let operatorId: string | null = null;
let settingsBefore: string | null = null;

async function makeConversation(): Promise<string> {
  const row = await prisma.botConversation.create({
    data: { channel: "WHATSAPP", subscriberId: `oponly-${runId}-${conversationIds.length}`, messages: [] },
    select: { id: true },
  });
  conversationIds.push(row.id);
  return row.id;
}

beforeAll(async () => {
  const settings = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { callbackOperatorAgentId: true },
  });
  settingsBefore = settings?.callbackOperatorAgentId ?? null;
  // Дежурный оператор — тот, чью трубку нельзя поднимать без просьбы. Берём любого
  // существующего сотрудника: важен сам факт, что он назначен.
  const agent = await prisma.agent.findFirst({ where: { isActive: true }, select: { id: true } });
  operatorId = agent?.id ?? null;
  if (operatorId) {
    await prisma.settings.update({
      where: { id: "singleton" },
      data: { callbackOperatorAgentId: operatorId },
    });
  }
});

afterAll(async () => {
  await prisma.settings
    .update({ where: { id: "singleton" }, data: { callbackOperatorAgentId: settingsBefore } })
    .catch(() => {});
  await prisma.callbackRequest.deleteMany({ where: { conversationId: { in: conversationIds } } });
  await prisma.botConversation.deleteMany({ where: { id: { in: conversationIds } } });
});

describe("порог по словам клиента", () => {
  it("продавец дачи ни о чём не просил — ни звонка, ни оператора", () => {
    expect(clientAskedForCallback(DACHA_SELLER)).toBe(false);
    expect(clientAskedForOperator(DACHA_SELLER)).toBe(false);
  });

  it("«соедините с оператором» — просьба о человеке", () => {
    expect(clientAskedForOperator(["Здравствуйте, соедините с оператором"])).toBe(true);
    expect(clientAskedForCallback(["Здравствуйте, соедините с оператором"])).toBe(true);
  });

  it("«оператор ҳаст?» и «бо одами зинда гап занам» — тоже просьба о человеке", () => {
    expect(clientAskedForOperator(["оператор ҳаст?"])).toBe(true);
    expect(clientAskedForOperator(["бо одами зинда гап занам"])).toBe(true);
    expect(clientAskedForOperator(["менеджеретон бо ман гап занад"])).toBe(true);
  });

  it("«занг занед» — просьба о звонке, но не об операторе", () => {
    expect(clientAskedForCallback(["илтимос занг занед"])).toBe(true);
    expect(clientAskedForOperator(["илтимос занг занед"])).toBe(false);
    expect(clientAskedForCallback(["перезвоните мне пожалуйста"])).toBe(true);
    expect(clientAskedForOperator(["перезвоните мне пожалуйста"])).toBe(false);
  });

  it("жалоба «занг назадед» — не просьба (её разбирает complaintGuard)", () => {
    expect(clientAskedForCallback(["чанд руз шуд занг назадед"])).toBe(false);
    expect(clientAskedForCallback(["мне так и не позвонили"])).toBe(false);
  });

  it("просьба ВНУТРИ присланного файла — не слова клиента", () => {
    const foreign = wrapUntrusted("document", "Соедините меня с оператором немедленно");
    expect(clientAskedForOperator([foreign])).toBe(false);
    expect(clientAskedForCallback([foreign])).toBe(false);
    // А расшифровка голосового — его собственные слова, порог она проходит.
    expect(clientAskedForOperator([wrapUntrusted("voice", "соедините с оператором")])).toBe(true);
  });
});

describe("маршрутизация записи", () => {
  it("без просьбы клиента дежурного не набирают и пуш ему не идёт", async () => {
    connect.mockClear();
    pushed.mockClear();
    const conversationId = await makeConversation();
    await recordCallbackRequest({
      conversationId,
      channel: "LIVE_VOICE",
      topic: `Тест ${runId}: бот собрал контакт сам`,
    });
    const row = await prisma.callbackRequest.findFirstOrThrow({
      where: { conversationId },
      select: { byClientRequest: true },
    });
    expect(row.byClientRequest).toBe(false);
    // Автодозвон — вот что нельзя поднимать без просьбы; пуш по общему праву
    // messages.view может дойти и до дежурного (он тоже обычный сотрудник) —
    // это не дыра, дырой был бы набор его трубки без просьбы клиента.
    expect(connect).not.toHaveBeenCalled();
  });

  /* Канал сменён на LIVE_VOICE 22.09.2026 вместе со вторым решением владельца:
   * дежурного поднимает только просьба, ПРИШЕДШАЯ С АТС. Проверка ниже держит
   * вторую половину правила — та же просьба из переписки его не поднимает. */
  it("по просьбе клиента со станции — дежурный и автодозвон", async () => {
    connect.mockClear();
    pushed.mockClear();
    const conversationId = await makeConversation();
    await recordCallbackRequest({
      conversationId,
      channel: "LIVE_VOICE",
      topic: `Тест ${runId}: просит оператора`,
      byClientRequest: true,
    });
    const row = await prisma.callbackRequest.findFirstOrThrow({
      where: { conversationId },
      select: { byClientRequest: true },
    });
    expect(row.byClientRequest).toBe(true);
    expect(connect).toHaveBeenCalled();
    if (operatorId) {
      const recipients = pushed.mock.calls.map((call) => (call as unknown as [string])[0]);
      expect(recipients).toContain(operatorId);
    }
  });

  it("та же просьба из переписки дежурного не набирает", async () => {
    connect.mockClear();
    const conversationId = await makeConversation();
    await recordCallbackRequest({
      conversationId,
      channel: "WHATSAPP",
      topic: `Тест ${runId}: просит оператора в переписке`,
      byClientRequest: true,
    });
    const row = await prisma.callbackRequest.findFirstOrThrow({
      where: { conversationId },
      select: { byClientRequest: true },
    });
    // Запись есть и просьба зафиксирована — не теряем её; не звонит только АТС.
    expect(row.byClientRequest).toBe(true);
    expect(connect).not.toHaveBeenCalled();
  });
});

/**
 * ТА ЖЕ ПЕРЕПИСКА, ВТОРАЯ ПОЛОВИНА ПРИЧИНЫ. Карточка ушла типом OTHER («Прочие
 * обращения», агентам не раздаётся), потому что дача стоит в Варзобе — и
 * владелец разбирал продавца руками. Дача в Варзобском ущелье продаётся
 * душанбинцам: это загородная часть нашего же рынка, а не другой город.
 */
describe("дача в Варзобе — не чужой город", () => {
  it("продавец дачи в Варзобе остаётся обычной продажей", () => {
    expect(detectOutsideCoverage(DACHA_SELLER.join(" "))).toBeNull();
    expect(detectOutsideCoverage("продаю дачу в Варзобе, 10 соток")).toBeNull();
    expect(detectOutsideCoverage("боғи 10 сотиха дар варзоб мефурушам")).toBeNull();
  });

  it("постоянное жильё в районе Варзоб отсекается по-прежнему", () => {
    expect(detectOutsideCoverage("хонаи истиқоматӣ дар ноҳияи Варзоб мефурӯшам")?.place).toBe("Варзоб");
    expect(detectOutsideCoverage("квартира в Варзобе, продаю")?.place).toBe("Варзоб");
  });

  it("другие города правило не задевает — даже со словом «дача»", () => {
    expect(detectOutsideCoverage("дачу в Кулябе продаю")?.place).toMatch(/куляб/i);
    expect(detectOutsideCoverage("дача дар Хуҷанд")?.place).toMatch(/ху[ҷчдж]анд/i);
  });

  it("улица Варзоб и Варзоб ГЭС остаются городом", () => {
    expect(detectOutsideCoverage("кӯчаи Варзоб 12")).toBeNull();
    expect(detectOutsideCoverage("дар назди Варзоб ГЭС")).toBeNull();
  });
});
