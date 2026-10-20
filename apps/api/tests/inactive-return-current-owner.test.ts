import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * ВОЗВРАТ ИЗ «НЕАКТИВНЫХ» СМОТРИТ НА ТЕКУЩЕГО ВЛАДЕЛЬЦА, А НЕ НА lastAgentId
 * (ночная проверка 24.09.2026, находка №1 круга «Клиенты и владение»).
 *
 * Сценарий из находки: клиент лежал в «Неактивных» у агента А; А уволили, раздача
 * дел (lib/agentHandover.ts) перенесла карточку живому Б, и changeClientAgent
 * записал lastAgentId = А. Клиент пишет снова. Раньше intake.ts спрашивал
 * decideReturningClient про А: тот уволен, но не «в отпуске» (frozenAt пуст) →
 * «недоступен» → очередь → pickAgentForLead — карточка, включая ПРОДАВЦА,
 * уезжала случайному третьему агенту при живом владельце Б.
 *
 * Правила владельца (docs/JOURNAL.md §4): продавец не уходит никогда; передаёт
 * клиента только владелец. С решения 23.09.2026 («заморозка — только чтобы не
 * приходили новые») покупатель тоже остаётся за своим агентом при любом его
 * отсутствии — до этого при отпуске он уходил в общую очередь. Значит,
 * спрашивать нужно про Б — и карточка остаётся за Б.
 *
 * Идёт напрямую через createLeadFromChannel (без бота), поэтому рабочие часы
 * здесь ни на что не влияют.
 */

const sendPushToAgent = vi.fn(async () => 1);
const sendPushToAgents = vi.fn(async () => 1);
vi.mock("../src/push.js", async (importOriginal) => ({
  // Подмена ДОПОЛНЯЕТ модуль, а не заменяет его целиком: фабрика без
  // importOriginal убирает остальные экспорты у всего процесса.
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent,
  sendPushToAgents,
}));

const { prisma } = await import("../src/db.js");
const { createLeadFromChannel } = await import("../src/leads.js");

const runId = Date.now();
/** А — уволен (isActive:false, frozenAt пуст — ровно так увольняет agents.ts). */
let firedAgentId: string;
/** Б — живой владелец карточки после раздачи дел А. */
let ownerAgentId: string;
/** В — ещё один живой агент, чтобы очереди было кому отдать карточку. */
let thirdAgentId: string;
const clientIds: string[] = [];

beforeAll(async () => {
  firedAgentId = (
    await prisma.agent.create({
      data: { fullName: "Уволенный А (возврат)", phone: `+992${runId}81`, role: "AGENT", passwordHash: "x", isActive: false },
    })
  ).id;
  ownerAgentId = (
    await prisma.agent.create({
      data: { fullName: "Владелец Б (возврат)", phone: `+992${runId}82`, role: "AGENT", passwordHash: "x" },
    })
  ).id;
  thirdAgentId = (
    await prisma.agent.create({
      data: { fullName: "Третий В (возврат)", phone: `+992${runId}83`, role: "AGENT", passwordHash: "x" },
    })
  ).id;
});

afterAll(async () => {
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: [firedAgentId, ownerAgentId, thirdAgentId] } } });
  await prisma.$disconnect();
});

/** Неактивная карточка после раздачи дел: владелец Б, lastAgentId — уволенный А. */
async function makeHandedOverInactiveClient(kind: "SELLER" | "BUYER") {
  const c = await prisma.client.create({
    data: {
      fullName: `Вернувшийся ${kind} после раздачи ${runId}-${clientIds.length}`,
      phone: `+992${runId}9${clientIds.length}`,
      source: "PHONE_CALL",
      kind,
      workStatus: "INACTIVE",
      inactiveSince: new Date(),
      assignedAgentId: ownerAgentId,
      acceptedAt: new Date(),
      lastAgentId: firedAgentId,
    },
  });
  clientIds.push(c.id);
  return c;
}

async function setOwnerOnVacation(on: boolean) {
  await prisma.agent.update({
    where: { id: ownerAgentId },
    data: on
      ? { frozenAt: new Date(), frozenReason: "Отпуск", absenceKind: "VACATION" }
      : { frozenAt: null, frozenReason: null, absenceKind: null },
  });
}

describe("Возврат из «Неактивных» после раздачи дел уволенного", () => {
  it("ПРОДАВЕЦ: владелец Б жив — предложение Б, карточка остаётся его, не третьему агенту", async () => {
    const c = await makeHandedOverInactiveClient("SELLER");

    const result = await createLeadFromChannel({ fullName: c.fullName, phone: c.phone, source: "WHATSAPP", kind: "SELLER" });
    expect(result.created).toBe(false);

    const after = await prisma.client.findUnique({ where: { id: c.id } });
    expect(after?.assignedAgentId).toBe(ownerAgentId);
    expect(after?.reactivationOfferedToAgentId).toBe(ownerAgentId);
    // Пока Б не решил — карточка ещё в «Неактивных», а не «оживлена» на другого.
    expect(after?.workStatus).toBe("INACTIVE");
  });

  it("ПОКУПАТЕЛЬ: владелец Б жив — то же предложение Б", async () => {
    const c = await makeHandedOverInactiveClient("BUYER");

    await createLeadFromChannel({ fullName: c.fullName, phone: c.phone, source: "WHATSAPP", kind: "BUYER" });

    const after = await prisma.client.findUnique({ where: { id: c.id } });
    expect(after?.assignedAgentId).toBe(ownerAgentId);
    expect(after?.reactivationOfferedToAgentId).toBe(ownerAgentId);
    expect(after?.workStatus).toBe("INACTIVE");
  });

  it("ПРОДАВЕЦ при владельце Б в отпуске — остаётся за Б (продавец не уходит никогда)", async () => {
    const c = await makeHandedOverInactiveClient("SELLER");
    await setOwnerOnVacation(true);
    try {
      await createLeadFromChannel({ fullName: c.fullName, phone: c.phone, source: "WHATSAPP", kind: "SELLER" });

      const after = await prisma.client.findUnique({ where: { id: c.id } });
      expect(after?.assignedAgentId).toBe(ownerAgentId);
      expect(after?.reactivationOfferedToAgentId).toBeNull();
      expect(after?.workStatus).toBe("ACTIVE");
    } finally {
      await setOwnerOnVacation(false);
    }
  });

  it("ПОКУПАТЕЛЬ при владельце Б в отпуске — остаётся за Б (решение владельца 23.09.2026)", async () => {
    const c = await makeHandedOverInactiveClient("BUYER");
    await setOwnerOnVacation(true);
    try {
      await createLeadFromChannel({ fullName: c.fullName, phone: c.phone, source: "WHATSAPP", kind: "BUYER" });

      const after = await prisma.client.findUnique({ where: { id: c.id } });
      expect(after?.reactivationOfferedToAgentId).toBeNull();
      expect(after?.workStatus).toBe("ACTIVE");
      // Раньше здесь ждали очередь: покупателя при отпуске агента отнимали. Теперь
      // он остаётся за Б — и главное прежнее требование в силе: карточка не
      // уезжает ни уволенному А, ни случайному третьему агенту.
      expect(after?.assignedAgentId).toBe(ownerAgentId);
      expect(after?.assignedAgentId).not.toBe(firedAgentId);
    } finally {
      await setOwnerOnVacation(false);
    }
  });
});
