import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";

/**
 * НАПОМИНАНИЯ И АВТО-ПРИНЯТИЕ ПО ЗВОНКУ ПОВЕРХ TTL-МЕХАНИЗМА (09.09.2026,
 * замена PR #180 — docs/acceptance-08-09/PR180-review.md).
 *
 * PR #180 предлагал СВОЙ параллельный механизм тайм-аута (жёсткие 48ч,
 * отдельный получасовой крон) поверх уже существующего TTL-механизма main
 * (коммит 317fe1a7 — reactivationOfferTtlHours, почасовой крон,
 * releaseReactivationOffersOfAgent при заморозке/увольнении) — источник истины
 * должен быть ОДИН. Здесь проверяется только то, что реально ново и перенесено
 * из PR: авто-принятие предложения по факту звонка агента клиенту, встроенное
 * в существующий почасовой тик runReactivationOfferReminders, без второго
 * крона. Напоминания агенту (были 25/50/75/90% TTL) убраны 02.10.2026.
 */

const sendPushToAgent = vi.fn(async () => 1);
const sendPushToAgents = vi.fn(async () => 1);
vi.mock("../src/push.js", async (importOriginal) => ({
  // Подмена ДОПОЛНЯЕТ модуль, а не заменяет его целиком (19.09.2026):
  // фабрика без importOriginal убирает остальные экспорты у всего
  // процесса, и СОСЕДНИЙ тест падает на «No "…" export is defined».
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent, sendPushToAgents,
}));

const { prisma } = await import("../src/db.js");
const { runReactivationOfferReminders } = await import("../src/lib/reactivationOffers.js");

const runId = Date.now();
const password = "testpass123";
let agentId: string;
const clientIds: string[] = [];
/** Прежний срок жизни предложения — возвращается в afterAll. */
let savedTtlHours = 0;

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  agentId = (
    await prisma.agent.create({
      data: { fullName: "Агент напоминаний реактивации", phone: `+992${runId}70`, role: "AGENT", passwordHash },
    })
  ).id;
  const before = await prisma.settings.upsert({
    where: { id: "singleton" },
    update: {},
    create: { id: "singleton" },
    select: { reactivationOfferTtlHours: true },
  });
  savedTtlHours = before.reactivationOfferTtlHours;
  await prisma.settings.update({ where: { id: "singleton" }, data: { reactivationOfferTtlHours: 24 } });
});

afterAll(async () => {
  // Settings — singleton на всю базу: оставленный срок жизни предложения
  // менял бы поведение соседних файлов, которые его не трогали.
  await prisma.settings.update({ where: { id: "singleton" }, data: { reactivationOfferTtlHours: savedTtlHours } });
  await prisma.notification.deleteMany({ where: { agentId } });
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.$disconnect();
});

async function makeOfferedClient(reactivationOfferedAt: Date) {
  const c = await prisma.client.create({
    data: {
      fullName: `Напоминание реактивации ${runId}-${clientIds.length}`,
      phone: `+992${runId}71${clientIds.length}`,
      source: "PHONE_CALL",
      kind: "BUYER",
      workStatus: "INACTIVE",
      lastAgentId: agentId,
      reactivationOfferedToAgentId: agentId,
      reactivationOfferedAt,
    },
  });
  clientIds.push(c.id);
  return c;
}

/**
 * НАПОМИНАНИЙ НЕТ (владелец 02.10.2026: напоминания агенту про вернувшегося
 * клиента не нужны). Раньше (20.09.2026) оставалась одна ступень на половине
 * срока; теперь тик не шлёт ни пуша, ни строки в ленте на любой стадии срока.
 */
describe("runReactivationOfferReminders — напоминаний агенту нет", () => {
  for (const [label, hoursAgo] of [
    ["до половины срока (1ч из 24ч)", 1],
    ["половина срока (12ч из 24ч)", 12],
    ["почти на исходе срока (22ч из 24ч)", 22],
  ] as const) {
    it(`${label} — ни записи в ленте, ни пуша; предложение остаётся висеть`, async () => {
      const c = await makeOfferedClient(new Date(Date.now() - hoursAgo * 3600_000));
      sendPushToAgent.mockClear();

      const first = await runReactivationOfferReminders();
      await runReactivationOfferReminders();
      expect(first.reminded).toBe(0);

      const notif = await prisma.notification.findFirst({ where: { agentId, tag: { contains: c.id } } });
      expect(notif).toBeNull();
      expect(JSON.stringify(sendPushToAgent.mock.calls)).not.toContain(c.id);

      // Снимает предложение срок (expireStaleReactivationOffers), а не этот тик.
      const after = await prisma.client.findUniqueOrThrow({ where: { id: c.id } });
      expect(after.reactivationOfferedToAgentId).toBe(agentId);
    });
  }
});

describe("runReactivationOfferReminders — авто-принятие по факту звонка", () => {
  it("агент позвонил клиенту сам — предложение принимается автоматически, напоминание не шлётся", async () => {
    const offeredAt = new Date(Date.now() - 12 * 3600_000);
    const c = await makeOfferedClient(offeredAt);
    await prisma.interaction.create({
      data: {
        clientId: c.id,
        agentId,
        type: "CALL",
        notes: "Агент позвонил клиенту без нажатия кнопки «Принять»",
        createdAt: new Date(offeredAt.getTime() + 1000),
      },
    });

    const result = await runReactivationOfferReminders();
    expect(result.accepted).toBeGreaterThanOrEqual(1);

    const after = await prisma.client.findUniqueOrThrow({ where: { id: c.id } });
    expect(after.workStatus).toBe("ACTIVE");
    expect(after.assignedAgentId).toBe(agentId);
    expect(after.reactivationOfferedToAgentId).toBeNull();
    expect(after.reactivationOfferedAt).toBeNull();

    const noReminder = await prisma.notification.findFirst({ where: { agentId, tag: { contains: c.id } } });
    expect(noReminder).toBeNull();
  });

  it("SYSTEM-запись после предложения не считается звонком — предложение остаётся висеть", async () => {
    const offeredAt = new Date(Date.now() - 12 * 3600_000);
    const c = await makeOfferedClient(offeredAt);
    await prisma.interaction.create({
      data: {
        clientId: c.id,
        agentId,
        type: "SYSTEM",
        notes: "Автоматическая запись, не действие агента",
        createdAt: new Date(offeredAt.getTime() + 1000),
      },
    });

    const result = await runReactivationOfferReminders();
    expect(result.accepted).toBe(0);

    const after = await prisma.client.findUniqueOrThrow({ where: { id: c.id } });
    expect(after.reactivationOfferedToAgentId).toBe(agentId);

    const reminder = await prisma.notification.findFirst({ where: { agentId, tag: { contains: c.id } } });
    expect(reminder).toBeNull();
  });
});
