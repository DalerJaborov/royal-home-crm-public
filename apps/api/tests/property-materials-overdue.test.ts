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
const { flushDirectorAlertQueue } = await import("../src/lib/directorAlertQueue.js");

/**
 * Просроченные фото/видео объекта — сигнал руководству. До 16.11.2026 ещё и штраф
 * Royal Score (photos_overdue / video_overdue); штраф снят владельцем, и отметкой
 * «уже сказали» стало само уведомление (одно на попадание объекта на этап).
 */

/** Новое правило «один сигнал на просрочку» считаем действующим всегда — иначе
 *  тест зависел бы от даты прогона относительно MATERIALS_ALERT_RULE_SINCE. */
const EPOCH = new Date(0);

/** Строки журнала по объекту — после снятия штрафа их быть не должно. */
const scoreRows = (propertyId: string) =>
  waitForSettled(() => prisma.royalScoreEvent.count({ where: { sourceId: propertyId } }));
/** Сколько раз о просрочке объекта поставили сигнал руководству. */
const alertsQueued = (propertyId: string) =>
  prisma.pendingDirectorAlert.count({ where: { tag: `materials-overdue-${propertyId}` } });

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
  it("фото просрочены (умолчание 2 дня) — сигнал руководству, баллов не списано", async () => {
    const property = await makeProperty("AWAITING_PHOTOS", 3);
    expect(await notifyOverdueMaterials(new Date(), EPOCH)).toBeGreaterThan(0);
    expect(await scoreRows(property.id)).toBe(0);
    expect(await alertsQueued(property.id)).toBe(1);
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

  it("видео просрочено — сигнал руководству, баллов не списано", async () => {
    const property = await makeProperty("AWAITING_VIDEO", 3);
    expect(await notifyOverdueMaterials(new Date(), EPOCH)).toBeGreaterThan(0);
    expect(await scoreRows(property.id)).toBe(0);
    expect(await alertsQueued(property.id)).toBe(1);
  });

  it("ровно отведённый срок — ещё не просрочка, сигнала нет", async () => {
    const property = await makeProperty("AWAITING_PHOTOS", 2);
    await notifyOverdueMaterials(new Date(), EPOCH);
    expect(await alertsQueued(property.id)).toBe(0);
  });

  it("второй тик по той же просрочке второй сигнал не ставит (без штрафа-отметки)", async () => {
    const property = await makeProperty("AWAITING_PHOTOS", 3);
    await notifyOverdueMaterials(new Date(), EPOCH);
    await notifyOverdueMaterials(new Date(), EPOCH);
    expect(await alertsQueued(property.id)).toBe(1);
  });

  it("объект без ответственного агента — руководству всё равно говорим", async () => {
    // Проверка «есть ли ответственный» стояла ради штрафа; штрафа нет с 16.11.2026.
    const property = await makeProperty("AWAITING_PHOTOS", 3);
    await prisma.property.update({ where: { id: property.id }, data: { intakeAgentId: null, assignedAgentId: null, createdById: null } });
    await notifyOverdueMaterials(new Date(), EPOCH);
    expect(await alertsQueued(property.id)).toBe(1);
  });

  it("просрочка, наступившая до нового правила, сигнала не даёт — без залпа после выката", async () => {
    const property = await makeProperty("AWAITING_PHOTOS", 10);
    await prisma.property.update({ where: { id: property.id }, data: { intakeAgentId: null, assignedAgentId: null, createdById: null } });
    // Правило «вступило» сутки назад, а этап просрочен уже 8 дней — это старая просрочка.
    await notifyOverdueMaterials(new Date(), new Date(Date.now() - 24 * 3600_000));
    expect(await alertsQueued(property.id)).toBe(0);
  });

  it("вернулся на этап заново и снова просрочил — новый сигнал", async () => {
    const property = await makeProperty("AWAITING_PHOTOS", 3);
    await notifyOverdueMaterials(new Date(), EPOCH);
    expect(await alertsQueued(property.id)).toBe(1);
    // Повторное попадание на этап: stageEnteredAt сдвигается вперёд, но снова просрочен.
    // Прошлый сигнал — раньше нового stageEnteredAt (так и бывает в жизни: дни назад).
    await prisma.pendingDirectorAlert.updateMany({
      where: { tag: `materials-overdue-${property.id}` },
      data: { createdAt: new Date(Date.now() - 5 * 24 * 3600_000) },
    });
    await prisma.notification.updateMany({
      where: { tag: `materials-overdue-${property.id}` },
      data: { createdAt: new Date(Date.now() - 5 * 24 * 3600_000) },
    });
    await notifyOverdueMaterials(new Date(), EPOCH);
    expect(await alertsQueued(property.id)).toBe(2);
  });

  it("второй тик по той же просрочке НЕ шлёт повторный push руководству", async () => {
    const property = await makeProperty("AWAITING_VIDEO", 3);
    await notifyOverdueMaterials(new Date(), EPOCH);
    await new Promise((r) => setTimeout(r, 200));
    await flushDirectorAlertQueue();
    sendPushToAgents.mockClear();
    await notifyOverdueMaterials(new Date(), EPOCH);
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
    const notified = await notifyOverdueMaterials(new Date(), EPOCH);
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
    await notifyOverdueMaterials(new Date(), EPOCH);
    const events = await prisma.royalScoreEvent.findMany({ where: { sourceId: p.id } });
    expect(events).toHaveLength(0);
  });

  it("срок ещё не вышел — молчим", async () => {
    const p = await makeProperty("EDITING", 1);
    await notifyOverdueMaterials(new Date(), EPOCH);
    const alert = await prisma.pendingDirectorAlert.findFirst({ where: { tag: `editing-overdue-${p.id}` } });
    expect(alert).toBeNull();
  });
});
