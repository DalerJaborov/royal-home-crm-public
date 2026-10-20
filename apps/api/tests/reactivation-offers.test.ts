import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { waitFor } from "./helpers/waitFor.js";
import bcrypt from "bcrypt";
import request from "supertest";

/**
 * РЕАКТИВАЦИЯ К ПРЕЖНЕМУ АГЕНТУ (разбор 31.08.2026, п.12).
 *
 * Два входа проверяются здесь:
 * 1. services/leads/intake.ts (createLeadFromChannel) — оба пути повторного
 *    обращения (Корзина / Неактивные) теперь ставят предложение вместо
 *    мгновенного назначения (см. также client-transfer-deactivate.test.ts для
 *    ветки «Неактивные» подробнее).
 * 2. routes/clients/reactivationOffers.ts — accept/decline самим предложением.
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

const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");
const { createLeadFromChannel } = await import("../src/leads.js");
const { expireStaleReactivationOffers, releaseReactivationOffersOfAgent } = await import(
  "../src/lib/reactivationOffers.js"
);
const { changeClientAgent } = await import("../src/lib/changeClientAgent.js");

const runId = Date.now();
const password = "testpass123";
let agentId: string;
let agentToken: string;
let otherAgentId: string;
let otherToken: string;
const clientIds: string[] = [];

async function login(phone: string) {
  const res = await request(app).post("/api/v1/auth/login").send({ phone, password });
  expect(res.status).toBe(200);
  return res.body.accessToken as string;
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  agentId = (
    await prisma.agent.create({
      data: { fullName: "Прежний агент реактивации", phone: `+992${runId}60`, role: "AGENT", passwordHash },
    })
  ).id;
  otherAgentId = (
    await prisma.agent.create({
      data: { fullName: "Другой агент реактивации", phone: `+992${runId}61`, role: "AGENT", passwordHash },
    })
  ).id;
  agentToken = await login(`+992${runId}60`);
  otherToken = await login(`+992${runId}61`);
});

afterAll(async () => {
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: [agentId, otherAgentId] } } });
  await prisma.$disconnect();
});

describe("intake.ts — Корзина: предложение прежнему агенту", () => {
  it("lastAgentId активен — предложение, а не свежий агент по очереди", async () => {
    const phone = `+992${runId}62`;
    const first = await createLeadFromChannel({ fullName: "Клиент из Корзины", phone, source: "INSTAGRAM", kind: "BUYER" });
    clientIds.push(first.clientId);
    await prisma.client.update({
      where: { id: first.clientId },
      data: { deletedAt: new Date(), deletedById: agentId, lastAgentId: agentId, assignedAgentId: agentId },
    });

    const result = await createLeadFromChannel({
      fullName: "Клиент из Корзины",
      phone,
      source: "WHATSAPP",
      kind: "BUYER",
    });
    expect(result.created).toBe(false);

    const after = await prisma.client.findUnique({ where: { id: first.clientId } });
    expect(after?.deletedAt).toBeNull();
    expect(after?.workStatus).toBe("INACTIVE");
    expect(after?.reactivationOfferedToAgentId).toBe(agentId);
    expect(after?.reactivationOfferedAt).not.toBeNull();
    // Пока предложение не решено — формально ни за кем не закреплена.
    expect(after?.assignedAgentId).toBeNull();
  });

  it("lastAgentId нет — обычная раздача по очереди, как раньше", async () => {
    const phone = `+992${runId}63`;
    const first = await createLeadFromChannel({ fullName: "Клиент без lastAgentId", phone, source: "INSTAGRAM", kind: "BUYER" });
    clientIds.push(first.clientId);
    await prisma.client.update({
      where: { id: first.clientId },
      data: { deletedAt: new Date(), deletedById: agentId },
    });

    const result = await createLeadFromChannel({
      fullName: "Клиент без lastAgentId",
      phone,
      source: "WHATSAPP",
      kind: "BUYER",
    });
    expect(result.created).toBe(false);

    const after = await prisma.client.findUnique({ where: { id: first.clientId } });
    expect(after?.deletedAt).toBeNull();
    expect(after?.reactivationOfferedToAgentId).toBeNull();
    expect(after?.assignedAgentId).not.toBeNull();

    const note = await prisma.interaction.findFirst({
      where: { clientId: first.clientId, type: "SYSTEM", notes: { contains: "восстановлена автоматически" } },
    });
    expect(note).not.toBeNull();
  });

  /**
   * П-1/П-10 (17.09.2026, Х1 из `docs/audit/recon-17-09/02-auto-transfer-mechanisms.md`):
   * возврат из Корзины с реальной сменой владельца обязан быть виден в AuditLog,
   * а не только в Interaction.
   */
  it("возврат из Корзины со сменой владельца пишет AuditLog CLIENT_AGENT_CHANGE", async () => {
    const phone = `+992${runId}70`;
    const first = await createLeadFromChannel({ fullName: "Клиент для аудита Х1", phone, source: "INSTAGRAM", kind: "BUYER" });
    clientIds.push(first.clientId);
    // Явно другой прежний владелец, без lastAgentId — гарантированно ветка "очередь",
    // а не "keep"/"offer".
    await prisma.client.update({
      where: { id: first.clientId },
      data: { deletedAt: new Date(), deletedById: agentId, assignedAgentId: otherAgentId, lastAgentId: null },
    });

    await createLeadFromChannel({ fullName: "Клиент для аудита Х1", phone, source: "WHATSAPP", kind: "BUYER" });

    const after = await prisma.client.findUnique({ where: { id: first.clientId } });
    if (after?.assignedAgentId !== otherAgentId) {
      /**
       * ДВОЙНАЯ ПРИЧИНА ФЛЕЙКА (найдено при слиянии 17.09.2026, 2 из 3 запусков
       * подряд даже в одиночном прогоне):
       *  1) у `first` УЖЕ есть своя запись CLIENT_AGENT_CHANGE с source
       *     "intake.createNewChannelLead" от МОМЕНТА ЕГО СОЗДАНИЯ
       *     (assignAgentForLead назначил агента ещё до Корзины) — без
       *     сортировки findFirst без указанного порядка мог вернуть ЛЮБУЮ из
       *     двух строк по этому entityId, а не именно последнюю;
       *  2) запись "intake.basket-return" пишется `logSystemAudit` НАПРЯМУЮ,
       *     БЕЗ await (best-effort по всему проекту, см. lib/audit.ts) — в
       *     отличие от `changeClientAgent`, который пишет AuditLog внутри своей
       *     же транзакции. `createLeadFromChannel` может вернуться раньше, чем
       *     эта фоновая запись физически попадёт в базу — короткий опрос вместо
       *     одного немедленного чтения.
       */
      const auditRow = await waitFor(() =>
        prisma.auditLog.findFirst({
          where: { entityType: "Client", entityId: first.clientId, action: "CLIENT_AGENT_CHANGE", meta: { path: ["source"], equals: "intake.basket-return" } },
          orderBy: { createdAt: "desc" },
        })
      );
      expect(auditRow).not.toBeNull();
      expect((auditRow?.meta as Record<string, unknown> | null)?.source).toBe("intake.basket-return");
      expect((auditRow?.meta as Record<string, unknown> | null)?.from).toBe(otherAgentId);
    }
  });
});

describe("POST /clients/:id/reactivation-offer/accept", () => {
  async function makeOfferedClient() {
    const c = await prisma.client.create({
      data: {
        fullName: `Предложенный клиент ${runId}-${clientIds.length}`,
        phone: `+992${runId}64${clientIds.length}`,
        source: "PHONE_CALL",
        kind: "BUYER",
        workStatus: "INACTIVE",
        assignedAgentId: agentId,
        lastAgentId: agentId,
        reactivationOfferedToAgentId: agentId,
        reactivationOfferedAt: new Date(),
      },
    });
    clientIds.push(c.id);
    return c;
  }

  it("свой агент — принимает, карточка ACTIVE и снова его", async () => {
    const c = await makeOfferedClient();
    const res = await request(app)
      .post(`/api/v1/clients/${c.id}/reactivation-offer/accept`)
      .set("Authorization", `Bearer ${agentToken}`)
      .send({});
    expect(res.status).toBe(200);

    const after = await prisma.client.findUnique({ where: { id: c.id } });
    expect(after?.workStatus).toBe("ACTIVE");
    expect(after?.assignedAgentId).toBe(agentId);
    expect(after?.reactivationOfferedToAgentId).toBeNull();
    expect(after?.reactivationOfferedAt).toBeNull();
    expect(after?.acceptedAt).not.toBeNull();
  });

  it("чужой агент — 403, решает только адресат", async () => {
    const c = await makeOfferedClient();
    const res = await request(app)
      .post(`/api/v1/clients/${c.id}/reactivation-offer/accept`)
      .set("Authorization", `Bearer ${otherToken}`)
      .send({});
    expect(res.status).toBe(403);

    const after = await prisma.client.findUnique({ where: { id: c.id } });
    expect(after?.workStatus).toBe("INACTIVE");
    expect(after?.reactivationOfferedToAgentId).toBe(agentId);
  });

  it("нет предложения по карточке — 409", async () => {
    const c = await prisma.client.create({
      data: {
        fullName: `Без предложения ${runId}`,
        phone: `+992${runId}65`,
        source: "PHONE_CALL",
        kind: "BUYER",
        assignedAgentId: agentId,
      },
    });
    clientIds.push(c.id);
    const res = await request(app)
      .post(`/api/v1/clients/${c.id}/reactivation-offer/accept`)
      .set("Authorization", `Bearer ${agentToken}`)
      .send({});
    expect(res.status).toBe(409);
  });

  it("GET /clients/reactivation-offers — видит только свои", async () => {
    const c = await makeOfferedClient();
    const res = await request(app)
      .get("/api/v1/clients/reactivation-offers")
      .set("Authorization", `Bearer ${agentToken}`);
    expect(res.status).toBe(200);
    expect(res.body.items.some((i: { id: string }) => i.id === c.id)).toBe(true);

    const resOther = await request(app)
      .get("/api/v1/clients/reactivation-offers")
      .set("Authorization", `Bearer ${otherToken}`);
    expect(resOther.status).toBe(200);
    expect(resOther.body.items.some((i: { id: string }) => i.id === c.id)).toBe(false);
  });

  it("GET /clients/reactivation-offers — телефон в пожеланиях клиента закрыт, как и в поле phone (находка №158)", async () => {
    const c = await makeOfferedClient();
    await prisma.client.update({
      where: { id: c.id },
      data: { requirementsNotes: "Хочет трёшку, звоните +992901234567 после шести" },
    });
    const res = await request(app)
      .get("/api/v1/clients/reactivation-offers")
      .set("Authorization", `Bearer ${agentToken}`);
    expect(res.status).toBe(200);
    const item = res.body.items.find((i: { id: string }) => i.id === c.id);
    expect(item).toBeDefined();
    expect(item.requirementsNotes).not.toContain("901234567");
    expect(item.requirementsNotes).toContain("трёшку");
  });
});

describe("POST /clients/:id/reactivation-offer/decline", () => {
  it("свой агент — отклоняет, карточка уходит по очереди другому агенту", async () => {
    const c = await prisma.client.create({
      data: {
        fullName: `Отклонённый клиент ${runId}`,
        phone: `+992${runId}66`,
        source: "PHONE_CALL",
        kind: "BUYER",
        workStatus: "INACTIVE",
        assignedAgentId: agentId,
        lastAgentId: agentId,
        reactivationOfferedToAgentId: agentId,
        reactivationOfferedAt: new Date(),
      },
    });
    clientIds.push(c.id);

    const res = await request(app)
      .post(`/api/v1/clients/${c.id}/reactivation-offer/decline`)
      .set("Authorization", `Bearer ${agentToken}`)
      .send({});
    expect(res.status).toBe(200);

    const after = await prisma.client.findUnique({ where: { id: c.id } });
    expect(after?.reactivationOfferedToAgentId).toBeNull();
    expect(after?.reactivationOfferedAt).toBeNull();
    expect(after?.workStatus).toBe("ACTIVE");
    // Прежнего агента pickAgentForLead исключает явно — самому себе отказ не вернётся.
    expect(after?.assignedAgentId).not.toBe(agentId);

    const note = await prisma.interaction.findFirst({
      where: { clientId: c.id, type: "SYSTEM", notes: { contains: "отклонил предложение реактивации" } },
    });
    expect(note).not.toBeNull();
  });
});

/**
 * Разведка 07.09.2026 (класс «осиротевшие спутники»): предложение реактивации
 * закреплялось за агентом навсегда — ни TTL, ни снятия при недоступности агента.
 */
describe("Снятие предложения реактивации, не решённого агентом", () => {
  async function makeOfferedClient(reactivationOfferedAt: Date, toAgentId = agentId) {
    const c = await prisma.client.create({
      data: {
        fullName: `Просроченное предложение ${runId}-${clientIds.length}`,
        phone: `+992${runId}67${clientIds.length}`,
        source: "PHONE_CALL",
        kind: "BUYER",
        workStatus: "INACTIVE",
        lastAgentId: toAgentId,
        reactivationOfferedToAgentId: toAgentId,
        reactivationOfferedAt,
      },
    });
    clientIds.push(c.id);
    return c;
  }

  it("expireStaleReactivationOffers снимает предложение старше TTL, свежее не трогает", async () => {
    const settings = await prisma.settings.upsert({
      where: { id: "singleton" },
      update: { reactivationOfferTtlHours: 24 },
      create: { id: "singleton", reactivationOfferTtlHours: 24 },
    });

    const stale = await makeOfferedClient(new Date(Date.now() - 25 * 3600_000));
    const fresh = await makeOfferedClient(new Date(Date.now() - 1 * 3600_000));

    const released = await expireStaleReactivationOffers();
    expect(released).toBeGreaterThanOrEqual(1);

    const staleAfter = await prisma.client.findUniqueOrThrow({ where: { id: stale.id } });
    expect(staleAfter.reactivationOfferedToAgentId).toBeNull();
    expect(staleAfter.reactivationOfferedAt).toBeNull();
    expect(staleAfter.workStatus).toBe("ACTIVE");
    expect(staleAfter.assignedAgentId).not.toBe(agentId);

    const freshAfter = await prisma.client.findUniqueOrThrow({ where: { id: fresh.id } });
    expect(freshAfter.reactivationOfferedToAgentId).toBe(agentId);

    await prisma.settings.update({ where: { id: "singleton" }, data: { reactivationOfferTtlHours: settings.reactivationOfferTtlHours } });
  });

  it("releaseReactivationOffersOfAgent снимает предложения сразу, не дожидаясь TTL", async () => {
    const c = await makeOfferedClient(new Date());

    const released = await releaseReactivationOffersOfAgent(agentId);
    expect(released).toBeGreaterThanOrEqual(1);

    const after = await prisma.client.findUniqueOrThrow({ where: { id: c.id } });
    expect(after.reactivationOfferedToAgentId).toBeNull();
    expect(after.assignedAgentId).not.toBe(agentId);
  });
});

/**
 * П-3 (17.09.2026, `docs/audit/lead-ownership-17-09.md` §2, §4): после контакта
 * клиент не уходит другому агенту автоматически по TTL/отклонению — остаётся у
 * прежнего держателя, эскалация вместо очереди. Без контакта — как раньше
 * (проверено выше).
 */
describe("П-3: контакт уже был — TTL/отклонение не передаёт другому агенту", () => {
  async function makeOfferedClientWithContact(reactivationOfferedAt: Date) {
    const c = await prisma.client.create({
      data: {
        fullName: `С контактом ${runId}-${clientIds.length}`,
        phone: `+992${runId}68${clientIds.length}`,
        source: "PHONE_CALL",
        kind: "BUYER",
        workStatus: "INACTIVE",
        lastAgentId: agentId,
        reactivationOfferedToAgentId: agentId,
        reactivationOfferedAt,
        // Контакт агента был раньше (звонок), хотя карточка сейчас без assignedAgentId.
        firstContactAt: new Date(Date.now() - 10 * 24 * 3600_000),
        lastAgentAttemptAt: new Date(Date.now() - 5 * 24 * 3600_000),
      },
    });
    clientIds.push(c.id);
    return c;
  }

  it("TTL истёк, контакт был — остаётся у прежнего агента, не у очереди", async () => {
    const c = await makeOfferedClientWithContact(new Date(Date.now() - 25 * 3600_000));

    const released = await expireStaleReactivationOffers();
    expect(released).toBeGreaterThanOrEqual(1);

    const after = await prisma.client.findUniqueOrThrow({ where: { id: c.id } });
    expect(after.assignedAgentId).toBe(agentId);
    expect(after.workStatus).toBe("ACTIVE");
    expect(after.reactivationOfferedToAgentId).toBeNull();

    const escalation = await prisma.interaction.findFirst({
      where: { clientId: c.id, type: "SYSTEM", notes: { contains: "П-3" } },
    });
    expect(escalation).not.toBeNull();
  });

  it("агент отклонил, контакт был — карточка не уходит другому по очереди", async () => {
    const c = await prisma.client.create({
      data: {
        fullName: `Отклонён с контактом ${runId}`,
        phone: `+992939${String(runId).slice(-6)}`,
        source: "PHONE_CALL",
        kind: "BUYER",
        workStatus: "INACTIVE",
        assignedAgentId: agentId,
        lastAgentId: agentId,
        reactivationOfferedToAgentId: agentId,
        reactivationOfferedAt: new Date(),
        firstContactAt: new Date(Date.now() - 10 * 24 * 3600_000),
      },
    });
    clientIds.push(c.id);

    const res = await request(app)
      .post(`/api/v1/clients/${c.id}/reactivation-offer/decline`)
      .set("Authorization", `Bearer ${agentToken}`)
      .send({});
    expect(res.status).toBe(200);

    const after = await prisma.client.findUniqueOrThrow({ where: { id: c.id } });
    expect(after.assignedAgentId).toBe(agentId);
  });

  it("заморозка/увольнение — контакт был, но карточка всё равно уходит по очереди (держателя больше нет)", async () => {
    const c = await makeOfferedClientWithContact(new Date());
    const released = await releaseReactivationOffersOfAgent(agentId, otherAgentId);
    expect(released).toBeGreaterThanOrEqual(1);

    const after = await prisma.client.findUniqueOrThrow({ where: { id: c.id } });
    expect(after.reactivationOfferedToAgentId).toBeNull();
    // Заморозка/увольнение — не автопередача, П-3 её не блокирует.
    expect(after.assignedAgentId).not.toBe(agentId);

    const auditRow = await waitFor(() =>
      prisma.auditLog.findFirst({
        where: { entityType: "Client", entityId: c.id, action: "CLIENT_AGENT_CHANGE" },
        orderBy: { createdAt: "desc" },
      })
    );
    expect(auditRow?.agentId).toBe(otherAgentId);
  });
});

/**
 * ПРОДАВЕЦ НЕ УХОДИТ НИКОГДА (24.09.2026, ночная проверка «Владение, К-идея»,
 * решение владельца 16.09.2026 — «Продавец никогда не уходит… Только я могу
 * передавать продавца или покупателя в таких случаях. А не система»,
 * docs/resheniya-vladelca-16-18-09-2026.md §1). Для продавца это правило
 * безусловное — в отличие от П-3 у покупателя (там нужен предыдущий контакт,
 * см. блок выше), продавец не уходит по очереди даже без него. Заморозка/
 * увольнение — легальный случай передачи (держателя больше нет физически),
 * его это правило не блокирует, тест ниже это тоже проверяет.
 */
describe("Продавец не уходит: непринятая реактивация не передаёт его другому агенту", () => {
  it("TTL истёк, контакта не было — продавец остаётся у прежнего агента, не у очереди", async () => {
    const c = await prisma.client.create({
      data: {
        fullName: `Продавец без контакта ${runId}`,
        phone: `+992${runId}71`,
        source: "PHONE_CALL",
        kind: "SELLER",
        workStatus: "INACTIVE",
        lastAgentId: agentId,
        reactivationOfferedToAgentId: agentId,
        reactivationOfferedAt: new Date(Date.now() - 25 * 3600_000),
      },
    });
    clientIds.push(c.id);

    const settings = await prisma.settings.upsert({
      where: { id: "singleton" },
      update: { reactivationOfferTtlHours: 24 },
      create: { id: "singleton", reactivationOfferTtlHours: 24 },
    });

    const released = await expireStaleReactivationOffers();
    expect(released).toBeGreaterThanOrEqual(1);

    const after = await prisma.client.findUniqueOrThrow({ where: { id: c.id } });
    expect(after.assignedAgentId).toBe(agentId);
    expect(after.workStatus).toBe("ACTIVE");
    expect(after.reactivationOfferedToAgentId).toBeNull();

    const note = await prisma.interaction.findFirst({
      where: { clientId: c.id, type: "SYSTEM", notes: { contains: "продавец не уходит" } },
    });
    expect(note).not.toBeNull();

    await prisma.settings.update({
      where: { id: "singleton" },
      data: { reactivationOfferTtlHours: settings.reactivationOfferTtlHours },
    });
  });

  it("агент отклонил, контакта не было — продавец не уходит другому по очереди", async () => {
    const c = await prisma.client.create({
      data: {
        fullName: `Продавец отклонён ${runId}`,
        phone: `+992${runId}72`,
        source: "PHONE_CALL",
        kind: "SELLER",
        workStatus: "INACTIVE",
        assignedAgentId: agentId,
        lastAgentId: agentId,
        reactivationOfferedToAgentId: agentId,
        reactivationOfferedAt: new Date(),
      },
    });
    clientIds.push(c.id);

    const res = await request(app)
      .post(`/api/v1/clients/${c.id}/reactivation-offer/decline`)
      .set("Authorization", `Bearer ${agentToken}`)
      .send({});
    expect(res.status).toBe(200);

    const after = await prisma.client.findUniqueOrThrow({ where: { id: c.id } });
    expect(after.assignedAgentId).toBe(agentId);
  });

  it("заморозка/увольнение продавца — карточка всё равно уходит по очереди (держателя больше нет)", async () => {
    const c = await prisma.client.create({
      data: {
        fullName: `Продавец уволенного агента ${runId}`,
        phone: `+992${runId}74`,
        source: "PHONE_CALL",
        kind: "SELLER",
        workStatus: "INACTIVE",
        lastAgentId: agentId,
        reactivationOfferedToAgentId: agentId,
        reactivationOfferedAt: new Date(),
      },
    });
    clientIds.push(c.id);

    const released = await releaseReactivationOffersOfAgent(agentId, otherAgentId);
    expect(released).toBeGreaterThanOrEqual(1);

    const after = await prisma.client.findUniqueOrThrow({ where: { id: c.id } });
    expect(after.reactivationOfferedToAgentId).toBeNull();
    expect(after.assignedAgentId).not.toBe(agentId);
  });
});

describe("Клиента назначили другому — старое предложение не отбирает его (23.09.2026)", () => {
  it("руководитель отдал клиента другому агенту: предложение снято, «Принять» прежнего — отказ", async () => {
    const c = await prisma.client.create({
      data: {
        fullName: `Предложение и назначение ${runId}`,
        phone: `+992937${String(runId).slice(-6)}`,
        source: "PHONE_CALL",
        kind: "BUYER",
        workStatus: "INACTIVE",
        lastAgentId: agentId,
        reactivationOfferedToAgentId: agentId,
        reactivationOfferedAt: new Date(),
      },
    });
    clientIds.push(c.id);

    const assigned = await changeClientAgent({
      clientId: c.id,
      toAgentId: otherAgentId,
      reason: "Руководитель назначил вручную",
      actorId: otherAgentId,
      source: "lifecycle.assign",
    });
    expect(assigned.ok).toBe(true);

    const mid = await prisma.client.findUniqueOrThrow({ where: { id: c.id } });
    expect(mid.reactivationOfferedToAgentId).toBeNull();
    expect(mid.reactivationOfferedAt).toBeNull();

    const res = await request(app)
      .post(`/api/v1/clients/${c.id}/reactivation-offer/accept`)
      .set("Authorization", `Bearer ${agentToken}`)
      .send({});
    expect(res.status).toBeGreaterThanOrEqual(400);

    const after = await prisma.client.findUniqueOrThrow({ where: { id: c.id } });
    expect(after.assignedAgentId).toBe(otherAgentId);
  });
});
