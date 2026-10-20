import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * КЛИК ПО РЕКЛАМЕ → «ПРОЧЕЕ» БЕЗ АГЕНТА → КЛИЕНТ СКАЗАЛ СВОЁ → ЛИД С АГЕНТОМ.
 *
 * Регрессия, найденная на ревью #455. Отсечка «пришёл по рекламе и ничего не
 * написал» (ai/leadKind.ts) НАМЕРЕННО заводит карточку «прочим обращением» без
 * агента: пока человек молчит, назначать некого. Но когда он наконец говорил
 * своё («3 комнаты в Сино»), сюда приходил kind=BUYER, kindChangeUpdate честно
 * менял тип — и на этом всё: pickAgentForLead в ветке повторного обращения
 * звался ТОЛЬКО при реактивации из «Неактивных».
 *
 * Итог был бы: каждый клик по рекламе объекта = покупатель без агента, лид
 * потерян молча. Push подменён — тест про раздачу, а не про доставку.
 */

const sendLeadPush = vi.fn(async () => 1);
vi.mock("../src/lib/pushLeadActions.js", () => ({
  sendLeadPush,
  // Остальные экспорты модуля этому тесту не нужны, но импортируются соседями.
  closeLeadPush: vi.fn(async () => {}),
}));

const sendPushToAgents = vi.fn(async () => 1);
const sendPushToAgent = vi.fn(async () => 1);
vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent,
  sendPushToAgents,
}));

const { prisma } = await import("../src/db.js");
const { createLeadFromChannel } = await import("../src/services/leads/intake.js");
const bcrypt = (await import("bcrypt")).default;
const { deleteAgentsWithTraces } = await import("./helpers/cleanupAgents.js");

const runId = Date.now();
const tail = String(runId).slice(-7);
const clientIds: string[] = [];
const agentIds: string[] = [];

beforeAll(async () => {
  // Раздача по очереди, а не «Вручную»: иначе агент не назначается по замыслу.
  await prisma.settings.upsert({
    where: { id: "singleton" },
    update: { leadDistributionStrategy: "fair" },
    create: { id: "singleton", leadDistributionStrategy: "fair" },
  });
  /**
   * СВОЙ АГЕНТ, А НЕ ПЕРВЫЙ НАЙДЕННЫЙ В БАЗЕ (20.09.2026).
   *
   * Файл проверял раздачу лида, но ни одного агента не заводил: он полагался на
   * то, что в общей базе кто-то уже есть. В базе тестов агентов не сеет никто —
   * они появляются только от соседних файлов, — поэтому исход зависел от того,
   * какие файлы попали в тот же шард и успели ли они убрать за собой. Оба теста
   * файла падали на чистой базе: `pickAgentForLead` не находил никого и оставлял
   * карточку без агента, а `agent!.id` ниже вовсе бросал «Cannot read properties
   * of null». Теперь агент свой, и результат не зависит от соседей.
   */
  const passwordHash = await bcrypt.hash("testpass123", 10);
  const agent = await prisma.agent.create({
    data: { fullName: `Реклама Агент ${runId}`, phone: `+992955${tail}`, role: "AGENT", passwordHash },
  });
  agentIds.push(agent.id);
});

afterEach(() => {
  sendLeadPush.mockClear();
  sendPushToAgents.mockClear();
  sendPushToAgent.mockClear();
});

afterAll(async () => {
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  // По самому агенту, а не по списку его клиентов: раздача могла отдать нашему
  // агенту карточку, которую этот файл не заводил (см. helpers/cleanupAgents.ts).
  await deleteAgentsWithTraces(agentIds);
});

describe("клик по рекламе, а потом свои слова", () => {
  it("OTHER без агента → BUYER С АГЕНТОМ и push «новый лид»", async () => {
    const phone = `+9929${tail}1`;

    // 1) Человек нажал кнопку под рекламой и не написал ни одной своей буквы.
    //    Так его заводит acceptLead после отсечки в ai/leadKind.ts.
    const first = await createLeadFromChannel({
      fullName: "Шоира",
      phone,
      source: "WHATSAPP",
      kind: "OTHER",
      channel: "WHATSAPP",
      requirementsNotes: "❓ ПРИШЁЛ ПО РЕКЛАМЕ И НИЧЕГО НЕ НАПИСАЛ",
    });
    clientIds.push(first.clientId);
    expect(first.created).toBe(true);

    const asOther = await prisma.client.findUnique({ where: { id: first.clientId } });
    expect(asOther?.kind).toBe("OTHER");
    // Это и есть замысел отсечки: пока человек молчит, агента нет.
    expect(asOther?.assignedAgentId).toBeNull();

    // 2) Тот же человек наконец сказал, что ему нужно.
    const second = await createLeadFromChannel({
      fullName: "Шоира",
      phone,
      source: "WHATSAPP",
      kind: "BUYER",
      channel: "WHATSAPP",
      desiredRooms: 3,
      requirementsNotes: "3 комнаты в Сино",
    });
    expect(second.created).toBe(false);
    expect(second.clientId).toBe(first.clientId);

    const asBuyer = await prisma.client.findUnique({ where: { id: first.clientId } });
    expect(asBuyer?.kind).toBe("BUYER");
    // ГЛАВНОЕ: агент назначен, а не «покупатель без агента».
    expect(asBuyer?.assignedAgentId).not.toBeNull();
    // Таймер принятия считается от assignedAt, а принять лид агент ещё должен.
    expect(asBuyer?.assignedAt).not.toBeNull();
    expect(asBuyer?.acceptedAt).toBeNull();

    // Агенту ушёл тот же push, что и по новой заявке.
    expect(sendLeadPush).toHaveBeenCalledTimes(1);
    expect(sendLeadPush.mock.calls[0][0]).toBe(asBuyer?.assignedAgentId);

    // В хронологии — от лица назначенного агента, без «дежурного директора»
    // (либо, П-10 17.09.2026: SYSTEM/CLIENT с тем же держателем в subjectAgentId —
    // «лид создан автоматически» и «клиент снова обратился» теперь честно не
    // подписываются агентом, которого назначил алгоритм, а не он сам).
    const events = await prisma.interaction.findMany({ where: { clientId: first.clientId } });
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) {
      if (e.agentId !== null) {
        expect(e.agentId).toBe(asBuyer?.assignedAgentId);
      } else {
        expect(e.subjectAgentId).toBe(asBuyer?.assignedAgentId);
      }
    }
  });

  it("обращение по вакансии агента по-прежнему НЕ получает", async () => {
    // Обратная сторона той же правки: BUYER→OTHER не должен вернуть карточку в
    // раздачу, иначе кандидат снова окажется у агента.
    const phone = `+9929${tail}2`;
    const client = await prisma.client.create({
      data: {
        fullName: `Кандидат ${runId}`,
        phone,
        source: "WHATSAPP",
        kind: "BUYER",
        currency: "TJS",
        assignedAgentId: agentIds[0],
      },
    });
    clientIds.push(client.id);

    await createLeadFromChannel({
      fullName: `Кандидат ${runId}`,
      phone,
      source: "WHATSAPP",
      kind: "OTHER",
      channel: "WHATSAPP",
      requirementsNotes: "💼 СОИСКАТЕЛЬ РАБОТЫ",
    });

    const after = await prisma.client.findUnique({ where: { id: client.id } });
    expect(after?.kind).toBe("OTHER");
    expect(after?.assignedAgentId).toBeNull();
    expect(sendLeadPush).not.toHaveBeenCalled();
  });
});
