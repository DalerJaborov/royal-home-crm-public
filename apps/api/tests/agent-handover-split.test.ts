import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { waitFor } from "./helpers/waitFor.js";

/**
 * РАЗНАЯ РАЗДАЧА ПОРТФЕЛЯ ПРИ УВОЛЬНЕНИИ (решение владельца 11.08.2026).
 *
 * Дословно: «В случае удаления агента его объекты распределяются между другими
 * агентами начиная с тех у кого низкий KPI, а клиенты (в том числе и горячие)
 * тем у кого высокий KPI (дальше свободный и не в отпуске)».
 *
 * Клиент — начатый разговор, его нельзя ставить на паузу, пока в нём разбирается
 * новичок. Объект — материал для работы, он никого не заставляет ждать и нужнее
 * тому, у кого работы мало. Раньше и то и другое раздавалось ОДНИМ вызовом
 * pickAgentForLead, то есть совершенно одинаково.
 *
 * ПО ОДНОЙ КАРТОЧКЕ И ПО КРУГУ (владелец 18.09.2026): раздача портфеля больше не
 * спрашивает очередь на каждом шаге — кольцо получателей строится один раз, и
 * карточки идут по кругу. Так 16 продавцов уволенного больше не могут уйти одному
 * агенту: прежняя очередь сортировала сначала по УРОВНЮ счёта, и когда в верхнем
 * уровне один человек, крутить внутри уровня было некого.
 */

const sendPushToAgent = vi.fn(async () => 1);
vi.mock("../src/push.js", async (importOriginal) => ({
  // Подмена ДОПОЛНЯЕТ модуль, а не заменяет его целиком (19.09.2026):
  // фабрика без importOriginal убирает остальные экспорты у всего
  // процесса, и СОСЕДНИЙ тест падает на «No "…" export is defined».
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent, sendPushToAgents: sendPushToAgent,
}));

/**
 * Кольцо получателей подменено: настоящее строится по ВСЕМ активным агентам общей
 * базы (сиды, соседние тестовые файлы), и по конечному получателю нельзя доказать,
 * каким правилом он выбран. Подмена отвечает ровно на этот вопрос — какое
 * направление круга запрошено и кого исключили. Само кольцо проверяется на живой
 * базе в handover-property-queue.test.ts.
 */
let queue: string[] = [];
const receiverRingByKpi = vi.fn(async (_exclude: string[], _order: "desc" | "asc") => queue);
const pickAgentForLead = vi.fn(async (_exclude?: string | string[]) => queue[0] ?? null);
vi.mock("../src/leads.js", () => ({
  receiverRingByKpi: (ids: string[], order: "desc" | "asc") => receiverRingByKpi(ids, order),
  pickAgentForLead: (ids?: string | string[]) => pickAgentForLead(ids),
}));

const { prisma } = await import("../src/db.js");
const { handoverAgentWork } = await import("../src/lib/agentHandover.js");

const runId = Date.now();
let leavingId: string;
let districtId: string;
const receiverIds: string[] = [];
const clientIds: string[] = [];
const propertyIds: string[] = [];
let savedClientsFlag = true;
let savedPropertiesFlag = true;

const HOUR = 3600_000;

async function makeClient(
  name: string,
  data: { status?: string; hotSince?: Date | null; createdAt?: Date } = {}
) {
  const c = await prisma.client.create({
    data: {
      fullName: `${name} ${runId}`,
      phone: `+9924${clientIds.length}${runId}`,
      source: "PHONE_CALL",
      assignedAgentId: leavingId,
      acceptedAt: new Date(),
      status: (data.status ?? "NEW") as never,
      hotSince: data.hotSince ?? null,
      ...(data.createdAt ? { createdAt: data.createdAt } : {}),
    },
  });
  clientIds.push(c.id);
  return c.id;
}

async function makeProperty(title: string) {
  const p = await prisma.property.create({
    data: {
      title: `${title} ${runId}`,
      type: "APARTMENT",
      areaSqm: 55,
      price: 50000,
      currency: "TJS",
      districtId,
      address: "Тестовая, 7",
      condition: "GOOD",
      assignedAgentId: leavingId,
    },
  });
  propertyIds.push(p.id);
  return p.id;
}

beforeAll(async () => {
  const settings = await prisma.settings.findUnique({ where: { id: "singleton" } });
  savedClientsFlag = settings?.handoverClientsToHighKpi ?? true;
  savedPropertiesFlag = settings?.handoverPropertiesToLowKpi ?? true;

  districtId = (await prisma.district.create({ data: { name: `Тест-район-раздача-${runId}` } })).id;
  leavingId = (
    await prisma.agent.create({
      data: { fullName: "Уходит с портфелем", phone: `+992940${runId}`, role: "AGENT", passwordHash: "x" },
    })
  ).id;
  for (let i = 0; i < 4; i++) {
    const a = await prisma.agent.create({
      data: { fullName: `Получатель ${i}`, phone: `+99294${i + 1}${runId}`, role: "AGENT", passwordHash: "x" },
    });
    receiverIds.push(a.id);
  }
});

beforeEach(async () => {
  queue = [...receiverIds];
  receiverRingByKpi.mockClear();
  pickAgentForLead.mockClear();
  await prisma.settings.update({
    where: { id: "singleton" },
    data: { handoverClientsToHighKpi: true, handoverPropertiesToLowKpi: true },
  });
});

afterEach(async () => {
  // Раздача забирает ВСЕХ клиентов уходящего — между тестами база должна быть чистой,
  // иначе следующий тест разбирает чужой портфель.
  await prisma.auditLog.deleteMany({ where: { entityId: { in: propertyIds } } });
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  clientIds.length = 0;
  propertyIds.length = 0;
});

afterAll(async () => {
  await prisma.settings.update({
    where: { id: "singleton" },
    data: { handoverClientsToHighKpi: savedClientsFlag, handoverPropertiesToLowKpi: savedPropertiesFlag },
  });
  await prisma.agent.deleteMany({ where: { id: { in: [leavingId, ...receiverIds] } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.$disconnect();
});

describe("Клиенты — в очередь сильных, горячие первыми", () => {
  it("горячие разбираются раньше остальных, свежий горячий — самым первым", async () => {
    // Порядок создания нарочно обратный ожидаемому порядку разбора.
    const cold = await makeClient("Холодный", {
      status: "COLD",
      createdAt: new Date(Date.now() - 10 * HOUR),
    });
    const plain = await makeClient("Обычный", { status: "NEW", createdAt: new Date(Date.now() - 5 * HOUR) });
    const oldHot = await makeClient("Горячий давний", { status: "HOT", hotSince: new Date(Date.now() - 2 * HOUR) });
    const freshHot = await makeClient("Горячий свежий", { status: "HOT", hotSince: new Date(Date.now() - 1 * HOUR) });

    const result = await handoverAgentWork(leavingId, undefined, receiverIds[0]);
    expect(result.clients).toBe(4);
    // Кольцо запрошено ОДИН раз и в сторону сильных; объектов нет — второе кольцо
    // не строилось вовсе. Прежняя реализация звала очередь по разу на карточку.
    const clientRings = receiverRingByKpi.mock.calls.filter((c) => c[1] === "desc");
    expect(clientRings).toHaveLength(1);
    expect(receiverRingByKpi.mock.calls.filter((c) => c[1] === "asc")).toHaveLength(0);
    expect(pickAgentForLead).not.toHaveBeenCalled();

    const byId = new Map(
      (await prisma.client.findMany({ where: { id: { in: clientIds } }, select: { id: true, assignedAgentId: true } }))
        .map((c) => [c.id, c.assignedAgentId])
    );
    // Первый в очереди получателей достался самому горячему — это и есть «горячие первыми».
    expect(byId.get(freshHot)).toBe(receiverIds[0]);
    expect(byId.get(oldHot)).toBe(receiverIds[1]);
    // Негорячие — следом, между собой по старшинству карточки.
    expect(byId.get(cold)).toBe(receiverIds[2]);
    expect(byId.get(plain)).toBe(receiverIds[3]);
  });

  it("клиент приходит уже принятым — решение руководителя (B7, 02.10.2026)", async () => {
    const id = await makeClient("Принять заново", { status: "CONTACTED" });
    await handoverAgentWork(leavingId, undefined, receiverIds[0]);
    const c = await prisma.client.findUnique({ where: { id }, select: { acceptedAt: true, assignedAgentId: true } });
    expect(c?.acceptedAt).not.toBeNull();
    expect(c?.assignedAgentId).toBe(receiverIds[0]);
  });
});

describe("По одному и по кругу — случай 16 продавцов", () => {
  it("портфель не уходит одному агенту: карточки ложатся по кругу, начиная с сильного", async () => {
    // Живой случай: все 16 продавцов уволенного достались одному человеку. Прежняя
    // очередь сортировала сначала по УРОВНЮ Royal Score, и когда в верхнем уровне
    // один агент, крутить внутри уровня было некого — каждая итерация выбирала его.
    const ids: string[] = [];
    for (let i = 0; i < 16; i++) {
      ids.push(await makeClient(`Продавец ${i}`, { status: "NEW", createdAt: new Date(Date.now() - i * HOUR) }));
    }

    const result = await handoverAgentWork(leavingId, undefined, receiverIds[0]);
    expect(result.clients).toBe(16);

    const rows = await prisma.client.findMany({
      where: { id: { in: ids } },
      select: { assignedAgentId: true },
    });
    const perAgent = new Map<string, number>();
    for (const r of rows) perAgent.set(r.assignedAgentId!, (perAgent.get(r.assignedAgentId!) ?? 0) + 1);

    // Разошлись по ВСЕМ получателям кольца, а не одному.
    expect(perAgent.size).toBe(queue.length);
    // И ровно поровну: 16 на 4 — по четыре. Круг не даёт перекоса в принципе.
    for (const count of perAgent.values()) expect(count).toBe(16 / queue.length);
    // Кольцо построено ОДИН раз, а не по разу на карточку.
    expect(receiverRingByKpi).toHaveBeenCalledTimes(1);
  });

  it("порядок буквально: Ноза → Маруф → третий → четвёртый → снова Ноза", async () => {
    /**
     * Дословно владелец 18.09.2026: «если сильная Ноза, а потом после неё Маруф —
     * идёт сначала Нозе, потом Маруфу и так далее. Когда закончили, опять сначала
     * по кругу».
     *
     * Равномерность проверена соседним тестом, но она одна не доказывает ПОРЯДОК:
     * раздать поровну можно и вразнобой. Здесь фиксируется сама последовательность,
     * включая замыкание круга на пятой карточке.
     */
    const ring = ["Ноза", "Маруф", "Третий", "Четвёртый"];
    // Карточки создаются с разным createdAt, чтобы порядок разбора был однозначным:
    // раздача идёт горячие → остальные, внутри группы — по старшинству карточки.
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      ids.push(await makeClient(`Карточка ${i}`, { status: "NEW", createdAt: new Date(Date.now() - (10 - i) * HOUR) }));
    }

    await handoverAgentWork(leavingId, undefined, receiverIds[0]);

    const byId = new Map(
      (await prisma.client.findMany({ where: { id: { in: ids } }, select: { id: true, assignedAgentId: true } })).map(
        (c) => [c.id, c.assignedAgentId]
      )
    );
    // Порядок разбора: самая старая карточка первой (ids[0] создан «10 часов назад»).
    const got = ids.map((id) => ring[receiverIds.indexOf(byId.get(id)!)]);
    expect(got).toEqual(["Ноза", "Маруф", "Третий", "Четвёртый", "Ноза", "Маруф"]);
  });

  it("получателей меньше, чем карточек, и число не делится — расходятся ровно, разница не больше одной", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) {
      ids.push(await makeClient(`Остаток ${i}`, { status: "NEW", createdAt: new Date(Date.now() - i * HOUR) }));
    }
    await handoverAgentWork(leavingId, undefined, receiverIds[0]);

    const rows = await prisma.client.findMany({ where: { id: { in: ids } }, select: { assignedAgentId: true } });
    const counts = new Map<string, number>();
    for (const r of rows) counts.set(r.assignedAgentId!, (counts.get(r.assignedAgentId!) ?? 0) + 1);
    const values = [...counts.values()];
    expect(Math.max(...values) - Math.min(...values)).toBeLessThanOrEqual(1);
  });
});

describe("Объекты — в перевёрнутую очередь, со следом в журнале", () => {
  it("объект уходит правилом низкого KPI, клиент — правилом высокого", async () => {
    await makeClient("Клиент при объекте", { status: "NEW" });
    const propertyId = await makeProperty("Объект на раздачу");

    const result = await handoverAgentWork(leavingId, undefined, receiverIds[0]);
    expect(result.clients).toBe(1);
    expect(result.properties).toBe(1);
    // По одному кольцу на каждую сторону — они больше не одно и то же.
    const desc = receiverRingByKpi.mock.calls.filter((c) => c[1] === "desc");
    const asc = receiverRingByKpi.mock.calls.filter((c) => c[1] === "asc");
    expect(desc).toHaveLength(1);
    expect(asc).toHaveLength(1);
    // Уходящий исключён из обоих колец — иначе портфель вернулся бы ему самому.
    expect(asc[0][0]).toContain(leavingId);
    expect(desc[0][0]).toContain(leavingId);

    // Круги независимы: объект берёт ПЕРВОГО из своего кольца, а не следующего
    // после клиента. Раньше оба правила делили один курсор очереди, и объект
    // доставался второму — то есть клиент сдвигал раздачу объектов, хотя это
    // разные правила с разным направлением.
    const property = await prisma.property.findUnique({ where: { id: propertyId } });
    expect(property?.assignedAgentId).toBe(receiverIds[0]);
  });

  it("передача объекта попадает в историю: кто, кому и почему", async () => {
    const propertyId = await makeProperty("Объект со следом");
    await handoverAgentWork(leavingId, undefined, receiverIds[0]);

    const entry = await waitFor(() =>
      prisma.auditLog.findFirst({
        where: { entityId: propertyId, action: "PROPERTY_HANDOVER" },
        orderBy: { createdAt: "desc" },
      })
    );
    expect(entry).not.toBeNull();
    expect(entry?.entityType).toBe("Property");
    // Автор записи — руководитель, запустивший передачу (П-5/П-10, как и у
    // клиентов), а не безликая «Система»: раздача — его решение.
    expect(entry?.agentId).toBe(receiverIds[0]);
    const meta = entry?.meta as Record<string, unknown>;
    expect(meta.fromAgentId).toBe(leavingId);
    expect(meta.toAgentId).toBe(receiverIds[0]);
    expect(meta.source).toBe("handover");
    expect(String(meta.reason)).toContain("низк");
  });
});

describe("Рубильники и ручная передача", () => {
  it("оба рубильника выключены — поведение ровно прежнее, одно правило на всё", async () => {
    await prisma.settings.update({
      where: { id: "singleton" },
      data: { handoverClientsToHighKpi: false, handoverPropertiesToLowKpi: false },
    });
    await makeClient("Клиент при выключенном", { status: "HOT", hotSince: new Date() });
    await makeProperty("Объект при выключенном");

    const result = await handoverAgentWork(leavingId, undefined, receiverIds[0]);
    expect(result.clients).toBe(1);
    expect(result.properties).toBe(1);
    // Прежнее поведение = обычное распределение и там, и там, колец не строим.
    expect(pickAgentForLead).toHaveBeenCalledTimes(2);
    expect(receiverRingByKpi).not.toHaveBeenCalled();
  });

  it("названный получатель перекрывает оба правила — очередь вообще не спрашивают", async () => {
    await makeClient("Клиент вручную", { status: "HOT", hotSince: new Date() });
    const propertyId = await makeProperty("Объект вручную");

    const result = await handoverAgentWork(leavingId, receiverIds[3], receiverIds[0]);
    expect(result.clients).toBe(1);
    expect(result.properties).toBe(1);
    expect(receiverRingByKpi).not.toHaveBeenCalled();
    expect(pickAgentForLead).not.toHaveBeenCalled();

    const property = await prisma.property.findUnique({ where: { id: propertyId } });
    expect(property?.assignedAgentId).toBe(receiverIds[3]);
  });
});
