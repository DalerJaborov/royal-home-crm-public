import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import { prisma } from "../src/db.js";
import {
  runClientPropertyCountAlarmTick,
  sellerGraceWorkingDays,
  SELLER_GRACE_WORKING_DAYS_FIRST,
  SELLER_GRACE_WORKING_DAYS_NEXT,
  BUYER_GRACE_DAYS_PER_UNIT,
} from "../src/lib/clientPropertyCountAlarm.js";
import { addAlarmWorkingDays, isAlarmDayOff } from "../src/lib/alarmCalendar.js";

/**
 * Аларм «заявлено N, сделано M» — продавец и покупатель, ОДНО уведомление на
 * клиента (владелец 06.09.2026 п.3, объединено 07.09.2026: «нужно, чтобы по
 * одному клиенту приходил один целый alarm, а не по отдельности»; срок
 * растянут по числу объектов 07.09.2026: «один объект — два дня, два — четыре,
 * три — шесть», покупателю — 5 дней на объект).
 *
 * ВЫДЕРЖКА ПРОДАВЦА ПЕРЕСЧИТАНА 12.09.2026 (владелец: «3 на первый и дальше по
 * 2 дня»): 3 РАБОЧИХ дня на первый заявленный объект и по 2 на каждый следующий,
 * воскресенье не в счёт. Сроки в тестах поэтому больше не считаются календарными
 * сутками руками — declaredAtFor() спрашивает срок у самой функции, иначе тест
 * пришлось бы править при каждой смене календаря и он перестал бы что-либо
 * проверять. Покупатель остался на 5 календарных днях — его воронку ведёт другой
 * чат, менять ему сроки из-под руки нельзя.
 */

const runId = Date.now();
const NOW = new Date("2026-09-01T07:00:00Z"); // рабочие часы, вторник
const DAY_MS = 86_400_000;
const password = "testpass123";

/**
 * Момент «ИИ услышал число N», подобранный так, чтобы к NOW выдержка ИМЕННО истекла
 * (expired) или ИМЕННО не истекла (ещё сутки в запасе). Срок берётся у боевой функции,
 * а не пересчитывается в тесте: захардкоженное «N × 2 дня» пережило бы смену правила
 * молча и зелёным.
 */
function declaredAtFor(declared: number, opts: { expired: boolean }): Date {
  const days = sellerGraceWorkingDays(declared);
  let cursor = new Date(NOW.getTime());
  while (addAlarmWorkingDays(cursor, days) > NOW) cursor = new Date(cursor.getTime() - DAY_MS);
  return opts.expired ? cursor : new Date(cursor.getTime() + DAY_MS);
}

let districtId: string;
let agentId: string;
let directorId: string;
let propertyId: string;
const clientIds: string[] = [];
const propertyIds: string[] = [];
const dealIds: string[] = [];

async function makeClient(opts: {
  sellerDeclared?: number | null;
  sellerDeclaredAt?: Date | null;
  propertiesAdded?: number;
  buyerDeclared?: number | null;
  buyerDeclaredAt?: Date | null;
  dealsCompleted?: number;
  kind?: "SELLER" | "BUYER";
  dualIntent?: boolean;
}) {
  const idx = clientIds.length;
  const c = await prisma.client.create({
    data: {
      fullName: `Заявлено-сделано ${runId}-${idx}`,
      phone: `+992919${runId}${idx}`,
      source: "PHONE_CALL",
      kind: opts.kind ?? "SELLER",
      dualIntent: opts.dualIntent ?? false,
      workStatus: "ACTIVE",
      status: "NEW",
      assignedAgentId: agentId,
      sellerDeclaredPropertyCount: opts.sellerDeclared ?? null,
      sellerDeclaredPropertyCountAt: opts.sellerDeclaredAt ?? null,
      buyerDesiredPropertyCount: opts.buyerDeclared ?? null,
      buyerDesiredPropertyCountAt: opts.buyerDeclaredAt ?? null,
    },
  });
  clientIds.push(c.id);

  for (let i = 0; i < (opts.propertiesAdded ?? 0); i++) {
    const p = await prisma.property.create({
      data: {
        title: `Тест-объект-сделано-${runId}-${idx}-${i}`,
        type: "APARTMENT",
        areaSqm: 50,
        price: 40000,
        currency: "USD",
        districtId,
        address: "Тестовая, 1",
        condition: "GOOD",
        assignedAgentId: agentId,
        ownerContact: `+99290002${runId}${idx}${i}`,
        sellerClientId: c.id,
      },
    });
    propertyIds.push(p.id);
  }

  for (let i = 0; i < (opts.dealsCompleted ?? 0); i++) {
    const d = await prisma.deal.create({
      data: {
        clientId: c.id,
        propertyId,
        agentId,
        stage: "COMPLETED",
      },
    });
    dealIds.push(d.id);
  }

  return c;
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  districtId = (await prisma.district.create({ data: { name: `Тест-район-сделано-${runId}` } })).id;
  agentId = (
    await prisma.agent.create({ data: { fullName: "Агент счёта сделано", phone: `+992966${runId}0`, role: "AGENT", passwordHash } })
  ).id;
  directorId = (
    await prisma.agent.create({ data: { fullName: "Директор счёта сделано", phone: `+992966${runId}1`, role: "DIRECTOR", passwordHash } })
  ).id;
  propertyId = (
    await prisma.property.create({
      data: {
        title: `Тест-объект-для-сделок-${runId}`,
        type: "APARTMENT",
        areaSqm: 50,
        price: 40000,
        currency: "USD",
        districtId,
        address: "Тестовая, 2",
        condition: "GOOD",
        assignedAgentId: agentId,
        ownerContact: `+992900030${runId}`,
      },
    })
  ).id;
  propertyIds.push(propertyId);
});

afterAll(async () => {
  // Только по СВОИМ клиентам: `startsWith` смёл бы и уведомления о чужих
  // карточках (сид стенда, прод), которые тест не заводил и трогать не вправе.
  await prisma.notification.deleteMany({
    where: { tag: { in: clientIds.map((id) => `client-property-count-${id}`) } },
  });
  await prisma.deal.deleteMany({ where: { id: { in: dealIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: [agentId, directorId] } } });
  await prisma.district.delete({ where: { id: districtId } });
});

describe("Выдержка продавца: 3 рабочих дня на первый объект, дальше по 2", () => {
  it("первый объект дороже остальных", () => {
    expect(sellerGraceWorkingDays(1)).toBe(3);
    expect(sellerGraceWorkingDays(2)).toBe(5);
    expect(sellerGraceWorkingDays(3)).toBe(7);
    expect(SELLER_GRACE_WORKING_DAYS_FIRST).toBe(3);
    expect(SELLER_GRACE_WORKING_DAYS_NEXT).toBe(2);
  });

  it("числа нет — выдержки нет (делить нечего)", () => {
    expect(sellerGraceWorkingDays(0)).toBe(0);
    expect(sellerGraceWorkingDays(-1)).toBe(0);
  });

  it("общий выходной (воскресенье в Настройках) не съедает выдержку: от пятницы три рабочих дня — это вторник", () => {
    const sundayOff = { companyDaysOff: [0] };
    // Пятница 04.09.2026, 12:00 по Душанбе (07:00 UTC).
    const friday = new Date("2026-09-04T07:00:00Z");
    const deadline = addAlarmWorkingDays(friday, sellerGraceWorkingDays(1), sundayOff);
    // Суббота и понедельник рабочие, воскресенье пропущено → четверо календарных суток.
    expect(deadline.getTime() - friday.getTime()).toBe(4 * DAY_MS);
    expect(isAlarmDayOff(deadline, sundayOff)).toBe(false);
  });

  it("по умолчанию выходных нет (11.10.2026): три рабочих дня от пятницы — это понедельник", () => {
    const friday = new Date("2026-09-04T07:00:00Z");
    const deadline = addAlarmWorkingDays(friday, sellerGraceWorkingDays(1));
    expect(deadline.getTime() - friday.getTime()).toBe(3 * DAY_MS);
  });
});

describe("runClientPropertyCountAlarmTick", () => {
  /**
   * Рассылка директорам «заявлено N, добавлено M» убрана по решению владельца
   * 02.10.2026 (за 14 дней ~2 000 срабатываний — спам). Тик остался заглушкой с
   * прежней сигнатурой, потому что его вызывает cron.ts: ни ленты, ни пуша, и
   * ничего не пишется ни в карточку, ни в дела.
   */
  it("истёкшее расхождение у продавца, покупателя и dualIntent → записей в ленте директору нет", async () => {
    const seller = await makeClient({
      sellerDeclared: 1,
      sellerDeclaredAt: declaredAtFor(1, { expired: true }),
      propertiesAdded: 0,
    });
    const buyer = await makeClient({
      buyerDeclared: 2,
      buyerDeclaredAt: new Date(NOW.getTime() - (BUYER_GRACE_DAYS_PER_UNIT * 2 + 1) * DAY_MS),
      dealsCompleted: 1,
      kind: "BUYER",
    });
    const dual = await makeClient({
      sellerDeclared: 3,
      sellerDeclaredAt: declaredAtFor(3, { expired: true }),
      propertiesAdded: 1,
      buyerDeclared: 2,
      buyerDeclaredAt: new Date(NOW.getTime() - (BUYER_GRACE_DAYS_PER_UNIT * 2 + 1) * DAY_MS),
      dealsCompleted: 0,
      dualIntent: true,
    });

    const { alerted } = await runClientPropertyCountAlarmTick(NOW);
    expect(alerted).toBe(0);

    const notes = await prisma.notification.count({
      where: { tag: { in: [seller.id, buyer.id, dual.id].map((id) => `client-property-count-${id}`) } },
    });
    expect(notes).toBe(0);
  });

  it("числа не заданы (ИИ ничего не услышал) → тик тоже молчит", async () => {
    const c = await makeClient({});
    const { alerted } = await runClientPropertyCountAlarmTick(NOW);
    expect(alerted).toBe(0);
    const note = await prisma.notification.findFirst({ where: { tag: `client-property-count-${c.id}` } });
    expect(note).toBeNull();
  });
});
