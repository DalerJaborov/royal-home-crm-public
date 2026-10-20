import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import { prisma } from "../src/db.js";
import {
  reactivationWeekKey,
  resolveReactivationTaskAgentId,
  runReactivationCampaignTick,
} from "../src/lib/reactivationCampaign.js";

/**
 * Пачка 12 (11.09.2026, docs/gaps-audit-11-09.md) — реактивация старых
 * клиентов пачкой. Проверяются границы отбора (срок без касания, optedOut),
 * потолок пачки и идемпотентность постановки в очередь в ту же неделю
 * (dedupeKey `reactivation:{clientId}:{weekKey}` — см. jobs/enqueue.ts).
 *
 * Сама отправка сообщения (jobs/clientReactivation.ts) здесь не гоняется: это
 * сетевой вызов к мессенджеру, тик лишь СТАВИТ задание — что оно потом
 * действительно попытается отправить, тестирует сам обработчик косвенно через
 * BackgroundJob.payload.
 */

const runId = Date.now();
const password = "testpass123";
let directorId: string;
let inactiveAgentId: string;
const agentIds: string[] = [];
const clientIds: string[] = [];

const NOW = new Date("2026-09-14T05:00:00Z"); // понедельник, 10:00 по Душанбе

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  directorId = (
    await prisma.agent.create({
      data: { fullName: `Директор реактивации ${runId}`, phone: `+992900${runId}`, role: "DIRECTOR", passwordHash, isActive: true },
    })
  ).id;
  inactiveAgentId = (
    await prisma.agent.create({
      data: {
        fullName: `Уволенный агент ${runId}`,
        phone: `+992901${runId}`,
        role: "AGENT",
        passwordHash,
        isActive: false,
      },
    })
  ).id;
  agentIds.push(directorId, inactiveAgentId);

  await prisma.settings.upsert({
    where: { id: "singleton" },
    update: { reactivationEnabled: true, reactivationAfterDays: 60, reactivationBatchSize: 20 },
    create: { id: "singleton", reactivationEnabled: true, reactivationAfterDays: 60, reactivationBatchSize: 20 },
  });
});

afterAll(async () => {
  await prisma.backgroundJob.deleteMany({ where: { dedupeKey: { startsWith: `reactivation:` } } }).catch(() => {});
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: agentIds } } });
  await prisma.settings.update({ where: { id: "singleton" }, data: { reactivationEnabled: false } }).catch(() => {});
  await prisma.$disconnect();
});

async function makeClient(overrides: Record<string, unknown>) {
  const c = await prisma.client.create({
    data: {
      fullName: `Реактивация ${runId}-${clientIds.length}`,
      phone: `+992${runId}${clientIds.length}`,
      kind: "BUYER",
      currency: "TJS",
      source: "WALK_IN",
      status: "COLD",
      lastContactAt: new Date(NOW.getTime() - 90 * 86_400_000), // 90 дней назад — старше дефолтных 60
      ...overrides,
    },
  });
  clientIds.push(c.id);
  return c;
}

describe("Реактивация старых клиентов пачкой", () => {
  it("тумблер выключен — тик ничего не ставит", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { reactivationEnabled: false } });
    const result = await runReactivationCampaignTick(NOW);
    expect(result).toEqual({ enqueued: 0, skipped: "disabled" });
    await prisma.settings.update({ where: { id: "singleton" }, data: { reactivationEnabled: true } });
  });

  it("клиент старше срока без касания — попадает в пачку; клиент внутри срока — нет", async () => {
    const old = await makeClient({ status: "COLD" });
    const fresh = await makeClient({ status: "COLD", lastContactAt: new Date(NOW.getTime() - 10 * 86_400_000) });

    const result = await runReactivationCampaignTick(NOW);
    expect(result.skipped).toBeNull();

    const weekKey = "2026-09-14";
    const oldJob = await prisma.backgroundJob.findUnique({ where: { dedupeKey: `reactivation:${old.id}:${weekKey}` } });
    const freshJob = await prisma.backgroundJob.findUnique({ where: { dedupeKey: `reactivation:${fresh.id}:${weekKey}` } });
    expect(oldJob).not.toBeNull();
    expect(freshJob).toBeNull();
  });

  it("клиент отписался (optedOutAt в BotConversation) — не ставится, даже пройдя остальной отбор", async () => {
    const client = await makeClient({ status: "LOST" });
    const conv = await prisma.botConversation.create({
      data: { channel: "WHATSAPP", subscriberId: `optedout-${client.id}`, clientId: client.id, optedOutAt: new Date() },
    });

    await runReactivationCampaignTick(NOW);

    const weekKey = "2026-09-14";
    const job = await prisma.backgroundJob.findUnique({ where: { dedupeKey: `reactivation:${client.id}:${weekKey}` } });
    expect(job).toBeNull();

    await prisma.botConversation.delete({ where: { id: conv.id } });
  });

  it("повторный тик в ту же неделю не заводит вторую отправку тому же клиенту (dedupeKey)", async () => {
    const client = await makeClient({ status: "COLD" });
    const weekKey = "2026-09-14";

    await runReactivationCampaignTick(NOW);
    const first = await prisma.backgroundJob.findUnique({ where: { dedupeKey: `reactivation:${client.id}:${weekKey}` } });
    expect(first).not.toBeNull();

    await runReactivationCampaignTick(new Date(NOW.getTime() + 5 * 60_000));
    const all = await prisma.backgroundJob.findMany({ where: { dedupeKey: `reactivation:${client.id}:${weekKey}` } });
    expect(all).toHaveLength(1);
  });

  /**
   * Аудит 23.09.2026, №49: раньше тест требовал ОБРАТНОГО — «следующая неделя,
   * ту же карточку можно поставить снова». Отправка lastContactAt не трогает,
   * поэтому одни и те же самые старые карточки уходили каждую неделю, а до
   * остальных очередь не доходила. Теперь повтор — не раньше, чем через тот же
   * срок (reactivationAfterDays), что и первая попытка.
   */
  it("следующая неделя — та же карточка НЕ ставится, повтор только через срок реактивации", async () => {
    const client = await makeClient({ status: "COLD" });
    const nextMonday = new Date("2026-09-21T05:00:00Z");
    const afterTerm = new Date(NOW.getTime() + 63 * 86_400_000); // 60 дней срока + запас
    await runReactivationCampaignTick(NOW);
    await runReactivationCampaignTick(nextMonday);
    await runReactivationCampaignTick(afterTerm);

    const week1 = await prisma.backgroundJob.findUnique({ where: { dedupeKey: `reactivation:${client.id}:2026-09-14` } });
    const week2 = await prisma.backgroundJob.findUnique({ where: { dedupeKey: `reactivation:${client.id}:2026-09-21` } });
    const later = await prisma.backgroundJob.findUnique({
      where: { dedupeKey: `reactivation:${client.id}:${reactivationWeekKey(afterTerm)}` },
    });
    expect(week1).not.toBeNull();
    expect(week2).toBeNull();
    expect(later).not.toBeNull();
  });

  it("размер пачки ограничивает число поставленных заданий за один тик", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { reactivationBatchSize: 1 } });
    const a = await makeClient({ status: "COLD" });
    const b = await makeClient({ status: "COLD" });

    const smallWeek = new Date("2026-09-28T05:00:00Z");
    const result = await runReactivationCampaignTick(smallWeek);
    expect(result.enqueued).toBeLessThanOrEqual(1);

    const weekKey = "2026-09-28";
    const jobA = await prisma.backgroundJob.findUnique({ where: { dedupeKey: `reactivation:${a.id}:${weekKey}` } });
    const jobB = await prisma.backgroundJob.findUnique({ where: { dedupeKey: `reactivation:${b.id}:${weekKey}` } });
    // Хотя бы одна из двух карточек НЕ должна быть поставлена — потолок пачки = 1.
    expect([jobA, jobB].filter((j) => j !== null).length).toBeLessThanOrEqual(1);

    await prisma.settings.update({ where: { id: "singleton" }, data: { reactivationBatchSize: 20 } });
  });
});


// В общей dev-базе может быть несколько активных директоров, а резолвер берёт
// старейшего — поэтому проверяем не конкретный id, а что адресат — живой DIRECTOR.
async function expectActiveDirector(agentId: string | null) {
  expect(agentId).not.toBeNull();
  const a = await prisma.agent.findUniqueOrThrow({ where: { id: agentId! } });
  expect(a.role).toBe("DIRECTOR");
  expect(a.isActive).toBe(true);
}

describe("Адресат задачи «перезвонить» после реактивации", () => {
  it("действующий владелец карточки — приоритет", async () => {
    const agentId = await resolveReactivationTaskAgentId({ assignedAgentId: directorId, lastAgentId: null });
    expect(agentId).toBe(directorId);
  });

  it("владельца нет, прежний агент уволен — уходит директору", async () => {
    const agentId = await resolveReactivationTaskAgentId({ assignedAgentId: null, lastAgentId: inactiveAgentId });
    await expectActiveDirector(agentId);
  });

  it("владельца и прежнего агента нет вовсе — очередь руководителя", async () => {
    const agentId = await resolveReactivationTaskAgentId({ assignedAgentId: null, lastAgentId: null });
    await expectActiveDirector(agentId);
  });
});
