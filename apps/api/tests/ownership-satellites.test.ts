import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * СТОРОЖ «СПУТНИКИ ГАСНУТ В САМОМ ЕДИНОМ ВХОДЕ» (11.09.2026, второй заход по
 * осиротевшим спутникам, `docs/archive/agent-briefs/ownership-security-11-09.md`, Пачка 15).
 *
 * Факты с прода 11.09: из 97 непрочитанных уведомлений «лид» 78 висели у
 * агентов, у которых клиента уже нет; 15 открытых задач — на агентах, не
 * ведущих клиента. Причина: `lib/changeClientAgent.ts` — единственная точка
 * записи `assignedAgentId`, но она писала только поле + Interaction + AuditLog,
 * а спутников (пуш/лента/требования/заявка на удаление/задачи/живое событие)
 * гасил каждый вызывающий сам — и почти никто не гасил всё.
 *
 * ПРОВЕРЯЕМ:
 * 1. `changeClientAgent` САМА зовёт `closeOwnershipSatellites`, когда агент
 *    реально меняется, и НЕ зовёт, когда `skipSatellites` или агент тот же —
 *    это и есть гарантия, что ВСЕ вызывающие места (declineLead,
 *    reassignStaleLeads, freeze, handover, transfer,
 *    refuse, assign — все они уже вызывают changeClientAgent, см. грепом ниже)
 *    получили гашение спутников бесплатно, одним изменением в одном файле.
 * 2. `closeOwnershipSatellites` реально делает то, что обещает: гасит
 *    непрочитанные Notification прежнего агента по клиенту, перевешивает
 *    открытую задачу на нового агента, снимает зависшую заявку на удаление,
 *    публикует `client.updated` с обоими агентами.
 * 3. `markClientLost` (агент не меняется) всё равно гасит push/уведомления и
 *    публикует live — отдельная ветка, не покрытая автоматическим вызовом
 *    внутри changeClientAgent (там agentId не меняется).
 * 4. `mergeClients` (используется и роутом /merge, и
 *    `lib/duplicateReview.ts::confirmDuplicateReview` напрямую) сама гасит
 *    спутники дубля — было дырой именно для второго вызывающего.
 * 5. Структурный грep: перечисленные в задании механизмы (reassignStaleLeads,
 *    declineLead, freeze, handover, transfer/refuse,
 *    merge через duplicateReview) действительно идут через единый вход
 *    (`changeClientAgent`/`mergeClients`), а не через свой прямой апдейт —
 *    иначе гашение спутников до них не доедет.
 */

const publishClientUpdated = vi.fn();
vi.mock("../src/lib/livePublish.js", () => ({
  publishClientUpdated,
  publishNotificationNew: vi.fn(),
  OVERSEER_ROLES: ["DIRECTOR", "ADMIN", "MANAGER", "SECURITY"],
}));

// 18.09.2026: changeClientAgent теперь сам зовёт автопилот («Коротко от ИИ»
// обязано узнать о смене владельца) — мокаем, чтобы тест проверял САМ ВЫЗОВ, а
// не гонял настоящий ИИ-скоринг в фоне на каждый прогон этого файла.
const runClientAutopilotInBackground = vi.fn();
vi.mock("../src/lib/clientAutopilot.js", () => ({ runClientAutopilotInBackground }));

const { prisma } = await import("../src/db.js");
const { changeClientAgent } = await import("../src/lib/changeClientAgent.js");
const { closeOwnershipSatellites } = await import("../src/lib/ownershipSatellites.js");
const { markClientLost } = await import("../src/lib/clientLifecycle.js");
const { mergeClients } = await import("../src/lib/clientMerge.js");
const { createNotification } = await import("../src/lib/notifications.js");

const runId = Date.now();
const password = "testpass123";
const agentIds: string[] = [];
const clientIds: string[] = [];

async function makeAgent(name: string) {
  const passwordHash = await bcrypt.hash(password, 10);
  const a = await prisma.agent.create({
    data: { fullName: `${name} ${runId}`, phone: `+992970${agentIds.length}${String(runId).slice(-6)}`, role: "AGENT", passwordHash },
  });
  agentIds.push(a.id);
  return a.id;
}

async function makeClient(assignedAgentId: string | null) {
  const c = await prisma.client.create({
    data: {
      fullName: `Клиент-спутники ${runId}-${clientIds.length}`,
      phone: `+992971${clientIds.length}${String(runId).slice(-6)}`,
      source: "PHONE_CALL",
      kind: "BUYER",
      status: "NEW",
      assignedAgentId,
      acceptedAt: new Date(),
    },
  });
  clientIds.push(c.id);
  return c;
}

let agentA: string;
let agentB: string;

beforeAll(async () => {
  agentA = await makeAgent("Агент-А спутники");
  agentB = await makeAgent("Агент-Б спутники");
});

afterAll(async () => {
  await prisma.pendingSummary.deleteMany({ where: { subjectId: { in: clientIds } } });
  await prisma.notification.deleteMany({ where: { agentId: { in: agentIds } } });
  await prisma.clientDeleteRequest.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: agentIds } } });
  await prisma.$disconnect();
});

describe("closeOwnershipSatellites — гасит все спутники разом", () => {
  it("гасит непрочитанное уведомление, перевешивает задачу, снимает заявку на удаление, публикует live", async () => {
    const client = await makeClient(agentA);

    await createNotification({
      agentId: agentA,
      kind: "lead",
      title: "🔔 Новый лид",
      body: client.fullName,
      url: `/clients/${client.shortId}`,
      tag: `lead-${client.id}`,
    });
    const openTask = await prisma.interaction.create({
      data: {
        clientId: client.id,
        agentId: agentA,
        type: "SYSTEM",
        notes: "Перезвонить завтра",
        nextAction: "Перезвонить",
        nextActionDate: new Date(Date.now() + 86_400_000),
      },
    });
    const deleteRequest = await prisma.clientDeleteRequest.create({
      data: { clientId: client.id, requestedById: agentA, reason: "OTHER", comment: "тест", status: "PENDING" },
    });

    publishClientUpdated.mockClear();
    await closeOwnershipSatellites({
      clientId: client.id,
      clientShortId: client.shortId,
      fromAgentId: agentA,
      toAgentId: agentB,
      reason: "тест: передача спутников",
    });

    const unreadLeft = await prisma.notification.count({ where: { agentId: agentA, tag: `lead-${client.id}`, read: false } });
    expect(unreadLeft).toBe(0);

    const task = await prisma.interaction.findUniqueOrThrow({ where: { id: openTask.id } });
    expect(task.agentId).toBe(agentB);

    const request = await prisma.clientDeleteRequest.findUniqueOrThrow({ where: { id: deleteRequest.id } });
    expect(request.status).toBe("REJECTED");

    expect(publishClientUpdated).toHaveBeenCalledWith(
      expect.objectContaining({ clientId: client.id, agentIds: [agentA, agentB] })
    );
  });

  it("задача и показ, заведённые ботом (agentId пуст, subjectAgentId = прежний агент), переезжают к новому (23.09.2026)", async () => {
    // П-10: запись бота/ИИ/системы хранит агента в subjectAgentId, agentId пуст.
    // Раньше перевешивались только задачи с agentId прежнего — показ, который
    // назначил бот, оставался в «Сегодня» у агента, у которого клиента уже нет.
    const client = await makeClient(agentA);
    const botTask = await prisma.interaction.create({
      data: {
        clientId: client.id,
        agentId: null,
        actorKind: "BOT",
        subjectAgentId: agentA,
        type: "MEETING",
        notes: "Бот назначил показ",
        nextAction: "Показ квартиры",
        nextActionDate: new Date(Date.now() + 86_400_000),
      },
    });

    await changeClientAgent({ clientId: client.id, toAgentId: agentB, source: "lifecycle.assign", reason: "тест: показ от бота", actorId: agentB });

    const task = await prisma.interaction.findUniqueOrThrow({ where: { id: botTask.id } });
    expect(task.subjectAgentId).toBe(agentB);
    expect(task.agentId).toBeNull();
    expect(task.actorKind).toBe("BOT");
  });

  it("владелец появился ИЗ НИЧЬЕЙ (fromAgentId: null, оффер реактивации) — заявка на удаление всё равно снимается (18.09.2026)", async () => {
    // Живой сценарий: карточка висит с assignedAgentId=null (предложение
    // реактивации), а директор (clients.viewAll) уже успел завести заявку на
    // удаление, пока владельца формально нет. `agentChanged` в
    // closeOwnershipSatellites требует непустой fromAgentId — без явного
    // условия на это заявка осталась бы висеть PENDING на карточке, которую
    // агент только что принял (см. комментарий в lib/ownershipSatellites.ts).
    const client = await makeClient(null);
    const deleteRequest = await prisma.clientDeleteRequest.create({
      data: { clientId: client.id, requestedById: agentA, reason: "OTHER", comment: "тест: из ничьей", status: "PENDING" },
    });

    await closeOwnershipSatellites({
      clientId: client.id,
      clientShortId: client.shortId,
      fromAgentId: null,
      toAgentId: agentB,
      reason: "тест: оффер принят, владелец появился впервые",
    });

    const request = await prisma.clientDeleteRequest.findUniqueOrThrow({ where: { id: deleteRequest.id } });
    expect(request.status).toBe("REJECTED");
  });

  it("когда получателя нет — задача остаётся, но помечена в notes", async () => {
    const client = await makeClient(agentA);
    const openTask = await prisma.interaction.create({
      data: {
        clientId: client.id,
        agentId: agentA,
        type: "SYSTEM",
        notes: "Уточнить бюджет",
        nextAction: "Уточнить бюджет",
        nextActionDate: new Date(Date.now() + 86_400_000),
      },
    });

    await closeOwnershipSatellites({
      clientId: client.id,
      clientShortId: client.shortId,
      fromAgentId: agentA,
      toAgentId: null,
      reason: "тест: в очередь руководителя",
    });

    const task = await prisma.interaction.findUniqueOrThrow({ where: { id: openTask.id } });
    expect(task.agentId).toBe(agentA);
    expect(task.notes).toContain("клиент передан");
  });
});

describe("changeClientAgent — зовёт closeOwnershipSatellites сама, когда агент меняется", () => {
  it("агент реально меняется → фоновый автопилот зовётся с agent_changed (18.09.2026)", async () => {
    runClientAutopilotInBackground.mockClear();
    const client = await makeClient(agentA);

    await changeClientAgent({
      clientId: client.id,
      toAgentId: agentB,
      reason: "тест: сводка ИИ обязана узнать о смене владельца",
      actorId: agentB,
      source: "test.ownership-satellites",
    });

    expect(runClientAutopilotInBackground).toHaveBeenCalledWith(client.id, "agent_changed");
  });

  it("агент НЕ меняется (тот же toAgentId) → автопилот не зовётся зря", async () => {
    runClientAutopilotInBackground.mockClear();
    const client = await makeClient(agentA);

    await changeClientAgent({
      clientId: client.id,
      toAgentId: agentA,
      reason: "тест: без реальной смены — без лишнего вызова",
      actorId: agentA,
      source: "test.ownership-satellites",
    });

    expect(runClientAutopilotInBackground).not.toHaveBeenCalled();
  });

  it("агент меняется → уведомление прежнего агента гаснет без явного вызова спутников", async () => {
    const client = await makeClient(agentA);
    await createNotification({
      agentId: agentA,
      kind: "lead",
      title: "🔔 Новый лид",
      body: client.fullName,
      url: `/clients/${client.shortId}`,
      tag: `lead-${client.id}`,
    });

    await changeClientAgent({
      clientId: client.id,
      toAgentId: agentB,
      reason: "тест: единый вход сам гасит спутники",
      actorId: agentB,
      source: "test.ownership-satellites",
    });

    const unread = await prisma.notification.count({ where: { agentId: agentA, tag: `lead-${client.id}`, read: false } });
    expect(unread).toBe(0);
  });

  it("skipSatellites:true — спутники не гасятся (явное исключение)", async () => {
    const client = await makeClient(agentA);
    await createNotification({
      agentId: agentA,
      kind: "lead",
      title: "🔔 Новый лид",
      body: client.fullName,
      url: `/clients/${client.shortId}`,
      tag: `lead-${client.id}`,
    });

    await changeClientAgent({
      clientId: client.id,
      toAgentId: agentB,
      reason: "тест: skipSatellites",
      actorId: agentB,
      source: "test.ownership-satellites",
      skipSatellites: true,
    });

    const unread = await prisma.notification.count({ where: { agentId: agentA, tag: `lead-${client.id}`, read: false } });
    expect(unread).toBe(1);
  });
});

describe("markClientLost — агент не меняется, но пуш/уведомления/live всё равно гасятся", () => {
  it("гасит непрочитанное уведомление и публикует live, хотя assignedAgentId остаётся тем же", async () => {
    const client = await makeClient(agentA);
    await createNotification({
      agentId: agentA,
      kind: "lead",
      title: "🔔 Новый лид",
      body: client.fullName,
      url: `/clients/${client.shortId}`,
      tag: `lead-${client.id}`,
    });

    publishClientUpdated.mockClear();
    const result = await markClientLost({
      clientId: client.id,
      reason: "тест: клиент потерян",
      actorId: agentA,
      source: "test.lost",
    });

    expect(result.ok).toBe(true);
    expect(result.client?.assignedAgentId).toBe(agentA);

    const unread = await prisma.notification.count({ where: { agentId: agentA, tag: `lead-${client.id}`, read: false } });
    expect(unread).toBe(0);
    expect(publishClientUpdated).toHaveBeenCalledWith(expect.objectContaining({ clientId: client.id }));
  });
});

describe("mergeClients — гасит спутники дубля (покрывает и duplicateReview, который зовёт mergeClients напрямую)", () => {
  it("заявка дубликата на удаление снята, live опубликовано", async () => {
    const primary = await makeClient(agentA);
    const duplicate = await makeClient(agentB);
    const deleteRequest = await prisma.clientDeleteRequest.create({
      data: { clientId: duplicate.id, requestedById: agentB, reason: "OTHER", comment: "дубль", status: "PENDING" },
    });

    publishClientUpdated.mockClear();
    await mergeClients(primary.id, duplicate.id, agentA, "тест: слияние дублей");

    const request = await prisma.clientDeleteRequest.findUniqueOrThrow({ where: { id: deleteRequest.id } });
    expect(request.status).toBe("APPROVED");
    expect(publishClientUpdated).toHaveBeenCalledWith(expect.objectContaining({ clientId: primary.id }));
  });
});

describe("структурный сторож: перечисленные механизмы идут через единый вход", () => {
  it("declineLead, reassignStaleLeads, freeze/отключение, handover, transfer используют changeClientAgent", () => {
    // unansweredAutoTransfer удалён 16.09.2026 (владелец: «только я могу передавать
    // продавца или покупателя, а не система») — из списка убран вместе с файлом.
    const files = [
      "src/services/leads/assignment.ts", // declineLead
      "src/services/leads/reassignment.ts", // reassignStaleLeads
      "src/lib/agentLeadRelease.ts", // freeze и отключение учётки (routes/agents.ts)
      "src/lib/agentHandover.ts",
      "src/lib/clientTransfer.ts", // transfer/refuse
    ];
    const root = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
    for (const rel of files) {
      const full = path.join(root, rel);
      const src = fs.readFileSync(full, "utf8");
      expect(src, `${rel} должен звать changeClientAgent`).toMatch(/changeClientAgent\s*\(/);
    }
  });

  it("confirmDuplicateReview (lib/duplicateReview.ts) зовёт mergeClients — единое ядро слияния", () => {
    const root = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
    const src = fs.readFileSync(path.join(root, "src/lib/duplicateReview.ts"), "utf8");
    expect(src).toMatch(/mergeClients\s*\(/);
  });
});
