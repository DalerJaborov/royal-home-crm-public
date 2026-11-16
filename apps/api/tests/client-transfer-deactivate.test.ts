import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { waitFor } from "./helpers/waitFor.js";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { createLeadFromChannel } from "../src/leads.js";

/**
 * «Передача» и «Неактивный» (ТЗ владельца 12.08.2026, «Логика Статус + Итог» +
 * голосовое уточнение) — отдельная логика на КАЖДОЕ из двух состояний.
 * «Передача» — ещё и явный роут POST /clients/:id/transfer, где агент решает
 * это действием на карточке.
 *
 * «Неактивного» больше нет вовсе (владелец 16.11.2026: «ничего лишнего») —
 * вместе с ним ушёл и describe про deactivateClient().
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

  /**
   * Предел передач исчерпан (16.11.2026): «Потерянных» больше нет, а карточку в
   * Корзину убирает человек. Клиент остаётся у агента и на виду, руководителю
   * уходит заявка на удаление (lib/clientDeleteRequest.ts).
   */
  it("предел передач исчерпан — карточка у агента, руководителю заявка на удаление", async () => {
    const max = (await prisma.settings.findUnique({ where: { id: "singleton" }, select: { leadMaxTransfers: true } }))?.leadMaxTransfers ?? 3;
    const c = await makeClient();
    await prisma.client.update({ where: { id: c.id }, data: { refusalCount: max - 1 } });
    await makeShowing(c.id);
    const res = await request(app)
      .post(`/api/v1/clients/${c.id}/transfer`)
      .set("Authorization", `Bearer ${token}`)
      .send({ reason: "NO_TRUST", comment: "не сложилось и у этого" });
    expect(res.status).toBe(200);

    const after = await prisma.client.findUniqueOrThrow({ where: { id: c.id } });
    expect(after.deletedAt).toBeNull();
    expect(after.status).not.toBe("LOST");
    expect(after.assignedAgentId).toBe(agentId);
    expect(after.escalatedAt).toBeNull();
    const request_ = await prisma.clientDeleteRequest.findFirst({ where: { clientId: c.id, status: "PENDING" } });
    expect(request_?.requestedById).toBe(agentId);
    expect(request_?.comment).toContain("Предел передач");
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
    // Старая строка INACTIVE (до 16.11.2026 её ставил deactivateClient, сейчас
    // таких переходов нет, но пометка «предложение прежнему агенту» ещё живёт).
    await prisma.client.update({ where: { id: c.id }, data: { workStatus: "INACTIVE", lastAgentId: agentId } });
    const deactivatedClient = await prisma.client.findUnique({ where: { id: c.id } });
    expect(deactivatedClient?.workStatus).toBe("INACTIVE");
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
    await prisma.client.update({ where: { id: c.id }, data: { workStatus: "INACTIVE", lastAgentId: agentId } });
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

