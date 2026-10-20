import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import { prisma } from "../src/db.js";
import { acceptLead } from "../src/lib/leadAccept.js";

/**
 * pickAgentForLead замокан на «некому передать» только для сценария сбоя
 * освобождения ниже. Без мока функция ходит в реальную (девелоперскую) базу —
 * там уже есть настоящие агенты, удовлетворяющие acceptingLeadsWhere(), так
 * что «некому передать» в реальности никогда не наступает и сценарий
 * непроверяем. Остальные тесты файла releaseClient не вызывают (requiresRelease
 * или обычный приём без освобождения места), так что глобальный мок им не мешает.
 */
vi.mock("../src/services/leads/selection.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/leads/selection.js")>();
  return { ...actual, pickAgentForLead: vi.fn().mockResolvedValue(null) };
});

/**
 * Приём лида: двойной клик (идемпотентность), принятие уже переназначенного
 * лида (гонка с кроном) и освобождение места под свой объект — включая случай
 * сбоя освобождения (пачка 10, 11.09.2026, п.4/п.7 —
 * flow-audit-lead-to-showing-11-09.md, ТОП-10 п.6/п.9).
 */

const runId = Date.now();
const password = "testpass123";

let agentId: string;
let otherAgentId: string;
const clientIds: string[] = [];
let savedSettings: Record<string, unknown>;

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  agentId = (
    await prisma.agent.create({
      data: { fullName: "Агент приёма лида", phone: `+992970${runId}`, role: "AGENT", passwordHash },
    })
  ).id;
  otherAgentId = (
    await prisma.agent.create({
      data: { fullName: "Второй агент приёма лида", phone: `+992971${runId}`, role: "AGENT", passwordHash },
    })
  ).id;

  const settings = await prisma.settings.upsert({ where: { id: "singleton" }, update: {}, create: { id: "singleton" } });
  savedSettings = {
    leadActiveLimit: settings.leadActiveLimit,
    ownPropertyOverLimitEnabled: settings.ownPropertyOverLimitEnabled,
    ownPropertyReleaseEnabled: settings.ownPropertyReleaseEnabled,
    ownPropertyReleaseMode: settings.ownPropertyReleaseMode,
  };
});

afterAll(async () => {
  await prisma.settings.update({ where: { id: "singleton" }, data: savedSettings });
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: [agentId, otherAgentId] } } });
  await prisma.$disconnect();
});

async function makeClient(overrides: Partial<{ ownPropertyLead: boolean; accepted: boolean; assignedAgentId: string }> = {}) {
  const c = await prisma.client.create({
    data: {
      fullName: `Клиент приёма лида ${runId}-${clientIds.length}`,
      phone: `+992972${runId}${clientIds.length}`,
      source: "PHONE_CALL",
      kind: "BUYER",
      assignedAgentId: overrides.assignedAgentId ?? agentId,
      acceptedAt: overrides.accepted ? new Date() : null,
      ownPropertyLead: overrides.ownPropertyLead ?? false,
    },
  });
  clientIds.push(c.id);
  return c;
}

describe("acceptLead — двойной клик", () => {
  it("повторный вызов на уже принятой карточке — успех, без побочных эффектов", async () => {
    const client = await makeClient();
    const first = await acceptLead({ clientId: client.id, agentId });
    expect(first.ok).toBe(true);

    const second = await acceptLead({ clientId: client.id, agentId });
    expect(second.ok).toBe(true);

    const reloaded = await prisma.client.findUniqueOrThrow({ where: { id: client.id } });
    expect(reloaded.acceptedAt).not.toBeNull();
    // Записей «Лид принят агентом» — ровно одна, не по одной на каждый клик.
    const accepts = await prisma.interaction.count({
      where: { clientId: client.id, notes: "Лид принят агентом — контакты открыты" },
    });
    expect(accepts).toBe(1);
  });
});

describe("acceptLead — принятие уже переназначенного лида", () => {
  it("лид ушёл другому агенту (гонка с кроном) — 409, а не тихий успех", async () => {
    const client = await makeClient();
    // Симулируем то, что делает крон переназначения между проверками агента и приёмом.
    await prisma.client.update({ where: { id: client.id }, data: { assignedAgentId: otherAgentId } });

    const result = await acceptLead({ clientId: client.id, agentId });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(409);
    }
  });
});

describe("acceptLead — освобождение места под свой объект", () => {
  it("портфель полон, режим «агент выбирает» — приём не состоялся, возвращены кандидаты", async () => {
    await prisma.settings.update({
      where: { id: "singleton" },
      data: {
        leadActiveLimit: 1,
        ownPropertyOverLimitEnabled: true,
        ownPropertyReleaseEnabled: true,
        ownPropertyReleaseMode: "agent_choice",
      },
    });

    // Слот уже занят обычным (не своим) клиентом.
    await makeClient({ accepted: true });
    const ownLead = await makeClient({ ownPropertyLead: true });

    const result = await acceptLead({ clientId: ownLead.id, agentId });
    expect(result.ok).toBe(false);
    if (!result.ok && result.requiresRelease) {
      expect(result.candidates.length).toBeGreaterThan(0);
    } else {
      throw new Error("ожидался requiresRelease:true");
    }

    // Приём НЕ состоялся — карточка своего объекта осталась непринятой.
    const reloaded = await prisma.client.findUniqueOrThrow({ where: { id: ownLead.id } });
    expect(reloaded.acceptedAt).toBeNull();
  });

  it("сбой освобождения (некому передать) не теряется молча — Interaction на освобождаемом клиенте", async () => {
    await prisma.settings.update({
      where: { id: "singleton" },
      data: {
        leadActiveLimit: 1,
        ownPropertyOverLimitEnabled: true,
        ownPropertyReleaseEnabled: true,
        // agent_choice — явно указываем, кого освобождать (releaseClientId), чтобы
        // выбор кандидата был детерминированным (см. ниже, почему это важно).
        ownPropertyReleaseMode: "agent_choice",
      },
    });

    const normal = await makeClient({ accepted: true });
    const ownLead = await makeClient({ ownPropertyLead: true });

    // pickAgentForLead замокан выше на «некому передать» (в реальной девелоперской
    // базе всегда находится хоть один подходящий агент, и «некому передать» иначе
    // непроверяемо) — освобождение обязано провалиться предсказуемо.
    //
    // releaseClientId передаём явно, а не полагаемся на releaseMode="random":
    // agentId используется во ВСЕХ тестах этого файла и у него уже могут быть
    // другие обычные лиды-кандидаты (например, «normal» из предыдущего теста
    // «портфель полон, режим агент выбирает» выше) — случайный выбор из
    // releaseCandidates мог бы попасть в чужого, а не в этого normal, и тогда
    // Interaction писалась бы не на том клиенте, которого проверяет этот тест.
    const result = await acceptLead({ clientId: ownLead.id, agentId, releaseClientId: normal.id });
    expect(result.ok).toBe(true);

    // releaseClient — фоновая, ждём её завершения.
    await new Promise((r) => setTimeout(r, 800));

    const normalReloaded = await prisma.client.findUniqueOrThrow({ where: { id: normal.id } });
    // Мок гарантирует отказ — клиент остаётся у прежнего агента.
    expect(normalReloaded.assignedAgentId).toBe(agentId);
    const failureNote = await prisma.interaction.findFirst({
      where: { clientId: normal.id, notes: { contains: "Не удалось передать освобождённого клиента" } },
    });
    expect(failureNote).not.toBeNull();
  });
});
