import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { waitFor } from "./helpers/waitFor.js";
import bcrypt from "bcrypt";
import { prisma } from "../src/db.js";
import { reactivateClientFromLost } from "../src/lib/clientLifecycle.js";
import { reactivateClient } from "../src/lib/clientWorkStatus.js";

/**
 * Регрессионный тест на баг B3 (docs/audit-02-09-2026/01-lifecycle.md):
 * единая функция возврата клиента из LOST/INACTIVE + снятие звонком.
 *
 * Проверяем:
 * 1. Клиент в LOST → реактивация без agentId → статус NEW, assignedAgentId=null,
 *    escalatedAt установлен (возврат в очередь руководителя).
 * 2. Клиент в LOST → реактивация с agentId → статус NEW, назначен агенту.
 * 3. Клиент в INACTIVE (не LOST) → реактивация → workStatus=ACTIVE.
 * 4. Повторная реактивация уже активного клиента — идемпотентна (ok=true,
 *    без дублирующей записи в хронологии).
 */

const runId = Date.now();
const password = "testpass123";

let agentId: string;
let supervisorId: string;
const clientIds: string[] = [];

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  agentId = (
    await prisma.agent.create({
      data: { fullName: `Агент B3 ${runId}`, phone: `+992970${runId}1`, role: "AGENT", passwordHash },
    })
  ).id;
  supervisorId = (
    await prisma.agent.create({
      data: { fullName: `Руководитель B3 ${runId}`, phone: `+992970${runId}2`, role: "DIRECTOR", passwordHash },
    })
  ).id;
});

afterAll(async () => {
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: [agentId, supervisorId] } } });
  await prisma.$disconnect();
});

async function makeLostClient() {
  const c = await prisma.client.create({
    data: {
      fullName: `LOST клиент B3-${clientIds.length}-${runId}`,
      phone: `+992971${runId}${clientIds.length}`,
      source: "PHONE_CALL",
      kind: "BUYER",
      status: "LOST",
      lostAt: new Date(),
      assignedAgentId: null,
      lastAgentId: agentId,
      acceptedAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
    },
  });
  clientIds.push(c.id);
  return c;
}

async function makeInactiveClient() {
  const c = await prisma.client.create({
    data: {
      fullName: `INACTIVE клиент B3-${clientIds.length}-${runId}`,
      phone: `+992972${runId}${clientIds.length}`,
      source: "PHONE_CALL",
      kind: "BUYER",
      status: "NEW",
      workStatus: "INACTIVE",
      inactiveLevel: "YELLOW",
      inactiveSince: new Date(Date.now() - 48 * 60 * 60 * 1000),
      inactivePingCount: 1,
      assignedAgentId: agentId,
      lastAgentId: agentId,
      acceptedAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000),
    },
  });
  clientIds.push(c.id);
  return c;
}

describe("reactivateClientFromLost (B3)", () => {
  it("LOST → реактивация без agentId: статус NEW, очередь руководителя", async () => {
    const client = await makeLostClient();
    const result = await reactivateClientFromLost({
      clientId: client.id,
      reason: "Тест: возврат в очередь",
    });

    expect(result.ok).toBe(true);
    expect(result.client?.status).toBe("NEW");
    expect(result.client?.assignedAgentId).toBeNull();

    const reloaded = await prisma.client.findUniqueOrThrow({ where: { id: client.id } });
    expect(reloaded.status).toBe("NEW");
    expect(reloaded.lostAt).toBeNull();
    expect(reloaded.assignedAgentId).toBeNull();
    expect(reloaded.escalatedAt).not.toBeNull();

    const interactions = await prisma.interaction.findMany({
      where: { clientId: client.id, type: "SYSTEM" },
      orderBy: { createdAt: "desc" },
    });
    expect(interactions[0]?.notes).toContain("[lifecycle]");
    expect(interactions[0]?.notes).toContain("возврат в очередь");
  });

  it("LOST → реактивация с agentId: назначен конкретному агенту", async () => {
    const client = await makeLostClient();
    const result = await reactivateClientFromLost({
      clientId: client.id,
      reason: "Тест: назначение агенту",
      agentId: supervisorId,
    });

    expect(result.ok).toBe(true);
    expect(result.client?.status).toBe("NEW");
    expect(result.client?.assignedAgentId).toBe(supervisorId);

    const reloaded = await prisma.client.findUniqueOrThrow({ where: { id: client.id } });
    expect(reloaded.status).toBe("NEW");
    expect(reloaded.lostAt).toBeNull();
    expect(reloaded.assignedAgentId).toBe(supervisorId);
    expect(reloaded.escalatedAt).toBeNull();
  });

  /**
   * П-1/П-10 (17.09.2026, `docs/audit/lead-ownership-17-09.md` §2, §4):
   * assignedAgentId раньше писался прямым tx.client.update, мимо
   * changeClientAgent — смена владельца при возврате из LOST была не видна
   * в AuditLog (Х3, `docs/audit/recon-17-09/02-auto-transfer-mechanisms.md`).
   */
  it("смена владельца из LOST теперь пишет AuditLog CLIENT_AGENT_CHANGE, source lifecycle", async () => {
    const client = await makeLostClient();
    await reactivateClientFromLost({
      clientId: client.id,
      reason: "Тест: проверка аудита",
      agentId: supervisorId,
    });

    const auditRow = await waitFor(() =>
      prisma.auditLog.findFirst({
        where: { entityType: "Client", entityId: client.id, action: "CLIENT_AGENT_CHANGE" },
      })
    );
    expect(auditRow).not.toBeNull();
    expect((auditRow?.meta as Record<string, unknown> | null)?.source).toBe("lifecycle");
    expect((auditRow?.meta as Record<string, unknown> | null)?.toAgentId).toBe(supervisorId);
  });

  it("LOST → реактивация с agentId и accept (звонок = принятие): acceptedAt стоит", async () => {
    const client = await makeLostClient();
    const result = await reactivateClientFromLost({ clientId: client.id, reason: "Тест: звонок", agentId: supervisorId, accept: true });
    expect(result.ok).toBe(true);
    const reloaded = await prisma.client.findUniqueOrThrow({ where: { id: client.id } });
    expect(reloaded.assignedAgentId).toBe(supervisorId);
    expect(reloaded.acceptedAt).not.toBeNull();
    expect(reloaded.refusalCount).toBe(0);
  });

  it("INACTIVE (не LOST) → реактивация снимает workStatus", async () => {
    const client = await makeInactiveClient();
    const result = await reactivateClientFromLost({
      clientId: client.id,
      reason: "Тест: снятие INACTIVE",
      agentId: agentId,
    });

    expect(result.ok).toBe(true);
    expect(result.client?.workStatus).toBe("ACTIVE");

    const reloaded = await prisma.client.findUniqueOrThrow({ where: { id: client.id } });
    expect(reloaded.workStatus).toBe("ACTIVE");
    expect(reloaded.inactiveLevel).toBeNull();
    expect(reloaded.inactiveSince).toBeNull();
    expect(reloaded.inactivePingCount).toBe(0);
  });

  it("повторная реактивация уже активного клиента идемпотентна", async () => {
    const client = await makeLostClient();
    await reactivateClientFromLost({ clientId: client.id, reason: "Первый раз" });
    const result = await reactivateClientFromLost({ clientId: client.id, reason: "Второй раз" });

    expect(result.ok).toBe(true);

    const interactions = await prisma.interaction.findMany({
      where: { clientId: client.id, type: "SYSTEM", notes: { contains: "[lifecycle]" } },
    });
    // Только одна запись от первого вызова; второй вызов не должен создавать дубль.
    expect(interactions).toHaveLength(1);
  });
});

/**
 * Второй путь возврата — кнопка «Вернуть в работу» на карточке
 * (routes/clients/lifecycle.ts → clientWorkStatus.ts::reactivateClient).
 *
 * До 07.09.2026 он писал только workStatus=ACTIVE и оставлял поля светофора от
 * прошлой жизни карточки — находка №25 в docs/audit-findings-2026-09-05.md.
 * Видно это было сразу (у вернувшегося клиента висел красный уровень), но вредило
 * тихо: inactivePingCount продолжал считать со старого значения, и при следующем
 * переводе в неактивные «предел попыток исчерпан» наступал досрочно, отправляя
 * карточку в LOST раньше срока.
 */
describe("reactivateClient — кнопка «Вернуть в работу» чистит светофор", () => {
  it("снимает уровень, причину, точку отсчёта и счётчик попыток", async () => {
    const client = await makeInactiveClient();
    // Исходное состояние — именно то, что оставил перевод в неактивные.
    expect(client.inactiveLevel).toBe("YELLOW");
    expect(client.inactivePingCount).toBe(1);

    const result = await reactivateClient({ clientId: client.id, agentId });
    expect(result.ok).toBe(true);

    const after = await prisma.client.findUniqueOrThrow({ where: { id: client.id } });
    expect(after.workStatus).toBe("ACTIVE");
    expect(after.inactiveLevel).toBeNull();
    expect(after.inactiveReasonKey).toBeNull();
    expect(after.inactiveSince).toBeNull();
    expect(after.inactivePingCount).toBe(0);
  });
});
