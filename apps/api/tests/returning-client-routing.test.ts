import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import { prisma } from "../src/db.js";
import { decideReturningClient } from "../src/lib/returningClientRouting.js";

/**
 * Кому достаётся вернувшийся клиент, когда его агента нет на работе
 * (владелец 08.09.2026, ПЕРЕПИСАНО 16.09.2026).
 *
 * Правила сократились с трёх развилок до двух строк — по прямому указанию владельца:
 * «Продавец никогда не уходит. Даже если агент в отпуске или на больничном» и «Только
 * я могу передавать продавца или покупателя. А не система».
 *
 *  ПРОДАВЕЦ остаётся за своим агентом при любом отсутствии. Есть объект в работе или
 *  нет — не важно: ждать объект не повод отнимать карточку.
 *
 *  ПОКУПАТЕЛЬ уходит в общую очередь ТОЛЬКО при отпуске (до 30 дней). При больничном
 *  (до 7) карточка остаётся за агентом, а владельцу уходит строка: решение за ним.
 *
 * Отменённые проверки — «есть ли у продавца объект» и «был ли у покупателя настоящий
 * разговор» — здесь намеренно оставлены отдельными тестами с новым ожиданием: они и
 * есть та граница, где механизм раньше забирал карточку сам.
 */
const runId = Date.now();
let agentId: string;
let districtId: string;
const clientIds: string[] = [];
const propertyIds: string[] = [];

beforeAll(async () => {
  const passwordHash = await bcrypt.hash("testpass123", 10);
  agentId = (
    await prisma.agent.create({
      data: { fullName: "Агент возврата", phone: `+992957${runId}`, role: "AGENT", passwordHash },
    })
  ).id;
  districtId = (await prisma.district.create({ data: { name: `Район-возврат-${runId}` } })).id;
});

afterAll(async () => {
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.$disconnect();
});

async function makeClient(kind: "SELLER" | "BUYER" | "OTHER") {
  const c = await prisma.client.create({
    data: {
      fullName: `Вернувшийся ${kind} ${runId}-${clientIds.length}`,
      phone: `+992958${runId}${clientIds.length}`,
      source: "PHONE_CALL",
      kind,
      lastAgentId: agentId,
      workStatus: "INACTIVE",
    },
  });
  clientIds.push(c.id);
  return c;
}

async function addProperty(sellerClientId: string) {
  const p = await prisma.property.create({
    data: {
      title: `Объект возврата ${runId}-${propertyIds.length}`,
      type: "APARTMENT",
      areaSqm: 50,
      price: 60000,
      currency: "TJS",
      districtId,
      address: "Тест",
      condition: "GOOD",
      status: "AVAILABLE",
      sellerClientId,
    },
  });
  propertyIds.push(p.id);
  return p;
}

async function addTalkedCall(clientId: string) {
  await prisma.interaction.create({
    data: { clientId, agentId, type: "CALL", callAttempt: "TALKED", notes: "Разговор через CRM" },
  });
}

/**
 * Вид отсутствия задаётся явно: с 09.09.2026 от него зависит, отдаём ли клиента
 * другому агенту сразу (отпуск) или ждём ответа своего (больничный).
 */
async function setAbsent(absent: boolean, kind: "VACATION" | "SICK" | "OTHER" = "VACATION") {
  await prisma.agent.update({
    where: { id: agentId },
    data: absent
      ? { frozenAt: new Date(), frozenReason: kind === "VACATION" ? "Отпуск" : "Больничный", absenceKind: kind }
      : { frozenAt: null, frozenReason: null, absenceKind: null },
  });
}

describe("Агент на месте", () => {
  it("вернувшийся клиент предлагается своему агенту", async () => {
    const c = await makeClient("BUYER");
    const route = await decideReturningClient({ clientId: c.id, kind: c.kind, lastAgentId: agentId });
    expect(route).toEqual({ kind: "offer", agentId });
  });

  /**
   * ПРАВКА, РАДИ КОТОРОЙ ЭТО И ЗАВОДИЛОСЬ. Пауза «не принимаю новых лидов» —
   * просьба агента закрыть ВХОД, чтобы спокойно доработать своих перед отпуском.
   * Раньше она отбирала у него и собственного вернувшегося клиента — ровно
   * наоборот тому, зачем кнопка нужна. Свой вернувшийся клиент не новый лид.
   */
  it("пауза «не принимаю новых лидов» НЕ отнимает собственного вернувшегося клиента", async () => {
    const c = await makeClient("BUYER");
    await prisma.agent.update({
      where: { id: agentId },
      data: { leadsPausedUntil: new Date(Date.now() + 24 * 3600_000) },
    });
    try {
      const route = await decideReturningClient({ clientId: c.id, kind: c.kind, lastAgentId: agentId });
      expect(route).toEqual({ kind: "offer", agentId });
    } finally {
      await prisma.agent.update({ where: { id: agentId }, data: { leadsPausedUntil: null } });
    }
  });
});

describe("Агента нет на работе — ПРОДАВЕЦ остаётся всегда", () => {
  it("объект добавлен — остаётся за своим агентом", async () => {
    const c = await makeClient("SELLER");
    await addProperty(c.id);
    await setAbsent(true);
    try {
      const route = await decideReturningClient({ clientId: c.id, kind: c.kind, lastAgentId: agentId });
      expect(route).toEqual({ kind: "keep", agentId, reason: "seller-absent-agent", notifyOwner: false });
    } finally {
      await setAbsent(false);
    }
  });

  it("объекта НЕТ и агент в отпуске — всё равно остаётся (было: уходил другому)", async () => {
    // Прежнее правило отдавало такого продавца в очередь: «вернувшемуся нужно
    // физическое действие, а человек в отпуске его не сделает». Отменено 16.09.2026:
    // ждать объект — не повод отнимать карточку у агента без решения владельца.
    const c = await makeClient("SELLER");
    await setAbsent(true, "VACATION");
    try {
      const route = await decideReturningClient({ clientId: c.id, kind: c.kind, lastAgentId: agentId });
      expect(route).toEqual({ kind: "keep", agentId, reason: "seller-absent-agent", notifyOwner: false });
    } finally {
      await setAbsent(false);
    }
  });

  it("больничный — тоже остаётся, и владельца этим не тревожим", async () => {
    const c = await makeClient("SELLER");
    await setAbsent(true, "SICK");
    try {
      const route = await decideReturningClient({ clientId: c.id, kind: c.kind, lastAgentId: agentId });
      expect(route).toEqual({ kind: "keep", agentId, reason: "seller-absent-agent", notifyOwner: false });
    } finally {
      await setAbsent(false);
    }
  });
});

describe("Агента нет на работе — ПОКУПАТЕЛЬ", () => {
  it("отпуск — карточка ОСТАЁТСЯ, владелец узнаёт (было: уходила в очередь; владелец 23.09.2026)", async () => {
    const c = await makeClient("BUYER");
    await setAbsent(true, "VACATION");
    try {
      const route = await decideReturningClient({ clientId: c.id, kind: c.kind, lastAgentId: agentId });
      expect(route).toEqual({ kind: "keep", agentId, reason: "buyer-absent-agent", notifyOwner: true });
    } finally {
      await setAbsent(false);
    }
  });

  it("отпуск: был настоящий разговор — тем более остаётся за агентом", async () => {
    const c = await makeClient("BUYER");
    await addTalkedCall(c.id);
    await setAbsent(true, "VACATION");
    try {
      const route = await decideReturningClient({ clientId: c.id, kind: c.kind, lastAgentId: agentId });
      expect(route).toEqual({ kind: "keep", agentId, reason: "buyer-absent-agent", notifyOwner: true });
    } finally {
      await setAbsent(false);
    }
  });

  it("больничный — карточка ОСТАЁТСЯ, но владелец узнаёт (было: уходила в очередь)", async () => {
    // Раньше покупателя без состоявшегося разговора отдавали сразу. Теперь система
    // не решает за владельца: карточка остаётся, ему приходит строка.
    const c = await makeClient("BUYER");
    await setAbsent(true, "SICK");
    try {
      const route = await decideReturningClient({ clientId: c.id, kind: c.kind, lastAgentId: agentId });
      expect(route).toEqual({ kind: "keep", agentId, reason: "buyer-sick-agent", notifyOwner: true });
    } finally {
      await setAbsent(false);
    }
  });

  it("больничный: разговор был — тот же ответ, разговор больше ничего не решает", async () => {
    const c = await makeClient("BUYER");
    await addTalkedCall(c.id);
    await setAbsent(true, "SICK");
    try {
      const route = await decideReturningClient({ clientId: c.id, kind: c.kind, lastAgentId: agentId });
      expect(route).toEqual({ kind: "keep", agentId, reason: "buyer-sick-agent", notifyOwner: true });
    } finally {
      await setAbsent(false);
    }
  });

  it("вид отсутствия неизвестен — ведём себя как при больничном", async () => {
    const c = await makeClient("BUYER");
    await setAbsent(true, "OTHER");
    try {
      const route = await decideReturningClient({ clientId: c.id, kind: c.kind, lastAgentId: agentId });
      expect(route).toEqual({ kind: "keep", agentId, reason: "buyer-sick-agent", notifyOwner: true });
    } finally {
      await setAbsent(false);
    }
  });
});

describe("Особые случаи", () => {
  it("«прочее обращение» агенту не полагается — сразу в очередь", async () => {
    const c = await makeClient("OTHER");
    const route = await decideReturningClient({ clientId: c.id, kind: c.kind, lastAgentId: agentId });
    expect(route).toEqual({ kind: "queue", reason: "no-agent" });
  });

  it("прежнего агента не было вовсе — в очередь", async () => {
    const c = await makeClient("BUYER");
    const route = await decideReturningClient({ clientId: c.id, kind: c.kind, lastAgentId: null });
    expect(route).toEqual({ kind: "queue", reason: "no-agent" });
  });

  it("агент уволен — в очередь, даже если продавец с объектом", async () => {
    const c = await makeClient("SELLER");
    await addProperty(c.id);
    await prisma.agent.update({ where: { id: agentId }, data: { isActive: false } });
    try {
      const route = await decideReturningClient({ clientId: c.id, kind: c.kind, lastAgentId: agentId });
      expect(route).toEqual({ kind: "queue", reason: "unavailable" });
    } finally {
      await prisma.agent.update({ where: { id: agentId }, data: { isActive: true } });
    }
  });
});
