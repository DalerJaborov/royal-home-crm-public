import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { waitFor } from "./helpers/waitFor.js";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { createLeadFromChannel, pickNextAgentByKpiQueue } from "../src/leads.js";
import { deactivateClient } from "../src/lib/clientWorkStatus.js";

/**
 * «Передача» и «Неактивный» (ТЗ владельца 12.08.2026, «Логика Статус + Итог» +
 * голосовое уточнение) — отдельная логика на КАЖДОЕ из двух состояний.
 * «Передача» — ещё и явный роут POST /clients/:id/transfer, где агент решает
 * это действием на карточке.
 *
 * «Неактивный» РУЧНОГО РОУТА БОЛЬШЕ НЕ ИМЕЕТ (владелец 16.09.2026): убран
 * последний живой вход — POST /clients/:id/deactivate и кнопка на карточке
 * (DeactivateClientModal.tsx). Ниже describe про «Неактивный» вызывает
 * deactivateClient()/lib/clientWorkStatus.ts напрямую — тем же способом, каким
 * теперь пользуется только автоматика (ai/callAnalysis.ts,
 * lib/clientInactiveTextDetector.ts): гейт canDeactivateWithReason и сама
 * функция не изменились, ушёл только HTTP-вход для агента.
 *
 * 08.09.2026 оба действия УБРАНЫ из «Итога показа» (kind="meeting"): окно
 * после встречи больше не меняет статус клиента вовсе — агент сообщает только
 * факт встречи, статус выводит система. Нижние describe проверяют уже это.
 */

const runId = Date.now();
const password = "testpass123";

let districtId: string;
let agentId: string;
let secondAgentId: string;
let token: string;
let propertyId: string;
const clientIds: string[] = [];
const interactionIds: string[] = [];
const summaryIds: string[] = [];

async function login(phone: string) {
  const res = await request(app).post("/api/v1/auth/login").send({ phone, password });
  expect(res.status).toBe(200);
  return res.body.accessToken as string;
}

async function makeClient() {
  const c = await prisma.client.create({
    data: {
      fullName: `Клиент передачи ${runId}-${clientIds.length}`,
      phone: `+992970${runId}${clientIds.length}`,
      source: "PHONE_CALL",
      assignedAgentId: agentId,
      acceptedAt: new Date(),
    },
  });
  clientIds.push(c.id);
  return c;
}

async function makeSellerClient() {
  const c = await prisma.client.create({
    data: {
      fullName: `Продавец передачи ${runId}-${clientIds.length}`,
      phone: `+992973${runId}${clientIds.length}`,
      source: "PHONE_CALL",
      kind: "SELLER",
      assignedAgentId: agentId,
      acceptedAt: new Date(),
    },
  });
  clientIds.push(c.id);
  return c;
}

async function makeShowing(clientId: string) {
  const showing = await prisma.interaction.create({
    data: { clientId, agentId, type: "SHOWING", propertyId, notes: `Показ ${runId}`, completedAt: new Date() },
  });
  interactionIds.push(showing.id);
  return showing;
}

async function makeMeetingSummary(clientId: string) {
  const showing = await makeShowing(clientId);
  const summary = await prisma.pendingSummary.create({
    data: { agentId, kind: "meeting", subjectId: showing.id, subjectName: "Клиент", dueAt: new Date() },
  });
  summaryIds.push(summary.id);
  return summary;
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  districtId = (await prisma.district.create({ data: { name: `Тест-район-передача-${runId}` } })).id;
  agentId = (
    await prisma.agent.create({
      data: { fullName: "Агент передачи", phone: `+992971${runId}`, role: "AGENT", passwordHash },
    })
  ).id;
  secondAgentId = (
    await prisma.agent.create({
      data: { fullName: "Второй агент передачи", phone: `+992972${runId}`, role: "AGENT", passwordHash },
    })
  ).id;
  token = await login(`+992971${runId}`);
  propertyId = (
    await prisma.property.create({
      data: {
        title: `Объект передачи ${runId}`,
        type: "APARTMENT",
        areaSqm: 45,
        price: 50000,
        currency: "TJS",
        districtId,
        address: "Тест",
        condition: "GOOD",
        status: "AVAILABLE",
      },
    })
  ).id;
});

afterAll(async () => {
  await prisma.pendingSummary.deleteMany({ where: { agentId: { in: [agentId, secondAgentId] } } });
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.agent.deleteMany({ where: { id: { in: [agentId, secondAgentId] } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.$disconnect();
});

describe("POST /clients/:id/transfer", () => {
  it("без показа — 409, передавать ещё нечего", async () => {
    const c = await makeClient();
    const res = await request(app)
      .post(`/api/v1/clients/${c.id}/transfer`)
      .set("Authorization", `Bearer ${token}`)
      .send({ reason: "NO_TRUST" });
    expect(res.status).toBe(409);
  });

  it("после показа — клиент уходит другому агенту, счётчик передач растёт", async () => {
    const c = await makeClient();
    await makeShowing(c.id);
    const res = await request(app)
      .post(`/api/v1/clients/${c.id}/transfer`)
      .set("Authorization", `Bearer ${token}`)
      .send({ reason: "NO_TRUST", comment: "две недели не выходили на связь" });
    expect(res.status).toBe(200);

    const after = await prisma.client.findUnique({ where: { id: c.id } });
    expect(after?.assignedAgentId).not.toBeNull();
    expect(after?.assignedAgentId).not.toBe(agentId);
    expect(after?.acceptedAt).toBeNull();
    expect(after?.refusalCount).toBe(1);

    const note = await prisma.interaction.findFirst({
      where: { clientId: c.id, type: "SYSTEM", notes: { contains: "Передан другому агенту" } },
    });
    expect(note).not.toBeNull();
  });

  it("«Передача» с respectLimit пропускает получателя, уже на лимите (код-ревью 13.08.2026)", async () => {
    const passwordHash = await bcrypt.hash(password, 10);
    // Изолируем очередь: исключаем ВСЕХ реальных агентов-претендентов (сид +
    // соседние тесты), оставляя только двух своих — иначе тай-брейк по KPI
    // между случайными агентами делает тест недетерминированным.
    const others = await prisma.agent.findMany({ where: { role: "AGENT" }, select: { id: true } });
    const busy = await prisma.agent.create({
      data: { fullName: "Занятый получатель", phone: `+992973${runId}`, role: "AGENT", passwordHash, kpi: 99 },
    });
    const free = await prisma.agent.create({
      data: { fullName: "Свободный получатель", phone: `+992974${runId}`, role: "AGENT", passwordHash, kpi: 1 },
    });
    const filler = await prisma.client.create({
      data: {
        fullName: `Заполнитель получателя ${runId}`,
        phone: `+992975${runId}`,
        source: "PHONE_CALL",
        assignedAgentId: busy.id,
        acceptedAt: new Date(),
        workStatus: "ACTIVE",
      },
    });
    const savedLimit = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { leadActiveLimit: true } });
    await prisma.settings.update({ where: { id: "singleton" }, data: { leadActiveLimit: 1 } });
    try {
      // busy.kpi=99 выигрывал бы тай-брейк по очереди у всех — без учёта лимита
      // передача ушла бы именно ему, хотя портфель уже полон.
      const excludeOthers = others.map((a) => a.id);
      const picked = await pickNextAgentByKpiQueue(excludeOthers, true);
      expect(picked).toBe(free.id);
    } finally {
      await prisma.settings.update({ where: { id: "singleton" }, data: { leadActiveLimit: savedLimit?.leadActiveLimit ?? 6 } });
      await prisma.client.deleteMany({ where: { id: filler.id } });
      await prisma.agent.deleteMany({ where: { id: { in: [busy.id, free.id] } } });
    }
  });

  it("причина, отличная от NO_TRUST, границей API отклоняется (задача F, сужение)", async () => {
    const c = await makeClient();
    await makeShowing(c.id);
    const res = await request(app)
      .post(`/api/v1/clients/${c.id}/transfer`)
      .set("Authorization", `Bearer ${token}`)
      .send({ reason: "OTHER", comment: "что угодно" });
    expect(res.status).toBe(400);
  });

});

describe("deactivateClient() — единственный путь в Неактивные (HTTP-вход убран 16.09.2026)", () => {
  it("переводит клиента в workStatus=INACTIVE, не трогая Состояние", async () => {
    const c = await makeClient();
    expect(c.workStatus).toBe("ACTIVE");
    const statusBefore = c.status;
    // След работы нужен для любой причины (владелец 03.09).
    await prisma.interaction.createMany({ data: [1, 2].map((n) => ({ clientId: c.id, agentId, type: "CALL" as const, callAttempt: "NO_ANSWER" as const, notes: `попытка ${n}` })) });

    const result = await deactivateClient({
      clientId: c.id,
      actor: { kind: "agent", agentId },
      reason: "POSTPONED",
      initiator: "CLIENT",
      actualNeeds: "2-комн в Сино, до $80 000",
    });
    expect(result.ok).toBe(true);

    const after = await prisma.client.findUnique({ where: { id: c.id } });
    expect(after?.workStatus).toBe("INACTIVE");
    // Состояние (ClientStatus) — только автоматика; действие «Неактивный» его не трогает.
    expect(after?.status).toBe(statusBefore);
    expect(after?.assignedAgentId).toBe(agentId);

    const note = await prisma.interaction.findFirst({
      where: { clientId: c.id, type: "SYSTEM", notes: { contains: "переведён в Неактивные" } },
    });
    expect(note).not.toBeNull();
    expect(note?.notes).toContain("2-комн в Сино");
  });

  it("без следа работы — гейт отказывает, а не тихо переводит", async () => {
    const c = await makeClient();
    const result = await deactivateClient({
      clientId: c.id,
      actor: { kind: "agent", agentId },
      reason: "THINKING",
      initiator: "AGENT",
      actualNeeds: "",
    });
    expect(result.ok).toBe(false);

    const after = await prisma.client.findUnique({ where: { id: c.id } });
    expect(after?.workStatus).toBe("ACTIVE");
  });

  /**
   * Решение владельца 11.09.2026 («Ждёт владельца», «продавцов нельзя
   * деактивировать руками»): гейт и деактивация были ограничены
   * `kind === "BUYER"` только на HTTP-уровне, хотя deactivateClient/гейт сама
   * kind-агностична. Выровнено: продавец деактивируется тем же путём, что и
   * покупатель — здесь этим путём пользуется только автоматика.
   */
  it("продавца автоматика тоже может перевести в Неактивные (выравнивание 11.09.2026)", async () => {
    const c = await makeSellerClient();
    expect(c.kind).toBe("SELLER");
    expect(c.workStatus).toBe("ACTIVE");
    await prisma.interaction.createMany({
      data: [1, 2].map((n) => ({
        clientId: c.id,
        agentId,
        type: "CALL" as const,
        callAttempt: "NO_ANSWER" as const,
        notes: `попытка ${n}`,
      })),
    });

    const result = await deactivateClient({
      clientId: c.id,
      actor: { kind: "agent", agentId },
      reason: "POSTPONED",
      initiator: "CLIENT",
      actualNeeds: "продаёт позже, ждёт цену",
    });
    expect(result.ok).toBe(true);

    const after = await prisma.client.findUnique({ where: { id: c.id } });
    expect(after?.workStatus).toBe("INACTIVE");
    expect(after?.assignedAgentId).toBe(agentId);
  });
});

/**
 * ТЗ п. 3 + голосовое владельца: «другие статусы даёт сама CRM, эти статусы агент не
 * имеет права трогать». Проверка именно серверная: кнопку из карточки убрали, но CRM
 * стоит как PWA — старый интерфейс из кэша служебного воркера продолжал бы слать
 * status, и запрет, живущий только в вёрстке, ничего бы не значил.
 */
describe("Состояние покупателя агент не меняет", () => {
  it("PATCH со status от агента — 403, Состояние не изменилось", async () => {
    const c = await makeClient();
    expect(c.status).toBe("NEW");

    const res = await request(app)
      .patch(`/api/v1/clients/${c.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "HOT" });
    expect(res.status).toBe(403);

    const after = await prisma.client.findUnique({ where: { id: c.id } });
    expect(after?.status).toBe("NEW");
  });

  it("остальные поля карточки агент правит как раньше", async () => {
    const c = await makeClient();
    const res = await request(app)
      .patch(`/api/v1/clients/${c.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ desiredRooms: 3 });
    expect(res.status).toBe(200);

    const after = await prisma.client.findUnique({ where: { id: c.id } });
    expect(after?.desiredRooms).toBe(3);
  });
});

/**
 * ТЗ п. 26-27: «Неактивный» — не дверь в один конец. Клиент, который сам написал,
 * возвращается в работу, иначе слот освобождён навсегда, а карточка вечно висит на
 * агенте вне лимита — даже когда клиент пришёл с деньгами.
 *
 * Полный флоу из ТЗ (предложить прежнему агенту как 7-го, приоритеты
 * зелёный/жёлтый/красный) владелец когда-то пометил «пока продумываем, без
 * запуска» — доделан 31.08.2026 (разбор жалобы, п.12): вместо мгновенного
 * возврата в ACTIVE карточка теперь ПРЕДЛАГАЕТСЯ прежнему агенту с правом
 * принять/отклонить (см. также reactivation-offers.test.ts).
 */
describe("Возвращение неактивного клиента", () => {
  it("клиент написал в канал — предложение прежнему агенту, не мгновенный ACTIVE", async () => {
    const c = await makeClient();
    // Светофор неактивных (21.08.2026): STOPPED_RESPONDING без «следа работы» —
    // 409, деактивация не пройдёт. Заводим два состоявшихся звонка заранее.
    await prisma.interaction.createMany({
      data: [
        { clientId: c.id, agentId, type: "CALL", recordingDurationSec: 45, notes: "Звонок 1" },
        { clientId: c.id, agentId, type: "CALL", recordingDurationSec: 40, notes: "Звонок 2" },
      ],
    });
    const deactivated = await deactivateClient({
      clientId: c.id,
      actor: { kind: "agent", agentId },
      reason: "STOPPED_RESPONDING",
      initiator: "CLIENT",
      actualNeeds: "2-комн в Сино",
    });
    expect(deactivated.ok).toBe(true);
    const deactivatedClient = await prisma.client.findUnique({ where: { id: c.id } });
    expect(deactivatedClient?.workStatus).toBe("INACTIVE");
    // deactivateClient пишет lastAgentId рядом с workStatus=INACTIVE — карточка
    // «помнит», кому предлагать реактивацию (см. lib/clientWorkStatus.ts).
    expect(deactivatedClient?.lastAgentId).toBe(agentId);

    // Тот же телефон приходит из канала — createLeadFromChannel узнаёт карточку.
    const result = await createLeadFromChannel({
      fullName: c.fullName,
      phone: c.phone,
      source: "WHATSAPP",
      requirementsNotes: "снова ищу квартиру",
    });
    expect(result.created).toBe(false);
    expect(result.clientId).toBe(c.id);

    const after = await prisma.client.findUnique({ where: { id: c.id } });
    // workStatus остаётся INACTIVE — карточка НЕ активна и НЕ «просто» назначена
    // назад, пока агент не принял решение (accept/decline).
    expect(after?.workStatus).toBe("INACTIVE");
    expect(after?.reactivationOfferedToAgentId).toBe(agentId);
    expect(after?.reactivationOfferedAt).not.toBeNull();
    // Агент прежний (assignedAgentId не трогаем — карточка и так его).
    expect(after?.assignedAgentId).toBe(agentId);
  });

  it("активный клиент повторным обращением не ломается", async () => {
    const c = await makeClient();
    await createLeadFromChannel({
      fullName: c.fullName,
      phone: c.phone,
      source: "WHATSAPP",
      requirementsNotes: "ещё вопрос",
    });
    const after = await prisma.client.findUnique({ where: { id: c.id } });
    expect(after?.workStatus).toBe("ACTIVE");
    expect(after?.assignedAgentId).toBe(agentId);
  });

  /**
   * П-1/П-10 (17.09.2026, Х2 из `docs/audit/recon-17-09/02-auto-transfer-mechanisms.md`):
   * прежнего агента предложить не вышло (уволен/неактивен) — карточка уходит
   * по очереди (reactivationFallbackAgentId). Смена владельца обязана быть
   * видна в AuditLog.
   */
  it("прежний агент неактивен — очередь, смена владельца пишет AuditLog CLIENT_AGENT_CHANGE", async () => {
    const c = await makeClient();
    await prisma.interaction.createMany({
      data: [
        { clientId: c.id, agentId, type: "CALL", recordingDurationSec: 45, notes: "Звонок 1" },
        { clientId: c.id, agentId, type: "CALL", recordingDurationSec: 40, notes: "Звонок 2" },
      ],
    });
    await deactivateClient({
      clientId: c.id,
      actor: { kind: "agent", agentId },
      reason: "STOPPED_RESPONDING",
      initiator: "CLIENT",
      actualNeeds: "2-комн в Сино",
    });
    // Прежний агент больше не работает — decideReturningClient должен уйти в "queue".
    await prisma.agent.update({ where: { id: agentId }, data: { isActive: false } });
    try {
      await createLeadFromChannel({
        fullName: c.fullName,
        phone: c.phone,
        source: "WHATSAPP",
        requirementsNotes: "снова ищу квартиру",
      });

      const after = await prisma.client.findUnique({ where: { id: c.id } });
      expect(after?.workStatus).toBe("ACTIVE");
      // НЕ «именно второй агент этого файла» (22.09.2026). Очередь выбирает из
      // ВСЕХ активных агентов базы, а база у прогона одна на все файлы: агент,
      // заведённый соседним файлом (поймано на «Обычный агент TikTok-теста» из
      // property-tiktok-publish.test.ts), совершенно законно оказывается
      // менее загруженным и забирает карточку. Проверка падала тогда не на
      // своей причине, а на чужом агенте — и только при определённом порядке
      // файлов, то есть мигала. Смысл пункта П-1/П-10 в другом: прежнего
      // агента предложить не вышло, карточка ушла ПО ОЧЕРЕДИ кому-то
      // работающему, а не зависла и не осталась за уволенным.
      expect(after?.assignedAgentId).not.toBeNull();
      expect(after?.assignedAgentId).not.toBe(agentId);
      const newOwner = await prisma.agent.findUniqueOrThrow({
        where: { id: after!.assignedAgentId! },
        select: { isActive: true },
      });
      expect(newOwner.isActive).toBe(true);
      expect(after?.reactivationOfferedToAgentId).toBeNull();

      const auditRow = await waitFor(() =>
        prisma.auditLog.findFirst({
          where: { entityType: "Client", entityId: c.id, action: "CLIENT_AGENT_CHANGE" },
        })
      );
      expect(auditRow).not.toBeNull();
      expect((auditRow?.meta as Record<string, unknown> | null)?.source).toBe("intake.reactivation-fallback");
      expect((auditRow?.meta as Record<string, unknown> | null)?.to).toBe(after?.assignedAgentId);
    } finally {
      await prisma.agent.update({ where: { id: agentId }, data: { isActive: true } });
    }
  });
});

