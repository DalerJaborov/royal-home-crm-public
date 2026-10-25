import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * ПОТЕРЯННЫЙ КЛИЕНТ УВОЛЕННОГО/ЗАМОРОЖЕННОГО АГЕНТА ПИШЕТ СНОВА (ночная проверка
 * 24.09.2026, находка №118, круг «Клиенты и владение»).
 *
 * `agentHandover.ts` при увольнении переносит только АКТИВНЫЕ статусы
 * (`MOVABLE_STATUSES`) — LOST туда намеренно не входит, `markClientLost`
 * оставляет `assignedAgentId` прежним. Ветка `existing.status === "LOST"` в
 * `services/leads/intake.ts` (`resumeExistingChannelLead`) до этой правки
 * безусловно возвращала статус в работу («написал сам — снова NEW»), не
 * проверяя, доступен ли держатель карточки: карточка «оживала» на уволенном
 * или замороженном агенте, и руководитель узнавал об этом только на утренней
 * сверке (~4 часа), хотя точно такая же реактивация ВХОДЯЩИМ ЗВОНКОМ
 * (`lib/telephony/inboundRouting.ts`) уже проверяла доступность и уводила
 * карточку в очередь.
 *
 * Это ДРУГОЙ путь, чем в `bot-lost-client-reactivation.test.ts`: та проверка
 * снимает LOST с карточки, УЖЕ привязанной к диалогу (`conversation.clientId`,
 * поймано и починено 18.09.2026, `messengers/conversation.ts`). Здесь же клиент
 * находится заново по номеру телефона (`createLeadFromChannel` →
 * `resumeExistingChannelLead`) — например, написал в канал, не связанный с
 * прежним диалогом, но с тем же номером. До этой правки эта ветка держателя
 * не проверяла вовсе.
 */

const sendPushToAgent = vi.fn(async () => 1);
const sendPushToAgents = vi.fn(async () => 1);
vi.mock("../src/push.js", async (importOriginal) => ({
  // Подмена ДОПОЛНЯЕТ модуль, а не заменяет целиком (правило 19.09.2026, см.
  // соседние тесты этого файла) — иначе валится другой открытый тест.
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent,
  sendPushToAgents,
}));

const { prisma } = await import("../src/db.js");
const { createLeadFromChannel } = await import("../src/leads.js");

const runId = Date.now();
const clientIds: string[] = [];
const agentIds: string[] = [];

async function makeAgent(label: string, extra: { isActive?: boolean; frozenAt?: Date } = {}) {
  const a = await prisma.agent.create({
    data: {
      fullName: `${label} ${runId}`,
      phone: `+99290${agentIds.length}${runId}`,
      role: "AGENT",
      passwordHash: "x",
      isActive: extra.isActive ?? true,
      frozenAt: extra.frozenAt ?? null,
    },
  });
  agentIds.push(a.id);
  return a.id;
}

beforeAll(async () => {
  // Рабочие часы фиксируем на круглые сутки — реактивация LOST не зависит от
  // раздачи по расписанию, но соседний по времени прогон не должен ловить
  // ночное окно (ловушка CLAUDE.md, "работает только днём").
  await prisma.settings.upsert({
    where: { id: "singleton" },
    update: { workHoursStart: "00:00", workHoursEnd: "24:00" },
    create: { id: "singleton", workHoursStart: "00:00", workHoursEnd: "24:00" },
  });
});

afterAll(async () => {
  await prisma.settings
    .update({ where: { id: "singleton" }, data: { workHoursStart: "09:30", workHoursEnd: "18:00" } })
    .catch(() => {});
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.auditLog.deleteMany({ where: { entityType: "Client", entityId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: agentIds } } });
  await prisma.$disconnect();
});

async function makeLostClient(
  phone: string,
  holderAgentId: string,
  kind: "BUYER" | "SELLER" = "BUYER"
): Promise<string> {
  const created = await createLeadFromChannel({ fullName: `Потерянный ${phone}`, phone, source: "INSTAGRAM", kind });
  clientIds.push(created.clientId);
  await prisma.client.update({
    where: { id: created.clientId },
    data: { status: "LOST", lostAt: new Date(), assignedAgentId: holderAgentId, lastAgentId: holderAgentId },
  });
  return created.clientId;
}

async function expectAvailableAutomaticOwner(client: { assignedAgentId: string | null; escalatedAt: Date | null; acceptedAt: Date | null; deletedAt: Date | null; workStatus: string }, formerId: string) {
  expect(client.assignedAgentId).not.toBe(formerId);
  if (client.assignedAgentId) {
    const holder = await prisma.agent.findUniqueOrThrow({ where: { id: client.assignedAgentId } });
    expect(holder.isActive).toBe(true);
    expect(holder.frozenAt).toBeNull();
  } else {
    // Обычная AUTO-очередь может ждать следующего прохода раздачи.
    // Это не ручная эскалация и не сохранение карточки у недоступного агента.
    expect(client.acceptedAt).toBeNull();
    expect(client.deletedAt).toBeNull();
    expect(client.workStatus).toBe("ACTIVE");
  }
  expect(client.escalatedAt).toBeNull();
}

describe("LOST-клиент уволенного/замороженного агента пишет снова", () => {
  it("активный исторический владелец получает LOST через центральную смену с аудитом", async () => {
    const formerId = await makeAgent("Уволенный текущий", { isActive: false });
    const historicalId = await makeAgent("Активный исторический");
    const phone = `+992914${runId}`;
    const clientId = await makeLostClient(phone, formerId);
    await prisma.client.update({ where: { id: clientId }, data: { lastAgentId: historicalId, acceptedAt: null, firstContactAt: null } });

    await createLeadFromChannel({ fullName: "Вернулся к прежнему", phone, source: "WHATSAPP" });

    const updated = await prisma.client.findUniqueOrThrow({ where: { id: clientId } });
    expect(updated.status).toBe("NEW");
    expect(updated.assignedAgentId).toBe(historicalId);
    expect(updated.escalatedAt).toBeNull();
    expect(updated.returnAcceptDueAt).not.toBeNull();
    const audits = await prisma.auditLog.findMany({ where: { entityId: clientId, action: "CLIENT_AGENT_CHANGE", meta: { path: ["source"], equals: "intake.lost-historical-owner" } } });
    expect(audits).toHaveLength(1);
    expect(audits[0].meta).toMatchObject({ fromAgentId: formerId, toAgentId: historicalId });
    expect(await prisma.interaction.count({ where: { clientId, type: "SYSTEM", notes: { contains: "intake.lost-historical-owner" } } })).toBe(1);
  });
  it("держатель активен — карточка возвращается ему, как раньше", async () => {
    const agentId = await makeAgent("Активный держатель");
    const phone = `+992910${runId}`;
    const clientId = await makeLostClient(phone, agentId);

    await createLeadFromChannel({ fullName: "Потерянный вернулся", phone, source: "WHATSAPP" });

    const updated = await prisma.client.findUniqueOrThrow({ where: { id: clientId } });
    expect(updated.status).toBe("NEW");
    expect(updated.assignedAgentId).toBe(agentId);
    expect(updated.escalatedAt).toBeNull();
  });

  it("держатель уволен (isActive:false) — карточка автоматически назначается доступному агенту", async () => {
    const agentId = await makeAgent("Уволенный держатель", { isActive: false });
    const phone = `+992911${runId}`;
    const clientId = await makeLostClient(phone, agentId);

    await createLeadFromChannel({ fullName: "Потерянный вернулся", phone, source: "WHATSAPP" });

    const updated = await prisma.client.findUniqueOrThrow({ where: { id: clientId } });
    expect(updated.status).toBe("NEW");
    await expectAvailableAutomaticOwner(updated, agentId);
  });

  it("держатель заморожен (frozenAt) — карточка автоматически назначается доступному агенту", async () => {
    const agentId = await makeAgent("Замороженный держатель", { frozenAt: new Date() });
    const phone = `+992912${runId}`;
    const clientId = await makeLostClient(phone, agentId);

    await createLeadFromChannel({ fullName: "Потерянный вернулся", phone, source: "WHATSAPP" });

    const updated = await prisma.client.findUniqueOrThrow({ where: { id: clientId } });
    expect(updated.status).toBe("NEW");
    await expectAvailableAutomaticOwner(updated, agentId);
  });

  it("продавец автоматически раздаётся, если держателя уволили", async () => {
    const agentId = await makeAgent("Уволенный держатель продавца", { isActive: false });
    const phone = `+992913${runId}`;
    const clientId = await makeLostClient(phone, agentId, "SELLER");

    await createLeadFromChannel({ fullName: "Продавец вернулся", phone, source: "WHATSAPP", kind: "SELLER" });

    const updated = await prisma.client.findUniqueOrThrow({ where: { id: clientId } });
    expect(updated.status).toBe("NEW");
    await expectAvailableAutomaticOwner(updated, agentId);
  });
});
