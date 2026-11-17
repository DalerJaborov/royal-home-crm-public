import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PermissionId } from "@royal-home/shared";

/**
 * «МОЗГ КОМПАНИИ» — инструменты чтения Шабнам (17.11.2026, ai/assistant/tools/brainReadTools.ts):
 * get_day_snapshot, get_unworked, get_my_day, get_missed_calls, get_team_load, get_stuck_work.
 *
 * Проверяем то, чего не видно по диффу: права как у экранов (агент — только своё,
 * руководитель — всё, без права — отказ), Корзина не попадает, номер под маской,
 * общая группа Telegram закрыта двумя стенами (GROUP_HIDDEN_TOOLS и отказ в run).
 * Gemini не нужен — плагины зовутся напрямую, как это делает ядро.
 *
 * Выводы — по своим данным (сотрудники и карточки с runId), а не по общим счётчикам
 * базы: тесты идут в два процесса на одной базе, и чужие строки сдвигают «всю компанию».
 * Где общий счётчик всё же нужен — сравнение «до/после» со своим вкладом.
 */

const { prisma } = await import("../src/db.js");
const { findAssistantToolPlugin } = await import("../src/ai/assistant/tools/index.js");
const { brainReadTools } = await import("../src/ai/assistant/tools/brainReadTools.js");
const { groupHiddenToolsForTests } = await import("../src/telegram/assistantBot.js");
const { createTestAgent } = await import("./helpers/ownAgent.js");
const { deleteAgentsWithTraces } = await import("./helpers/cleanupAgents.js");
const { dushanbeDateString, dushanbeInputToDate } = await import("../src/lib/dushanbeTime.js");

const runId = String(Date.now()).slice(-8);
const nameA = `Мозгов${runId}`;
const SNAPSHOT_NAME = `Тест-доступ ${runId}`;

type Actor = Parameters<NonNullable<ReturnType<typeof tool>["run"]>>[1]["actor"];
function tool(name: string) {
  const plugin = findAssistantToolPlugin(name);
  if (!plugin || plugin.level !== "A") throw new Error(`нет инструмента чтения ${name}`);
  return plugin;
}
async function call(name: string, args: Record<string, unknown>, actor: Actor): Promise<any> {
  return tool(name).run(args, { actor });
}

let agentA = "";
let agentB = "";
let director = "";
const clientIds: string[] = [];
const callIds: string[] = [];
let cA = { id: "", shortId: 0, phone: "" };
let cB = { id: "", shortId: 0, phone: "" };
let cTrash = { id: "", shortId: 0, phone: "" };
let cPending = { id: "", shortId: 0, phone: "" };

function baseActor(id: string, permissions: PermissionId[], over: Partial<Actor> = {}): Actor {
  const set = new Set<PermissionId>(permissions);
  return {
    id,
    role: "AGENT",
    surface: "crm-private",
    canViewAllClients: set.has("clients.viewAll"),
    canViewPhone: set.has("clients.viewPhone"),
    canViewReports: set.has("reports.view"),
    canViewFinance: set.has("finance.view"),
    canViewAllDeals: false,
    canAssignClients: set.has("clients.assign"),
    canEditForeignProperties: false,
    canModerate: false,
    canRequestChange: false,
    permissions: set,
    ...over,
  } as Actor;
}
/** Рядовой агент: свои звонки, без пульта, команды и журнала. */
const actorA = () => baseActor(agentA, ["calls.ownTranscripts"]);
const actorB = () => baseActor(agentB, ["calls.ownTranscripts"]);
/** Сотрудник без единого права на эти экраны. */
const actorBare = () => baseActor(agentA, []);
const LEADER_PERMISSIONS: PermissionId[] = [
  "dashboard.analytics", "team.viewFull", "auditLog.view", "calls.transcripts",
  "clients.viewAll", "clients.viewPhone", "finance.view",
];
const actorLeader = (over: Partial<Actor> = {}) => baseActor(director, LEADER_PERMISSIONS, { role: "DIRECTOR", ...over });

let seq = 0;
async function makeClient(data: Record<string, unknown>) {
  const c = await prisma.client.create({
    data: {
      fullName: `Мозг клиент ${seq}`,
      phone: `+9928${runId}${seq++}`,
      source: "WEBSITE",
      acceptedAt: new Date(),
      ...data,
    } as never,
  });
  clientIds.push(c.id);
  return { id: c.id, shortId: c.shortId, phone: c.phone };
}
async function missedCall(client: { id: string; phone: string }) {
  const row = await prisma.incomingCall.create({
    data: {
      channelId: `brain-${runId}-${seq++}`,
      phone: client.phone,
      startedAt: new Date(Date.now() - 60_000),
      answered: false,
      clientId: client.id,
    },
  });
  callIds.push(row.id);
}

beforeAll(async () => {
  agentA = await createTestAgent(nameA);
  agentB = await createTestAgent(`Другой мозг ${runId}`);
  director = await createTestAgent(`Директор мозга ${runId}`, "DIRECTOR");

  cA = await makeClient({ assignedAgentId: agentA });
  cB = await makeClient({ assignedAgentId: agentB });
  cTrash = await makeClient({ assignedAgentId: agentA, deletedAt: new Date() });
  cPending = await makeClient({ assignedAgentId: agentA, acceptedAt: null, assignedAt: new Date() });

  // Просроченная задача — встреча вчера (не CALL/MESSAGE: те засчитались бы перезвоном).
  const yesterday = new Date(Date.now() - 26 * 60 * 60 * 1000);
  for (const clientId of [cA.id, cTrash.id]) {
    await prisma.interaction.create({
      data: { clientId, agentId: agentA, type: "MEETING", notes: "н", nextAction: `перезвонить ${runId}`, nextActionDate: yesterday },
    });
  }
  // Показ сегодня по Душанбе, в 23:59: до этого часа он не «просрочен» для get_unworked
  // (там срок < сейчас), так что счёт просрочек ниже не зависит от времени прогона.
  await prisma.interaction.create({
    data: {
      clientId: cA.id, agentId: agentA, type: "SHOWING", notes: "показ", nextAction: "Показ объекта",
      nextActionDate: dushanbeInputToDate(dushanbeDateString(), "23:59"),
    },
  });
});

afterAll(async () => {
  await prisma.incomingCall.deleteMany({ where: { id: { in: callIds } } });
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.integrationHealthSnapshot.deleteMany({ where: { name: SNAPSHOT_NAME } });
  await deleteAgentsWithTraces([agentA, agentB, director]);
  await prisma.$disconnect();
});

describe("реестр и общая группа", () => {
  const names = brainReadTools.map((p) => p.name);

  it("все шесть зарегистрированы как чтение и закрыты в общей группе Telegram", () => {
    expect(names.sort()).toEqual(
      ["get_day_snapshot", "get_missed_calls", "get_my_day", "get_stuck_work", "get_team_load", "get_unworked"],
    );
    for (const name of names) expect(findAssistantToolPlugin(name)?.level).toBe("A");
    expect(names.filter((n) => !groupHiddenToolsForTests().has(n))).toEqual([]);
  });

  it("в группе — не объявляются и отказывают даже руководству (вторая стена)", async () => {
    const group = actorLeader({ surface: "telegram-group" });
    for (const name of names) {
      expect(tool(name).allowed!(group), name).toBe(false);
      expect((await call(name, {}, group)).error, name).toMatch(/личном чате/);
    }
  });
});

/**
 * Показ засеян на 23:59 по Душанбе «сегодня» — в последнюю минуту суток он уже просрочен и счёт
 * просрочек разойдётся. Часы (только Date) на время теста ставим на полдень этих суток: результат
 * не зависит от минуты прогона. Запросы к базе и таймеры не трогаем.
 */
function useNoonClock(): void {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(dushanbeInputToDate(dushanbeDateString(), "12:00"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });
}

describe("get_unworked", () => {
  useNoonClock();
  it("агент видит только своё: свою просрочку и своих без контакта, без Корзины", async () => {
    const own = await call("get_unworked", {}, actorA());
    expect(own.scope).toBe("только ваше");
    expect(own.byAgent).toBeUndefined();
    expect(own.counts.overdueTasks).toBe(1);
    const overdueHrefs = own.overdueTasks.map((r: any) => r.client.href);
    expect(overdueHrefs).toEqual([`/clients/${cA.shortId}`]);
    const noContactHrefs = own.noContact.map((r: any) => r.client.href);
    expect(noContactHrefs).toContain(`/clients/${cA.shortId}`);
    expect(noContactHrefs).not.toContain(`/clients/${cTrash.shortId}`);
    expect(noContactHrefs).not.toContain(`/clients/${cB.shortId}`);
    expect(typeof own.display).toBe("string");

    const other = await call("get_unworked", {}, actorB());
    expect(other.overdueTasks.map((r: any) => r.client.href)).not.toContain(`/clients/${cA.shortId}`);
    // Имя сотрудника агенту ничего не открывает: без права «Контроль» — только своё.
    const sneaky = await call("get_unworked", { agent: nameA }, actorB());
    expect(sneaky.scope).toBe("только ваше");
    expect(sneaky.overdueTasks.map((r: any) => r.client.href)).not.toContain(`/clients/${cA.shortId}`);
  });

  it("руководитель: по имени сотрудника — ровно его, по всей компании — с разбивкой", async () => {
    const one = await call("get_unworked", { agent: nameA }, actorLeader());
    expect(one.scope).toBe(nameA);
    expect(one.counts.overdueTasks).toBe(1);
    expect(one.overdueTasks[0].client.href).toBe(`/clients/${cA.shortId}`);

    const all = await call("get_unworked", { lang: "tg" }, actorLeader());
    expect(all.counts.overdueTasks).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(all.byAgent)).toBe(true);
    expect(all.byAgent.length).toBeLessThanOrEqual(10);
    expect(all.overdueTasks.length).toBeLessThanOrEqual(10);
    expect(all.display).toContain("Кӣ кор накард");
  });

  it("неизвестное имя — честный отказ, а не «всё отработано»", async () => {
    expect((await call("get_unworked", { agent: `Нетакого${runId}` }, actorLeader())).error).toMatch(/не найден/);
  });
});

describe("get_my_day", () => {
  useNoonClock();
  it("свои показы, просрочка и непринятая заявка; чужие дела не видны", async () => {
    const day = await call("get_my_day", {}, actorA());
    expect(day.scope).toBe("только ваше");
    expect(day.counts.showings).toBe(1);
    expect(day.counts.overdue).toBe(1);
    expect(day.counts.unacceptedLeads).toBe(1);
    expect(day.unacceptedLeads[0].client.href).toBe(`/clients/${cPending.shortId}`);
    expect(day.overdue.map((r: any) => r.client.href)).toEqual([`/clients/${cA.shortId}`]);

    const other = await call("get_my_day", {}, actorB());
    expect(other.counts.showings).toBe(0);
    expect(other.counts.unacceptedLeads).toBe(0);
  });

  it("без права на звонки — блок пропущенных не считается вовсе", async () => {
    const day = await call("get_my_day", {}, actorBare());
    expect(day.counts.missedCallsNoCallback).toBeNull();
    expect(day.missedCalls).toEqual([]);
  });
});

describe("get_missed_calls", () => {
  it("агент — только звонки своих клиентов, номер под маской; Корзина и чужие не видны", async () => {
    const before = await call("get_missed_calls", {}, actorA());
    await missedCall(cA);
    await missedCall(cB);
    await missedCall(cTrash);

    const own = await call("get_missed_calls", {}, actorA());
    expect(own.scope).toBe("только ваши");
    expect(own.total - before.total).toBe(1);
    const hrefs = own.items.map((i: any) => i.client?.href);
    expect(hrefs).toContain(`/clients/${cA.shortId}`);
    expect(hrefs).not.toContain(`/clients/${cB.shortId}`);
    expect(hrefs).not.toContain(`/clients/${cTrash.shortId}`);
    const mine = own.items.find((i: any) => i.client?.href === `/clients/${cA.shortId}`);
    expect(mine.phone).not.toBe(cA.phone);
    expect(mine.phone).toContain("•");

    // get_my_day берёт тот же источник.
    expect((await call("get_my_day", {}, actorA())).counts.missedCallsNoCallback).toBeGreaterThanOrEqual(1);
  });

  it("руководитель видит звонки всей компании, но не из Корзины; без права — отказ", async () => {
    const all = await call("get_missed_calls", { days: 1 }, actorLeader());
    expect(all.scope).toBe("вся компания");
    const hrefs = all.items.map((i: any) => i.client?.href);
    expect(hrefs).not.toContain(`/clients/${cTrash.shortId}`);
    expect(all.items.length).toBeLessThanOrEqual(10);
    expect(all.total).toBeGreaterThanOrEqual(2);
    // mine=true — только свои: у директора своих звонков нет.
    expect((await call("get_missed_calls", { mine: true }, actorLeader())).items.map((i: any) => i.client?.href))
      .not.toContain(`/clients/${cB.shortId}`);

    expect(tool("get_missed_calls").allowed!(actorBare())).toBe(false);
    expect((await call("get_missed_calls", {}, actorBare())).error).toMatch(/Звонки/);
  });
});

describe("get_team_load", () => {
  it("агент — только своя нагрузка, без списка команды", async () => {
    const own = await call("get_team_load", {}, actorA());
    expect(own.scope).toBe("только ваша нагрузка");
    expect(own.agents).toBeUndefined();
    // cA и непринятый cPending — покупатели в работе; Корзина не в счёт.
    expect(own.you.buyersInWork).toBe(2);
    expect(own.leaderboard).toBeUndefined();
  });

  it("руководитель — команда до 10 строк и рейтинг недели", async () => {
    const team = await call("get_team_load", {}, actorLeader());
    expect(team.scope).toBe("вся команда");
    expect(team.agents.length).toBeLessThanOrEqual(10);
    expect(Array.isArray(team.leaderboard)).toBe(true);
    expect(typeof team.display).toBe("string");
  });
});

describe("get_day_snapshot", () => {
  it("без права «Аналитика» — не объявляется и отказывает", async () => {
    expect(tool("get_day_snapshot").allowed!(actorA())).toBe(false);
    expect((await call("get_day_snapshot", {}, actorA())).error).toMatch(/руководство/);
  });

  it("руководителю — снимок; деньги только с finance.view", async () => {
    const withMoney = await call("get_day_snapshot", {}, actorLeader());
    expect(withMoney.scope).toBe("вся компания");
    expect(typeof withMoney.today.newLeads).toBe("number");
    expect(withMoney.attention.overdueTasks).toBeGreaterThanOrEqual(1);
    expect(typeof withMoney.finance.commissionMonthTJS).toBe("number");
    expect(withMoney.display).toContain("💰");

    const noMoney = await call(
      "get_day_snapshot",
      {},
      actorLeader({ canViewFinance: false, permissions: new Set<PermissionId>(LEADER_PERMISSIONS.filter((p) => p !== "finance.view")) }),
    );
    expect(noMoney.finance).toBe("Суммы вам не показываются");
    expect(noMoney.properties.portfolioValueTJS).toBeUndefined();
    expect(noMoney.display).not.toContain("💰");
  });
});

describe("get_stuck_work", () => {
  it("без права на журнал — отказ; с правом — очередь и сломанные доступы из снимка", async () => {
    expect(tool("get_stuck_work").allowed!(actorA())).toBe(false);
    expect((await call("get_stuck_work", {}, actorA())).error).toMatch(/руководство/);

    await prisma.integrationHealthSnapshot.upsert({
      where: { name: SNAPSHOT_NAME },
      create: { name: SNAPSHOT_NAME, ok: false, detail: "ключ отозван" },
      update: { ok: false, detail: "ключ отозван" },
    });
    const stuck = await call("get_stuck_work", {}, actorLeader());
    expect(typeof stuck.counts.givenUp).toBe("number");
    expect(stuck.givenUp.length).toBeLessThanOrEqual(10);
    expect(stuck.integrations.broken.map((b: any) => b.name)).toContain(SNAPSHOT_NAME);
    expect(stuck.display).toContain(SNAPSHOT_NAME);
  });
});
