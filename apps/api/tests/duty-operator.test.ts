import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

const pushed: string[] = [];
vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent: async (agentId: string) => {
    pushed.push(agentId);
    return 1;
  },
}));

import { prisma } from "../src/db.js";
import { loadDutyOperator } from "../src/lib/telephony/callbackConnect.js";
import { loadDutyAgentId } from "../src/lib/telephony/dutyOperator.js";
import { notifyHumanAsk } from "../src/lib/callbackRequests.js";
import { reserveExtensionBase } from "./helpers/extensionBase.js";

/**
 * Дежурный оператор: «человек один» (владелец 28.11.2026). Сначала сотрудник, чей телефон
 * совпадает с номером переадресации (Settings.incomingForwardPhone, по хвосту номера), потом запасной
 * Settings.callbackOperatorAgentId. Единая функция для просьб клиента и автоперезвона пропущенным.
 */

const stamp = String(Date.now()).slice(-6);
let ext = 0;
let saved: { callbackOperatorAgentId: string | null; incomingForwardPhone: string | null; incomingNoAnswerAction: string } | null = null;
const made: string[] = [];

async function agent(over: { phone: string; sipExtension?: string | null; isActive?: boolean; name: string }) {
  const a = await prisma.agent.create({
    data: {
      fullName: `${over.name} ${stamp}`,
      phone: over.phone,
      role: "AGENT",
      passwordHash: "x",
      isActive: over.isActive ?? true,
      sipExtension: over.sipExtension === undefined ? String(ext++) : over.sipExtension,
    },
  });
  made.push(a.id);
  return a;
}

const setDuty = (data: { callbackOperatorAgentId?: string | null; incomingForwardPhone?: string | null; incomingNoAnswerAction?: string }) =>
  prisma.settings.update({ where: { id: "singleton" }, data });

beforeAll(async () => {
  ext = await reserveExtensionBase(8);
  const row = await prisma.settings.upsert({ where: { id: "singleton" }, update: {}, create: { id: "singleton" } });
  saved = { callbackOperatorAgentId: row.callbackOperatorAgentId, incomingForwardPhone: row.incomingForwardPhone, incomingNoAnswerAction: row.incomingNoAnswerAction };
  // Номер переадресации действует в режимах forward и both (как в Настройках).
  await prisma.settings.update({ where: { id: "singleton" }, data: { incomingNoAnswerAction: "both" } });
});

afterAll(async () => {
  if (saved) await prisma.settings.update({ where: { id: "singleton" }, data: saved });
  await prisma.agent.deleteMany({ where: { id: { in: made } } });
  await prisma.$disconnect();
});

describe("loadDutyOperator", () => {
  const fallbackPhone = `+99294${stamp}2`;

  it("номер переадресации найден у сотрудника: он дежурный, даже если запасной другой; запись номера не важна", async () => {
    const owner = await agent({ name: "Принимающий", phone: `+99293${stamp}1` });
    const spare = await agent({ name: "Запасной", phone: fallbackPhone });
    // В настройках номер записан иначе (без плюса, с пробелами): совпадение по хвосту.
    await setDuty({ incomingForwardPhone: `992 93 ${stamp.slice(0, 3)} ${stamp.slice(3)}1`, callbackOperatorAgentId: spare.id });
    expect((await loadDutyOperator())?.id).toBe(owner.id);
  });

  it("номер переадресации не найден у сотрудников: запасной", async () => {
    const spare = await agent({ name: "Запасной 2", phone: `+99294${stamp}3` });
    await setDuty({ incomingForwardPhone: "+992900000000", callbackOperatorAgentId: spare.id });
    expect((await loadDutyOperator())?.id).toBe(spare.id);
  });

  it("сотрудник с этим номером неактивен: запасной", async () => {
    await agent({ name: "Уволенный", phone: `+99291${stamp}4`, isActive: false });
    const spare = await agent({ name: "Запасной 3", phone: `+99294${stamp}5` });
    await setDuty({ incomingForwardPhone: `+99291${stamp}4`, callbackOperatorAgentId: spare.id });
    expect((await loadDutyOperator())?.id).toBe(spare.id);
  });

  it("у сотрудника с этим номером нет внутреннего номера: запасной", async () => {
    await agent({ name: "Без SIP", phone: `+99292${stamp}6`, sipExtension: null });
    const spare = await agent({ name: "Запасной 4", phone: `+99294${stamp}7` });
    await setDuty({ incomingForwardPhone: `+99292${stamp}6`, callbackOperatorAgentId: spare.id });
    expect((await loadDutyOperator())?.id).toBe(spare.id);
  });

  it("номер переадресации пуст: как раньше, только запасной", async () => {
    const spare = await agent({ name: "Запасной 5", phone: `+99294${stamp}8` });
    await setDuty({ incomingForwardPhone: null, callbackOperatorAgentId: spare.id });
    expect((await loadDutyOperator())?.id).toBe(spare.id);
    await setDuty({ incomingForwardPhone: "", callbackOperatorAgentId: spare.id });
    expect((await loadDutyOperator())?.id).toBe(spare.id);
  });

  it("нет ни сотрудника по номеру, ни запасного: дежурного нет", async () => {
    await setDuty({ incomingForwardPhone: "+992900000001", callbackOperatorAgentId: null });
    expect(await loadDutyOperator()).toBeNull();
  });

  it("запасной неактивен: дежурного нет, а не падение", async () => {
    const gone = await agent({ name: "Запасной уволен", phone: `+99294${stamp}9`, isActive: false });
    await setDuty({ incomingForwardPhone: null, callbackOperatorAgentId: gone.id });
    expect(await loadDutyOperator()).toBeNull();
  });
});

describe("один дежурный на все пути", () => {
  it("просьба клиента о живом человеке: уведомление уходит тому же, кого находит loadDutyOperator (по номеру переадресации), а не запасному", async () => {
    const owner = await agent({ name: "Принимает звонки", phone: `+99293${stamp}0` });
    const spare = await agent({ name: "Запасной в настройках", phone: `+99294${stamp}0` });
    await setDuty({ incomingForwardPhone: `+99293${stamp}0`, callbackOperatorAgentId: spare.id });
    pushed.length = 0;
    const res = await notifyHumanAsk({
      conversationId: randomUUID(),
      clientId: null,
      channel: "LIVE_VOICE",
      topic: "хочу квартиру",
      clientText: "дайте менеджера",
    });
    expect(res).toBe("sent");
    expect(pushed).toEqual([owner.id]);
    expect((await loadDutyOperator())?.id).toBe(owner.id);
  });

  it("уведомление и звонок одному человеку: у держателя номера нет внутреннего номера, оба идут к запасному", async () => {
    await agent({ name: "Принимает без SIP", phone: `+99293${stamp}7`, sipExtension: null });
    const spare = await agent({ name: "Запасной с SIP", phone: `+99295${stamp}7` });
    await setDuty({ incomingForwardPhone: `+99293${stamp}7`, callbackOperatorAgentId: spare.id });
    expect(await loadDutyAgentId()).toBe(spare.id);
    expect((await loadDutyOperator())?.id).toBe(spare.id);
  });

  it("звонить некому (ни у кого нет внутреннего номера): уведомление всё равно уходит человеку по номеру", async () => {
    const noSip = await agent({ name: "Единственный без SIP", phone: `+99293${stamp}8`, sipExtension: null });
    const spareNoSip = await agent({ name: "Запасной без SIP", phone: `+99295${stamp}8`, sipExtension: null });
    await setDuty({ incomingForwardPhone: `+99293${stamp}8`, callbackOperatorAgentId: spareNoSip.id });
    expect(await loadDutyOperator()).toBeNull();
    expect(await loadDutyAgentId()).toBe(noSip.id);
  });

  it("номер переадресации не используется, когда правило «если оператор не ответил» его не применяет", async () => {
    const owner = await agent({ name: "Держатель номера", phone: `+99293${stamp}9` });
    const spare = await agent({ name: "Запасной режим none", phone: `+99295${stamp}9` });
    await setDuty({ incomingForwardPhone: `+99293${stamp}9`, callbackOperatorAgentId: spare.id, incomingNoAnswerAction: "none" });
    expect((await loadDutyOperator())?.id).toBe(spare.id);
    await setDuty({ incomingNoAnswerAction: "forward" });
    expect((await loadDutyOperator())?.id).toBe(owner.id);
    await setDuty({ incomingNoAnswerAction: "both" });
    expect((await loadDutyOperator())?.id).toBe(owner.id);
  });

  it("несколько сотрудников с одним хвостом номера: выбор детерминированный, у кого есть внутренний номер, затем самый давний", async () => {
    // Один и тот же номер, записанный по-разному (телефон сотрудника уникален только как строка).
    await agent({ name: "Дубль без SIP", phone: `+99296${stamp}1`, sipExtension: null });
    const older = await agent({ name: "Дубль с SIP старший", phone: `99296${stamp}1` });
    await agent({ name: "Дубль с SIP младший", phone: `+992 96${stamp}1` });
    await setDuty({ incomingForwardPhone: `+99296${stamp}1`, callbackOperatorAgentId: null });
    expect((await loadDutyOperator())?.id).toBe(older.id);
    expect(await loadDutyAgentId()).toBe(older.id);
  });
});
