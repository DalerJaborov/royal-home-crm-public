import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import { randomInt } from "node:crypto";
import { prisma } from "../src/db.js";
import { dushanbeStartOfToday } from "../src/lib/dushanbeTime.js";
import { deleteAgentsWithTraces } from "./helpers/cleanupAgents.js";

/**
 * ПР-000477 (владелец, разбор 24-25.09.2026): лид продавца крутился каруселью
 * 26 раз за один вечер и не был принят никем. Два независимых дефекта и одно
 * решение владельца:
 *
 *  1. `triedAgentIds` смешивает «отклонил» и «не успел», и сброс полного круга
 *     стирал отказы — Ноза отклонила лид трижды, а он возвращался к ней ещё 5
 *     раз. Чинит `Client.declinedAgentIds` — отдельный список, который круг
 *     никогда не обнуляет (см. services/leads/assignment.ts::declineLead,
 *     services/leads/reassignment.ts::reassignStaleLeads).
 *  2. Маъруф не заходил в CRM с 11:51, а получал лид девять раз подряд — по 15
 *     минут впустую и штраф за каждый раз. Чинит мягкий фильтр «заходил
 *     сегодня» в services/leads/selection.ts::pickAgentForLead.
 *
 * Плюс: один сигнал руководителю на полный круг карусели (карусель не
 * останавливается — правило 17.09.2026, «пусть крутится»).
 */

vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent: vi.fn(async () => undefined),
  sendPushToAgents: vi.fn(async () => undefined),
}));

const { reassignStaleLeads } = await import("../src/services/leads/reassignment.js");
const { declineLead, assignAgentForLead } = await import("../src/services/leads/assignment.js");
const { pickAgentForLead } = await import("../src/services/leads/selection.js");

const runId = `${Date.now()}${randomInt(1000, 9999)}`;
const phone = () => `+99297${randomInt(1_000_000, 9_999_999)}`;
const clientIds: string[] = [];
const agentIds: string[] = [];
let frozenOthers: string[] = [];
let savedSettings: Record<string, unknown> | null = null;

async function makeAgent(name: string, extra: Record<string, unknown> = {}) {
  const passwordHash = await bcrypt.hash("testpass123", 4);
  const a = await prisma.agent.create({
    data: { fullName: `${name} ${runId}`, phone: phone(), role: "AGENT", passwordHash, ...extra },
  });
  agentIds.push(a.id);
  return a.id;
}

/**
 * Замораживает ВСЕХ активных агентов, кроме `keep` — включая уже заведённые
 * фикстуры СОСЕДНИХ describe этого же файла (agentIds копится на весь файл, а
 * не на один блок). Без этого держатель предыдущего блока остаётся активным и
 * может случайно выиграть подбор в следующем — так первая версия этого файла
 * и падала: "заходил сегодня" ловил постороннего агента из блока про отказы.
 * Список замороженных копится в `frozenOthers` на весь файл и размораживается
 * один раз в конце (afterAll) — блоки этого файла идут строго последовательно,
 * повторно замораживать уже замороженных не нужно.
 */
async function freezeEveryoneElse(keep: string[]) {
  const freshlyFrozen = (
    await prisma.agent.findMany({
      where: { role: "AGENT", isActive: true, frozenAt: null, id: { notIn: keep } },
      select: { id: true },
    })
  ).map((a) => a.id);
  if (freshlyFrozen.length) {
    await prisma.agent.updateMany({ where: { id: { in: freshlyFrozen } }, data: { frozenAt: new Date() } });
    frozenOthers.push(...freshlyFrozen);
  }
}

async function lead(data: {
  holder: string;
  kind?: "SELLER" | "BUYER";
  reassignCount?: number;
  triedAgentIds?: string[];
  declinedAgentIds?: string[];
  assignedAt?: Date;
}) {
  const c = await prisma.client.create({
    data: {
      fullName: `Карусель-отказы ${runId} ${clientIds.length}`,
      phone: phone(),
      source: "PHONE_CALL",
      kind: data.kind ?? "SELLER",
      status: "NEW",
      assignedAgentId: data.holder,
      assignedAt: data.assignedAt ?? new Date(Date.now() - 20 * 60_000),
      acceptedAt: null,
      reassignCount: data.reassignCount ?? 0,
      triedAgentIds: data.triedAgentIds ?? [],
      declinedAgentIds: data.declinedAgentIds ?? [],
    },
  });
  clientIds.push(c.id);
  return c;
}

beforeAll(async () => {
  savedSettings = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { leadAcceptMinutes: true, leadDistributionStrategy: true, workHoursStart: true, workHoursEnd: true },
  });
  await prisma.settings.update({
    where: { id: "singleton" },
    data: {
      leadAcceptMinutes: 15,
      leadDistributionStrategy: "round_robin",
      // Круглые сутки — 00:00–24:00, а не 23:59 (см. journal 24.09 про эту ловушку).
      workHoursStart: "00:00",
      workHoursEnd: "24:00",
    },
  });
});

afterEach(async () => {
  await prisma.royalScoreEvent.deleteMany({ where: { agentId: { in: agentIds } } });
});

afterAll(async () => {
  await prisma.interaction.deleteMany({ where: { OR: [{ clientId: { in: clientIds } }, { agentId: { in: agentIds } }] } });
  await prisma.notification.deleteMany({ where: { tag: { in: clientIds.map((id) => `lead-full-circle-${id}`) } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await deleteAgentsWithTraces(agentIds);
  if (frozenOthers.length) await prisma.agent.updateMany({ where: { id: { in: frozenOthers } }, data: { frozenAt: null } });
  if (savedSettings) await prisma.settings.update({ where: { id: "singleton" }, data: savedSettings });
  await prisma.$disconnect();
});

describe("declinedAgentIds переживает сброс круга карусели", () => {
  let holder: string, decliner: string, fresh: string;

  beforeAll(async () => {
    holder = await makeAgent("Держатель");
    decliner = await makeAgent("Отказавший");
    fresh = await makeAgent("Свежий");
    // СВОЙ ПОЛУЧАТЕЛЬ СИГНАЛА, А НЕ ИЗ ПОСЕВА (25.09.2026, прогон с --clean-db).
    // Сигнал о полном круге уходит по праву `clients.assign`
    // (lib/recipients.ts::findAgentsWithPermission), и на засеянной базе такой
    // сотрудник есть сам — директор из prisma/seed.ts. На пустой базе его нет
    // вовсе, получателей ноль, и проверка «строка в ленте появилась» падала на
    // исправном коде. Директор заведён замороженным: `frozenAt` закрывает вход
    // новых лидов, поэтому подбор его не выберет, а получателем он остаётся —
    // выборка получателей смотрит только на `isActive`.
    await makeAgent("Руководитель круга", { role: "DIRECTOR", frozenAt: new Date() });
    await freezeEveryoneElse([holder, decliner, fresh]);
  });

  it("полный круг сбрасывает triedAgentIds, но НЕ declinedAgentIds — отказавший не возвращается", async () => {
    // Три агента в очереди, полный круг уже пройден (reassignCount >= 3) —
    // carouselExhausted сбрасывает triedAgentIds на [holder], но decliner
    // остаётся исключён навсегда через declinedAgentIds.
    const c = await lead({
      holder,
      reassignCount: 3,
      triedAgentIds: [],
      declinedAgentIds: [decliner],
    });

    await reassignStaleLeads();

    const after = await prisma.client.findUnique({ where: { id: c.id } });
    expect(after?.assignedAgentId).toBe(fresh); // единственный, кто не был исключён
    expect(after?.assignedAgentId).not.toBe(decliner);
  });

  it("честный текст: «все доступные агенты отказались от лида», когда отдать некому кроме отказавшегося", async () => {
    // Только держатель и отказавший в очереди (freeze fresh тоже) — исключая
    // держателя и отказавшего, отдать действительно некому.
    await prisma.agent.update({ where: { id: fresh }, data: { frozenAt: new Date() } });
    try {
      const c = await lead({
        holder,
        reassignCount: 5,
        triedAgentIds: [],
        declinedAgentIds: [decliner],
      });

      await reassignStaleLeads();

      const after = await prisma.client.findUnique({ where: { id: c.id } });
      expect(after?.escalatedAt).not.toBeNull();
      expect(after?.assignedAgentId).toBe(holder); // не переходит к отказавшему
      const interactions = await prisma.interaction.findMany({ where: { clientId: c.id }, select: { notes: true } });
      const text = interactions.map((i) => i.notes ?? "").join("\n");
      expect(text).toContain("отказались от лида");
      expect(text).not.toContain("не осталось вовсе");
    } finally {
      await prisma.agent.update({ where: { id: fresh }, data: { frozenAt: null } });
    }
  });

  it("сигнал руководителю о полном круге уходит один раз (дедуп по тегу)", async () => {
    // Свой руководитель: на пустой базе (`ship --clean-db`) другого может не
    // оказаться, и сигнал законно некому слать (поймано 25.09.2026 на #949).
    const supervisor = await makeAgent("Руководитель полного круга", { role: "DIRECTOR" });
    const c = await lead({ holder, reassignCount: 3, triedAgentIds: [], declinedAgentIds: [] });
    const tag = `lead-full-circle-${c.id}`;

    await reassignStaleLeads();
    const afterFirst = await prisma.notification.findMany({ where: { tag } });
    // Одна строка НА ПОЛУЧАТЕЛЯ (руководителей может быть несколько в сидовой
    // базе) — проверяем, что их число не растёт, а не что оно ровно единица.
    expect(afterFirst.filter((n) => n.agentId === supervisor)).toHaveLength(1);

    // Второй полный круг того же лида (снова протух) — сигнал не должен задвоиться.
    await prisma.client.update({ where: { id: c.id }, data: { assignedAt: new Date(Date.now() - 20 * 60_000), reassignCount: 5 } });
    await reassignStaleLeads();

    const afterSecond = await prisma.notification.findMany({ where: { tag } });
    expect(afterSecond.length).toBe(afterFirst.length);
  });
});

describe("declineLead запоминает отказ навсегда", () => {
  let holder: string, other: string;

  beforeAll(async () => {
    holder = await makeAgent("Держатель-2");
    other = await makeAgent("Другой-2");
    await freezeEveryoneElse([holder, other]);
  });

  it("отказ пишется в declinedAgentIds, а не только в triedAgentIds", async () => {
    const c = await lead({ holder });
    const result = await declineLead(c.id, holder);
    expect(result.ok).toBe(true);

    const after = await prisma.client.findUnique({ where: { id: c.id } });
    const declined = Array.isArray(after?.declinedAgentIds) ? (after!.declinedAgentIds as string[]) : [];
    expect(declined).toContain(holder);
  });

  it("отказ по кнопке (мимо requireAuth) тоже отмечает присутствие агента", async () => {
    const before = await prisma.agent.findUnique({ where: { id: holder }, select: { lastSeenAt: true } });
    const c = await lead({ holder });
    await declineLead(c.id, holder);
    const after = await prisma.agent.findUnique({ where: { id: holder }, select: { lastSeenAt: true } });
    expect(after?.lastSeenAt).not.toBeNull();
    if (before?.lastSeenAt) expect(after!.lastSeenAt!.getTime()).toBeGreaterThan(before.lastSeenAt.getTime());
  });

  it("честный текст при отказе: «все доступные агенты уже отказались», когда отдать некому кроме держателя", async () => {
    await prisma.agent.update({ where: { id: other }, data: { frozenAt: new Date() } });
    try {
      const c = await lead({ holder, declinedAgentIds: [other] }); // second agent already declined earlier
      const result = await declineLead(c.id, holder);
      expect(result).toMatchObject({ ok: true, reassignedTo: null, escalated: true });
      const notes = await prisma.interaction.findMany({ where: { clientId: c.id }, select: { notes: true } });
      const text = notes.map((n) => n.notes ?? "").join("\n");
      expect(text).toContain("все доступные агенты уже отказались");
    } finally {
      await prisma.agent.update({ where: { id: other }, data: { frozenAt: null } });
    }
  });
});

describe("«заходил сегодня» — мягкий фильтр присутствия", () => {
  let present: string, absent: string;

  beforeAll(async () => {
    present = await makeAgent("Заходивший");
    absent = await makeAgent("Отсутствующий");
    await freezeEveryoneElse([present, absent]);
    await prisma.agent.update({ where: { id: present }, data: { lastSeenAt: new Date() } });
    await prisma.agent.update({ where: { id: absent }, data: { lastSeenAt: null } });
  });

  it("выбирает заходившего сегодня агента, а не отсутствующего", async () => {
    // round_robin ставит вперёд того, кому дольше не назначали — оба свежие,
    // без назначений, поэтому без фильтра присутствия результат был бы
    // недетерминирован (порядок из базы). Фильтр должен снять absent целиком.
    const picked = await pickAgentForLead([], "BUYER");
    expect(picked).toBe(present);
  });

  it("если сегодня не заходил никто — откатывается и подбирает как раньше", async () => {
    await prisma.agent.update({ where: { id: present }, data: { lastSeenAt: null } });
    try {
      const picked = await pickAgentForLead([], "BUYER");
      expect([present, absent]).toContain(picked);
    } finally {
      await prisma.agent.update({ where: { id: present }, data: { lastSeenAt: new Date() } });
    }
  });

  it("устаревшая отметка (не сегодня) не считается присутствием", async () => {
    const before = dushanbeStartOfToday(new Date(Date.now() - 24 * 3600_000)); // начало ВЧЕРАШНИХ суток
    await prisma.agent.update({ where: { id: present }, data: { lastSeenAt: new Date(before.getTime() + 60_000) } });
    try {
      const picked = await pickAgentForLead([], "BUYER");
      // Оба «не сегодня» — фильтр отсеял бы всех и откатился, результат недетерминирован по присутствию.
      expect([present, absent]).toContain(picked);
    } finally {
      await prisma.agent.update({ where: { id: present }, data: { lastSeenAt: new Date() } });
    }
  });
});

describe("лид по своему объекту идёт хозяину, даже если он сегодня не заходил", () => {
  let owner: string;
  let propertyId: string;
  let districtId: string;

  beforeAll(async () => {
    owner = await makeAgent("Хозяин-объекта");
    await freezeEveryoneElse([owner]);
    await prisma.agent.update({ where: { id: owner }, data: { lastSeenAt: null } });
    const district = await prisma.district.create({ data: { name: `Район ПР477 ${runId}` } });
    districtId = district.id;
    const property = await prisma.property.create({
      data: {
        title: `Объект ПР477 ${runId}`,
        type: "APARTMENT",
        areaSqm: 60,
        rooms: 2,
        price: 100000,
        currency: "TJS",
        districtId,
        address: "Тестовая, 477",
        condition: "GOOD",
        status: "AVAILABLE",
        intakeAgentId: owner,
      },
      select: { id: true },
    });
    propertyId = property.id;
  });

  afterAll(async () => {
    await prisma.property.deleteMany({ where: { id: propertyId } });
    await prisma.district.deleteMany({ where: { id: districtId } });
  });

  it("assignAgentForLead с явным propertyId отдаёт хозяину мимо pickAgentForLead", async () => {
    const assignment = await assignAgentForLead({ propertyId, kind: "BUYER" });
    expect(assignment.agentId).toBe(owner);
    expect(assignment.reason).toBe("own_property_explicit");
  });
});
