import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import { penalizeMissedFirstCalls } from "../src/services/leads/firstCall.js";
import { dushanbeInputToDate } from "../src/lib/dushanbeTime.js";
import { deleteAgentsWithTraces } from "./helpers/cleanupAgents.js";

/**
 * P0-1 аудита docs/audit-bots-2026-10-10-object-routing.md: «первый звонок не
 * совершён за 15 мин» при включённом тумблере обучения
 * (`leadReassignOnMissedCallEnabled`) уводил лид по СВОЕМУ объекту хозяина к
 * следующему агенту очереди. Теперь такой лид остаётся у хозяина (штраф, запись,
 * сигнал руководителю), а лид без объекта или по чужому объекту — уходит, как
 * раньше. После ухода причина «свой объект» на карточке не остаётся.
 *
 * Очередь подменена: следующий агент — всегда «Следующий по очереди» этого файла,
 * чтобы проверка не зависела от чужих агентов общей базы. Лиды живут в своём
 * прошлом дне, настройки подменяются только в этом процессе — тот же приём, что у
 * lead-first-call-owner-guard.test.ts (чужие тики идут с настоящим «сейчас»).
 */
const hooks = vi.hoisted(() => ({ next: null as string | null }));

vi.mock("../src/services/leads/selection.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/leads/selection.js")>();
  return {
    ...actual,
    pickAgentForLead: async (...args: Parameters<typeof actual.pickAgentForLead>) =>
      hooks.next ?? actual.pickAgentForLead(...args),
  };
});

const runId = Date.now();
const tail = String(runId).slice(-6);
const NOW = dushanbeInputToDate("2026-07-16", "12:00");
const PINNED = {
  leadCallMinutes: 15,
  leadReassignOnMissedCallEnabled: true,
  leadEscalationEnabled: true,
  leadEscalateAfter: 3,
  workHoursStart: "00:00",
  workHoursEnd: "24:00",
};

let districtId: string;
let ownerId: string;
let strangerOwnerId: string;
let nextId: string;
let ownPropertyId: string;
let foreignPropertyId: string;
const clientIds: string[] = [];

async function tick() {
  const delegate = prisma.settings;
  const real = delegate.findUnique.bind(delegate);
  const spy = vi.spyOn(delegate, "findUnique").mockImplementation((async (args: Parameters<typeof real>[0]) => {
    const row = await real(args);
    return row ? { ...row, ...PINNED } : row;
  }) as never);
  try {
    await penalizeMissedFirstCalls(NOW);
  } finally {
    spy.mockRestore();
  }
}

async function makeLead(label: string, data: Record<string, unknown>) {
  const c = await prisma.client.create({
    data: {
      fullName: `Первый звонок ${label} ${runId}`,
      phone: `+99293${tail}${clientIds.length}`,
      source: "INSTAGRAM",
      kind: "BUYER",
      assignedAgentId: ownerId,
      assignedAt: new Date(NOW.getTime() - 20 * 60_000),
      acceptedAt: new Date(NOW.getTime() - 20 * 60_000),
      ...data,
    },
  });
  clientIds.push(c.id);
  return c;
}

beforeAll(async () => {
  hooks.next = null;
  districtId = (await prisma.district.create({ data: { name: `Район-первый-звонок-${runId}` } })).id;
  const mk = (fullName: string, n: number) =>
    prisma.agent.create({ data: { fullName, role: "AGENT", phone: `+99294${tail}${n}`, passwordHash: "x" } });
  ownerId = (await mk("Хозяин объекта (первый звонок)", 1)).id;
  strangerOwnerId = (await mk("Хозяин чужого объекта (первый звонок)", 2)).id;
  nextId = (await mk("Следующий по очереди (первый звонок)", 3)).id;
  const mkProperty = (title: string, intakeAgentId: string) =>
    prisma.property.create({
      data: {
        title: `${title} ${runId}`,
        type: "APARTMENT",
        areaSqm: 60,
        rooms: 2,
        price: 300_000,
        currency: "TJS",
        districtId,
        address: "Тестовая, 10",
        condition: "GOOD",
        status: "AVAILABLE",
        intakeAgentId,
      },
    });
  ownPropertyId = (await mkProperty("Свой объект первого звонка", ownerId)).id;
  foreignPropertyId = (await mkProperty("Чужой объект первого звонка", strangerOwnerId)).id;
  hooks.next = nextId;
});

afterAll(async () => {
  hooks.next = null;
  await prisma.royalScoreEvent.deleteMany({ where: { agentId: { in: [ownerId, strangerOwnerId, nextId] } } });
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.auditLog.deleteMany({ where: { entityId: { in: clientIds } } });
  await prisma.notification.deleteMany({ where: { tag: { in: clientIds.flatMap((id) => [`lead-call-missed-${id}`, `lead-call-due-${id}`, `lead-${id}`]) } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.property.deleteMany({ where: { id: { in: [ownPropertyId, foreignPropertyId] } } });
  await deleteAgentsWithTraces([ownerId, strangerOwnerId, nextId]);
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.$disconnect();
});

describe("P0-1: срыв первого звонка не уводит лид по своему объекту", () => {
  it("лид по своему объекту (пометка и причина) остаётся у хозяина, руководитель знает", async () => {
    const lead = await makeLead("свой", {
      matchedPropertyId: ownPropertyId,
      ownPropertyLead: true,
      assignReason: "own_property_explicit",
    });
    await tick();
    const after = await prisma.client.findUniqueOrThrow({ where: { id: lead.id } });
    expect(after.assignedAgentId).toBe(ownerId);
    expect(after.acceptedAt).not.toBeNull();
    expect(after.reassignCount).toBe(0);
    expect(after.assignReason).toBe("own_property_explicit");
    const note = await prisma.interaction.findFirst({
      where: { clientId: lead.id, notes: { contains: "остаётся у хозяина объекта" } },
    });
    expect(note).not.toBeNull();
    const moved = await prisma.interaction.findFirst({
      where: { clientId: lead.id, notes: { contains: "Лид снят и переназначен" } },
    });
    expect(moved).toBeNull();
  });

  it("пометка не легла (P2-13), но причина и объект хозяина есть — тоже остаётся", async () => {
    const lead = await makeLead("без пометки", {
      matchedPropertyId: ownPropertyId,
      ownPropertyLead: false,
      assignReason: "instagram_post_link",
    });
    await tick();
    const after = await prisma.client.findUniqueOrThrow({ where: { id: lead.id } });
    expect(after.assignedAgentId).toBe(ownerId);
  });

  it("лид без объекта уходит следующему, как раньше", async () => {
    const lead = await makeLead("без объекта", {});
    await tick();
    const after = await prisma.client.findUniqueOrThrow({ where: { id: lead.id } });
    expect(after.assignedAgentId).toBe(nextId);
    expect(after.acceptedAt).toBeNull();
  });

  it("лид по ЧУЖОМУ объекту уходит, и причина «свой объект» на карточке не остаётся", async () => {
    const lead = await makeLead("чужой объект", {
      matchedPropertyId: foreignPropertyId,
      ownPropertyLead: false,
      assignReason: "own_property_explicit",
    });
    await tick();
    const after = await prisma.client.findUniqueOrThrow({ where: { id: lead.id } });
    expect(after.assignedAgentId).toBe(nextId);
    expect(after.assignReason).toBeNull();
    expect(after.matchedPropertyId).toBe(foreignPropertyId);
  });
});
