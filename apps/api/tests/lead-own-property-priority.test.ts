import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { assignAgentForLead } from "../src/leads.js";

/**
 * «Свой объект — свой клиент» (решение владельца 11.08.2026).
 *
 * Агент, который сам съездил к собственнику, отснял фото и видео и завёл объект,
 * получает клиента по этому объекту вне очереди по KPI: он зарабатывает на таком
 * лиде обе половины комиссии, и в этом весь смысл правила.
 *
 * Два основания, и они РАЗНОЙ силы:
 *   — бот уже показывал клиенту объект: безусловно, без порога;
 *   — запрос совпал с объектом: только выше порога из Настроек.
 *
 * Последний тест — регресс-щит: с выключенным рубильником распределение обязано
 * вести себя ровно как до 11.08.2026.
 */

const runId = Date.now();

let districtId: string;
let ownerId: string;
let rivalId: string;
let strongId: string;
let exactPropertyId: string;
let exactShortId: number;
let weakPropertyId: string;
let clientId: string;
/** Все посторонние агенты (сиды и соседние тесты) — их исключаем из выбора. */
let outsiders: string[] = [];
let saved: Record<string, unknown> = {};

const TOUCHED = [
  "ownPropertyPriorityEnabled",
  "ownPropertyMatchThreshold",
  "ownPropertyShownExceptionEnabled",
  "ownPropertyShownWindowDays",
  "leadDistributionStrategy",
  "leadActiveLimit",
  "ownPropertyOverLimitEnabled",
  "ownPropertyLeadCap",
] as const;

async function setRules(patch: Record<string, unknown>) {
  await prisma.settings.update({ where: { id: "singleton" }, data: patch });
}

async function makeProperty(opts: { rooms: number; price: number; intakeAgentId: string }) {
  return prisma.property.create({
    data: {
      title: `Объект правила ${opts.rooms}к ${runId}`,
      type: "APARTMENT",
      areaSqm: 60,
      rooms: opts.rooms,
      price: opts.price,
      currency: "TJS",
      districtId,
      address: "Тестовая, 1",
      condition: "GOOD",
      status: "AVAILABLE",
      intakeAgentId: opts.intakeAgentId,
    },
  });
}

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Тест-правило-${runId}` } })).id;

  // KPI подобран нарочно: хозяин объекта — САМЫЙ СЛАБЫЙ. Если правило работает,
  // он всё равно выигрывает у сильных, и это единственное, что тест проверяет.
  const mk = async (name: string, phone: string, kpi: number) =>
    (
      await prisma.agent.create({
        data: { fullName: name, phone, role: "AGENT", passwordHash: "x", kpi },
      })
    ).id;
  ownerId = await mk("Хозяин объекта", `+992905${runId}`, 20);
  rivalId = await mk("Хозяин второго объекта", `+992904${runId}`, 50);
  strongId = await mk("Сильный агент", `+992903${runId}`, 99);

  outsiders = (
    await prisma.agent.findMany({
      where: { role: "AGENT", id: { notIn: [ownerId, rivalId, strongId] } },
      select: { id: true },
    })
  ).map((a) => a.id);

  const exact = await makeProperty({ rooms: 3, price: 300_000, intakeAgentId: ownerId });
  exactPropertyId = exact.id;
  exactShortId = exact.shortId;
  weakPropertyId = (await makeProperty({ rooms: 4, price: 430_000, intakeAgentId: rivalId })).id;

  const client = await prisma.client.create({
    data: {
      fullName: `Клиент правила ${runId}`,
      phone: `+992902${runId}`,
      source: "INSTAGRAM",
      kind: "BUYER",
      status: "NEW",
      currency: "TJS",
      budgetMin: 250_000,
      budgetMax: 400_000,
      desiredDistrictId: districtId,
      desiredRooms: 3,
    },
  });
  clientId = client.id;

  const current = await prisma.settings.upsert({
    where: { id: "singleton" },
    update: {},
    create: { id: "singleton" },
  });
  saved = Object.fromEntries(TOUCHED.map((k) => [k, (current as Record<string, unknown>)[k]]));
  await setRules({
    ownPropertyPriorityEnabled: true,
    ownPropertyMatchThreshold: 85,
    ownPropertyShownExceptionEnabled: true,
    ownPropertyShownWindowDays: 30,
    leadDistributionStrategy: "fair",
  });
});

afterEach(async () => {
  await prisma.propertyExposure.deleteMany({ where: { clientId } });
});

afterAll(async () => {
  await prisma.settings.update({ where: { id: "singleton" }, data: saved });
  await prisma.propertyExposure.deleteMany({ where: { clientId } });
  await prisma.interaction.deleteMany({ where: { clientId } });
  await prisma.client.deleteMany({ where: { id: clientId } });
  await prisma.property.deleteMany({ where: { id: { in: [exactPropertyId, weakPropertyId] } } });
  await prisma.agent.deleteMany({ where: { id: { in: [ownerId, rivalId, strongId] } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.$disconnect();
});

describe("Бот показал объект — лид хозяину, безусловно", () => {
  it("хозяин получает клиента мимо очереди даже с самым низким KPI", async () => {
    await prisma.propertyExposure.create({
      data: {
        channel: "INSTAGRAM",
        recipientId: `psid-${runId}`,
        clientId,
        propertyId: exactPropertyId,
        shortId: exactShortId,
        kind: "PHOTO",
      },
    });

    const assignment = await assignAgentForLead({ clientId }, outsiders);
    expect(assignment.agentId).toBe(ownerId);
    expect(assignment.reason).toBe("own_property_shown");
    expect(assignment.propertyShortId).toBe(exactShortId);
  });

  it("правило работает по переписке, когда карточки клиента ещё нет", async () => {
    // Обычный случай: бот показывает объекты РАНЬШЕ, чем узнаёт телефон.
    const recipientId = `psid-nocard-${runId}`;
    await prisma.propertyExposure.create({
      data: {
        channel: "INSTAGRAM",
        recipientId,
        propertyId: exactPropertyId,
        shortId: exactShortId,
        kind: "LINK",
      },
    });

    const assignment = await assignAgentForLead({ channel: "INSTAGRAM", recipientId }, outsiders);
    expect(assignment.agentId).toBe(ownerId);
    expect(assignment.reason).toBe("own_property_shown");

    await prisma.propertyExposure.deleteMany({ where: { recipientId } });
  });

  it("показ старше окна из Настроек уже не считается", async () => {
    await prisma.propertyExposure.create({
      data: {
        channel: "INSTAGRAM",
        recipientId: `psid-old-${runId}`,
        clientId,
        propertyId: exactPropertyId,
        shortId: exactShortId,
        kind: "PHOTO",
        sentAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000),
      },
    });

    const assignment = await assignAgentForLead({ clientId }, outsiders);
    // Совпадение при этом точное — сработает второе правило, но причина другая.
    expect(assignment.reason).toBe("own_property_match");
  });

  /**
   * ПЕРЕВЁРНУТО 11.09.2026 (Пачка 1 п.3, ownership-audit-11-09.md): раньше пауза
   * агента-хозяина отдавала лид очереди — владелец решил, что владение объектом
   * сильнее паузы. Теперь пауза/заморозка НЕ отменяют правило, лид всё равно
   * уходит хозяину, а руководитель узнаёт об этом пушем (assignment.ts::
   * notifyOwnerUnavailable). Уволенного/деактивированного агента правило по-
   * прежнему не касается — см. следующий тест.
   */
  it("хозяин на паузе («не принимаю лиды») — лид всё равно ему", async () => {
    await prisma.propertyExposure.create({
      data: {
        channel: "INSTAGRAM",
        recipientId: `psid-${runId}`,
        clientId,
        propertyId: exactPropertyId,
        shortId: exactShortId,
        kind: "PHOTO",
      },
    });
    await prisma.agent.update({
      where: { id: ownerId },
      data: { leadsPausedUntil: new Date(Date.now() + 60 * 60_000) },
    });

    const assignment = await assignAgentForLead({ clientId }, outsiders);
    expect(assignment.agentId).toBe(ownerId);

    await prisma.agent.update({ where: { id: ownerId }, data: { leadsPausedUntil: null } });
  });

  it("хозяин заморожен — лид всё равно ему", async () => {
    await prisma.propertyExposure.create({
      data: {
        channel: "INSTAGRAM",
        recipientId: `psid-frozen-${runId}`,
        clientId,
        propertyId: exactPropertyId,
        shortId: exactShortId,
        kind: "PHOTO",
      },
    });
    await prisma.agent.update({ where: { id: ownerId }, data: { frozenAt: new Date() } });

    const assignment = await assignAgentForLead({ clientId }, outsiders);
    expect(assignment.agentId).toBe(ownerId);

    await prisma.agent.update({ where: { id: ownerId }, data: { frozenAt: null } });
  });

  it("хозяин уволен (isActive=false) — правило уступает обычной очереди", async () => {
    await prisma.propertyExposure.create({
      data: {
        channel: "INSTAGRAM",
        recipientId: `psid-fired-${runId}`,
        clientId,
        propertyId: exactPropertyId,
        shortId: exactShortId,
        kind: "PHOTO",
      },
    });
    await prisma.agent.update({ where: { id: ownerId }, data: { isActive: false } });

    const assignment = await assignAgentForLead({ clientId }, outsiders);
    expect(assignment.agentId).not.toBe(ownerId);

    await prisma.agent.update({ where: { id: ownerId }, data: { isActive: true } });
  });
});

describe("Совпадение запроса с объектом", () => {
  it("совпадение выше порога отдаёт лид хозяину", async () => {
    // Точное попадание — 100 из 100 при пороге 85.
    const assignment = await assignAgentForLead({ clientId }, outsiders);
    expect(assignment.agentId).toBe(ownerId);
    expect(assignment.reason).toBe("own_property_match");
    expect(assignment.score).toBe(100);
  });

  it("совпадение ниже порога уходит обычной очередью", async () => {
    await setRules({ ownPropertyMatchThreshold: 100 });
    // Тот же объект даёт ровно 100 — поднимаем порог выше достижимого.
    await prisma.property.update({ where: { id: exactPropertyId }, data: { rooms: 4 } });

    const assignment = await assignAgentForLead({ clientId }, outsiders);
    expect(assignment.reason).toBe("queue");

    await prisma.property.update({ where: { id: exactPropertyId }, data: { rooms: 3 } });
    await setRules({ ownPropertyMatchThreshold: 85 });
  });

  it("спорят двое — выигрывает тот, у кого объект подходит точнее", async () => {
    // Порог опущен, чтобы в спор попал и слабый объект соперника (65 из 100).
    await setRules({ ownPropertyMatchThreshold: 60 });

    const assignment = await assignAgentForLead({ clientId }, outsiders);
    expect(assignment.agentId).toBe(ownerId);
    expect(assignment.score).toBe(100);

    await setRules({ ownPropertyMatchThreshold: 85 });
  });

  it("при равном совпадении спор решает очередь по KPI, а не порядок в базе", async () => {
    // У соперника точно такой же объект — баллы равны, решает уровень KPI.
    const twin = await makeProperty({ rooms: 3, price: 300_000, intakeAgentId: rivalId });

    const assignment = await assignAgentForLead({ clientId }, outsiders);
    expect(assignment.reason).toBe("own_property_match");
    // KPI 50 против 20 — соперник выше уровнем и забирает ничью.
    expect(assignment.agentId).toBe(rivalId);

    await prisma.property.deleteMany({ where: { id: twin.id } });
  });
});

/**
 * ЛИМИТА ДЛЯ СВОЕГО ОБЪЕКТА БОЛЬШЕ НЕТ ВООБЩЕ (Пачка 1 п.1, 11.09.2026,
 * ownership-audit-11-09.md: «клиент, интересующийся конкретным объектом,
 * уходит агенту этого объекта безоговорочно: без проверки портфеля»).
 *
 * До этой правки здесь стоял потолок activeLimit+ownPropertyLeadCap (решение
 * владельца 13.08.2026) — три теста ниже раньше проверяли именно его: один
 * такой же лид всё ещё проходил под потолком, второй блокировался НА потолке.
 * Теперь блокировки нет ни при каком размере портфеля — старые Settings-поля
 * (`ownPropertyOverLimitEnabled`, `ownPropertyLeadCap`) остаются в схеме ради
 * совместимости, но canTakeOwnPropertyLead их больше не читает.
 */
describe("Лимита для своего объекта больше нет (решение владельца 11.09.2026)", () => {
  const portfolioIds: string[] = [];

  async function fillOwnerPortfolio(ownCount: number) {
    for (let i = 0; i < ownCount; i++) {
      const c = await prisma.client.create({
        data: {
          fullName: `Свой клиент хозяина ${i} ${runId}`,
          phone: `+992906${i}${runId}`,
          source: "PHONE_CALL",
          status: "NEW",
          assignedAgentId: ownerId,
          acceptedAt: new Date(),
          ownPropertyLead: true,
        },
      });
      portfolioIds.push(c.id);
    }
  }

  afterEach(async () => {
    if (portfolioIds.length === 0) return;
    await prisma.client.deleteMany({ where: { id: { in: portfolioIds } } });
    portfolioIds.length = 0;
  });

  it("портфель забит далеко за старый потолок (activeLimit=2, было бы cap=1 → 3) — лид всё равно хозяину", async () => {
    await setRules({ leadActiveLimit: 2, ownPropertyOverLimitEnabled: true, ownPropertyLeadCap: 1 });
    await fillOwnerPortfolio(3); // раньше блокировало ровно на этом числе

    const assignment = await assignAgentForLead({ clientId }, outsiders);
    expect(assignment.agentId).toBe(ownerId);
    expect(assignment.reason).toBe("own_property_match");
  });

  it("рубильник ownPropertyOverLimitEnabled выключен — правило всё равно не читает лимит", async () => {
    await setRules({ leadActiveLimit: 2, ownPropertyOverLimitEnabled: false, ownPropertyLeadCap: 1 });
    await fillOwnerPortfolio(10); // намного больше и лимита, и старой надбавки

    const assignment = await assignAgentForLead({ clientId }, outsiders);
    expect(assignment.agentId).toBe(ownerId);
  });

  it("огромный портфель (10 своих клиентов) — лид всё равно уходит хозяину", async () => {
    await setRules({ leadActiveLimit: 2, ownPropertyOverLimitEnabled: true, ownPropertyLeadCap: 0 });
    await fillOwnerPortfolio(10);

    const assignment = await assignAgentForLead({ clientId }, outsiders);
    expect(assignment.agentId).toBe(ownerId);
  });
});

/**
 * ОБЪЕКТ НАЗВАН ЯВНО (Пачка 1 п.5, 11.09.2026): `ctx.propertyId` — заявка с
 * сайта пришла со страницы конкретной карточки, или звонок распознал объект в
 * разговоре. Самое прямое основание, стоит выше поста Instagram и показа бота.
 */
describe("Объект назван явно (ctx.propertyId)", () => {
  it("выигрывает даже когда объект слабее (4 комнаты вместо желаемых 3)", async () => {
    // weakPropertyId принадлежит rivalId и не совпадает по комнатам с запросом
    // клиента (client хочет 3, weakPropertyId — 4к) — обычный подбор его бы не
    // выбрал вовсе, а «названо явно» отдаёт лид его хозяину без всякой оценки.
    const assignment = await assignAgentForLead({ clientId, propertyId: weakPropertyId }, outsiders);
    expect(assignment.agentId).toBe(rivalId);
    expect(assignment.reason).toBe("own_property_explicit");
  });

  it("объект в Корзине — правило уступает обычной лестнице", async () => {
    const trashed = await prisma.property.create({
      data: {
        title: `Удалённый объект ${runId}`,
        type: "APARTMENT",
        areaSqm: 60,
        rooms: 3,
        price: 300_000,
        currency: "TJS",
        districtId,
        address: "Тестовая, 2",
        condition: "GOOD",
        status: "AVAILABLE",
        intakeAgentId: strongId,
        deletedAt: new Date(),
      },
    });
    const assignment = await assignAgentForLead({ clientId, propertyId: trashed.id }, outsiders);
    expect(assignment.agentId).not.toBe(strongId);
    await prisma.property.deleteMany({ where: { id: trashed.id } });
  });
});

describe("Регресс-щит", () => {
  it("рубильник выключен — распределение как до правила", async () => {
    await setRules({ ownPropertyPriorityEnabled: false, ownPropertyShownExceptionEnabled: false });
    await prisma.propertyExposure.create({
      data: {
        channel: "INSTAGRAM",
        recipientId: `psid-${runId}`,
        clientId,
        propertyId: exactPropertyId,
        shortId: exactShortId,
        kind: "PHOTO",
      },
    });

    const assignment = await assignAgentForLead({ clientId }, outsiders);
    expect(assignment.reason).toBe("queue");
    // Очередь «по наименьшей загрузке» — у всех троих лидов нет, тай-брейк по
    // давности назначения; важно лишь то, что выбран кто-то из живых агентов.
    expect([ownerId, rivalId, strongId]).toContain(assignment.agentId);

    await setRules({ ownPropertyPriorityEnabled: true, ownPropertyShownExceptionEnabled: true });
  });

  it("режим «Вручную» правило не обходит", async () => {
    await setRules({ leadDistributionStrategy: "manual" });
    const assignment = await assignAgentForLead({ clientId }, outsiders);
    expect(assignment.agentId).toBeNull();
    expect(assignment.reason).toBe("queue");
    await setRules({ leadDistributionStrategy: "fair" });
  });
});
