#!/usr/bin/env node
/**
 * ДЕМОНСТРАЦИОННЫЕ ДАННЫЕ ДЛЯ ОДНОГО АГЕНТА — чтобы владелец мог пройти
 * приложение на своём телефоне по живым экранам, а не по пустым заглушкам
 * (просьба 15.09.2026: «наполни мою учётку, чтобы никому не мешали, потом
 * скажу — сразу удалишь»).
 *
 *   npx tsx apps/api/scripts/demo-data.ts fill --phone +992900000002
 *   npx tsx apps/api/scripts/demo-data.ts wipe
 *
 * ЧЕМ ЭТИ ЗАПИСИ ОТЛИЧАЮТСЯ ОТ НАСТОЯЩИХ. Поля «демо» в схеме нет, заводить
 * его ради временной проверки — миграция на проде ради часа работы. Поэтому
 * метка живёт в данных, и сразу двойная:
 *   1) телефон из диапазона +99200000xxxx — в Таджикистане таких номеров нет,
 *      настоящий клиент под маску не попадёт никогда;
 *   2) имя начинается с «ДЕМО · » — видно глазами в любом списке.
 * `wipe` удаляет строго по маске телефона, поэтому снести чужое он не может
 * даже при ошибке в имени.
 *
 * Каскад: удаление клиента уносит его переписку и события (onDelete: Cascade
 * в схеме), сделки гасим явно — у них своя связь.
 */
import { PrismaClient } from "../src/generated/prisma/client.js";
import { makePrismaAdapter } from "../src/lib/prismaAdapter.js";

// Клиент Prisma в этом проекте работает через драйвер-адаптер (см. src/db.ts) —
// без него конструктор падает сразу, ещё до первого запроса.
const prisma = new PrismaClient({ adapter: makePrismaAdapter(process.env.DATABASE_URL ?? "") });

/** Маска демонстрационных номеров. По ней же идёт удаление — не по имени. */
const DEMO_PREFIX = "+99200000";
/** Приставки к имени НЕТ намеренно: в списке на телефоне строка узкая, и
 *  «ДЕМО · » съедала полфамилии — на кадре проверки читалось «ДЕМО · Юсупо…».
 *  Метка и так надёжнее: номер из несуществующего диапазона. */
const DEMO_NAME = "";

/** Душанбе живёт в UTC+5, контейнер — в UTC.
 *
 *  Тонкость, на которой это уже один раз сломалось: «сегодня» надо брать по
 *  ДУШАНБИНСКОМУ календарю, а не по UTC. Ночью с 19:00 UTC до полуночи в
 *  Душанбе уже следующие сутки, и день, взятый из `getUTCDate()`, оказывается
 *  вчерашним — задачи создаются задним числом и на экран «сегодня» не
 *  попадают вовсе. Поэтому сначала сдвигаем момент на +5 и только потом
 *  читаем календарные поля. */
function dushanbeToday(hour: number, minute = 0) {
  const shifted = new Date(Date.now() + 5 * 60 * 60 * 1000);
  return new Date(
    Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate(), hour - 5, minute)
  );
}

const CLIENTS = [
  { n: "Сафаров Рустам", p: "01", src: "INSTAGRAM", rooms: 2, min: 320000, max: 420000, accepted: false },
  { n: "Мирзоева Нигина", p: "02", src: "WHATSAPP", rooms: 3, min: 500000, max: 650000, accepted: false },
  { n: "Холов Джамшед", p: "03", src: "WEBSITE", rooms: 1, min: 180000, max: 240000, accepted: true },
  { n: "Раджабова Саида", p: "04", src: "TELEGRAM", rooms: 2, min: 280000, max: 360000, accepted: true },
  { n: "Назаров Фаррух", p: "05", src: "REFERRAL", rooms: 4, min: 700000, max: 900000, accepted: true },
  { n: "Юсупова Малика", p: "06", src: "PHONE_CALL", rooms: 2, min: 300000, max: 380000, accepted: true },
];

/** Задачи и показы на сегодня — из них строятся «Мой фокус», «Далее по
 *  приоритету» и «Показы сегодня» (см. routes/dashboard.ts). */
const TASKS = [
  { i: 0, type: "CALL", at: [9, 30], next: "Перезвонить: обещал ответ по двум вариантам" },
  { i: 1, type: "SHOWING", at: [11, 0], next: "Показ: 3-комн, Сино" },
  { i: 2, type: "MEETING", at: [14, 0], next: "Встреча в офисе: задаток" },
  { i: 3, type: "SHOWING", at: [16, 30], next: "Показ: 2-комн, Фирдавси" },
  { i: 4, type: "CALL", at: [18, 0], next: "Уточнить бюджет после совета с семьёй" },
];

async function findAgent(phone: string) {
  const agent = await prisma.agent.findUnique({ where: { phone } });
  if (!agent) throw new Error(`Агент с телефоном ${phone} не найден`);
  return agent;
}

async function fill(phone: string) {
  const agent = await findAgent(phone);
  console.log(`агент: ${agent.fullName} (${agent.role})`);

  const district = await prisma.district.findFirst();
  const created = [];

  for (const c of CLIENTS) {
    const client = await prisma.client.upsert({
      where: { phone: `${DEMO_PREFIX}${c.p}` },
      update: { assignedAgentId: agent.id },
      create: {
        fullName: `${DEMO_NAME}${c.n}`,
        phone: `${DEMO_PREFIX}${c.p}`,
        source: c.src,
        kind: "BUYER",
        status: c.accepted ? "CONTACTED" : "NEW",
        desiredRooms: c.rooms,
        budgetMin: c.min,
        budgetMax: c.max,
        desiredDistrictId: district?.id ?? null,
        assignedAgentId: agent.id,
        acceptedAt: c.accepted ? new Date() : null,
      },
    });
    created.push(client);
  }
  console.log(`клиентов: ${created.length} (из них ждут принятия: ${CLIENTS.filter((c) => !c.accepted).length})`);

  // Старые демо-события убираем, чтобы повторный запуск не плодил задачи.
  await prisma.interaction.deleteMany({ where: { clientId: { in: created.map((c) => c.id) } } });

  const property = await prisma.property.findFirst({ where: { status: "AVAILABLE" } });
  for (const t of TASKS) {
    await prisma.interaction.create({
      data: {
        clientId: created[t.i].id,
        agentId: agent.id,
        type: t.type,
        propertyId: t.type === "SHOWING" ? property?.id ?? null : null,
        notes: "Демонстрационная запись для проверки экранов на телефоне",
        nextAction: t.next,
        nextActionDate: dushanbeToday(t.at[0], t.at[1]),
      },
    });
  }
  console.log(`задач на сегодня: ${TASKS.length} (из них показов: ${TASKS.filter((t) => t.type === "SHOWING").length})`);
  console.log("готово. снести: npx tsx apps/api/scripts/demo-data.ts wipe");
}

async function wipe() {
  const clients = await prisma.client.findMany({ where: { phone: { startsWith: DEMO_PREFIX } }, select: { id: true } });
  const ids = clients.map((c) => c.id);
  if (ids.length === 0) {
    console.log("демонстрационных записей нет");
    return;
  }
  await prisma.deal.deleteMany({ where: { clientId: { in: ids } } });
  const removed = await prisma.client.deleteMany({ where: { id: { in: ids } } });
  console.log(`удалено клиентов: ${removed.count} (их события и переписка ушли каскадом)`);
}

const [, , cmd, ...rest] = process.argv;
const phoneArg = rest[rest.indexOf("--phone") + 1];

try {
  if (cmd === "fill") {
    if (!phoneArg || !phoneArg.startsWith("+")) throw new Error("нужен --phone +992...");
    await fill(phoneArg);
  } else if (cmd === "wipe") {
    await wipe();
  } else {
    console.log("npx tsx apps/api/scripts/demo-data.ts fill --phone +992900000002 | wipe");
    process.exitCode = 1;
  }
} catch (e) {
  console.error(`ошибка: ${e.message}`);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
