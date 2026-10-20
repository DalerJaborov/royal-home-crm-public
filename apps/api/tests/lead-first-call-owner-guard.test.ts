import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import { prisma } from "../src/db.js";
import { penalizeMissedFirstCalls } from "../src/services/leads/firstCall.js";
import { dushanbeInputToDate } from "../src/lib/dushanbeTime.js";

/**
 * ТУМБЛЕР ОБУЧЕНИЯ ПРОТИВ «/assign» РУКОВОДИТЕЛЯ (ночная проверка 24.09.2026,
 * находка №6). `penalizeMissedFirstCalls` читает кандидатов пачкой, потом на
 * каждого — штраф, подбор следующего агента, транзакция. Руководитель за это
 * время через `/assign` отдаёт карточку Б и ставит `acceptedAt`. До починки
 * запись шла без условия на владельца из снимка: карточка уезжала к В с
 * `acceptedAt: null`, а Б получал «карточка передана» по лиду, который ему
 * только что вручили. Рядом `reassignment.ts::claimLead` тот же класс закрыт
 * `guardWhere` — теперь так же и здесь.
 *
 * Окно «между снимком и записью» — `pickAgentForLead`: её зовут после штрафа и
 * до транзакции; хук делает то, что сделал бы `/assign`, и отдаёт настоящий ответ.
 */
const hooks = vi.hoisted(() => ({ beforePick: null as null | (() => Promise<void>) }));

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

const runId = Date.now();
let agentAId: string;
let agentBId: string;
let agentCId: string;
const clientIds: string[] = [];

/**
 * ОБЩАЯ БАЗА ШАРДА — ДВА ИСТОЧНИКА ЧУЖИХ РУК (24.09.2026, полный прогон: файл
 * упал один раз и был зелёным в одиночку). Ещё пять файлов зовут
 * `penalizeMissedFirstCalls` на той же базе, и в их процессах нашего хука нет:
 *  1. их тик с настоящим «сейчас» подбирал и наш лид («принят 20 минут назад,
 *     звонка нет») и отдавал его своему следующему агенту — мимо хука;
 *  2. они же меняют `Settings.singleton` (тумблер передачи, окно часов) в своих
 *     beforeAll/afterAll, и наш тик мог прочитать тумблер выключенным.
 * Поэтому лид живёт в своём прошлом дне (окно кандидатов у чужого тика —
 * часы, не недели), тик зовётся с тем же «сейчас», а настройки подменяются
 * только в этом процессе, без записи в общую строку.
 */
const NOW = dushanbeInputToDate("2026-07-15", "12:00");
const PINNED = {
  leadCallMinutes: 15,
  leadReassignOnMissedCallEnabled: true,
  leadEscalationEnabled: true,
  leadEscalateAfter: 3,
  // Круглые сутки — это "00:00"–"24:00", а НЕ "00:00"–"23:59": минута 23:59 у
  // второго остаётся закрытой, и closedMsBeforeDue добавляет к сроку паузу —
  // тест падает одну минуту в сутки. "00:00"–"00:00" паузу тоже убирает, но
  // для isWithinDushanbeWindow пустое окно значит «никогда», и раздача лидов
  // в таком файле молча перестанет случаться. Разбор — docs/journal/2026-09-24-krugolosutochnoe-okno-24-00.md.
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

beforeAll(async () => {
  const passwordHash = await bcrypt.hash("testpass123", 10);
  agentAId = (
    await prisma.agent.create({
      data: { fullName: "Агент А не позвонил", phone: `+992979${runId}`, role: "AGENT", passwordHash },
    })
  ).id;
  agentBId = (
    await prisma.agent.create({
      data: { fullName: "Агент Б от руководителя", phone: `+992980${runId}`, role: "AGENT", passwordHash },
    })
  ).id;
  agentCId = (
    await prisma.agent.create({
      data: { fullName: "Агент В следующий", phone: `+992981${runId}`, role: "AGENT", passwordHash },
    })
  ).id;
});

afterAll(async () => {
  hooks.beforePick = null;
  await prisma.royalScoreEvent.deleteMany({ where: { agentId: { in: [agentAId, agentBId, agentCId] } } });
  await prisma.interaction.deleteMany({
    where: { OR: [{ clientId: { in: clientIds } }, { agentId: { in: [agentAId, agentBId, agentCId] } }] },
  });
  await prisma.auditLog.deleteMany({ where: { entityId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: [agentAId, agentBId, agentCId] } } });
  await prisma.$disconnect();
});

describe("Срыв первого звонка при включённом тумблере", () => {
  it("руководитель отдал карточку Б, пока тик подбирал следующего — карточка остаётся у Б, принятой", async () => {
    const lead = await prisma.client.create({
      data: {
        fullName: `Лид гонки первого звонка ${runId}`,
        phone: `+992982${runId}`,
        source: "PHONE_CALL",
        kind: "BUYER",
        assignedAgentId: agentAId,
        assignedAt: new Date(NOW.getTime() - 20 * 60_000),
        acceptedAt: new Date(NOW.getTime() - 20 * 60_000),
      },
    });
    clientIds.push(lead.id);

    hooks.beforePick = async () => {
      // Только по этому лиду: соседние кандидаты из общей базы хук не трогает.
      await prisma.client.update({
        where: { id: lead.id },
        data: { assignedAgentId: agentBId, lastAgentId: agentAId, acceptedAt: NOW, assignedAt: NOW },
      });
    };
    try {
      await penalizeWithPinnedSettings();
    } finally {
      hooks.beforePick = null;
    }

    const after = await prisma.client.findUnique({ where: { id: lead.id } });
    expect(after?.assignedAgentId).toBe(agentBId);
    expect(after?.lastAgentId).toBe(agentAId);
    expect(after?.acceptedAt).not.toBeNull();
    expect(after?.reassignCount).toBe(0);
    const trace = await prisma.interaction.findFirst({
      where: { clientId: lead.id, notes: { contains: "Лид снят и переназначен" } },
    });
    expect(trace).toBeNull();
  });
});
