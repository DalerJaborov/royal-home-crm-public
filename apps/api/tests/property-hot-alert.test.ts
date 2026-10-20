import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * «ОБЪЕКТ ЗАГОРЕЛСЯ» — УВЕДОМЛЕНИЕ АГЕНТУ (24.09.2026), lib/propertyHotAlert.ts.
 * Пуш подменён; база общая, поэтому проверки смотрят только на свои объекты
 * (по tag), а свой объект набирает заведомо больше просмотров, чем чужие.
 */

const { sendPushToAgent } = vi.hoisted(() => ({ sendPushToAgent: vi.fn(async () => 1) }));
vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent,
}));

const { prisma } = await import("../src/db.js");
const { notifyHotProperties } = await import("../src/lib/propertyHotAlert.js");
const { dushanbeDayKeyToDate } = await import("../src/lib/siteStats.js");
const { dushanbeDayKey } = await import("@royal-home/shared");

const runId = Date.now();
const DAY = 86_400_000;
const phones = [`+992951${runId}`, `+992952${runId}`, `+992953${runId}`];
// Своя самая старая строка посещаемости: история сайта длиннее двух недель.
const oldHour = new Date(Math.floor((Date.now() - 20 * DAY) / 3_600_000) * 3_600_000 + (runId % 997) * 1000);
let districtId: string;
let agentId: string;
let intakeId: string;
let inactiveId: string;
const props: Record<"hot" | "steady" | "fallback", string> = { hot: "", steady: "", fallback: "" };

function dayAgo(n: number): Date {
  return dushanbeDayKeyToDate(dushanbeDayKey(new Date(Date.now() - n * DAY)));
}

type PushCall = [string, { kind: string; title: string; body: string; url: string; tag: string }];

function calls(): PushCall[] {
  return sendPushToAgent.mock.calls as unknown as PushCall[];
}

function tagsSent(): string[] {
  return calls().map((c) => c[1].tag);
}

function callFor(propertyId: string): PushCall | undefined {
  return calls().find((c) => c[1].tag === `property-hot:${propertyId}`);
}

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Тест-район-загорелся-${runId}` } })).id;
  agentId = (await prisma.agent.create({ data: { fullName: "Агент загорелся", phone: phones[0], role: "AGENT", passwordHash: "x" } })).id;
  intakeId = (await prisma.agent.create({ data: { fullName: "Принял объект", phone: phones[1], role: "AGENT", passwordHash: "x" } })).id;
  inactiveId = (
    await prisma.agent.create({ data: { fullName: "Уволен", phone: phones[2], role: "AGENT", passwordHash: "x", isActive: false } })
  ).id;
  await prisma.siteVisitHour.create({ data: { hourStart: oldHour, views: 1, visitors: 1 } });

  const base = { type: "APARTMENT" as const, rooms: 2, currency: "TJS" as const, districtId, address: "Тестовая, 5", condition: "GOOD" as const, areaSqm: 50, price: 500_000, status: "AVAILABLE" as const };
  props.hot = (await prisma.property.create({ data: { ...base, title: `Загорелся ${runId}`, assignedAgentId: agentId } })).id;
  props.steady = (await prisma.property.create({ data: { ...base, title: `Ровный ${runId}`, assignedAgentId: agentId } })).id;
  props.fallback = (
    await prisma.property.create({ data: { ...base, title: `Без агента сделки ${runId}`, assignedAgentId: inactiveId, intakeAgentId: intakeId } })
  ).id;

  const data: { propertyId: string; day: Date; views: number; visitors: number }[] = [];
  for (let n = 15; n >= 0; n--) {
    // Вспышка: 2 просмотра в день две недели, потом 300 за два дня.
    data.push({ propertyId: props.hot, day: dayAgo(n), views: n <= 1 ? 300 : 2, visitors: 1 });
    data.push({ propertyId: props.fallback, day: dayAgo(n), views: n <= 1 ? 250 : 2, visitors: 1 });
    // Всегда много — это не вспышка.
    data.push({ propertyId: props.steady, day: dayAgo(n), views: 200, visitors: 1 });
  }
  await prisma.sitePropertyDay.createMany({ data });
});

beforeEach(() => {
  sendPushToAgent.mockClear();
});

afterAll(async () => {
  const ids = Object.values(props);
  await prisma.sitePropertyDay.deleteMany({ where: { propertyId: { in: ids } } });
  await prisma.property.deleteMany({ where: { id: { in: ids } } });
  await prisma.siteVisitHour.deleteMany({ where: { hourStart: oldHour } });
  await prisma.agent.deleteMany({ where: { phone: { in: phones } } });
  await prisma.district.delete({ where: { id: districtId } }).catch(() => {});
  await prisma.$disconnect();
});

describe("notifyHotProperties — «Объект загорелся»", () => {
  it("истории сайта меньше двух недель — молчит (нечего считать обычным)", async () => {
    await notifyHotProperties(new Date(Date.now() - 5 * 365 * DAY));
    expect(tagsSent()).not.toContain(`property-hot:${props.hot}`);
  });

  it("вспышка — пуш агенту сделки со ссылкой на «Статистику»; ровный объект — нет", async () => {
    await notifyHotProperties();
    const call = callFor(props.hot);
    expect(call).toBeDefined();
    expect(call![0]).toBe(agentId);
    expect(call![1].kind).toBe("hot");
    expect(call![1].title).toMatch(/^Объект загорелся: ОБ-\d{6}$/);
    expect(call![1].body).toMatch(/600 просмотров на сайте за 2 дня, в 150 раза больше обычного/);
    expect(call![1].url).toMatch(/\?tab=stats$/);
    expect(tagsSent()).not.toContain(`property-hot:${props.steady}`);
    const p = await prisma.property.findUniqueOrThrow({ where: { id: props.hot }, select: { hotNotifiedAt: true } });
    expect(p.hotNotifiedAt).not.toBeNull();
  });

  it("агент сделки уволен — уведомление принявшему объект", async () => {
    // Прошлый тест уже разослал и этот объект — снимаем отметку и смотрим адресата.
    const row = await prisma.property.findUniqueOrThrow({ where: { id: props.fallback }, select: { hotNotifiedAt: true } });
    expect(row.hotNotifiedAt).not.toBeNull();
    await prisma.property.update({ where: { id: props.fallback }, data: { hotNotifiedAt: null } });
    await notifyHotProperties();
    expect(callFor(props.fallback)?.[0]).toBe(intakeId);
  });

  it("повторный сбор в ту же неделю — без второго пуша", async () => {
    await notifyHotProperties();
    expect(tagsSent()).not.toContain(`property-hot:${props.hot}`);
    expect(tagsSent()).not.toContain(`property-hot:${props.fallback}`);
  });
});
