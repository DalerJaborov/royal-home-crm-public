import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { runLostInactiveTrashSweep } from "../src/lib/lostInactiveTrashSweep.js";

/**
 * АВТОУБОРКА «ПОТЕРЯННЫХ» И «НЕАКТИВНЫХ» В КОРЗИНУ (решение владельца 30.08.2026).
 *
 * До 25.09.2026 до этого файла не дотягивался ни один тест (замер
 * `node scripts/impact-tests.mjs --for=apps/api/src/lib/lostInactiveTrashSweep.ts`).
 * Он работает по расписанию, без человека, и УНОСИТ КАРТОЧКИ КЛИЕНТОВ — то есть
 * поломку здесь замечают по последствиям, а не по красной проверке. Владельцу
 * уже приходилось возвращать карточки, ошибочно снятые автоматикой.
 *
 * Проверяется не «сколько унесло» (свип идёт по ВСЕЙ базе, и соседний файл
 * прогона добавит своих кандидатов), а судьба КАЖДОЙ СВОЕЙ карточки: уехала или
 * осталась. Счётчики сводки — только неравенством.
 *
 * Все карточки здесь заведомо старше срока: свип берёт только тех, у кого
 * `lostAt`/`inactiveSince` старше `Settings.lostOrInactiveToTrashAfterDays`
 * (по умолчанию 90 суток), поэтому чужие свежие записи под него не попадают.
 */

const runId = Date.now();
const DAY_MS = 86_400_000;
const OLD = new Date(Date.now() - 200 * DAY_MS);
const RECENT = new Date(Date.now() - 3 * DAY_MS);

const clientIds: string[] = [];
const propertyIds: string[] = [];
const dealIds: string[] = [];
let districtId = "";
let agentId = "";
let adminId = "";
let ownAdminId = "";

async function makeClient(data: Record<string, unknown>) {
  const c = await prisma.client.create({
    data: {
      fullName: `Клиент автосвипа ${runId}-${clientIds.length}`,
      phone: `+99277${String(runId).slice(-6)}${clientIds.length}`,
      source: "PHONE_CALL",
      assignedAgentId: agentId,
      ...data,
    },
  });
  clientIds.push(c.id);
  return c;
}

async function deletedAtOf(id: string) {
  const row = await prisma.client.findUnique({ where: { id }, select: { deletedAt: true } });
  return row?.deletedAt ?? null;
}

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Тест-район-автосвип-${runId}` } })).id;
  const agent = await prisma.agent.create({
    data: { fullName: `Агент автосвипа ${runId}`, phone: `+99271${String(runId).slice(-7)}`, role: "AGENT", passwordHash: "x" },
  });
  agentId = agent.id;
  // Исполнителем автоматика берёт первого активного ADMIN; в базе прогона он
  // должен быть, иначе свип честно ничего не трогает и пишет в журнал ошибок.
  // На чистой базе (ship --clean-db) ADMIN может не оказаться — тогда заводим своего и убираем за собой.
  const admin = await prisma.agent.findFirst({ where: { role: "ADMIN", isActive: true }, select: { id: true } });
  if (admin) adminId = admin.id;
  else {
    ownAdminId = (
      await prisma.agent.create({
        data: { fullName: `Админ автосвипа ${runId}`, phone: `+99272${String(runId).slice(-7)}`, role: "ADMIN", passwordHash: "x" },
      })
    ).id;
    adminId = ownAdminId;
  }
});

afterAll(async () => {
  await prisma.deal.deleteMany({ where: { id: { in: dealIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
  // Свип пишет действия от имени админа — сначала его следы в журнале, потом сам агент.
  if (ownAdminId) {
    await prisma.auditLog.deleteMany({ where: { agentId: ownAdminId } }).catch(() => {});
    await prisma.agent.deleteMany({ where: { id: ownAdminId } }).catch(() => {});
  }
  await prisma.district.deleteMany({ where: { id: districtId } });
});

describe("Автоуборка Потерянных и Неактивных в Корзину", () => {
  it("забирает просроченных и не трогает свежих, уже удалённых и LOST без даты потери", async () => {
    expect(adminId, "в базе прогона нет активного ADMIN — свип не смог бы действовать").not.toBe("");

    const lostOld = await makeClient({ status: "LOST", lostAt: OLD });
    const inactiveOld = await makeClient({ workStatus: "INACTIVE", inactiveSince: OLD });
    const lostRecent = await makeClient({ status: "LOST", lostAt: RECENT });
    const inactiveRecent = await makeClient({ workStatus: "INACTIVE", inactiveSince: RECENT });
    // Карточка, ставшая LOST до появления поля lostAt (миграция 20260830200000):
    // даты потери у неё нет, и свип НЕ должен домысливать её за неё.
    const lostWithoutDate = await makeClient({ status: "LOST", lostAt: null });
    // Уже в Корзине: повторно трогать нечего, и в кандидаты попадать не должна.
    const alreadyTrashed = await makeClient({
      status: "LOST",
      lostAt: OLD,
      deletedAt: new Date(),
      deletedById: adminId,
    });
    const trashedAtBefore = await deletedAtOf(alreadyTrashed.id);

    const summary = await runLostInactiveTrashSweep();
    expect(summary.trashed).toBeGreaterThanOrEqual(2);

    expect(await deletedAtOf(lostOld.id)).not.toBeNull();
    expect(await deletedAtOf(inactiveOld.id)).not.toBeNull();

    expect(await deletedAtOf(lostRecent.id)).toBeNull();
    expect(await deletedAtOf(inactiveRecent.id)).toBeNull();
    expect(await deletedAtOf(lostWithoutDate.id)).toBeNull();
    // Дата удаления не переписана заново — карточка в выборку не попала.
    expect((await deletedAtOf(alreadyTrashed.id))?.getTime()).toBe(trashedAtBefore?.getTime());
  });

  it("срок берётся из настроек, а не зашит числом", async () => {
    const settings = await prisma.settings.findUnique({
      where: { id: "singleton" },
      select: { lostOrInactiveToTrashAfterDays: true },
    });
    const before = settings?.lostOrInactiveToTrashAfterDays ?? null;

    // Карточка потеряна десять дней назад: при сроке 90 суток она остаётся,
    // при сроке 5 суток — уезжает. Один и тот же клиент, разная настройка.
    const client = await makeClient({ status: "LOST", lostAt: new Date(Date.now() - 10 * DAY_MS) });

    await prisma.settings.update({ where: { id: "singleton" }, data: { lostOrInactiveToTrashAfterDays: 90 } });
    await runLostInactiveTrashSweep();
    expect(await deletedAtOf(client.id)).toBeNull();

    await prisma.settings.update({ where: { id: "singleton" }, data: { lostOrInactiveToTrashAfterDays: 5 } });
    await runLostInactiveTrashSweep();
    expect(await deletedAtOf(client.id)).not.toBeNull();

    await prisma.settings.update({
      where: { id: "singleton" },
      data: { lostOrInactiveToTrashAfterDays: before ?? 90 },
    });
  });

  it("карточку с незакрытой сделкой не уносит: сделка важнее срока", async () => {
    const client = await makeClient({ status: "LOST", lostAt: OLD });
    const property = await prisma.property.create({
      data: {
        title: `Объект автосвипа ${runId}`,
        type: "APARTMENT",
        areaSqm: 50,
        price: 100000,
        currency: "TJS",
        districtId,
        address: "Тестовая, автосвип",
        condition: "GOOD",
      },
    });
    propertyIds.push(property.id);
    const deal = await prisma.deal.create({
      data: { clientId: client.id, propertyId: property.id, agentId, stage: "NEGOTIATION" },
    });
    dealIds.push(deal.id);

    const summary = await runLostInactiveTrashSweep();
    expect(await deletedAtOf(client.id)).toBeNull();
    expect(summary.skipped).toBeGreaterThanOrEqual(1);
  });

  it("продавца с объектом в работе не уносит: иначе объект остался бы без хозяина", async () => {
    const seller = await makeClient({ status: "LOST", lostAt: OLD });
    const property = await prisma.property.create({
      data: {
        title: `Объект продавца автосвипа ${runId}`,
        type: "APARTMENT",
        areaSqm: 60,
        price: 120000,
        currency: "TJS",
        districtId,
        address: "Тестовая, продавец автосвипа",
        condition: "GOOD",
        sellerClientId: seller.id,
      },
    });
    propertyIds.push(property.id);

    await runLostInactiveTrashSweep();
    expect(await deletedAtOf(seller.id)).toBeNull();
  });
});
