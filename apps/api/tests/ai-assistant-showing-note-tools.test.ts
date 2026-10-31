import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Инструменты помощника «показы и заметки» (П3, группа show, 31.10.2026):
 * book_showing, reschedule_showing, cancel_showing (уровень C) и add_client_note (B).
 *
 * Что держим (каждый пункт — отдельный тест, поломка условия обязана краснеть):
 *  - превью НИЧЕГО не пишет, пока человек не нажал «Подтвердить»;
 *  - права — те же, что у REST: рядовой агент — свои, чужие — руководитель с clients.assign;
 *    служба безопасности («видеть всех» без clients.assign) и акционер — не пишут;
 *  - подтверждение исполняет РОВНО один раз, повторное нажатие возвращает прежний результат;
 *  - устаревший снимок — 409 STALE, и показ/заметка остаются как были;
 *  - условная запись сервиса показов (`expectedAt`) не даёт двинуть показ, который уже двинули;
 *  - откат заметки удаляет только её и только нетронутую.
 */

const sendPushToAgent = vi.fn(async () => 1);
vi.mock("../src/push.js", async (importOriginal) => ({
  // Подмена ДОПОЛНЯЕТ модуль, а не заменяет его целиком (см. bot-showing.test.ts).
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent,
  sendPushToAgents: sendPushToAgent,
}));

const { prisma } = await import("../src/db.js");
const { invalidateAgentAccess } = await import("../src/auth/middleware.js");
const { AssistantActionError, confirmAssistantAction, createPendingAssistantAction, undoAssistantAction } = await import(
  "../src/lib/assistantActions.js"
);
const { runAssistantToolPlugin } = await import("../src/ai/assistant/tools/run.js");
const { findAssistantToolPlugin } = await import("../src/ai/assistant/tools/index.js");
const { bookShowing, rescheduleShowingById } = await import("../src/lib/showingBooking.js");
const { ShowingMutationError } = await import("../src/lib/showingMutation.js");
const { dushanbeDateString } = await import("../src/lib/dushanbeTime.js");
const { cleanupAssistantActionAgents, actorFor } = await import("./helpers/assistantActionFixture.js");
const { deleteAgentsWithTraces } = await import("./helpers/cleanupAgents.js");

const runId = String(Date.now()).slice(-8);
const phone = () => `+992${Math.floor(Math.random() * 900_000_000) + 100_000_000}`;

type Role = "AGENT" | "DIRECTOR" | "SECURITY" | "SHAREHOLDER";
const agents = {} as Record<"owner" | "other" | "director" | "security" | "shareholder", string>;
let districtId = "";
let ownClientId = "";
let foreignClientId = "";
let unacceptedClientId = "";
let trashClientId = "";
let propertyId = "";
let propertyShortId = 0;
let secondPropertyId = "";
let soldPropertyId = "";
const propertyIds: string[] = [];
const clientIds: string[] = [];

async function makeAgent(name: string, role: Role): Promise<string> {
  const agent = await prisma.agent.create({
    data: { fullName: `${name} ${runId}`, phone: phone(), role, passwordHash: "x" },
  });
  return agent.id;
}

async function makeClient(name: string, extra: Record<string, unknown> = {}): Promise<string> {
  const client = await prisma.client.create({
    data: { fullName: `${name} ${runId}`, phone: phone(), source: "WHATSAPP", ...extra },
  });
  clientIds.push(client.id);
  return client.id;
}

async function makeProperty(title: string, extra: Record<string, unknown> = {}) {
  const property = await prisma.property.create({
    data: {
      title: `${title} ${runId}`,
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
  propertyIds.push(property.id);
  return property;
}

/** «ГГГГ-ММ-ДД ЧЧ:ММ» по Душанбе через N суток от сейчас: внутри часов показов, дальше 30 минут, ближе 30 дней. */
function futureAt(daysAhead: number, time: string): string {
  return `${dushanbeDateString(new Date(Date.now() + daysAhead * 24 * 3600_000))} ${time}`;
}

const showingsOf = (clientId: string) =>
  prisma.interaction.findMany({ where: { clientId, type: "SHOWING" }, orderBy: { createdAt: "asc" } });

async function pending(tool: string, args: Record<string, unknown>, agentId: string) {
  return createPendingAssistantAction(actorFor(agentId), tool, args);
}

async function pendingError(tool: string, args: Record<string, unknown>, agentId: string) {
  const err = await pending(tool, args, agentId).then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AssistantActionError);
  return err as InstanceType<typeof AssistantActionError>;
}

/** Показ клиента через сам сервис — исходное состояние для переноса/отмены. */
async function bookedShowing(clientId: string, at: string, forProperty = propertyId, by = agents.owner): Promise<string> {
  const action = await pending("book_showing", { clientId, propertyId: forProperty, at }, by);
  const { action: done } = await confirmAssistantAction(action.id, actorFor(by));
  return (done.result as { interactionId: string }).interactionId;
}

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Тест-район-помощник-показы-${runId}` } })).id;
  agents.owner = await makeAgent("Агент владелец", "AGENT");
  agents.other = await makeAgent("Агент чужой", "AGENT");
  agents.director = await makeAgent("Руководитель", "DIRECTOR");
  agents.security = await makeAgent("Служба безопасности", "SECURITY");
  agents.shareholder = await makeAgent("Акционер", "SHAREHOLDER");

  ownClientId = await makeClient("Свой клиент", { assignedAgentId: agents.owner, acceptedAt: new Date() });
  foreignClientId = await makeClient("Чужой клиент", { assignedAgentId: agents.other, acceptedAt: new Date() });
  unacceptedClientId = await makeClient("Непринятый лид", { assignedAgentId: agents.owner });
  trashClientId = await makeClient("Клиент в Корзине", {
    assignedAgentId: agents.owner,
    acceptedAt: new Date(),
    deletedAt: new Date(),
  });

  const property = await makeProperty("Объект показа", { assignedAgentId: agents.other });
  propertyId = property.id;
  propertyShortId = property.shortId;
  secondPropertyId = (await makeProperty("Второй объект показа", { assignedAgentId: agents.other })).id;
  soldPropertyId = (await makeProperty("Проданный объект", { status: "SOLD" })).id;
});

beforeEach(async () => {
  sendPushToAgent.mockClear();
  invalidateAgentAccess();
  // Показы и заметки сценариев друг другу не мешают: каждый тест начинает с чистых клиентов.
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
});

afterAll(async () => {
  const allAgents = Object.values(agents).filter(Boolean);
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.interaction.deleteMany({ where: { subjectAgentId: { in: allAgents } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await cleanupAssistantActionAgents(allAgents);
  await deleteAgentsWithTraces(allAgents);
  if (districtId) await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.$disconnect();
});

/* ─────────────────────────────── book_showing ─────────────────────────────── */

describe("book_showing: превью и права", () => {
  it("рядовой агент, свой клиент: карточка «было → станет», в базе пока ничего", async () => {
    const at = futureAt(2, "15:00");
    const action = await pending("book_showing", { clientId: ownClientId, propertyId, at }, agents.owner);

    expect(action.status).toBe("PENDING");
    expect(action.preview.title).toBe("Назначить показ");
    expect(action.preview.was).toEqual({ Показ: "не назначен" });
    expect(action.preview.becomes).toMatchObject({ Время: `${at} (Душанбе)` });
    expect(action.preview.becomes["Объект"]).toContain("Объект показа");
    expect(await showingsOf(ownClientId)).toHaveLength(0);
    expect(sendPushToAgent).not.toHaveBeenCalled();
  });

  it("короткий номер объекта (ОБ-000088 → 88) понимается, как в REST", async () => {
    const action = await pending(
      "book_showing",
      { clientId: ownClientId, propertyId: String(propertyShortId), at: futureAt(2, "15:00") },
      agents.owner,
    );
    expect(action.preview.becomes["Объект"]).toContain("Объект показа");
  });

  it("рядовой агент, чужой клиент: 403, действие не создаётся", async () => {
    const before = await prisma.assistantAction.count({ where: { agentId: agents.owner } });
    const err = await pendingError("book_showing", { clientId: foreignClientId, propertyId, at: futureAt(2, "15:00") }, agents.owner);
    expect(err.status).toBe(403);
    expect(await prisma.assistantAction.count({ where: { agentId: agents.owner } })).toBe(before);
  });

  it("руководитель (clients.assign) назначает показ чужому клиенту", async () => {
    const action = await pending("book_showing", { clientId: foreignClientId, propertyId, at: futureAt(2, "15:00") }, agents.director);
    expect(action.status).toBe("PENDING");
  });

  it("служба безопасности («видеть всех» без clients.assign) в чужую карточку не пишет — как REST", async () => {
    const err = await pendingError("book_showing", { clientId: foreignClientId, propertyId, at: futureAt(2, "15:00") }, agents.security);
    expect(err.status).toBe(403);
  });

  it("акционер только смотрит", async () => {
    const err = await pendingError("book_showing", { clientId: ownClientId, propertyId, at: futureAt(2, "15:00") }, agents.shareholder);
    expect(err.status).toBe(403);
  });

  it("клиент из Корзины и непринятый лид рядового агента — «клиент не найден»", async () => {
    for (const clientId of [trashClientId, unacceptedClientId]) {
      const err = await pendingError("book_showing", { clientId, propertyId, at: futureAt(2, "15:00") }, agents.owner);
      expect(err.status).toBe(404);
    }
  });

  it("проданный объект — отказ без записи; несуществующий — 404", async () => {
    const sold = await pendingError("book_showing", { clientId: ownClientId, propertyId: soldPropertyId, at: futureAt(2, "15:00") }, agents.owner);
    expect(sold.status).toBe(409);
    const missing = await pendingError("book_showing", { clientId: ownClientId, propertyId: "net-takogo", at: futureAt(2, "15:00") }, agents.owner);
    expect(missing.status).toBe(404);
  });

  it("часы 09:00–20:00 и прошлое держит сервис: вне часов и в прошлом — отказ", async () => {
    const night = await pendingError("book_showing", { clientId: ownClientId, propertyId, at: futureAt(2, "22:00") }, agents.owner);
    expect(night.code).toBe("SLOT_OUTSIDE_HOURS");
    const past = await pendingError("book_showing", { clientId: ownClientId, propertyId, at: futureAt(-1, "15:00") }, agents.owner);
    expect(past.code).toBe("SLOT_PAST");
    const garbage = await pendingError("book_showing", { clientId: ownClientId, propertyId, at: "как-нибудь потом" }, agents.owner);
    expect(garbage.code).toBe("BAD_TIME");
  });

  it("занятость агента — предупреждение в превью, а не блок (решение владельца 31.07.2026)", async () => {
    const at = futureAt(2, "15:00");
    // У агента клиента (owner) уже есть показ другого его клиента в это же время.
    const busyClient = await makeClient("Занятый клиент", { assignedAgentId: agents.owner, acceptedAt: new Date() });
    await bookedShowing(busyClient, at, propertyId, agents.owner);
    const action = await pending("book_showing", { clientId: ownClientId, propertyId, at }, agents.owner);
    expect(action.preview.risk).toContain("занят");
  });
});

describe("book_showing: исполнение", () => {
  it("подтверждение создаёт показ один раз; повторное нажатие отдаёт прежний результат", async () => {
    const at = futureAt(2, "15:00");
    const action = await pending("book_showing", { clientId: ownClientId, propertyId, at }, agents.owner);

    const first = await confirmAssistantAction(action.id, actorFor(agents.owner));
    const second = await confirmAssistantAction(action.id, actorFor(agents.owner));

    expect(first.replay).toBe(false);
    expect(second.replay).toBe(true);
    const showings = await showingsOf(ownClientId);
    expect(showings).toHaveLength(1);
    expect(showings[0]).toMatchObject({ propertyId, nextAction: "Показ объекта" });
    // 15:00 по Душанбе (UTC+5) = 10:00 UTC — время не уехало на пять часов.
    expect(showings[0].nextActionDate!.getUTCHours()).toBe(10);
    expect(showings[0].notes).toContain("через ИИ-помощника");
    expect((first.action.result as { href: string }).href).toBe(`/clients/${ownClientId}`);
  });

  it("два параллельных подтверждения — один показ", async () => {
    const action = await pending("book_showing", { clientId: ownClientId, propertyId, at: futureAt(2, "16:00") }, agents.owner);
    const results = await Promise.allSettled([
      confirmAssistantAction(action.id, actorFor(agents.owner)),
      confirmAssistantAction(action.id, actorFor(agents.owner)),
    ]);
    expect(results.some((r) => r.status === "fulfilled")).toBe(true);
    expect(await showingsOf(ownClientId)).toHaveLength(1);
  });

  it("тот же объект на другое время — перенос существующего показа, а не второй показ", async () => {
    await bookedShowing(ownClientId, futureAt(2, "15:00"));
    const action = await pending("book_showing", { clientId: ownClientId, propertyId, at: futureAt(3, "17:00") }, agents.owner);
    expect(action.preview.risk).toContain("перенесён");
    await confirmAssistantAction(action.id, actorFor(agents.owner));
    const showings = await showingsOf(ownClientId);
    expect(showings).toHaveLength(1);
    expect(showings[0].nextActionDate!.getUTCHours()).toBe(12);
  });

  it("другой объект почти в то же время заменяет прежний показ — превью говорит об этом заранее", async () => {
    await bookedShowing(ownClientId, futureAt(2, "15:00"), secondPropertyId);
    const action = await pending("book_showing", { clientId: ownClientId, propertyId, at: futureAt(2, "15:30") }, agents.owner);
    expect(action.preview.risk).toContain("будет снят и заменён");
  });

  it("снимок устарел (показ уже назначили) — 409 STALE, второго показа нет", async () => {
    const at = futureAt(2, "15:00");
    const action = await pending("book_showing", { clientId: ownClientId, propertyId, at }, agents.owner);
    // Пока человек читал карточку, показ назначили в обход помощника.
    const direct = await bookShowing({
      clientId: ownClientId,
      request: { propertyCode: propertyId, day: dushanbeDateString(new Date(Date.now() + 2 * 24 * 3600_000)), time: "15:00" },
      actor: { kind: "agent", agentId: agents.director, agentName: "Руководитель" },
    });
    expect(direct.ok).toBe(true);

    const err = await confirmAssistantAction(action.id, actorFor(agents.owner)).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toMatchObject({ status: 409, code: "STALE" });
    expect(await showingsOf(ownClientId)).toHaveLength(1);
  });

  it("объект успели продать до «Подтвердить» — отказ БЕЗ записи «бот не смог назначить» и без push", async () => {
    const fresh = await makeProperty("Объект, который продадут", { assignedAgentId: agents.other });
    const action = await pending("book_showing", { clientId: ownClientId, propertyId: fresh.id, at: futureAt(2, "15:00") }, agents.owner);
    await prisma.property.update({ where: { id: fresh.id }, data: { status: "SOLD" } });

    const err = await confirmAssistantAction(action.id, actorFor(agents.owner)).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toMatchObject({ status: 409 });
    expect(await prisma.interaction.count({ where: { clientId: ownClientId } })).toBe(0);
    expect(sendPushToAgent).not.toHaveBeenCalled();
  });

  it("права перечитываются на нажатии: агенту отозвали клиента — подтверждение отказывает", async () => {
    const action = await pending("book_showing", { clientId: ownClientId, propertyId, at: futureAt(2, "15:00") }, agents.owner);
    await prisma.client.update({ where: { id: ownClientId }, data: { assignedAgentId: agents.other } });
    try {
      const err = await confirmAssistantAction(action.id, actorFor(agents.owner)).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toMatchObject({ status: 403 });
      expect(await showingsOf(ownClientId)).toHaveLength(0);
    } finally {
      await prisma.client.update({ where: { id: ownClientId }, data: { assignedAgentId: agents.owner } });
    }
  });
});

/* ──────────────────────── reschedule_showing / cancel_showing ──────────────────────── */

describe("reschedule_showing", () => {
  it("свой показ: превью без записи, подтверждение двигает время и пишет «через ИИ-помощника»", async () => {
    const id = await bookedShowing(ownClientId, futureAt(2, "15:00"));
    sendPushToAgent.mockClear();
    const newAt = futureAt(3, "11:00");
    const action = await pending("reschedule_showing", { interactionId: id, newAt }, agents.owner);

    expect(action.preview.becomes).toMatchObject({ Время: `${newAt} (Душанбе)` });
    expect((await prisma.interaction.findUniqueOrThrow({ where: { id } })).nextActionDate!.getUTCHours()).toBe(10);

    const done = await confirmAssistantAction(action.id, actorFor(agents.owner));
    await confirmAssistantAction(action.id, actorFor(agents.owner));
    const row = await prisma.interaction.findUniqueOrThrow({ where: { id } });
    expect(row.nextActionDate!.getUTCHours()).toBe(6);
    expect(row.notes).toContain("через ИИ-помощника");
    expect(row.notes).toContain("по просьбе сотрудника через ИИ-помощника");
    expect(done.replay).toBe(false);
    // Повторное нажатие не двигает снова: одна пометка о переносе.
    expect(row.notes.match(/Перенесён/g)).toHaveLength(1);
  });

  it("чужой показ: рядовому агенту 403, руководителю можно, службе безопасности нельзя", async () => {
    const id = await bookedShowing(foreignClientId, futureAt(2, "15:00"), propertyId, agents.other);
    const newAt = futureAt(3, "11:00");
    expect((await pendingError("reschedule_showing", { interactionId: id, newAt }, agents.owner)).status).toBe(403);
    expect((await pendingError("reschedule_showing", { interactionId: id, newAt }, agents.security)).status).toBe(403);
    expect((await pending("reschedule_showing", { interactionId: id, newAt }, agents.director)).status).toBe("PENDING");
  });

  it("акционер не двигает, несуществующая запись — 404", async () => {
    const id = await bookedShowing(ownClientId, futureAt(2, "15:00"));
    expect((await pendingError("reschedule_showing", { interactionId: id, newAt: futureAt(3, "11:00") }, agents.shareholder)).status).toBe(403);
    expect((await pendingError("reschedule_showing", { interactionId: "net-takoy", newAt: futureAt(3, "11:00") }, agents.owner)).status).toBe(404);
  });

  it("в прошлое, на то же время и не-показ — отказ", async () => {
    const at = futureAt(2, "15:00");
    const id = await bookedShowing(ownClientId, at);
    expect((await pendingError("reschedule_showing", { interactionId: id, newAt: futureAt(-1, "11:00") }, agents.owner)).code).toBe("PAST");
    expect((await pendingError("reschedule_showing", { interactionId: id, newAt: at }, agents.owner)).code).toBe("NO_CHANGE");

    const task = await prisma.interaction.create({
      data: { clientId: ownClientId, type: "SYSTEM", notes: "задача", nextAction: "Позвонить", nextActionDate: new Date(Date.now() + 86400_000), agentId: agents.owner },
    });
    expect((await pendingError("reschedule_showing", { interactionId: task.id, newAt: futureAt(3, "11:00") }, agents.owner)).code).toBe("NOT_SHOWING");
  });

  it("показ успели подвинуть до «Подтвердить» — 409 STALE, время остаётся чужим", async () => {
    const id = await bookedShowing(ownClientId, futureAt(2, "15:00"));
    const action = await pending("reschedule_showing", { interactionId: id, newAt: futureAt(4, "11:00") }, agents.owner);
    const movedBy = new Date(Date.now() + 5 * 86400_000);
    await prisma.interaction.update({ where: { id }, data: { nextActionDate: movedBy } });

    const err = await confirmAssistantAction(action.id, actorFor(agents.owner)).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toMatchObject({ status: 409, code: "STALE" });
    expect((await prisma.interaction.findUniqueOrThrow({ where: { id } })).nextActionDate!.getTime()).toBe(movedBy.getTime());
  });

  it("сервис показов пишет условно: время изменили между проверкой и записью — ShowingMutationError, ничего не пишется", async () => {
    const id = await bookedShowing(ownClientId, futureAt(2, "15:00"));
    const row = await prisma.interaction.findUniqueOrThrow({ where: { id } });
    const expectedAt = row.nextActionDate!;
    await prisma.interaction.update({ where: { id }, data: { nextActionDate: new Date(expectedAt.getTime() + 3600_000) } });

    await expect(
      rescheduleShowingById({
        interactionId: id,
        at: new Date(Date.now() + 6 * 86400_000),
        actor: { kind: "agent", agentId: agents.owner, agentName: "Владелец", via: "assistant" },
        reason: "тест условной записи",
        expectedAt,
      }),
    ).rejects.toBeInstanceOf(ShowingMutationError);
    expect((await prisma.interaction.findUniqueOrThrow({ where: { id } })).notes).not.toContain("Перенесён");
  });
});

describe("cancel_showing", () => {
  it("причина обязательна: без неё и с пустой — отказ, показ жив", async () => {
    const id = await bookedShowing(ownClientId, futureAt(2, "15:00"));
    expect((await pendingError("cancel_showing", { interactionId: id }, agents.owner)).status).toBe(400);
    expect((await pendingError("cancel_showing", { interactionId: id, reason: "  " }, agents.owner)).status).toBe(400);
    expect((await prisma.interaction.findUniqueOrThrow({ where: { id } })).nextAction).not.toBeNull();
  });

  it("свой показ: превью без записи, подтверждение снимает с календаря один раз и заводит «согласовать новую дату»", async () => {
    const id = await bookedShowing(ownClientId, futureAt(2, "15:00"));
    const action = await pending("cancel_showing", { interactionId: id, reason: "клиент передумал" }, agents.owner);
    expect((await prisma.interaction.findUniqueOrThrow({ where: { id } })).nextAction).not.toBeNull();

    await confirmAssistantAction(action.id, actorFor(agents.owner));
    await confirmAssistantAction(action.id, actorFor(agents.owner));

    const row = await prisma.interaction.findUniqueOrThrow({ where: { id } });
    expect(row.nextAction).toBeNull();
    expect(row.declinedAt).not.toBeNull();
    expect(row.notes).toContain("клиент передумал");
    expect(row.notes).toContain("через ИИ-помощника");
    expect(await prisma.interaction.count({ where: { clientId: ownClientId, nextAction: "Согласовать новую дату показа" } })).toBe(1);
  });

  it("чужой показ: рядовому агенту 403, руководителю можно, службе безопасности и акционеру нельзя", async () => {
    const id = await bookedShowing(foreignClientId, futureAt(2, "15:00"), propertyId, agents.other);
    const args = { interactionId: id, reason: "объект продан" };
    expect((await pendingError("cancel_showing", args, agents.owner)).status).toBe(403);
    expect((await pendingError("cancel_showing", args, agents.security)).status).toBe(403);
    expect((await pendingError("cancel_showing", args, agents.shareholder)).status).toBe(403);
    expect((await pending("cancel_showing", args, agents.director)).status).toBe("PENDING");
  });

  it("уже отменённый показ второй раз не отменяется", async () => {
    const id = await bookedShowing(ownClientId, futureAt(2, "15:00"));
    const action = await pending("cancel_showing", { interactionId: id, reason: "клиент передумал" }, agents.owner);
    await confirmAssistantAction(action.id, actorFor(agents.owner));
    const err = await pendingError("cancel_showing", { interactionId: id, reason: "ещё раз" }, agents.owner);
    expect(err.status).toBe(409);
  });

  it("показ подвинули после превью — 409 STALE, показ остаётся живым", async () => {
    const id = await bookedShowing(ownClientId, futureAt(2, "15:00"));
    const action = await pending("cancel_showing", { interactionId: id, reason: "клиент передумал" }, agents.owner);
    await prisma.interaction.update({ where: { id }, data: { nextActionDate: new Date(Date.now() + 6 * 86400_000) } });

    const err = await confirmAssistantAction(action.id, actorFor(agents.owner)).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toMatchObject({ status: 409, code: "STALE" });
    expect((await prisma.interaction.findUniqueOrThrow({ where: { id } })).nextAction).not.toBeNull();
  });
});

/* ────────────────────────────── add_client_note ────────────────────────────── */

describe("add_client_note", () => {
  const notePlugin = () => findAssistantToolPlugin("add_client_note")!;
  const runNote = (clientId: string, text: string, agentId: string) =>
    runAssistantToolPlugin(
      notePlugin(),
      { clientId, text },
      {
        id: agentId,
        role: "AGENT",
        canViewAllClients: false,
        canViewPhone: false,
        canViewReports: false,
        canViewFinance: false,
        canViewAllDeals: false,
        canAssignClients: false,
        canEditForeignProperties: false,
        canModerate: false,
        canRequestChange: false,
      },
      { channel: "crm" },
    ) as Promise<{ done?: boolean; actionId?: string; undoUntil?: string | null; result?: { noteId: string; href: string }; error?: string; code?: string }>;

  const notesOf = (clientId: string) =>
    prisma.interaction.findMany({ where: { clientId, actorKind: "AI", type: "SYSTEM" } });

  it("своему клиенту: пишется сразу, автор «ИИ», вернулась ссылка и окно отката", async () => {
    const answer = await runNote(ownClientId, "Просил перезвонить после 18:00", agents.owner);
    expect(answer.done).toBe(true);
    expect(answer.undoUntil).not.toBeNull();
    expect(answer.result!.href).toBe(`/clients/${ownClientId}`);

    const notes = await notesOf(ownClientId);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ actorKind: "AI", agentId: null, subjectAgentId: agents.owner, nextAction: null });
    expect(notes[0].notes).toContain("Просил перезвонить после 18:00");
  });

  it("чужому клиенту: рядовой агент и служба безопасности — отказ, руководитель — можно", async () => {
    const own = await runNote(foreignClientId, "заметка", agents.owner);
    expect(own).toMatchObject({ error: expect.any(String), code: "FORBIDDEN" });
    const security = await runNote(foreignClientId, "заметка", agents.security);
    expect(security).toMatchObject({ code: "FORBIDDEN" });
    const shareholder = await runNote(ownClientId, "заметка", agents.shareholder);
    expect(shareholder).toMatchObject({ code: "FORBIDDEN" });
    expect(await notesOf(foreignClientId)).toHaveLength(0);

    const director = await runNote(foreignClientId, "заметка руководителя", agents.director);
    expect(director.done).toBe(true);
    expect(await notesOf(foreignClientId)).toHaveLength(1);
  });

  it("Корзина и непринятый лид рядового агента — «клиент не найден»", async () => {
    for (const clientId of [trashClientId, unacceptedClientId]) {
      expect(await runNote(clientId, "заметка", agents.owner)).toMatchObject({ code: "NOT_FOUND" });
    }
  });

  it("длина: 2000 знаков можно, 2001 — нет, пустой текст — нет", async () => {
    expect((await runNote(ownClientId, "а".repeat(2000), agents.owner)).done).toBe(true);
    expect(await runNote(ownClientId, "а".repeat(2001), agents.owner)).toMatchObject({ code: "NOTE_TOO_LONG" });
    expect(await runNote(ownClientId, "   ", agents.owner)).toMatchObject({ code: "BAD_ARGS" });
    expect(await notesOf(ownClientId)).toHaveLength(1);
  });

  it("откат удаляет ТОЛЬКО созданную заметку, чужие записи остаются; повтор отката не ломает", async () => {
    const keep = await prisma.interaction.create({
      data: { clientId: ownClientId, type: "SYSTEM", notes: "чужая запись", agentId: agents.owner },
    });
    const answer = await runNote(ownClientId, "нужная заметка", agents.owner);
    expect(await notesOf(ownClientId)).toHaveLength(1);

    const undone = await undoAssistantAction(answer.actionId!, actorFor(agents.owner));
    expect(undone.action.status).toBe("UNDONE");
    expect(await notesOf(ownClientId)).toHaveLength(0);
    expect(await prisma.interaction.findUnique({ where: { id: keep.id } })).not.toBeNull();

    expect((await undoAssistantAction(answer.actionId!, actorFor(agents.owner))).replay).toBe(true);
  });

  it("заметку успели изменить — откат отказывает (409), правка не затирается", async () => {
    const answer = await runNote(ownClientId, "исходный текст", agents.owner);
    const noteId = answer.result!.noteId;
    await prisma.interaction.update({ where: { id: noteId }, data: { notes: "Заметка (ИИ-помощник): исправил руками" } });

    const err = await undoAssistantAction(answer.actionId!, actorFor(agents.owner)).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toMatchObject({ status: 409 });
    expect(await prisma.interaction.findUnique({ where: { id: noteId } })).not.toBeNull();
  });

  it("клиента передали другому до записи — 409 STALE, заметки нет", async () => {
    const clientId = await makeClient("Передаваемый клиент", { assignedAgentId: agents.other, acceptedAt: new Date() });
    const action = await pending("add_client_note", { clientId, text: "заметка" }, agents.director);
    await prisma.client.update({ where: { id: clientId }, data: { assignedAgentId: agents.owner } });

    const err = await confirmAssistantAction(action.id, actorFor(agents.director)).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toMatchObject({ status: 409, code: "STALE" });
    expect(await notesOf(clientId)).toHaveLength(0);
  });

  it("повторное подтверждение той же заметки не дублирует её", async () => {
    const action = await pending("add_client_note", { clientId: ownClientId, text: "одна заметка" }, agents.owner);
    await confirmAssistantAction(action.id, actorFor(agents.owner));
    await confirmAssistantAction(action.id, actorFor(agents.owner));
    expect(await notesOf(ownClientId)).toHaveLength(1);
  });
});

describe("регистрация в реестре помощника", () => {
  it("все четыре инструмента зарегистрированы с нужным уровнем и схемой для модели", () => {
    const expected: Array<[string, "B" | "C"]> = [
      ["book_showing", "C"],
      ["reschedule_showing", "C"],
      ["cancel_showing", "C"],
      ["add_client_note", "B"],
    ];
    for (const [name, level] of expected) {
      const plugin = findAssistantToolPlugin(name);
      expect(plugin?.level).toBe(level);
      expect(plugin?.parameters).toMatchObject({ type: "object", required: expect.any(Array) });
      expect(plugin?.description).toMatch(/НЕ звать/);
    }
  });
});
