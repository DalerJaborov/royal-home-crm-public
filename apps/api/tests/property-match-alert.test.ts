import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import { notifyWaitingBuyersOfNewProperty } from "../src/lib/propertyMatchFilter.js";

/**
 * Автоуведомление агента: объект встал в AVAILABLE → кому из ждущих покупателей
 * он подходит (docs/auto-match-alert-plan-31-08-2026.md). Проверяется САМА функция
 * напрямую, не через HTTP-роут — она вызывается из нескольких мест перехода объекта
 * в AVAILABLE (crud.ts create/PATCH, propertyPipeline.ts publishAfterEditingComplete),
 * и дублировать проверку в каждом было бы избыточно; здесь — её собственный контракт.
 *
 * push.js замокан на весь файл: реального VAPID в тестовой среде нет, sendPushToAgent
 * и так возвращает 0 без отправки — мок нужен не для этого, а чтобы посчитать, СКОЛЬКО
 * раз он вызван (проверка группировки пушей в один на агента, см. блок ниже).
 */
vi.mock("../src/push.js", async (importOriginal) => ({
  // Подмена ДОПОЛНЯЕТ модуль, а не заменяет его целиком (19.09.2026):
  // фабрика без importOriginal убирает остальные экспорты у всего
  // процесса, и СОСЕДНИЙ тест падает на «No "…" export is defined».
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent: vi.fn().mockResolvedValue(0),
}));
import { sendPushToAgent } from "../src/push.js";

const runId = Date.now();
let districtId: string;
let otherDistrictId: string;
const extraDistrictIds: string[] = [];
let agentId: string;
const clientIds: string[] = [];
const propertyIds: string[] = [];

async function makeAgent() {
  const a = await prisma.agent.create({
    data: { fullName: `Агент автоподбора ${runId}`, phone: `+992945${runId}`, role: "AGENT", passwordHash: "x" },
  });
  return a.id;
}

async function makeClient(data: Record<string, unknown>) {
  const c = await prisma.client.create({
    data: {
      fullName: `Покупатель-${clientIds.length}-${runId}`,
      phone: `+9929${runId.toString().slice(-8)}${clientIds.length}`,
      status: "NEW",
      kind: "BUYER",
      workStatus: "ACTIVE",
      source: "WEBSITE",
      assignedAgentId: agentId,
      currency: "TJS",
      ...data,
    } as never,
  });
  clientIds.push(c.id);
  return c;
}

async function makeProperty(data: Record<string, unknown>) {
  const p = await prisma.property.create({
    data: {
      title: `Объект автоподбора ${runId}-${propertyIds.length}`,
      type: "APARTMENT",
      areaSqm: 60,
      rooms: 3,
      price: 400000,
      currency: "TJS",
      districtId,
      address: "Тестовая, 1",
      condition: "GOOD",
      status: "AVAILABLE",
      ...data,
    } as never,
  });
  propertyIds.push(p.id);
  return p;
}

/**
 * Свежий район под один тест — нужен там, где важен ТОЧНЫЙ счёт совпадений
 * (группировка пуша ниже): клиенты между it() внутри файла не удаляются
 * (только в afterAll), и общий район подмешал бы в выборку клиентов из уже
 * прошедших тестов.
 */
async function makeIsolatedDistrict() {
  const d = await prisma.district.create({ data: { name: `Автоподбор-изолир-${runId}-${extraDistrictIds.length}` } });
  extraDistrictIds.push(d.id);
  return d.id;
}

/** Записи автоподбора в хронологии клиентов из этого прогона. */
async function autoMatchInteractions(propertyId: string) {
  return prisma.interaction.findMany({
    where: { propertyId, clientId: { in: clientIds }, type: "SYSTEM", notes: { startsWith: "Автоподбор:" } },
  });
}

beforeAll(async () => {
  const [d1, d2] = await Promise.all([
    prisma.district.create({ data: { name: `Автоподбор-${runId}` } }),
    prisma.district.create({ data: { name: `Автоподбор-чужой-${runId}` } }),
  ]);
  districtId = d1.id;
  otherDistrictId = d2.id;
  agentId = await makeAgent();
});

afterAll(async () => {
  await prisma.interaction.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.district.deleteMany({ where: { id: { in: [districtId, otherDistrictId, ...extraDistrictIds] } } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
});

describe("notifyWaitingBuyersOfNewProperty", () => {
  it("подходящему ждущему клиенту уходит запись в хронологию с номерами объекта и клиента", async () => {
    const property = await makeProperty({});
    const client = await makeClient({ desiredDistrictId: districtId, desiredRooms: 3, budgetMax: 450000 });

    await notifyWaitingBuyersOfNewProperty(property);

    const rows = await autoMatchInteractions(property.id);
    const mine = rows.find((r) => r.clientId === client.id);
    expect(mine).toBeDefined();
    // Автоподбор — алгоритм, не решение агента (П-10, 17.09.2026): kind "ai",
    // agentId пуст, держатель виден через subjectAgentId.
    expect(mine!.actorKind).toBe("AI");
    expect(mine!.agentId).toBeNull();
    expect(mine!.subjectAgentId).toBe(agentId);
    expect(mine!.notes).toContain(`№${property.shortId}`);
    expect(mine!.notes).toContain(`№${client.shortId}`);
  });

  it("клиенту из другого района без желаемых мест запись не создаётся", async () => {
    const property = await makeProperty({});
    const foreign = await makeClient({ desiredDistrictId: otherDistrictId, budgetMax: 450000 });

    await notifyWaitingBuyersOfNewProperty(property);

    const rows = await autoMatchInteractions(property.id);
    expect(rows.map((r) => r.clientId)).not.toContain(foreign.id);
  });

  /**
   * 12.09.2026, docs/geo-match-plan-12-09.md блок D3: район и радиус — РАЗНЫЕ
   * пути к совпадению, не ужесточение друг друга. Клиент из ЧУЖОГО района, но с
   * желаемым местом ровно в точке объекта, теперь тоже получает запись — иначе
   * ClientDesiredPlace никогда не спасал бы совпадение, ради которого заводился
   * (владелец: клиент искал «у ЦУМа», объект встал в соседнем районе).
   */
  it("клиенту из другого района, но с желаемым местом рядом с объектом, запись создаётся", async () => {
    const property = await makeProperty({ lat: 38.5598, lng: 68.787 });
    const nearby = await makeClient({
      desiredDistrictId: otherDistrictId,
      budgetMax: 450000,
      desiredPlaces: { create: [{ lat: 38.5598, lng: 68.787, radiusM: 1000, label: "Тестовый ориентир" }] },
    });

    await notifyWaitingBuyersOfNewProperty(property);

    const rows = await autoMatchInteractions(property.id);
    const mine = rows.find((r) => r.clientId === nearby.id);
    expect(mine).toBeDefined();
    expect(mine!.notes).toContain("Тестовый ориентир");
  });

  it("клиенту из другого района с желаемым местом ДАЛЕКО от объекта запись не создаётся — радиус не резиновый", async () => {
    const property = await makeProperty({ lat: 38.5598, lng: 68.787 });
    const far = await makeClient({
      desiredDistrictId: otherDistrictId,
      budgetMax: 450000,
      // ~3 км от точки объекта по широте — внутри грубого SQL bbox-предфильтра
      // (потолок 10 км), но заведомо за пределами РЕАЛЬНОГО радиуса места 1000 м:
      // проверяет именно точный JS-расчёт (nearestDesiredPlace), а не сам bbox.
      desiredPlaces: { create: [{ lat: 38.5868, lng: 68.787, radiusM: 1000, label: "Далёкий ориентир" }] },
    });

    await notifyWaitingBuyersOfNewProperty(property);

    const rows = await autoMatchInteractions(property.id);
    expect(rows.map((r) => r.clientId)).not.toContain(far.id);
  });

  it("клиенту без единого заданного требования запись не создаётся — иначе под фильтр попал бы любой активный покупатель", async () => {
    const property = await makeProperty({});
    const blank = await makeClient({});

    await notifyWaitingBuyersOfNewProperty(property);

    const rows = await autoMatchInteractions(property.id);
    expect(rows.map((r) => r.clientId)).not.toContain(blank.id);
  });

  /**
   * 12.09.2026, docs/geo-match-plan-12-09.md блок D6 — ИМЕННО ради потерянных,
   * неактивных и отложенных клиентов функция и затевалась (владелец: клиент
   * искал у ЦУМа, месяц спустя другой агент завёл подходящий объект). До этой
   * правки workStatus=INACTIVE отсекался — теперь входит в выборку наравне с
   * ACTIVE.
   */
  it("неактивному клиенту (workStatus=INACTIVE) запись создаётся — потерянные и неактивные тоже в подборе", async () => {
    const property = await makeProperty({});
    const inactive = await makeClient({ desiredDistrictId: districtId, budgetMax: 450000, workStatus: "INACTIVE" });

    await notifyWaitingBuyersOfNewProperty(property);

    const rows = await autoMatchInteractions(property.id);
    expect(rows.map((r) => r.clientId)).toContain(inactive.id);
  });

  describe("отложенные клиенты (workStatus=DEFERRED) — собственный срочный сигнал", () => {
    /**
     * План требует «звонок в тот же день, а не по таймеру» — отложенный клиент
     * получает задачу «перезвонить сегодня» в самой записи хронологии и
     * ОТДЕЛЬНЫЙ (не сгруппированный) пуш, а не молчаливое попадание в общий
     * список группового уведомления наравне с рядовыми совпадениями.
     */
    it("отложенному клиенту запись создаётся с задачей «перезвонить сегодня» и отдельным пушем", async () => {
      const pushMock = vi.mocked(sendPushToAgent);
      pushMock.mockClear();

      const isolated = await makeIsolatedDistrict();
      const property = await makeProperty({ districtId: isolated });
      const deferred = await makeClient({ desiredDistrictId: isolated, budgetMax: 450000, workStatus: "DEFERRED" });

      await notifyWaitingBuyersOfNewProperty(property);

      const rows = await autoMatchInteractions(property.id);
      const mine = rows.find((r) => r.clientId === deferred.id);
      expect(mine).toBeDefined();
      expect(mine!.nextAction).toContain(`№${property.shortId}`);
      expect(mine!.nextActionDate).not.toBeNull();

      const deferredCalls = pushMock.mock.calls.filter(
        ([, payload]) => payload.tag === `match-alert-deferred-${deferred.id}-${property.id}`
      );
      expect(deferredCalls).toHaveLength(1);
      expect(deferredCalls[0][1].kind).toBe("look");

      // НЕ в общей группировке — обычный групповой/одиночный тег на этот же
      // объект+агента отложенному клиенту не принадлежит.
      const groupOrSingleCalls = pushMock.mock.calls.filter(
        ([id, payload]) => id === agentId && payload.tag !== `match-alert-deferred-${deferred.id}-${property.id}`
      );
      expect(groupOrSingleCalls.every((c) => !c[1].body?.includes(String(deferred.shortId)))).toBe(true);
    });
  });

  it("клиенту в «Переговорах» по другому объекту запись не создаётся — он уже занят сделкой", async () => {
    const property = await makeProperty({});
    const negotiating = await makeClient({
      desiredDistrictId: districtId,
      budgetMax: 450000,
      buyerStage: "NEGOTIATION",
    });

    await notifyWaitingBuyersOfNewProperty(property);

    const rows = await autoMatchInteractions(property.id);
    expect(rows.map((r) => r.clientId)).not.toContain(negotiating.id);
  });

  it("клиенту без назначенного агента запись не создаётся — уведомлять некого", async () => {
    const property = await makeProperty({});
    const unassigned = await makeClient({
      desiredDistrictId: districtId,
      budgetMax: 450000,
      assignedAgentId: null,
    });

    await notifyWaitingBuyersOfNewProperty(property);

    const rows = await autoMatchInteractions(property.id);
    expect(rows.map((r) => r.clientId)).not.toContain(unassigned.id);
  });

  it("бюджет клиента ниже цены объекта больше чем на допуск — запись не создаётся", async () => {
    const property = await makeProperty({ price: 400000, currency: "TJS" });
    const tooCheap = await makeClient({ desiredDistrictId: districtId, budgetMax: 300000 });

    await notifyWaitingBuyersOfNewProperty(property);

    const rows = await autoMatchInteractions(property.id);
    expect(rows.map((r) => r.clientId)).not.toContain(tooCheap.id);
  });

  it("повторный вызов по той же паре клиент+объект не дублирует запись — дедуп по хронологии", async () => {
    const property = await makeProperty({});
    const client = await makeClient({ desiredDistrictId: districtId, budgetMax: 450000 });

    await notifyWaitingBuyersOfNewProperty(property);
    await notifyWaitingBuyersOfNewProperty(property);

    const rows = await autoMatchInteractions(property.id);
    expect(rows.filter((r) => r.clientId === client.id)).toHaveLength(1);
  });

  /**
   * Решение владельца 12.09.2026 («все да» п.5): дедуп по паре клиент+объект не
   * абсолютный — снижение цены на 5% и больше от цены последнего уведомления
   * пробивает его заново.
   */
  describe("повторное уведомление при снижении цены (решение владельца 12.09.2026 п.5)", () => {
    it("цена упала на 5% и больше — уходит вторая запись с пометкой о снижении цены", async () => {
      const property = await makeProperty({ price: 400000 });
      const client = await makeClient({ desiredDistrictId: districtId, budgetMax: 450000 });

      await notifyWaitingBuyersOfNewProperty(property);
      await notifyWaitingBuyersOfNewProperty({ ...property, price: 380000 }); // -5% ровно

      const rows = await autoMatchInteractions(property.id).then((r) => r.filter((x) => x.clientId === client.id));
      expect(rows).toHaveLength(2);
      expect(rows.some((r) => r.notes.includes("снижена цена"))).toBe(true);
      expect(Number(rows.find((r) => r.notes.includes("снижена цена"))!.matchNotifiedPriceTjs)).toBe(380000);
    });

    it("цена упала меньше чем на 5% — вторая запись не создаётся", async () => {
      const property = await makeProperty({ price: 400000 });
      const client = await makeClient({ desiredDistrictId: districtId, budgetMax: 450000 });

      await notifyWaitingBuyersOfNewProperty(property);
      await notifyWaitingBuyersOfNewProperty({ ...property, price: 390000 }); // -2,5%

      const rows = await autoMatchInteractions(property.id).then((r) => r.filter((x) => x.clientId === client.id));
      expect(rows).toHaveLength(1);
    });

    it("второе падение цены подряд сравнивается с последним уведомлением, не с первым", async () => {
      const property = await makeProperty({ price: 400000 });
      const client = await makeClient({ desiredDistrictId: districtId, budgetMax: 450000 });

      await notifyWaitingBuyersOfNewProperty(property); // 400000
      await notifyWaitingBuyersOfNewProperty({ ...property, price: 380000 }); // -5% от 400000 — пробивает
      // Ещё -3% от 380000 (368 600) — от ПЕРВОЙ цены (400000) это было бы -7,85% и пробило бы дедуп
      // по ошибке; от последней (380000) порог не достигнут — новой записи быть не должно.
      await notifyWaitingBuyersOfNewProperty({ ...property, price: 368600 });

      const rows = await autoMatchInteractions(property.id).then((r) => r.filter((x) => x.clientId === client.id));
      expect(rows).toHaveLength(2);
    });
  });

  it("объект без совпадений не бросает ошибку", async () => {
    const property = await makeProperty({});
    await expect(notifyWaitingBuyersOfNewProperty(property)).resolves.toBeUndefined();
  });

  describe("пуш обычным клиентам убран (владелец 02.10.2026)", () => {
    /**
     * «Подходящий объект появился» / «… сразу N клиентам» / «Снижена цена» агенту
     * больше не шлются. Запись в хронологии клиента остаётся, отложенным — свой
     * срочный пуш (тест выше).
     */
    it("двум клиентам одного агента — пуша нет, записи в хронологии есть", async () => {
      const pushMock = vi.mocked(sendPushToAgent);
      pushMock.mockClear();

      const isolated = await makeIsolatedDistrict();
      const property = await makeProperty({ districtId: isolated });
      const first = await makeClient({ desiredDistrictId: isolated, budgetMax: 450000 });
      const second = await makeClient({ desiredDistrictId: isolated, budgetMax: 450000 });

      await notifyWaitingBuyersOfNewProperty(property);

      expect(pushMock.mock.calls.filter(([id]) => id === agentId)).toHaveLength(0);
      const rows = await autoMatchInteractions(property.id);
      expect(rows.map((r) => r.clientId).sort()).toEqual([first.id, second.id].sort());
    });

    it("одному клиенту — пуша нет, запись в хронологии есть", async () => {
      const pushMock = vi.mocked(sendPushToAgent);
      pushMock.mockClear();

      const isolated = await makeIsolatedDistrict();
      const property = await makeProperty({ districtId: isolated });
      const client = await makeClient({ desiredDistrictId: isolated, budgetMax: 450000 });

      await notifyWaitingBuyersOfNewProperty(property);

      expect(pushMock.mock.calls.filter(([id]) => id === agentId)).toHaveLength(0);
      const rows = await autoMatchInteractions(property.id);
      expect(rows.map((r) => r.clientId)).toContain(client.id);
    });
  });
});
