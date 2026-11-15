import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import type { PermissionId } from "@royal-home/shared";

/**
 * «СВОИ ДАННЫЕ — ЧЕРЕЗ ШАБНАМ» (владелец 15.11.2026), часть про удаление:
 * delete_client (свой клиент → Корзина, чужого нельзя, жёсткого удаления нет) и сообщение РОП,
 * директору и админу о каждом удалении объекта/клиента с кнопкой «Восстановить»
 * (telegram/trashRestoreNotice.ts, дверь sendStaffNotice, вид `trash`).
 *
 * Идут через настоящий брокер подтверждений и настоящие функции Корзины. Подменён только
 * Telegram (отправка и ответ на нажатие); ИИ в этих тестах не участвует.
 */
const { sendHtmlMessage, answerCallbackQuery } = vi.hoisted(() => {
  let id = 9000;
  return {
    sendHtmlMessage: vi.fn(async (_c: string, _h: string, _r?: number, _b?: unknown) => ({ message_id: ++id })),
    answerCallbackQuery: vi.fn(async (_id: string, _text?: string) => ({})),
  };
});
vi.mock("../src/telegram/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/telegram/api.js")>()),
  sendHtmlMessage,
  answerCallbackQuery,
}));

const { prisma } = await import("../src/db.js");
await import("../src/ai/assistant/tools/index.js");
const { createPendingAssistantAction, confirmAssistantAction, AssistantActionError } = await import("../src/lib/assistantActions.js");
const { listAssistantToolPlugins } = await import("../src/ai/assistant/tools/index.js");
const { handleTrashRestoreCallback, notifyTrashRemoval } = await import("../src/telegram/trashRestoreNotice.js");
const { setKindMuted } = await import("../src/lib/notificationPrefs.js");
const { parseNoticeIntent } = await import("../src/telegram/staffNotice.js");
const { PUSH_KINDS } = await import("@royal-home/shared");
const { actorFor, cleanupAssistantActionAgents } = await import("./helpers/assistantActionFixture.js");
const { waitFor, waitForSettled } = await import("./helpers/waitFor.js");

const runId = String(Date.now()).slice(-7);
const AGENT_PERMS: PermissionId[] = ["properties.requestChange"];
let n = 0;
let cb = 1;

let districtId = "";
const ids: Record<"owner" | "other" | "director" | "admin" | "hos" | "noTelegram" | "bystander", string> = {
  owner: "", other: "", director: "", admin: "", hos: "", noTelegram: "", bystander: "",
};
const chats: Record<string, string> = {};
const clientIds: string[] = [];
const propertyIds: string[] = [];

async function mkAgent(key: keyof typeof ids, role: "AGENT" | "DIRECTOR" | "ADMIN" | "HEAD_OF_SALES", telegram: boolean) {
  const chat = String(870_000_000 + Number(runId) * 10 + Object.keys(chats).length);
  const agent = await prisma.agent.create({
    data: {
      fullName: `Удаление ${key} ${runId}`,
      phone: `+992${Math.floor(Math.random() * 900_000_000) + 100_000_000}`,
      role,
      passwordHash: await bcrypt.hash("testpass123", 4),
      ...(telegram ? { telegramChatId: chat, telegramUserId: chat } : {}),
    },
  });
  ids[key] = agent.id;
  if (telegram) chats[key] = chat;
}

async function seedClient(assignedAgentId: string, overrides: Record<string, unknown> = {}) {
  const client = await prisma.client.create({
    data: {
      fullName: `Клиент удаления ${runId}-${++n}`,
      phone: `+992${Math.floor(Math.random() * 900_000_000) + 100_000_000}`,
      source: "PHONE_CALL",
      kind: "BUYER",
      assignedAgentId,
      acceptedAt: new Date(),
      ...overrides,
    } as never,
  });
  clientIds.push(client.id);
  return client;
}

async function seedProperty(agentId: string) {
  const property = await prisma.property.create({
    data: {
      title: `Объект удаления ${runId}-${++n}`,
      type: "APARTMENT", rooms: 2, areaSqm: 50, floor: 3, totalFloors: 9,
      price: 400000, currency: "TJS", districtId, address: `Удаляемая ${runId}-${n}`, condition: "GOOD",
      status: "AVAILABLE", createdById: agentId, assignedAgentId: agentId,
    } as never,
  });
  propertyIds.push(property.id);
  return property;
}

async function run(agentId: string, tool: string, args: Record<string, unknown>) {
  const actor = actorFor(agentId, AGENT_PERMS);
  const pending = await createPendingAssistantAction(actor, tool, args);
  await confirmAssistantAction(pending.id, actor);
  // Сообщение руководству уходит «в отрыве» от подтверждения — ждём, пока рассылка уляжется, чтобы она не попала в соседний тест.
  await waitForSettled(() => sendHtmlMessage.mock.calls.length);
  return pending;
}

const refused = async (agentId: string, tool: string, args: Record<string, unknown>) => {
  const err = await createPendingAssistantAction(actorFor(agentId, AGENT_PERMS), tool, args).then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(AssistantActionError);
  return err as InstanceType<typeof AssistantActionError>;
};

/** Сообщения, ушедшие в чат этого сотрудника. */
const sentTo = (key: string) => sendHtmlMessage.mock.calls.filter((c) => c[0] === chats[key]);
const buttonsOf = (call: unknown[] | undefined) => JSON.stringify(call?.[3] ?? []);
const press = (key: string, data: string) =>
  handleTrashRestoreCallback({
    id: `tr-${runId}-${cb++}`, data, from: { id: Number(chats[key]) },
    message: { chat: { id: Number(chats[key]), type: "private" }, message_id: 55, text: "Удалено" },
  } as never);

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Удаление ${runId}` } })).id;
  await mkAgent("owner", "AGENT", true);
  await mkAgent("other", "AGENT", true);
  await mkAgent("director", "DIRECTOR", true);
  await mkAgent("admin", "ADMIN", true);
  await mkAgent("hos", "HEAD_OF_SALES", true);
  await mkAgent("noTelegram", "DIRECTOR", false);
  await mkAgent("bystander", "AGENT", true);
});

beforeEach(() => {
  sendHtmlMessage.mockClear();
  answerCallbackQuery.mockClear();
});

afterAll(async () => {
  const agents = Object.values(ids);
  await prisma.staffNotice.deleteMany({ where: { agentId: { in: agents } } });
  await waitForSettled(() => prisma.notification.count({ where: { agentId: { in: agents } } }));
  await prisma.notification.deleteMany({ where: { agentId: { in: agents } } });
  await prisma.deal.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await cleanupAssistantActionAgents(agents);
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.$disconnect();
});

describe("delete_client: свой клиент — в Корзину", () => {
  it("превью ничего не пишет; подтверждение кладёт в Корзину (не стирает), повтор не дублирует", async () => {
    const client = await seedClient(ids.owner);
    const actor = actorFor(ids.owner, AGENT_PERMS);
    const pending = await createPendingAssistantAction(actor, "delete_client", { clientId: client.id });
    expect(pending.preview.risk).toMatch(/Корзин/);
    expect((await prisma.client.findUniqueOrThrow({ where: { id: client.id } })).deletedAt).toBeNull();

    await confirmAssistantAction(pending.id, actor);
    const again = await confirmAssistantAction(pending.id, actor);
    expect(again.replay).toBe(true);
    const row = await prisma.client.findUniqueOrThrow({ where: { id: client.id } });
    expect(row.deletedAt).not.toBeNull();
    expect(row.deletedById).toBe(ids.owner);
    expect(await prisma.client.count({ where: { id: client.id } })).toBe(1);
  });

  it("по номеру карточки тоже находит; запись в журнале — TRASH от помощника", async () => {
    const client = await seedClient(ids.owner);
    await run(ids.owner, "delete_client", { clientId: String(client.shortId) });
    expect((await prisma.client.findUniqueOrThrow({ where: { id: client.id } })).deletedAt).not.toBeNull();
    const audit = await waitFor(() => prisma.auditLog.findFirst({ where: { entityId: client.id, action: "TRASH" } }));
    expect(audit?.agentId).toBe(ids.owner);
  });

  it("чужого клиента удалить нельзя — ни рядовому агенту, ни руководителю: отказ простыми словами, ничего не тронуто", async () => {
    const foreign = await seedClient(ids.other);
    for (const who of [ids.owner, ids.director]) {
      const error = await refused(who, "delete_client", { clientId: foreign.id });
      expect(error.status).toBe(403);
      expect(error.message).toMatch(/только своего клиента/);
    }
    expect((await prisma.client.findUniqueOrThrow({ where: { id: foreign.id } })).deletedAt).toBeNull();
    expect(sentTo("director")).toHaveLength(0);
  });

  it("клиент со сделкой — отказ до карточки подтверждения, жёсткого удаления у Шабнам нет вовсе", async () => {
    const withDeal = await seedClient(ids.owner);
    const property = await seedProperty(ids.owner);
    await prisma.deal.create({
      data: { clientId: withDeal.id, propertyId: property.id, agentId: ids.owner, stage: "NEGOTIATION" } as never,
    });
    const error = await refused(ids.owner, "delete_client", { clientId: withDeal.id });
    expect(error.status).toBe(409);
    expect(error.message).toMatch(/сделк/i);

    // Класс «жёсткое удаление из чата»: ни одного инструмента, который стирает клиента или объект насовсем.
    const names = listAssistantToolPlugins().map((p) => p.name);
    expect(names.filter((name) => /permanent|purge|hard_?delete|erase/.test(name))).toEqual([]);
    expect(names).toEqual(expect.arrayContaining(["delete_client", "delete_property", "restore_property"]));
  });

  it("клиента успели передать другому после превью — подтверждение отказывает, карточка на месте", async () => {
    const client = await seedClient(ids.owner);
    const actor = actorFor(ids.owner, AGENT_PERMS);
    const pending = await createPendingAssistantAction(actor, "delete_client", { clientId: client.id });
    await prisma.client.update({ where: { id: client.id }, data: { assignedAgentId: ids.other } });
    const error = await confirmAssistantAction(pending.id, actor).then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(AssistantActionError);
    expect((await prisma.client.findUniqueOrThrow({ where: { id: client.id } })).deletedAt).toBeNull();
  });
});

describe("сообщение РОП, директору и админу об удалении — одно, с кнопкой «Восстановить»", () => {
  it("клиент: директор и админ — с кнопкой, РОП — без (нет права восстанавливать), удалившему и постороннему — ничего; по одному сообщению", async () => {
    const client = await seedClient(ids.owner);
    await run(ids.owner, "delete_client", { clientId: client.id });
    await waitFor(() => (sentTo("director").length > 0 && sentTo("admin").length > 0 && sentTo("hos").length > 0 ? true : null));
    await waitForSettled(() => sendHtmlMessage.mock.calls.length);

    for (const key of ["director", "admin"]) {
      expect(sentTo(key), key).toHaveLength(1);
      expect(String(sentTo(key)[0][1])).toContain("удалил(а) клиента");
      expect(buttonsOf(sentTo(key)[0])).toContain(`tr:c:${client.id}`);
      expect(buttonsOf(sentTo(key)[0])).toContain("Не присылать такое");
    }
    expect(sentTo("hos")).toHaveLength(1);
    expect(buttonsOf(sentTo("hos")[0])).not.toContain("tr:c:");
    expect(sentTo("owner")).toHaveLength(0);
    expect(sentTo("other")).toHaveLength(0);
    expect(sentTo("bystander")).toHaveLength(0);

    // Повтор того же повода (двойная доставка) — второго сообщения нет.
    await notifyTrashRemoval({ kind: "client", entityId: client.id, label: "повтор", byAgentId: ids.owner });
    expect(sentTo("director")).toHaveLength(1);
  });

  it("в тексте нет телефона клиента", async () => {
    const client = await seedClient(ids.owner, { fullName: `Иван +992900112233 ${runId}` });
    await run(ids.owner, "delete_client", { clientId: client.id });
    await waitFor(() => (sentTo("director").length > 0 ? true : null));
    expect(String(sentTo("director").at(-1)?.[1])).not.toContain("900112233");
  });

  it("объект: Шабнам удаляет свой объект → то же сообщение с кнопкой объекта", async () => {
    const property = await seedProperty(ids.owner);
    await run(ids.owner, "delete_property", { ref: String(property.shortId) });
    await waitFor(() => (sentTo("director").length > 0 ? true : null));
    expect(String(sentTo("director").at(-1)?.[1])).toContain("удалил(а) объект");
    expect(buttonsOf(sentTo("director").at(-1))).toContain(`tr:p:${property.id}`);
    expect(sentTo("owner")).toHaveLength(0);
  });

  it("отключается словами: «не присылай мне уведомления об удалениях» → вид trash, и выключившему сообщение не идёт", async () => {
    expect(PUSH_KINDS.map((k) => k.key)).toContain("trash");
    expect(parseNoticeIntent("не присылай мне уведомления об удалениях")).toMatchObject({ type: "mute", kind: "trash" });
    await setKindMuted(ids.director, "trash", true);
    try {
      const client = await seedClient(ids.owner);
      await run(ids.owner, "delete_client", { clientId: client.id });
      await waitFor(() => (sentTo("admin").length > 0 ? true : null));
      expect(sentTo("director")).toHaveLength(0);
      expect(sentTo("admin")).toHaveLength(1);
    } finally {
      await setKindMuted(ids.director, "trash", false);
    }
  });

  it("у кого Telegram не привязан — то же лентой и пушем CRM, одно на удаление", async () => {
    const client = await seedClient(ids.owner);
    await run(ids.owner, "delete_client", { clientId: client.id });
    const rows = await waitFor(async () => {
      const found = await prisma.notification.findMany({ where: { agentId: ids.noTelegram, kind: "trash", tag: `trash-removal-client-${client.id}` } });
      return found.length > 0 ? found : null;
    });
    expect(rows).toHaveLength(1);
    expect(rows![0].body).toContain("в Корзине");
  });
});

describe("кнопка «Восстановить»: та же дверь, что в CRM, права — свежие", () => {
  it("клиент: директор нажал — карточка вернулась; повторное нажатие тем же id ничего не делает", async () => {
    const client = await seedClient(ids.owner);
    await run(ids.owner, "delete_client", { clientId: client.id });
    await waitFor(() => (sentTo("director").length > 0 ? true : null));

    expect(await press("director", `tr:c:${client.id}`)).toBe(true);
    expect((await prisma.client.findUniqueOrThrow({ where: { id: client.id } })).deletedAt).toBeNull();
    expect(answerCallbackQuery.mock.calls.at(-1)?.[1]).toBe("Клиент восстановлен");
    const audit = await waitFor(() => prisma.auditLog.findFirst({ where: { entityId: client.id, action: "RESTORE" } }));
    expect(audit?.agentId).toBe(ids.director);

    // Уже восстановлен — понятный ответ, а не сбой.
    await press("admin", `tr:c:${client.id}`);
    expect(answerCallbackQuery.mock.calls.at(-1)?.[1]).toMatch(/Уже восстановлено/);
  });

  it("клиент: РОП без права «восстанавливать» и посторонний агент — отказ, карточка остаётся в Корзине", async () => {
    const client = await seedClient(ids.owner);
    await run(ids.owner, "delete_client", { clientId: client.id });
    await press("hos", `tr:c:${client.id}`);
    expect(answerCallbackQuery.mock.calls.at(-1)?.[1]).toMatch(/директор или администратор/);
    await press("bystander", `tr:c:${client.id}`);
    expect(answerCallbackQuery.mock.calls.at(-1)?.[1]).toMatch(/директор или администратор/);
    expect((await prisma.client.findUniqueOrThrow({ where: { id: client.id } })).deletedAt).not.toBeNull();
  });

  it("объект: директор нажал — объект вернулся из Корзины; посторонний агент — отказ по общему правилу Корзины", async () => {
    const property = await seedProperty(ids.owner);
    await run(ids.owner, "delete_property", { ref: String(property.shortId) });
    await press("bystander", `tr:p:${property.id}`);
    expect(answerCallbackQuery.mock.calls.at(-1)?.[1]).toMatch(/Восстановить объект из Корзины может/);
    expect((await prisma.property.findUniqueOrThrow({ where: { id: property.id } })).deletedAt).not.toBeNull();

    await press("director", `tr:p:${property.id}`);
    expect(answerCallbackQuery.mock.calls.at(-1)?.[1]).toBe("Объект восстановлен");
    expect((await prisma.property.findUniqueOrThrow({ where: { id: property.id } })).deletedAt).toBeNull();
  });

  it("чужие кнопки не трогаем; нажавший без привязки — просьба привязать", async () => {
    expect(await handleTrashRestoreCallback({ id: `x-${cb++}`, data: "nm:payment", from: { id: 1 } } as never)).toBe(false);
    const client = await seedClient(ids.owner);
    await run(ids.owner, "delete_client", { clientId: client.id });
    await handleTrashRestoreCallback({
      id: `tr-${runId}-${cb++}`, data: `tr:c:${client.id}`, from: { id: 1 },
      message: { chat: { id: 1, type: "private" }, message_id: 5 },
    } as never);
    expect(answerCallbackQuery.mock.calls.at(-1)?.[1]).toMatch(/Привяжите аккаунт/);
    expect((await prisma.client.findUniqueOrThrow({ where: { id: client.id } })).deletedAt).not.toBeNull();
  });
});
