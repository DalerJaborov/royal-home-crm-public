import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const sendPushToAgent = vi.fn(async () => 1);
vi.mock("../src/push.js", async (importOriginal) => ({
  // Подмена ДОПОЛНЯЕТ модуль, а не заменяет его целиком (19.09.2026):
  // фабрика без importOriginal убирает остальные экспорты у всего
  // процесса, и СОСЕДНИЙ тест падает на «No "…" export is defined».
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent, sendPushToAgents: sendPushToAgent,
}));

const { prisma } = await import("../src/db.js");
const { remindIncompleteCards } = await import("../src/lib/cardReminders.js");

/** Контроль заполнения карточки: напоминание агенту через час, руководству — через
 *  12 часов. Точка отсчёта переносится сама любой работой с клиентом — звонком,
 *  сообщением, показом (lastContactAt). Кнопка «Я в работе» убрана из интерфейса
 *  08.08.2026, но старая отметка workingMarkedAt по-прежнему учитывается. */

const runId = Date.now();
const hoursAgo = (h: number) => new Date(Date.now() - h * 60 * 60 * 1000);

let agentId: string;
let directorId: string;
let districtId: string;
const clientIds: string[] = [];

async function makeClient(name: string, data: Record<string, unknown>) {
  const c = await prisma.client.create({
    data: {
      fullName: `${name} ${runId}`,
      phone: `+9929${clientIds.length}${runId}`,
      source: "PHONE_CALL",
      assignedAgentId: agentId,
      // Последний контакт по умолчанию — момент принятия лида: у настоящей карточки,
      // с которой после принятия ничего не делали, он именно такой. Без этого у
      // всех тестовых карточек стояло бы «только что» (значение по умолчанию в
      // схеме), и отсчёт всегда начинался бы с текущей секунды.
      ...(data.acceptedAt ? { lastContactAt: data.acceptedAt } : {}),
      ...data,
    },
  });
  clientIds.push(c.id);
  return c.id;
}

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Тест-район-карточки-${runId}` } })).id;
  agentId = (
    await prisma.agent.create({
      data: { fullName: "Агент карточек", phone: `+992936${runId}`, role: "AGENT", passwordHash: "x" },
    })
  ).id;
  directorId = (
    await prisma.agent.create({
      data: { fullName: "Директор карточек", phone: `+992935${runId}`, role: "DIRECTOR", passwordHash: "x" },
    })
  ).id;
});

beforeEach(() => sendPushToAgent.mockClear());

afterAll(async () => {
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: [agentId, directorId] } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.$disconnect();
});

/**
 * Уведомления, адресованные этому человеку.
 *
 * Первый аргумент — либо один идентификатор (личное напоминание агенту), либо
 * список (рассылка руководству идёт ОДНИМ запросом, sendPushToAgents). Обе формы
 * проверяются здесь, чтобы тест не зависел от того, каким способом отправлено.
 */
function pushesFor(id: string) {
  return (sendPushToAgent.mock.calls as unknown as [string | string[], Record<string, string>][]).filter(([to]) =>
    Array.isArray(to) ? to.includes(id) : to === id
  );
}

describe("Напоминания о незаполненной карточке", () => {
  it("через час после принятия агенту НИЧЕГО не шлёт, но отметку ставит (решение владельца 02.10.2026)", async () => {
    // Пуш и запись в ленту агенту убраны. Отметка cardReminderSentAt обязана
    // остаться: иначе выборка кандидатов (take: 300) забьётся одними и теми же.
    const id = await makeClient("Пустая карточка", { acceptedAt: hoursAgo(2) });
    await remindIncompleteCards();
    expect(pushesFor(agentId).some(([, p]) => p.title.includes("Карточка не заполнена"))).toBe(false);
    const saved = await prisma.client.findUnique({ where: { id } });
    expect(saved?.cardReminderSentAt).not.toBeNull();
  });

  it("повторный тик по уже отмеченной карточке тоже тихий", async () => {
    await makeClient("Без подписки", { acceptedAt: hoursAgo(2) });
    await remindIncompleteCards();
    sendPushToAgent.mockClear();
    await remindIncompleteCards();
    expect(pushesFor(agentId)).toHaveLength(0);
  });

  it("второй раз то же напоминание не шлёт", async () => {
    await remindIncompleteCards();
    expect(pushesFor(agentId).some(([, p]) => p.title.includes("Карточка не заполнена"))).toBe(false);
  });

  it("заполненную карточку не трогает вовсе", async () => {
    await makeClient("Заполненная", {
      acceptedAt: hoursAgo(20),
      budgetMin: 100000,
      desiredDistrictId: districtId,
      desiredRooms: 2,
    });
    sendPushToAgent.mockClear();
    await remindIncompleteCards();
    const titles = pushesFor(agentId).map(([, p]) => p.body ?? "");
    expect(titles.some((b) => b.includes("Заполненная"))).toBe(false);
  });

  it("через 12 часов руководству уведомления нет, отметка эскалации стоит (владелец 02.10.2026)", async () => {
    const clientId = await makeClient("Забытая карточка", { acceptedAt: hoursAgo(13) });
    sendPushToAgent.mockClear();
    await remindIncompleteCards();
    expect(pushesFor(directorId), "руководителю телефон звонить не должен").toHaveLength(0);
    const row = await prisma.notification.findFirst({
      where: { agentId: directorId, tag: `card-escalated-${clientId}` },
    });
    expect(row, "строки в ленте руководителя быть не должно").toBeNull();
    const after = await prisma.client.findUnique({ where: { id: clientId }, select: { cardEscalatedAt: true } });
    expect(after?.cardEscalatedAt, "отметка эскалации остаётся, иначе клиент вернётся в выборку").not.toBeNull();
  });

  it("разговор с клиентом переносит отсчёт сам — руководству не сообщают", async () => {
    // Лид приняли 13 часов назад, но два часа назад агент с клиентом говорил.
    // Раньше для этого приходилось нажимать «Я в работе», теперь достаточно самой работы.
    await makeClient("Живая карточка", { acceptedAt: hoursAgo(13), lastContactAt: hoursAgo(2) });
    sendPushToAgent.mockClear();
    await remindIncompleteCards();
    const toDirector = pushesFor(directorId).filter(([, p]) => (p.body ?? "").includes("Живая карточка"));
    expect(toDirector).toHaveLength(0);
  });

  /**
   * ЖИВАЯ ПЕРЕПИСКА ГАСИТ НАПОМИНАНИЕ, НО НЕ ПРЯЧЕТ КЛИЕНТА ОТ ОТЧЁТОВ.
   *
   * Ради этого случая и заведено отдельное поле lastClientMessageAt: сообщение
   * клиента больше не двигает lastContactAt, потому что тот читают отчёты о
   * забытых клиентах и об остывании — им нужно отсутствие ЧЕЛОВЕЧЕСКОЙ работы.
   * Напоминание же о карточке должно молчать, пока в ней идёт диалог.
   */
  it("клиент пишет сам — напоминание молчит, но отчёты его по-прежнему видят", async () => {
    const acceptedAt = hoursAgo(13);
    const id = await makeClient("Переписка с ботом", {
      acceptedAt,
      // Человек не трогал карточку с самого принятия лида.
      lastContactAt: acceptedAt,
      lastClientMessageAt: hoursAgo(1),
    });
    sendPushToAgent.mockClear();
    await remindIncompleteCards();

    expect(pushesFor(directorId).filter(([, p]) => (p.body ?? "").includes("Переписка с ботом"))).toHaveLength(0);
    expect(pushesFor(agentId).filter(([, p]) => (p.body ?? "").includes("Переписка с ботом"))).toHaveLength(0);

    // А для отчётов клиент остаётся необслуженным: lastContactAt не поехал.
    const saved = await prisma.client.findUnique({ where: { id } });
    expect(saved!.lastContactAt.getTime()).toBe(acceptedAt.getTime());
    // Тем же условием, что и «забытые клиенты» (problemReport) и кандидаты на
    // остывание (clientAutoStatus): выборка по lastContactAt его находит.
    const forgotten = await prisma.client.count({
      where: { id, deletedAt: null, lastContactAt: { lt: hoursAgo(12) } },
    });
    expect(forgotten).toBe(1);
  });

  it("старая отметка «Я в работе» по-прежнему переносит отсчёт", async () => {
    await makeClient("В работе", { acceptedAt: hoursAgo(13), workingMarkedAt: hoursAgo(2) });
    sendPushToAgent.mockClear();
    await remindIncompleteCards();
    const toDirector = pushesFor(directorId).filter(([, p]) => (p.body ?? "").includes("В работе"));
    expect(toDirector).toHaveLength(0);
  });

  it("до принятия лида ничего не требует", async () => {
    await makeClient("Непринятый", { acceptedAt: null });
    sendPushToAgent.mockClear();
    await remindIncompleteCards();
    expect(pushesFor(agentId).some(([, p]) => (p.body ?? "").includes("Непринятый"))).toBe(false);
  });
});
