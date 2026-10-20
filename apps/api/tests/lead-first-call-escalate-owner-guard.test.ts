import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import { prisma } from "../src/db.js";
import { penalizeMissedFirstCalls } from "../src/services/leads/firstCall.js";
import { dushanbeInputToDate } from "../src/lib/dushanbeTime.js";

/**
 * ЭСКАЛАЦИЯ ПЕРВОГО ЗВОНКА ПРОТИВ «/assign» РУКОВОДИТЕЛЯ (аудит Codex 04.10.2026,
 * находка №17). Ветка `firstCall.escalate` звала `changeClientAgent` с
 * `toAgentId: client.assignedAgentId` из снимка и БЕЗ `guardWhere`: если за время
 * подбора кандидата руководитель отдал карточку Б (с `acceptedAt: null`, как
 * делает `/assign`), закон П-3 передачу пропускал, и владелец откатывался к А,
 * а руководителю уходил пуш про «сорванный звонок» по лиду, который у него
 * только что отобрали. Соседняя ветка `reassign` закрыта `guardWhere` — теперь так
 * же и эскалация.
 *
 * Окно «между снимком и записью» — `pickAgentForLead`, её зовут до транзакции;
 * `leadEscalateAfter: 0` гонит лид в ветку эскалации, а хук делает то, что сделал
 * бы `/assign`. Настройки подменяются только в этом процессе (общая база шарда).
 */
const hooks = vi.hoisted(() => ({
  beforePick: null as null | (() => Promise<void>),
  feedCalls: [] as Array<{ tag?: string }>,
}));

vi.mock("../src/services/leads/selection.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/leads/selection.js")>();
  return {
    ...actual,
    pickAgentForLead: async (...args: Parameters<typeof actual.pickAgentForLead>) => {
      await hooks.beforePick?.();
      return actual.pickAgentForLead(...args);
    },
  };
});

vi.mock("../src/lib/notifications.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/notifications.js")>();
  return {
    ...actual,
    notifyFeedOnly: async (...args: Parameters<typeof actual.notifyFeedOnly>) => {
      hooks.feedCalls.push({ tag: (args[1] as { tag?: string }).tag });
      return actual.notifyFeedOnly(...args);
    },
  };
});

const runId = Date.now();
let agentAId: string;
let agentBId: string;
const clientIds: string[] = [];

const NOW = dushanbeInputToDate("2026-07-16", "12:00");
const PINNED = {
  leadCallMinutes: 15,
  leadReassignOnMissedCallEnabled: true,
  leadEscalationEnabled: true,
  leadEscalateAfter: 0, // reassignCount (0) >= 0 — лид идёт в эскалацию, а не к следующему агенту
  workHoursStart: "00:00",
  workHoursEnd: "24:00",
};

async function penalizeWithPinnedSettings() {
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

async function makeLead(label: string) {
  const lead = await prisma.client.create({
    data: {
      fullName: `Лид эскалации ${label} ${runId}`,
      phone: `+99298${label === "гонка" ? 3 : 4}${runId}`,
      source: "PHONE_CALL",
      kind: "BUYER",
      assignedAgentId: agentAId,
      assignedAt: new Date(NOW.getTime() - 20 * 60_000),
      acceptedAt: new Date(NOW.getTime() - 20 * 60_000),
    },
  });
  clientIds.push(lead.id);
  return lead;
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash("testpass123", 10);
  agentAId = (
    await prisma.agent.create({
      data: { fullName: "Агент А эскалация", phone: `+992985${runId}`, role: "AGENT", passwordHash },
    })
  ).id;
  agentBId = (
    await prisma.agent.create({
      data: { fullName: "Агент Б от руководителя эск", phone: `+992986${runId}`, role: "AGENT", passwordHash },
    })
  ).id;
});

afterAll(async () => {
  hooks.beforePick = null;
  await prisma.royalScoreEvent.deleteMany({ where: { agentId: { in: [agentAId, agentBId] } } });
  await prisma.interaction.deleteMany({
    where: { OR: [{ clientId: { in: clientIds } }, { agentId: { in: [agentAId, agentBId] } }] },
  });
  await prisma.auditLog.deleteMany({ where: { entityId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: [agentAId, agentBId] } } });
  await prisma.$disconnect();
});

describe("Эскалация срыва первого звонка", () => {
  it("руководитель отдал карточку Б, пока тик подбирал кандидата — владелец остаётся Б, эскалации и пуша нет", async () => {
    const lead = await makeLead("гонка");
    hooks.feedCalls.length = 0;
    hooks.beforePick = async () => {
      // Только по этому лиду: чужих кандидатов из общей базы хук не трогает.
      await prisma.client.update({
        where: { id: lead.id },
        data: { assignedAgentId: agentBId, lastAgentId: agentAId, acceptedAt: null, assignedAt: NOW },
      });
    };
    try {
      await penalizeWithPinnedSettings();
    } finally {
      hooks.beforePick = null;
    }

    const after = await prisma.client.findUnique({ where: { id: lead.id } });
    expect(after?.assignedAgentId).toBe(agentBId);
    expect(after?.escalatedAt).toBeNull();
    const trace = await prisma.interaction.findFirst({
      where: { clientId: lead.id, notes: { contains: "эскалация руководителю" } },
    });
    expect(trace).toBeNull();
    expect(hooks.feedCalls.some((c) => c.tag === `lead-call-escalated-${lead.id}`)).toBe(false);
  });

  it("без вмешательства руководителя эскалация проходит как прежде (владелец тот же, escalatedAt, запись и пуш)", async () => {
    const lead = await makeLead("штатный");
    hooks.feedCalls.length = 0;
    await penalizeWithPinnedSettings();

    const after = await prisma.client.findUnique({ where: { id: lead.id } });
    expect(after?.assignedAgentId).toBe(agentAId);
    expect(after?.escalatedAt).not.toBeNull();
    const trace = await prisma.interaction.findFirst({
      where: { clientId: lead.id, notes: { contains: "эскалация руководителю" } },
    });
    expect(trace).not.toBeNull();
    expect(hooks.feedCalls.some((c) => c.tag === `lead-call-escalated-${lead.id}`)).toBe(true);
  });
});
