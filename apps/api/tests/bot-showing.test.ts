import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Бот сам назначает показ (решение владельца 31.07.2026): цель разговора — не номер
 * телефона, а назначенная встреча на объекте. Проверяем ровно то, из-за чего это
 * может тихо не работать в проде: время считается в часах Душанбе, ночью показ не
 * назначается, агент узнаёт сразу, а на недоступный объект показ не создаётся.
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
const { bookShowing, cancelShowing, resolveShowingSlot, showingTimeLabel } = await import(
  "../src/lib/showingBooking.js"
);
const { showingPromptBlock } = await import("../src/ai/leadQualifier.js");

const runId = Date.now();
let districtId: string;
let agentId: string;
let propertyAgentId: string;
let directorId: string;
let clientId: string;
/** Клиент без своего агента — показ должен достаться агенту объекта. */
let orphanClientId: string;
/** Отдельный клиент под перенос/отмену: те тесты считают показы поштучно, и чужие
 *  записи из соседних сценариев ломали бы счёт. */
let moveClientId: string;
let propertyId: string;
let propertyShortId: number;
/** Второй доступный объект — для «давайте лучше посмотрим ту, вторую». */
let secondPropertyId: string;
let secondPropertyShortId: number;
let soldPropertyShortId: number;
let deletedPropertyShortId: number;
let propertyIds: string[] = [];

/** 31.07.2026, 14:00 по Душанбе (09:00 UTC) — от этого момента считаются «сегодня»/«завтра». */
const NOW = new Date("2026-07-31T09:00:00.000Z");

async function makeProperty(title: string, extra: Record<string, unknown> = {}) {
  const p = await prisma.property.create({
    data: {
      title,
      type: "APARTMENT",
      areaSqm: 60,
      price: 350000,
      currency: "TJS",
      districtId,
      address: `Тестовая, ${runId}`,
      condition: "GOOD",
      ...extra,
    },
  });
  propertyIds.push(p.id);
  return p;
}

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Тест-район-бот-показ-${runId}` } })).id;
  agentId = (
    await prisma.agent.create({
      data: { fullName: "Агент бота", phone: `+992951${runId}`, role: "AGENT", passwordHash: "x" },
    })
  ).id;
  propertyAgentId = (
    await prisma.agent.create({
      data: { fullName: "Агент объекта", phone: `+992952${runId}`, role: "AGENT", passwordHash: "x" },
    })
  ).id;
  directorId = (
    await prisma.agent.create({
      data: { fullName: "Директор бота", phone: `+992953${runId}`, role: "DIRECTOR", passwordHash: "x" },
    })
  ).id;
  clientId = (
    await prisma.client.create({
      data: {
        fullName: `Клиент бота ${runId}`,
        phone: `+992954${runId}`,
        source: "WHATSAPP",
        assignedAgentId: agentId,
        acceptedAt: new Date(),
      },
    })
  ).id;
  orphanClientId = (
    await prisma.client.create({
      data: { fullName: `Клиент без агента ${runId}`, phone: `+992955${runId}`, source: "WHATSAPP" },
    })
  ).id;
  moveClientId = (
    await prisma.client.create({
      data: {
        fullName: `Клиент переноса ${runId}`,
        phone: `+992956${runId}`,
        source: "WHATSAPP",
        assignedAgentId: agentId,
        acceptedAt: new Date(),
      },
    })
  ).id;

  const property = await makeProperty(`Объект бота ${runId}`, { assignedAgentId: propertyAgentId });
  propertyId = property.id;
  propertyShortId = property.shortId;
  const second = await makeProperty(`Второй объект бота ${runId}`, { assignedAgentId: propertyAgentId });
  secondPropertyId = second.id;
  secondPropertyShortId = second.shortId;
  soldPropertyShortId = (await makeProperty(`Проданный ${runId}`, { status: "SOLD" })).shortId;
  deletedPropertyShortId = (await makeProperty(`Удалённый ${runId}`, { deletedAt: new Date() })).shortId;
});

beforeEach(() => sendPushToAgent.mockClear());

afterAll(async () => {
  // База общая, поэтому убираем за собой всегда — даже если beforeAll успел создать
  // не всё (иначе следующий прогон спотыкается о чужой мусор и FK).
  const clientIds = [clientId, orphanClientId, moveClientId].filter(Boolean);
  const agentIds = [agentId, propertyAgentId, directorId].filter(Boolean);
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: agentIds } } });
  if (districtId) await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.$disconnect();
});

describe("Разбор расплывчатого времени", () => {
  it("«завтра вечером» — это 18:00 следующего дня по Душанбе", () => {
    const slot = resolveShowingSlot({ day: "tomorrow", time: "evening" }, NOW);
    expect(slot.ok).toBe(true);
    // 18:00 Душанбе = 13:00 UTC; заодно проверяем переход через конец месяца.
    if (slot.ok) expect(slot.at.toISOString()).toBe("2026-08-01T13:00:00.000Z");
  });

  it("«пагоҳ соати шаш» приходит как tomorrow + 18:00 и даёт тот же момент", () => {
    const slot = resolveShowingSlot({ day: "пагоҳ", time: "18:00" }, NOW);
    expect(slot.ok && slot.at.toISOString()).toBe("2026-08-01T13:00:00.000Z");
  });

  it("точная дата понимается как календарный день Душанбе", () => {
    const slot = resolveShowingSlot({ day: "2026-08-05", time: "10:00" }, NOW);
    expect(slot.ok && slot.at.toISOString()).toBe("2026-08-05T05:00:00.000Z");
  });

  it("границы часов показов включительны: 09:00 и 20:00 годятся", () => {
    expect(resolveShowingSlot({ day: "tomorrow", time: "09:00" }, NOW).ok).toBe(true);
    expect(resolveShowingSlot({ day: "tomorrow", time: "20:00" }, NOW).ok).toBe(true);
  });

  it("ночь и раннее утро отвергаются", () => {
    for (const time of ["23:00", "02:00", "07:30", "20:30"]) {
      const slot = resolveShowingSlot({ day: "tomorrow", time }, NOW);
      expect(slot.ok).toBe(false);
      if (!slot.ok) expect(slot.reason).toBe("outside_hours");
    }
  });

  it("время, которое уже прошло сегодня, не назначается", () => {
    const slot = resolveShowingSlot({ day: "today", time: "10:00" }, NOW);
    expect(!slot.ok && slot.reason).toBe("past");
  });

  it("непонятое время не превращается в случайный час", () => {
    expect(resolveShowingSlot({ day: "tomorrow", time: "как получится" }, NOW).ok).toBe(false);
    expect(resolveShowingSlot({ day: "", time: "18:00" }, NOW).ok).toBe(false);
  });

  it("подпись времени для агента — в часах Душанбе, а не UTC", () => {
    expect(showingTimeLabel(new Date("2026-08-01T13:00:00.000Z"))).toBe("01.08 в 18:00");
  });
});

describe("Промт про показ", () => {
  it("сообщает модели дату и время Душанбе, а не UTC", () => {
    // 20:00 UTC 31 июля — в Душанбе уже 1 августа, 01:00.
    expect(showingPromptBlock(new Date("2026-07-31T20:00:00.000Z"))).toContain("01.08.2026, 01:00");
  });

  it("различает назначить, перенести и отменить — иначе модель заведёт вторую встречу", () => {
    const block = showingPromptBlock(NOW);
    expect(block).toContain("action=book");
    expect(block).toContain("action=reschedule");
    expect(block).toContain("action=cancel");
  });

  /**
   * Тот же блок приклеивается и к разговору ПОСЛЕ приёма заявки, где стоит прямой
   * запрет «НЕ проси телефон снова». Безусловное «договорился о встрече — тут же
   * попроси номер», да ещё с готовой таджикской фразой и ниже по тексту, этот запрет
   * перебивало: человек, чей номер уже у нас, получал просьбу дать его снова.
   */
  it("до заявки просит номер, после заявки — запрещает просить его снова", () => {
    expect(showingPromptBlock(NOW, false)).toContain("тут же попроси номер");
    const afterLead = showingPromptBlock(NOW, true);
    expect(afterLead).not.toContain("тут же попроси номер");
    expect(afterLead).toContain("просить его ещё раз ЗАПРЕЩЕНО");
  });
});

describe("Бот назначает показ", () => {
  it("создаёт показ на выбранное клиентом время и уведомляет агента сразу", async () => {
    const result = await bookShowing({
      clientId,
      request: { propertyCode: propertyShortId, day: "tomorrow", time: "evening" },
      channel: "WHATSAPP",
      now: NOW,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const interaction = await prisma.interaction.findUnique({ where: { id: result.interactionId } });
    expect(interaction?.type).toBe("SHOWING");
    expect(interaction?.propertyId).toBe(propertyId);
    // П-10 (задание Б2): бот — не агент, agentId null, держатель в subjectAgentId.
    expect(interaction?.actorKind).toBe("BOT");
    expect(interaction?.agentId).toBeNull();
    expect(interaction?.subjectAgentId).toBe(agentId);
    // Без текста задачи показ был бы «задачей-невидимкой»: ни календаря, ни напоминаний.
    expect(interaction?.nextAction).toBe("Показ объекта");
    expect(interaction?.nextActionDate?.toISOString()).toBe("2026-08-01T13:00:00.000Z");

    const [to, payload] = sendPushToAgent.mock.calls[0] as unknown as [string, Record<string, string>];
    expect(to).toBe(agentId);
    expect(payload.title).toContain("Бот назначил показ");
    expect(payload.body).toContain("01.08 в 18:00");

    const property = await prisma.property.findUnique({ where: { id: propertyId } });
    expect(property?.viewsCount).toBe(1);
  });

  it("повторная доставка того же хода не плодит второй показ", async () => {
    const before = await prisma.interaction.count({ where: { clientId, type: "SHOWING" } });
    const again = await bookShowing({
      clientId,
      request: { propertyCode: propertyShortId, day: "tomorrow", time: "18:00" },
      channel: "WHATSAPP",
      now: NOW,
    });
    expect(again.ok).toBe(true);
    expect(await prisma.interaction.count({ where: { clientId, type: "SHOWING" } })).toBe(before);
  });

  it("ночью показ не назначается — вместо записи человек получает уведомление", async () => {
    const before = await prisma.interaction.count({ where: { clientId, type: "SHOWING" } });
    const result = await bookShowing({
      clientId,
      request: { propertyCode: propertyShortId, day: "tomorrow", time: "23:30" },
      now: NOW,
    });
    expect(!result.ok && result.reason).toBe("outside_hours");
    expect(await prisma.interaction.count({ where: { clientId, type: "SHOWING" } })).toBe(before);

    const [to, payload] = sendPushToAgent.mock.calls[0] as unknown as [string, Record<string, string>];
    expect(to).toBe(agentId);
    expect(payload.title).toContain("Показ требует согласования");
  });

  it("на проданный объект показ не создаётся", async () => {
    const before = await prisma.interaction.count({ where: { clientId, type: "SHOWING" } });
    const result = await bookShowing({
      clientId,
      request: { propertyCode: soldPropertyShortId, day: "tomorrow", time: "12:00" },
      now: NOW,
    });
    expect(!result.ok && result.reason).toBe("unavailable");
    expect(await prisma.interaction.count({ where: { clientId, type: "SHOWING" } })).toBe(before);
  });

  it("на объект из корзины показ не создаётся", async () => {
    const result = await bookShowing({
      clientId,
      request: { propertyCode: deletedPropertyShortId, day: "tomorrow", time: "12:00" },
      now: NOW,
    });
    expect(!result.ok && result.reason).toBe("unavailable");
  });

  it("объекта нет в базе — показ не создаётся", async () => {
    const result = await bookShowing({
      clientId,
      request: { propertyCode: 999_999_999, day: "tomorrow", time: "12:00" },
      now: NOW,
    });
    expect(!result.ok && result.reason).toBe("no_property");
  });

  it("у клиента ещё нет агента — показ ведёт агент объекта", async () => {
    const result = await bookShowing({
      clientId: orphanClientId,
      request: { propertyCode: propertyShortId, day: "tomorrow", time: "16:00" },
      now: NOW,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.agentId).toBe(propertyAgentId);
    const [to] = sendPushToAgent.mock.calls[0] as unknown as [string, Record<string, string>];
    expect(to).toBe(propertyAgentId);
  });
});

/* ─────────────────────── Перенос и отмена показа ────────────────────────────
 *
 * Свежий баг выкаченного кода: на «давайте не завтра, а в субботу» модель
 * заполняла showing заново, и в календаре агента оказывалось ДВЕ встречи — он
 * ехал на первую, которой уже нет, а клиент ждал во вторую. Ниже проверяется
 * ровно то, из-за чего это может тихо не работать снова.
 * ──────────────────────────────────────────────────────────────────────────── */

/** Показ на завтра 18:00 для клиента переносов — исходная точка почти каждого теста. */
async function bookInitialShowing(time = "18:00") {
  const result = await bookShowing({
    clientId: moveClientId,
    request: { action: "book", propertyCode: propertyShortId, day: "tomorrow", time },
    channel: "WHATSAPP",
    now: NOW,
  });
  if (!result.ok) throw new Error(`не удалось назначить исходный показ: ${result.reason}`);
  return result;
}

const showingsOfMoveClient = () => prisma.interaction.count({ where: { clientId: moveClientId, type: "SHOWING" } });

describe("Клиент переносит показ", () => {
  beforeEach(async () => {
    await prisma.interaction.deleteMany({ where: { clientId: moveClientId } });
    sendPushToAgent.mockClear();
  });

  it("меняет время у назначенной встречи и не заводит вторую", async () => {
    const first = await bookInitialShowing();
    sendPushToAgent.mockClear();

    const moved = await bookShowing({
      clientId: moveClientId,
      request: { action: "reschedule", propertyCode: propertyShortId, day: "2026-08-02", time: "12:00" },
      channel: "WHATSAPP",
      now: NOW,
    });
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    expect(moved.rescheduled).toBe(true);
    // Та же запись: на её id завязаны напоминания и хронология клиента.
    expect(moved.interactionId).toBe(first.interactionId);
    expect(await showingsOfMoveClient()).toBe(1);

    const row = await prisma.interaction.findUnique({ where: { id: first.interactionId } });
    expect(row?.nextActionDate?.toISOString()).toBe("2026-08-02T07:00:00.000Z");
    // История переезда видна агенту прямо в карточке.
    expect(row?.notes).toContain("Перенесён ботом");
    expect(row?.notes).toContain("01.08 в 18:00");

    // Агент мог уже спланировать день — узнаёт сразу, с обоими временами.
    const [to, payload] = sendPushToAgent.mock.calls[0] as unknown as [string, Record<string, string>];
    expect(to).toBe(agentId);
    expect(payload.title).toContain("перенёс показ");
    expect(payload.body).toContain("01.08 в 18:00");
    expect(payload.body).toContain("02.08 в 12:00");
  });

  it("модель назвала перенос новым показом — второй встречи всё равно нет", async () => {
    const first = await bookInitialShowing();
    // Ровно тот случай, ради которого решение принимается по базе, а не по слову
    // модели: action=book на объект, показ которого уже назначен.
    const again = await bookShowing({
      clientId: moveClientId,
      request: { action: "book", propertyCode: propertyShortId, day: "tomorrow", time: "20:00" },
      now: NOW,
    });
    expect(again.ok && again.rescheduled).toBe(true);
    expect(again.ok && again.interactionId).toBe(first.interactionId);
    expect(await showingsOfMoveClient()).toBe(1);
  });

  it("сбрасывает подтверждение и ступени напоминаний: они относились к старому времени", async () => {
    const first = await bookInitialShowing();
    await prisma.interaction.update({
      where: { id: first.interactionId },
      data: {
        confirmAskedAt: NOW,
        confirmedAt: NOW,
        declinedAt: NOW,
        remindersSent: ["2h", "confirm-ask"],
        reminderSentAt: NOW,
        noShowNotifiedAt: NOW,
      },
    });

    await bookShowing({
      clientId: moveClientId,
      request: { action: "reschedule", propertyCode: propertyShortId, day: "after_tomorrow", time: "11:00" },
      now: NOW,
    });

    const row = await prisma.interaction.findUnique({ where: { id: first.interactionId } });
    // Иначе просьбу подтвердить новое время клиенту никто не отправит (выборка в
    // meetingReminders берёт только confirmAskedAt=null), а агент увидит галочку
    // «подтвердил» на встрече, которую человек не подтверждал.
    expect(row?.confirmAskedAt).toBeNull();
    expect(row?.confirmedAt).toBeNull();
    expect(row?.declinedAt).toBeNull();
    expect(row?.remindersSent).toEqual([]);
    expect(row?.reminderSentAt).toBeNull();
    expect(row?.noShowNotifiedAt).toBeNull();
  });

  it("повторная доставка того же хода не считается переносом", async () => {
    const first = await bookInitialShowing();
    sendPushToAgent.mockClear();
    const again = await bookShowing({
      clientId: moveClientId,
      request: { action: "reschedule", propertyCode: propertyShortId, day: "tomorrow", time: "evening" },
      now: NOW,
    });
    expect(again.ok && again.rescheduled).toBe(false);
    expect(again.ok && again.interactionId).toBe(first.interactionId);
    expect(await showingsOfMoveClient()).toBe(1);
    // Время не менялось — дёргать агента нечем.
    expect(sendPushToAgent).not.toHaveBeenCalled();
  });

  it("прошедший показ переносом не считается — это новая встреча", async () => {
    // Показ, время которого уже миновало, заводим руками: bookShowing прошедшее
    // время не принимает намеренно.
    const past = await prisma.interaction.create({
      data: {
        clientId: moveClientId,
        agentId,
        type: "SHOWING",
        propertyId,
        notes: "Показ назначен ботом",
        nextAction: "Показ объекта",
        nextActionDate: new Date(NOW.getTime() - 2 * 60 * 60 * 1000),
      },
    });

    const result = await bookShowing({
      clientId: moveClientId,
      request: { action: "book", propertyCode: propertyShortId, day: "tomorrow", time: "16:00" },
      now: NOW,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rescheduled).toBe(false);
    expect(result.interactionId).not.toBe(past.id);
    expect(await showingsOfMoveClient()).toBe(2);

    // Старая встреча осталась как есть: она уже состоялась или сорвалась, и это
    // отдельная строчка истории, а не то, что клиент двигает.
    const stale = await prisma.interaction.findUnique({ where: { id: past.id } });
    expect(stale?.nextActionDate?.getTime()).toBe(NOW.getTime() - 2 * 60 * 60 * 1000);
  });

  /**
   * Регрессия на баг, найденный аудитом 02.09.2026 (docs/audit-02-09-2026/02-popups.md,
   * сценарий S9): «Итог показа» уже успел всплыть по СТАРОМУ времени показа
   * (крон сработал раньше, чем клиент попросил перенос) — без фикса окно так и
   * осталось бы с dueAt в прошлом, и агент отвечал бы про встречу, которая по
   * факту ещё не наступила.
   */
  it("уже всплывшее «Итог показа» сдвигается на новое время, а не остаётся отвеченным", async () => {
    const first = await bookInitialShowing();
    const summary = await prisma.pendingSummary.create({
      data: {
        agentId,
        kind: "meeting",
        subjectId: first.interactionId,
        subjectName: "Клиент переноса",
        dueAt: new Date(NOW.getTime() - 60_000),
      },
    });

    await bookShowing({
      clientId: moveClientId,
      request: { action: "reschedule", propertyCode: propertyShortId, day: "2026-08-02", time: "12:00" },
      channel: "WHATSAPP",
      now: NOW,
    });

    const after = await prisma.pendingSummary.findUnique({ where: { id: summary.id } });
    expect(after?.doneAt).toBeNull();
    expect(after?.dismissedAt).toBeNull();
    // Новое время встречи — 2026-08-02T07:00:00Z (проверено в тесте выше) + 90 мин по умолчанию.
    expect(after?.dueAt.toISOString()).toBe("2026-08-02T08:30:00.000Z");
  });
});

describe("Клиент передумал и выбрал другой объект", () => {
  beforeEach(async () => {
    await prisma.interaction.deleteMany({ where: { clientId: moveClientId } });
    await prisma.property.updateMany({ where: { id: { in: [propertyId, secondPropertyId] } }, data: { viewsCount: 0 } });
    sendPushToAgent.mockClear();
  });

  it("«давайте лучше ту, вторую» переносит встречу на другой объект, а не заводит вторую", async () => {
    const first = await bookInitialShowing();
    sendPushToAgent.mockClear();

    const moved = await bookShowing({
      clientId: moveClientId,
      request: { action: "reschedule", propertyCode: secondPropertyShortId, day: "2026-08-02", time: "12:00" },
      channel: "WHATSAPP",
      now: NOW,
    });
    expect(moved.ok && moved.rescheduled).toBe(true);
    // Главное: запись ТА ЖЕ. Иначе старая встреча осталась бы в календаре агента,
    // и он поехал бы смотреть объект, от которого клиент как раз отказался.
    expect(moved.ok && moved.interactionId).toBe(first.interactionId);
    expect(await showingsOfMoveClient()).toBe(1);

    const row = await prisma.interaction.findUnique({ where: { id: first.interactionId } });
    expect(row?.propertyId).toBe(secondPropertyId);
    expect(row?.nextActionDate?.toISOString()).toBe("2026-08-02T07:00:00.000Z");
    expect(row?.notes).toContain("на другой объект");

    // Просмотр переезжает вместе со встречей: смотреть поедут другой объект.
    expect((await prisma.property.findUnique({ where: { id: propertyId } }))?.viewsCount).toBe(0);
    expect((await prisma.property.findUnique({ where: { id: secondPropertyId } }))?.viewsCount).toBe(1);

    const [to, payload] = sendPushToAgent.mock.calls[0] as unknown as [string, Record<string, string>];
    expect(to).toBe(agentId);
    // В уведомлении оба объекта: если модель промахнулась кодом, агент увидит это сразу.
    expect(payload.body).toContain(`Объект бота ${runId}`);
    expect(payload.body).toContain(`Второй объект бота ${runId}`);
  });

  it("другой объект в то же самое время — перенос, что бы ни сказала модель", async () => {
    // Человек не бывает в двух местах разом: action=book тут ничего не меняет.
    const first = await bookInitialShowing("18:00");
    const again = await bookShowing({
      clientId: moveClientId,
      request: { action: "book", propertyCode: secondPropertyShortId, day: "tomorrow", time: "18:00" },
      now: NOW,
    });
    expect(again.ok && again.rescheduled).toBe(true);
    expect(again.ok && again.interactionId).toBe(first.interactionId);
    expect(await showingsOfMoveClient()).toBe(1);
  });

  it("«хочу посмотреть обе» — вторая встреча заводится и первая остаётся", async () => {
    const first = await bookInitialShowing("18:00");
    const second = await bookShowing({
      clientId: moveClientId,
      request: { action: "book", propertyCode: secondPropertyShortId, day: "after_tomorrow", time: "15:00" },
      now: NOW,
    });
    expect(second.ok && second.rescheduled).toBe(false);
    expect(second.ok && second.interactionId).not.toBe(first.interactionId);
    expect(await showingsOfMoveClient()).toBe(2);

    // Первая встреча цела: клиент от неё не отказывался.
    const stale = await prisma.interaction.findUnique({ where: { id: first.interactionId } });
    expect(stale?.nextAction).toBe("Показ объекта");
    expect(stale?.propertyId).toBe(propertyId);
  });
});

describe("Клиент отменяет показ", () => {
  beforeEach(async () => {
    await prisma.interaction.deleteMany({ where: { clientId: moveClientId } });
    sendPushToAgent.mockClear();
  });

  it("снимает встречу с календаря, но НЕ стирает историю", async () => {
    const booked = await bookInitialShowing();
    sendPushToAgent.mockClear();

    const cancelled = await cancelShowing({
      clientId: moveClientId,
      propertyCode: propertyShortId,
      channel: "WHATSAPP",
      now: NOW,
    });
    expect(cancelled.ok).toBe(true);

    const row = await prisma.interaction.findUnique({ where: { id: booked.interactionId } });
    // Запись жива, и время встречи в ней тоже: агенту нужно видеть, что показ БЫЛ
    // назначен и отменён, а не что его никогда не было.
    expect(row).not.toBeNull();
    expect(row?.type).toBe("SHOWING");
    expect(row?.propertyId).toBe(propertyId);
    expect(row?.nextActionDate?.toISOString()).toBe("2026-08-01T13:00:00.000Z");
    expect(row?.notes).toContain("Отменён клиентом");
    expect(row?.declinedAt).not.toBeNull();
    // Из задач ушла (TASK_WHERE смотрит на nextAction) — календарь, напоминания,
    // просьба подтвердить и «показ не проведён» её больше не видят.
    expect(row?.nextAction).toBeNull();
    // И при этом не «выполнена»: иначе KPI засчитал бы агенту встречу, которой не было.
    expect(row?.completedAt).toBeNull();

    const [to, payload] = sendPushToAgent.mock.calls[0] as unknown as [string, Record<string, string>];
    expect(to).toBe(agentId);
    expect(payload.title).toContain("отменил показ");
    expect(payload.body).toContain("01.08 в 18:00");
  });

  it("после отмены новая договорённость заводится с нуля, а не воскрешает старую", async () => {
    const booked = await bookInitialShowing();
    await cancelShowing({ clientId: moveClientId, now: NOW });

    const again = await bookShowing({
      clientId: moveClientId,
      request: { action: "book", propertyCode: propertyShortId, day: "after_tomorrow", time: "15:00" },
      now: NOW,
    });
    expect(again.ok && again.rescheduled).toBe(false);
    expect(again.ok && again.interactionId).not.toBe(booked.interactionId);
    expect(await showingsOfMoveClient()).toBe(2);
  });

  it("код объекта модель назвала неточно — отменяется ближайший показ клиента", async () => {
    const booked = await bookInitialShowing();
    const cancelled = await cancelShowing({ clientId: moveClientId, propertyCode: soldPropertyShortId, now: NOW });
    expect(cancelled.ok && cancelled.interactionId).toBe(booked.interactionId);
  });

  it("отменять нечего — молчим, а не дёргаем агента", async () => {
    const result = await cancelShowing({ clientId: moveClientId, now: NOW });
    expect(!result.ok && result.reason).toBe("no_showing");
    expect(sendPushToAgent).not.toHaveBeenCalled();
  });

  /**
   * Регрессия на баг, найденный аудитом 02.09.2026 (docs/audit-02-09-2026/02-popups.md,
   * сценарий S9): без фикса «Итог показа», уже всплывший до отмены, так и
   * оставался бы открытым — агент отвечал бы «как прошла встреча» про встречу,
   * которой не было.
   */
  it("уже всплывшее «Итог показа» закрывается вместе с отменой", async () => {
    const booked = await bookInitialShowing();
    const summary = await prisma.pendingSummary.create({
      data: {
        agentId,
        kind: "meeting",
        subjectId: booked.interactionId,
        subjectName: "Клиент отмены",
        dueAt: new Date(NOW.getTime() - 60_000),
      },
    });

    await cancelShowing({ clientId: moveClientId, propertyCode: propertyShortId, now: NOW });

    const after = await prisma.pendingSummary.findUnique({ where: { id: summary.id } });
    expect(after?.doneAt).not.toBeNull();
  });
});
