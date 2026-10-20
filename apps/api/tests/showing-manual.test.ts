import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Три дыры выкаченного кода, закрытые вместе:
 *
 *  1. На одно «не смогу» агент получал ДВА push — от разбора ответа на просьбу
 *     подтвердить и от хода бота с action=cancel. Проверяем, что уведомление одно
 *     и что правило «молчание не отказ» при этом цело.
 *  2. Отменённый показ считался в отчётах и на доске почёта. Проверяем предикат
 *     COUNTED_SHOWING_WHERE — и главное, что ИСТОРИЧЕСКИЕ показы он не выкидывает.
 *  3. Отменить или перенести показ из CRM было нельзя вообще. Проверяем, что это
 *     делает та же функция, что и бот, а не вторая копия логики.
 */

const sendPushToAgent = vi.fn(async () => 1);
vi.mock("../src/push.js", async (importOriginal) => ({
  // Подмена ДОПОЛНЯЕТ модуль, а не заменяет его целиком (19.09.2026):
  // фабрика без importOriginal убирает остальные экспорты у всего
  // процесса, и СОСЕДНИЙ тест падает на «No "…" export is defined».
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent, sendPushToAgents: sendPushToAgent,
}));

const { prisma } = await import("../src/db.js");
const { cancelShowing, cancelShowingById, rescheduleShowingById } = await import("../src/lib/showingBooking.js");
const { applyShowingReply } = await import("../src/lib/showingConfirmation.js");
const { COUNTED_SHOWING_WHERE } = await import("../src/lib/tasks.js");

const runId = Date.now();
let districtId: string;
let agentId: string;
/** Руководитель — отменяет чужой показ: агент записи об этом узнать обязан. */
let chiefId: string;
let clientId: string;
let propertyId: string;

const NOW = new Date("2026-07-31T09:00:00.000Z");
const IN_3H = new Date(NOW.getTime() + 3 * 60 * 60 * 1000);

async function makeShowing(extra: Record<string, unknown> = {}) {
  return prisma.interaction.create({
    data: {
      clientId,
      agentId,
      type: "SHOWING",
      propertyId,
      notes: `Показ ${runId}`,
      nextAction: "Показ объекта",
      nextActionDate: IN_3H,
      ...extra,
    },
  });
}

/** Сколько показов этого клиента засчитывается в отчёты и на доску почёта. */
const countedShowings = () =>
  prisma.interaction.count({ where: { clientId, type: "SHOWING", ...COUNTED_SHOWING_WHERE } });

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Тест-район-ручной-показ-${runId}` } })).id;
  agentId = (
    await prisma.agent.create({
      data: { fullName: "Агент показов", phone: `+992961${runId}`, role: "AGENT", passwordHash: "x" },
    })
  ).id;
  chiefId = (
    await prisma.agent.create({
      data: { fullName: "Руководитель показов", phone: `+992962${runId}`, role: "DIRECTOR", passwordHash: "x" },
    })
  ).id;
  clientId = (
    await prisma.client.create({
      data: {
        fullName: `Клиент ручных показов ${runId}`,
        phone: `+992963${runId}`,
        source: "WHATSAPP",
        assignedAgentId: agentId,
        acceptedAt: new Date(),
      },
    })
  ).id;
  propertyId = (
    await prisma.property.create({
      data: {
        title: `Объект ручных показов ${runId}`,
        type: "APARTMENT",
        areaSqm: 55,
        price: 300000,
        currency: "TJS",
        districtId,
        address: `Тестовая, ${runId}`,
        condition: "GOOD",
      },
    })
  ).id;
});

beforeEach(async () => {
  sendPushToAgent.mockClear();
  await prisma.interaction.deleteMany({ where: { clientId } });
});

afterAll(async () => {
  // База общая с другими прогонами — убираем за собой всё и всегда, даже если
  // beforeAll успел создать не всё (иначе следующий прогон спотыкается о FK).
  await prisma.interaction.deleteMany({ where: { clientId } });
  await prisma.client.deleteMany({ where: { id: clientId } });
  await prisma.propertyPhoto.deleteMany({ where: { propertyId } });
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.agent.deleteMany({ where: { id: { in: [agentId, chiefId].filter(Boolean) } } });
  if (districtId) await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.$disconnect();
});

describe("Один отказ клиента — одно уведомление агенту", () => {
  it("«не смогу» и следом отмена ботом дают ровно один push", async () => {
    const showing = await makeShowing({
      confirmAskedAt: new Date(NOW.getTime() - 60 * 60 * 1000),
      remindersSent: ["confirm-ask"],
    });

    // Путь первый: разбор ответа на просьбу подтвердить.
    await applyShowingReply(clientId, "Не смогу прийти", NOW);
    expect(sendPushToAgent).toHaveBeenCalledTimes(1);
    const [, first] = sendPushToAgent.mock.calls[0] as unknown as [string, Record<string, string>];
    expect(first.title).toContain("не сможет");

    // Путь второй: ход бота с action=cancel по тому же сообщению. Работу свою
    // делает (встреча уходит из календаря), но второй раз агента не дёргает.
    const cancelled = await cancelShowing({ clientId, channel: "WHATSAPP", now: NOW });
    expect(cancelled.ok).toBe(true);
    expect(sendPushToAgent).toHaveBeenCalledTimes(1);

    const row = await prisma.interaction.findUnique({ where: { id: showing.id } });
    expect(row?.nextAction).toBeNull();
    expect(row?.declinedAt).not.toBeNull();
    expect(row?.completedAt).toBeNull();
  });

  it("если бот отменил первым, разбор ответа второго уведомления не шлёт", async () => {
    await makeShowing({
      confirmAskedAt: new Date(NOW.getTime() - 60 * 60 * 1000),
      remindersSent: ["confirm-ask"],
    });

    await cancelShowing({ clientId, now: NOW });
    expect(sendPushToAgent).toHaveBeenCalledTimes(1);

    await applyShowingReply(clientId, "Не смогу прийти", NOW);
    expect(sendPushToAgent).toHaveBeenCalledTimes(1);
  });

  it("МОЛЧАНИЕ по-прежнему ничего не отменяет", async () => {
    const showing = await makeShowing({
      confirmAskedAt: new Date(NOW.getTime() - 60 * 60 * 1000),
      remindersSent: ["confirm-ask"],
    });
    // Пустое сообщение (фото/голосовое) и посторонний текст отменой не являются.
    await applyShowingReply(clientId, "   ", NOW);
    await applyShowingReply(clientId, "А во сколько именно?", NOW);

    const row = await prisma.interaction.findUnique({ where: { id: showing.id } });
    expect(row?.nextAction).toBe("Показ объекта");
    expect(row?.declinedAt).toBeNull();
  });
});

describe("Отменённый показ не попадает в цифры", () => {
  it("исторические показы считаются, отменённый — нет", async () => {
    // Показ прошлого месяца: до появления отмены их никто не помечал, и цифры
    // за прошлые месяцы обязаны остаться прежними.
    await makeShowing({ nextActionDate: new Date("2026-06-15T13:00:00.000Z"), completedAt: new Date() });
    // Клиент сказал «не смогу», но встречу никто не снимал — показ ещё может
    // состояться, значит считается. Ставим его позже живого: отменяется ближайший.
    await makeShowing({ nextActionDate: new Date(IN_3H.getTime() + 60 * 60 * 1000), declinedAt: NOW, confirmAskedAt: NOW });
    const live = await makeShowing();
    expect(await countedShowings()).toBe(3);

    await cancelShowing({ clientId, now: NOW });
    // Ушёл ровно один — тот, который сняли с календаря.
    expect(await countedShowings()).toBe(2);
    expect((await prisma.interaction.findUnique({ where: { id: live.id } }))?.nextAction).toBeNull();
  });
});

describe("Отмена и перенос показа руками из CRM", () => {
  it("отменяет тем же путём, что бот: задача снята, история цела, агент уведомлён", async () => {
    const showing = await makeShowing();
    sendPushToAgent.mockClear();

    const result = await cancelShowingById({
      interactionId: showing.id,
      actor: { kind: "agent", agentId: chiefId, agentName: "Руководитель показов" },
      reason: "Клиент заболел",
      now: NOW,
    });
    expect(result.ok).toBe(true);

    const row = await prisma.interaction.findUnique({ where: { id: showing.id } });
    expect(row?.nextAction).toBeNull();
    expect(row?.declinedAt).not.toBeNull();
    // Время встречи и сама запись остаются: агент должен видеть, что показ БЫЛ
    // назначен и снят, а не что его никогда не было.
    expect(row?.nextActionDate?.getTime()).toBe(IN_3H.getTime());
    expect(row?.notes).toContain("Отменён в CRM (Руководитель показов)");
    // Причина отмены обязана попасть в хронологию, а не потеряться (владелец 16.08.2026).
    expect(row?.notes).toContain("Причина: Клиент заболел");
    // И не «выполнен»: иначе KPI засчитал бы агенту встречу, которой не было.
    expect(row?.completedAt).toBeNull();
    expect(await countedShowings()).toBe(0);

    // Показ снял не тот, кто его ведёт, — агент обязан узнать до выезда, и причину
    // должен увидеть тут же, а не заходить в карточку отдельно.
    const [to, payload] = sendPushToAgent.mock.calls[0] as unknown as [string, Record<string, string>];
    expect(to).toBe(agentId);
    expect(payload.title).toContain("отменён");
    expect(payload.body).toContain("Клиент заболел");

    // Клиент не должен «зависнуть»: отмена руками заводит задачу-напоминание
    // связаться и согласовать новую дату.
    const followUp = await prisma.interaction.findFirst({
      where: { clientId, type: "SYSTEM", nextAction: "Согласовать новую дату показа" },
    });
    expect(followUp).toBeTruthy();
    expect(followUp?.actorKind).toBe("AGENT");
    expect(followUp?.agentId).toBe(chiefId);
    expect(followUp?.subjectAgentId ?? followUp?.agentId).toBe(agentId);
    expect(followUp?.notes).toContain("Клиент заболел");
  });

  it("агент отменил свой показ — push самому себе не уходит, но задача-напоминание всё равно заводится", async () => {
    const showing = await makeShowing();
    sendPushToAgent.mockClear();

    await cancelShowingById({
      interactionId: showing.id,
      actor: { kind: "agent", agentId, agentName: "Агент показов" },
      reason: "Клиент попросил перенести на другую неделю",
      now: NOW,
    });
    expect(sendPushToAgent).not.toHaveBeenCalled();

    const followUp = await prisma.interaction.findFirst({
      where: { clientId, type: "SYSTEM", nextAction: "Согласовать новую дату показа" },
    });
    expect(followUp).toBeTruthy();
  });

  it("отменить дважды нельзя — второй раз история не переписывается", async () => {
    const showing = await makeShowing();
    await cancelShowingById({
      interactionId: showing.id,
      actor: { kind: "agent", agentId, agentName: "А" },
      reason: "Клиент не отвечает",
      now: NOW,
    });
    const again = await cancelShowingById({
      interactionId: showing.id,
      actor: { kind: "agent", agentId, agentName: "А" },
      reason: "Клиент не отвечает",
      now: NOW,
    });
    expect(!again.ok && again.reason).toBe("already_cancelled");
  });

  it("переносит на новое время и сбрасывает подтверждение — оно было про старое", async () => {
    const showing = await makeShowing({
      confirmAskedAt: NOW,
      confirmedAt: NOW,
      remindersSent: ["confirm-ask", "2h"],
      reminderSentAt: NOW,
    });
    const at = new Date(NOW.getTime() + 26 * 60 * 60 * 1000);

    const result = await rescheduleShowingById({
      interactionId: showing.id,
      at,
      actor: { kind: "agent", agentId: chiefId, agentName: "Руководитель показов" },
      reason: "Агент занят на другом показе",
      now: NOW,
    });
    expect(result.ok).toBe(true);

    const row = await prisma.interaction.findUnique({ where: { id: showing.id } });
    expect(row?.nextActionDate?.getTime()).toBe(at.getTime());
    expect(row?.nextAction).toBe("Показ объекта");
    expect(row?.confirmAskedAt).toBeNull();
    expect(row?.confirmedAt).toBeNull();
    expect(row?.remindersSent).toEqual([]);
    expect(row?.notes).toContain("Перенесён в CRM (Руководитель показов)");
    expect(row?.notes).toContain("Причина: Агент занят на другом показе");
    // Перенесённый показ остаётся в цифрах: встреча жива, просто в другой час.
    expect(await countedShowings()).toBe(1);
  });

  it("перенести в прошлое нельзя — такая встреча просрочена в момент создания", async () => {
    const showing = await makeShowing();
    const result = await rescheduleShowingById({
      interactionId: showing.id,
      at: new Date(NOW.getTime() - 60 * 60 * 1000),
      actor: { kind: "agent", agentId, agentName: "А" },
      reason: "Причина",
      now: NOW,
    });
    expect(!result.ok && result.reason).toBe("past");
  });

  it("не показ и несуществующая запись отвергаются, а не портят соседние данные", async () => {
    const call = await prisma.interaction.create({
      data: { clientId, agentId, type: "CALL", notes: "Звонок", nextAction: "Перезвонить", nextActionDate: IN_3H },
    });
    const notShowing = await cancelShowingById({
      interactionId: call.id,
      actor: { kind: "agent", agentId, agentName: "А" },
      reason: "Причина",
      now: NOW,
    });
    expect(!notShowing.ok && notShowing.reason).toBe("not_showing");

    const missing = await cancelShowingById({
      interactionId: "00000000-0000-0000-0000-000000000000",
      actor: { kind: "agent", agentId, agentName: "А" },
      reason: "Причина",
      now: NOW,
    });
    expect(!missing.ok && missing.reason).toBe("not_found");
  });
});

/* Раздел «Обход "Итог показа" поздней отменой/переносом» удалён 13.09.2026:
   он проверял, что поздняя отмена не даёт агенту уйти от обязательного окна.
   Окон больше нет — уходить не от чего. Сама поздняя отмена и перенос
   проверяются разделами выше. */
