import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { waitFor, waitForSettled } from "./helpers/waitFor.js";

const sendPushToAgents = vi.fn(async () => 1);
vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgents }));
// Пуш руководству теперь идёт через общую очередь алармов (07.09.2026, часы
// алармов) — тест не должен плавать в зависимости от часа реального прогона.
vi.mock("../src/lib/workingHours.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/workingHours.js")>()),
  isWithinAlarmHours: async () => true,
}));

const { prisma } = await import("../src/db.js");
const { notifyOverdueMaterials } = await import("../src/lib/propertyPipeline.js");
const { DEFAULT_EVENT_POINTS } = await import("../src/lib/scoreJournal.js");
const { flushDirectorAlertQueue } = await import("../src/lib/directorAlertQueue.js");

/**
 * Штраф Royal Score за просроченные фото/видео объекта (таблица владельца,
 * п. 21-22) — конвейер уже красит этап просроченным, здесь только проверяем,
 * что он же пишет событие и не дублирует его на следующем тике.
 */

const runId = Date.now();
let districtId: string;
let agentId: string;
let directorId: string;
const propertyIds: string[] = [];

async function makeProperty(status: "AWAITING_PHOTOS" | "AWAITING_VIDEO" | "EDITING", daysAgo: number) {
  const p = await prisma.property.create({
    data: {
      title: `Объект материалов ${runId}-${propertyIds.length}`,
      type: "APARTMENT",
      areaSqm: 50,
      price: 40000,
      currency: "TJS",
      districtId,
      address: "Тестовая, 2",
      condition: "GOOD",
      status,
      intakeAgentId: agentId,
    },
  });
  await prisma.property.update({
    where: { id: p.id },
    data: { stageEnteredAt: new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000) },
  });
  propertyIds.push(p.id);
  return p;
}

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Тест-район-материалы-${runId}` } })).id;
  agentId = (
    await prisma.agent.create({
      data: { fullName: "Агент материалов", phone: `+992941${runId}`, role: "AGENT", passwordHash: "x" },
    })
  ).id;
  // Получатель пуша руководству через очередь алармов (clients.assign) — без
  // него findAgentsWithPermission вернул бы пусто, и flush молча закрыл бы
  // строку очереди, никого не найдя.
  directorId = (
    await prisma.agent.create({
      data: { fullName: "Директор материалов", phone: `+992942${runId}`, role: "DIRECTOR", passwordHash: "x" },
    })
  ).id;
});

beforeEach(() => sendPushToAgents.mockClear());

afterAll(async () => {
  await prisma.pendingDirectorAlert.deleteMany({ where: { tag: { startsWith: "materials-overdue-" } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: [agentId, directorId] } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
});

describe("Просроченные фото/видео объекта", () => {
  it("фото просрочены (умолчание 2 дня) — photos_overdue ответственному", async () => {
    const property = await makeProperty("AWAITING_PHOTOS", 3);
    expect(await notifyOverdueMaterials()).toBeGreaterThan(0);
    // recordScoreEvent не ждётся внутри конвейера (fire-and-forget, как и в
    // остальных overdue-джобах) — ждём запись помощником, а не фиксированным сном.
    const event = await waitFor(
      () => prisma.royalScoreEvent.findFirst({ where: { agentId, sourceId: property.id } }),
      { label: "балл Royal Score" }
    ).catch(() => null);
    expect(event?.kind).toBe("photos_overdue");
    expect(event?.delta).toBe(DEFAULT_EVENT_POINTS.photos_overdue);
    await flushDirectorAlertQueue();
    /**
     * ПРОВЕРЯЕМ ЛЕНТУ В БАЗЕ, А НЕ ПОДМЕНУ ПУША. Очередь алармов
     * (PendingDirectorAlert) одна на всю базу, а тесты сервера идут в два
     * процесса на одной базе: `flushDirectorAlertQueue` из соседнего файла
     * разбирает ВСЕ незакрытые строки, включая нашу, и тогда пуш уходит в его
     * подмену — наша `sendPushToAgents.mock` остаётся пустой, хотя аларм
     * доставлен. Ровно это уронило сборку 23.09.2026, а в одиночку файл давал
     * 8 из 8. Строка ленты пишется тем же проходом очереди в общую базу, кто бы
     * его ни выполнил, — по ней и судим.
     */
    const delivered = await waitFor(
      () => prisma.notification.findFirst({ where: { agentId: directorId, tag: `materials-overdue-${property.id}` } }),
      { label: "аларм руководству" }
    ).catch(() => null);
    expect(delivered).toBeTruthy();
  });

  it("видео просрочено — video_overdue", async () => {
    const property = await makeProperty("AWAITING_VIDEO", 3);
    expect(await notifyOverdueMaterials()).toBeGreaterThan(0);
    const event = await waitFor(
      () => prisma.royalScoreEvent.findFirst({ where: { agentId, sourceId: property.id } }),
      { label: "балл Royal Score" }
    ).catch(() => null);
    expect(event?.kind).toBe("video_overdue");
    expect(event?.delta).toBe(DEFAULT_EVENT_POINTS.video_overdue);
  });

  it("ровно отведённый срок — ещё не просрочка, событие не пишется", async () => {
    const property = await makeProperty("AWAITING_PHOTOS", 2);
    await notifyOverdueMaterials();
    const event = await prisma.royalScoreEvent.findFirst({ where: { agentId, sourceId: property.id } });
    expect(event).toBeNull();
  });

  it("второй тик по той же просрочке не начисляет штраф дважды", async () => {
    const property = await makeProperty("AWAITING_PHOTOS", 3);
    await notifyOverdueMaterials();
    const before = await waitForSettled(() =>
      prisma.royalScoreEvent.count({ where: { agentId, sourceId: property.id } })
    );
    await notifyOverdueMaterials();
    const after = await waitForSettled(() =>
      prisma.royalScoreEvent.count({ where: { agentId, sourceId: property.id } })
    );
    expect(after).toBe(before);
  });

  it("второй тик по той же просрочке НЕ шлёт повторный push руководству", async () => {
    const property = await makeProperty("AWAITING_VIDEO", 3);
    await notifyOverdueMaterials();
    await new Promise((r) => setTimeout(r, 200));
    await flushDirectorAlertQueue();
    sendPushToAgents.mockClear();
    await notifyOverdueMaterials();
    await flushDirectorAlertQueue();
    const call = sendPushToAgents.mock.calls.find(
      ([, payload]) => (payload as Record<string, string>).tag === `materials-overdue-${property.id}`
    );
    expect(call).toBeUndefined();
  });
});

/**
 * МОНТАЖ — единственный этап конвейера, где объект лежит МЕЖДУ людьми и его никто
 * не ждёт: владелец уже одобрил материалы и считает, что дело идёт. До 09.09.2026
 * просрочка этого этапа честно красилась на карточке, но задачи не производила
 * ни у кого.
 */
describe("Объект стоит на монтаже", () => {
  it("просрочка монтажа доходит до руководства", async () => {
    const p = await makeProperty("EDITING", 5);
    const notified = await notifyOverdueMaterials();
    expect(notified).toBeGreaterThanOrEqual(1);
    const alert = await prisma.pendingDirectorAlert.findFirst({ where: { tag: `editing-overdue-${p.id}` } });
    expect(alert).not.toBeNull();
  });

  /**
   * Материалы агент сдал, владелец их одобрил — дальше объект у монтажёра.
   * Наказывать агента за чужой этап нельзя: двойное наказание и наказание не того
   * разрушают доверие к системе быстрее всего.
   */
  it("штрафа агенту за монтаж нет", async () => {
    const p = await makeProperty("EDITING", 5);
    await notifyOverdueMaterials();
    const events = await prisma.royalScoreEvent.findMany({ where: { sourceId: p.id } });
    expect(events).toHaveLength(0);
  });

  it("срок ещё не вышел — молчим", async () => {
    const p = await makeProperty("EDITING", 1);
    await notifyOverdueMaterials();
    const alert = await prisma.pendingDirectorAlert.findFirst({ where: { tag: `editing-overdue-${p.id}` } });
    expect(alert).toBeNull();
  });
});
