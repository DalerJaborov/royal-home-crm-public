import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/** Звонок через станцию подменён: проверяем решения очереди, а не станцию. Остальное в модуле настоящее. */
const dialMock = vi.fn();
vi.mock("../src/lib/telephony/callbackConnect.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/telephony/callbackConnect.js")>()),
  dialOperatorThenClient: (...args: unknown[]) => dialMock(...args),
}));

const { prisma } = await import("../src/db.js");
const { scheduleMissedCallRedial, runMissedCallRedialTick } = await import("../src/lib/telephony/missedCallRedial.js");
const { beginOrigination, endOrigination } = await import("../src/lib/telephony/callTracker.js");
const { reserveExtensionBase } = await import("./helpers/extensionBase.js");

/**
 * Автоперезвон пропущенным (28.11.2026): рубильник, защиты, одна очередь на номер, исход попытки,
 * gave_up после трёх неудач, ночь, занятый дежурный, чистка. Время передаётся в функции явно.
 * Душанбе = UTC+5: 06:00Z это 11:00 (рабочее окно 09:30-18:00), 18:00Z это 23:00 (ночь).
 */

const stamp = String(Date.now()).slice(-5);
let seq = 0;
const mobile = () => `+99290${stamp}${String(++seq).padStart(2, "0")}`;
const DAY = new Date("2026-11-30T06:00:00Z");
const NIGHT = new Date("2026-11-30T18:00:00Z");
const min = (d: Date, m: number) => new Date(d.getTime() + m * 60_000);

let saved: Record<string, unknown> | null = null;
let dutyId = "";
const madeAgents: string[] = [];
const madeClients: string[] = [];

const KEYS = [
  "missedCallRedialEnabled",
  "missedCallRedialDelays",
  "missedCallRedialJunkEnabled",
  "callbackOperatorAgentId",
  "incomingForwardPhone",
  "workHoursStart",
  "workHoursEnd",
] as const;

const setSettings = (data: Record<string, unknown>) => prisma.settings.update({ where: { id: "singleton" }, data });
const rowFor = (phone: string) => prisma.missedCallRedial.findFirst({ where: { phone }, orderBy: { createdAt: "desc" } });

async function client(phone: string) {
  const c = await prisma.client.create({ data: { fullName: `Автоперезвон ${stamp}-${seq}`, phone, source: "PHONE_CALL" } });
  madeClients.push(c.id);
  return c;
}

async function dueRow(phone: string, data: Record<string, unknown> = {}) {
  return prisma.missedCallRedial.create({ data: { phone, nextAttemptAt: new Date(DAY.getTime() - 60_000), ...data } });
}

beforeAll(async () => {
  const row = await prisma.settings.upsert({ where: { id: "singleton" }, update: {}, create: { id: "singleton" } });
  saved = Object.fromEntries(KEYS.map((k) => [k, (row as Record<string, unknown>)[k]]));
  const base = await reserveExtensionBase(2);
  const duty = await prisma.agent.create({
    data: { fullName: `Дежурный автоперезвон ${stamp}`, phone: `+99298${stamp}00`, role: "AGENT", passwordHash: "x", sipExtension: String(base) },
  });
  dutyId = duty.id;
  madeAgents.push(duty.id);
});

beforeEach(async () => {
  dialMock.mockReset();
  dialMock.mockResolvedValue({ outcome: "connected", interactionId: null });
  await prisma.missedCallRedial.deleteMany({});
  await setSettings({
    missedCallRedialEnabled: true,
    missedCallRedialDelays: "5,30,120",
    missedCallRedialJunkEnabled: false,
    callbackOperatorAgentId: dutyId,
    incomingForwardPhone: null,
    workHoursStart: "09:30",
    workHoursEnd: "18:00",
  });
});

afterEach(() => {
  endOrigination(dutyId);
});

afterAll(async () => {
  await prisma.missedCallRedial.deleteMany({});
  if (saved) await prisma.settings.update({ where: { id: "singleton" }, data: saved });
  await prisma.interaction.deleteMany({ where: { clientId: { in: madeClients } } });
  await prisma.incomingCall.deleteMany({ where: { phone: { startsWith: "+99290" } } });
  await prisma.client.deleteMany({ where: { id: { in: madeClients } } });
  await prisma.agent.deleteMany({ where: { id: { in: madeAgents } } });
  await prisma.$disconnect();
});

describe("постановка в очередь", () => {
  it("рубильник выключен: ничего не ставится и не звонится", async () => {
    await setSettings({ missedCallRedialEnabled: false });
    const phone = mobile();
    expect(await scheduleMissedCallRedial({ phone, now: DAY })).toBe("disabled");
    expect(await rowFor(phone)).toBeNull();
    expect(await runMissedCallRedialTick(DAY)).toBe("disabled");
    expect(dialMock).not.toHaveBeenCalled();
  });

  it("включён: строка с первой попыткой через 5 минут", async () => {
    const phone = mobile();
    expect(await scheduleMissedCallRedial({ phone, now: DAY })).toBe("scheduled");
    const row = await rowFor(phone);
    expect(row?.status).toBe("pending");
    expect(row?.attempts).toBe(0);
    expect(row?.nextAttemptAt).toEqual(min(DAY, 5));
  });

  it("ночной пропущенный: первая попытка утром 09:30", async () => {
    const phone = mobile();
    await scheduleMissedCallRedial({ phone, now: NIGHT });
    expect((await rowFor(phone))?.nextAttemptAt).toEqual(new Date("2026-12-01T04:30:00Z"));
  });

  it("повторный звонок с того же номера не плодит вторую очередь", async () => {
    const phone = mobile();
    await scheduleMissedCallRedial({ phone, now: DAY });
    const first = await rowFor(phone);
    expect(await scheduleMissedCallRedial({ phone, now: min(DAY, 1) })).toBe("already_queued");
    expect(await prisma.missedCallRedial.count({ where: { phone } })).toBe(1);
    expect((await rowFor(phone))?.nextAttemptAt).toEqual(first?.nextAttemptAt);
  });

  it("два звонка одновременно: одна строка (частичный уникальный индекс)", async () => {
    const phone = mobile();
    const results = await Promise.all([scheduleMissedCallRedial({ phone, now: DAY }), scheduleMissedCallRedial({ phone, now: DAY })]);
    expect(results.filter((r) => r === "scheduled").length).toBe(1);
    expect(await prisma.missedCallRedial.count({ where: { phone } })).toBe(1);
  });

  it("защиты: иностранный, сотрудник, номер компании, «не по делу», пустой номер", async () => {
    expect(await scheduleMissedCallRedial({ phone: "+79161234567", now: DAY })).toBe("not_dialable");
    expect(await scheduleMissedCallRedial({ phone: "", now: DAY })).toBe("no_phone");
    expect(await scheduleMissedCallRedial({ phone: "+992777776001", now: DAY })).toBe("company_number");

    const staffPhone = mobile();
    const staff = await prisma.agent.create({ data: { fullName: `Сотрудник ${stamp}-${seq}`, phone: staffPhone, role: "AGENT", passwordHash: "x" } });
    madeAgents.push(staff.id);
    expect(await scheduleMissedCallRedial({ phone: staffPhone, now: DAY })).toBe("staff");

    const junk = mobile();
    await prisma.incomingCall.create({ data: { channelId: `redial-${stamp}-${seq}`, phone: junk, irrelevant: true } });
    expect(await scheduleMissedCallRedial({ phone: junk, now: DAY })).toBe("irrelevant");
    expect(await prisma.missedCallRedial.count()).toBe(0);
  });

  it("недавно закрытая серия: новую не начинаем сразу", async () => {
    const phone = mobile();
    await prisma.missedCallRedial.create({ data: { phone, status: "gave_up", nextAttemptAt: DAY } });
    expect(await scheduleMissedCallRedial({ phone, now: new Date() })).toBe("recent_series");
  });
});

describe("тик: звонок и его исход", () => {
  it("рано: ждёт; подошло время: звонит дежурному один раз и ждёт итога", async () => {
    const phone = mobile();
    const c = await client(phone);
    await dueRow(phone, { clientId: c.id, nextAttemptAt: min(DAY, 5) });
    expect(await runMissedCallRedialTick(DAY)).toBe("idle");
    expect(dialMock).not.toHaveBeenCalled();

    expect(await runMissedCallRedialTick(min(DAY, 5))).toBe("dialed");
    expect(dialMock).toHaveBeenCalledTimes(1);
    const arg = dialMock.mock.calls[0][0] as { operator: { id: string }; phone: string; callerName: string };
    expect(arg.operator.id).toBe(dutyId);
    expect(arg.phone).toBe(phone);
    expect(arg.callerName).toContain("Пропущенный");
    const row = await rowFor(phone);
    expect(row?.attempts).toBe(1);
    expect(row?.lastOutcome).toBeNull();

    // Следующий тик той же строкой не звонит: итог ещё не известен.
    expect(await runMissedCallRedialTick(min(DAY, 6))).toBe("idle");
    expect(dialMock).toHaveBeenCalledTimes(1);
  });

  it("не дозвонились: следующая попытка через 30 минут, не раньше", async () => {
    const phone = mobile();
    const c = await client(phone);
    const call = await prisma.interaction.create({ data: { actorKind: "AGENT", agentId: dutyId, clientId: c.id, type: "CALL", notes: "авто", callAttempt: "NO_ANSWER" } });
    await dueRow(phone, { clientId: c.id, attempts: 1, lastAttemptAt: DAY, lastInteractionId: call.id, nextAttemptAt: DAY });
    await runMissedCallRedialTick(min(DAY, 2));
    const row = await rowFor(phone);
    expect(row?.lastOutcome).toBe("no_answer");
    expect(row?.status).toBe("pending");
    expect(row?.nextAttemptAt).toEqual(min(DAY, 30));
    expect(dialMock).not.toHaveBeenCalled();
  });

  it("дозвонились: серия закрыта done, больше не звоним", async () => {
    const phone = mobile();
    const c = await client(phone);
    const call = await prisma.interaction.create({ data: { actorKind: "AGENT", agentId: dutyId, clientId: c.id, type: "CALL", notes: "авто", callAttempt: "TALKED" } });
    await dueRow(phone, { clientId: c.id, attempts: 1, lastAttemptAt: DAY, lastInteractionId: call.id });
    await runMissedCallRedialTick(min(DAY, 20));
    const row = await rowFor(phone);
    expect(row?.status).toBe("done");
    expect(row?.closedReason).toBe("answered");
    expect(dialMock).not.toHaveBeenCalled();
  });

  it("после трёх неудач: gave_up, запись в хронологии, карточка на месте, больше не звоним", async () => {
    const phone = mobile();
    const c = await client(phone);
    const call = await prisma.interaction.create({ data: { actorKind: "AGENT", agentId: dutyId, clientId: c.id, type: "CALL", notes: "авто", callAttempt: "NO_ANSWER" } });
    await dueRow(phone, { clientId: c.id, attempts: 3, lastAttemptAt: DAY, lastInteractionId: call.id });
    await runMissedCallRedialTick(min(DAY, 5));
    const row = await rowFor(phone);
    expect(row?.status).toBe("gave_up");
    const note = await prisma.interaction.findFirst({ where: { clientId: c.id, notes: { contains: "не дозвонились" } } });
    expect(note).not.toBeNull();
    expect(await prisma.client.findUnique({ where: { id: c.id } })).not.toBeNull();
    expect(await runMissedCallRedialTick(min(DAY, 600))).toBe("idle");
    expect(dialMock).not.toHaveBeenCalled();
  });

  it("человек сам дозвонился или оставил голосовое: не звоним", async () => {
    const answered = mobile();
    const a = await dueRow(answered);
    await prisma.incomingCall.create({ data: { channelId: `redial-a-${stamp}-${seq}`, phone: answered, answered: true, startedAt: DAY } });
    expect(await runMissedCallRedialTick(DAY)).toBe("closed");
    expect((await prisma.missedCallRedial.findUnique({ where: { id: a.id } }))?.closedReason).toBe("self_answered");

    const voicemail = mobile();
    const v = await dueRow(voicemail);
    await prisma.incomingCall.create({ data: { channelId: `redial-v-${stamp}-${seq}`, phone: voicemail, voicemailFile: "x.wav", startedAt: DAY } });
    expect(await runMissedCallRedialTick(DAY)).toBe("closed");
    expect((await prisma.missedCallRedial.findUnique({ where: { id: v.id } }))?.closedReason).toBe("voicemail");
    expect(dialMock).not.toHaveBeenCalled();
  });

  it("ночью не звонит, а переносит на утро", async () => {
    const phone = mobile();
    await dueRow(phone, { nextAttemptAt: new Date(NIGHT.getTime() - 60_000) });
    expect(await runMissedCallRedialTick(NIGHT)).toBe("off_hours");
    expect(dialMock).not.toHaveBeenCalled();
    expect((await rowFor(phone))?.nextAttemptAt).toEqual(new Date("2026-12-01T04:30:00Z"));
  });

  it("дежурный занят: попытка не сгорает, переносится на 2 минуты", async () => {
    const phone = mobile();
    await dueRow(phone);
    expect(beginOrigination(dutyId)).toBe(true);
    expect(await runMissedCallRedialTick(DAY)).toBe("operator_busy");
    const row = await rowFor(phone);
    expect(row?.attempts).toBe(0);
    expect(row?.nextAttemptAt).toEqual(min(DAY, 2));
    expect(dialMock).not.toHaveBeenCalled();
  });

  it("дежурного нет: ждёт, попытка не сгорает", async () => {
    await setSettings({ callbackOperatorAgentId: null });
    const phone = mobile();
    await dueRow(phone);
    expect(await runMissedCallRedialTick(DAY)).toBe("no_operator");
    expect((await rowFor(phone))?.attempts).toBe(0);
  });

  it("станция не набрала: засчитывается попыткой, следующая по расписанию", async () => {
    dialMock.mockResolvedValue({ outcome: "failed", interactionId: null });
    const phone = mobile();
    await dueRow(phone);
    expect(await runMissedCallRedialTick(DAY)).toBe("failed");
    const row = await rowFor(phone);
    expect(row?.attempts).toBe(1);
    expect(row?.lastOutcome).toBe("failed");
    expect(row?.nextAttemptAt).toEqual(min(DAY, 30));
  });

  it("за один тик набирается ровно один номер", async () => {
    await dueRow(mobile());
    await dueRow(mobile());
    expect(await runMissedCallRedialTick(DAY)).toBe("dialed");
    expect(dialMock).toHaveBeenCalledTimes(1);
  });
});

describe("чистка (рубильник)", () => {
  it("включена: после неудач и недели тишины автозадача закрывается, карточка остаётся", async () => {
    await setSettings({ missedCallRedialJunkEnabled: true });
    const phone = mobile();
    const c = await client(phone);
    const task = await prisma.interaction.create({
      data: { actorKind: "AGENT", agentId: dutyId, clientId: c.id, type: "SYSTEM", notes: "перезвонить", autoTaskKind: "inbound_missed_callback", nextAction: "Перезвонить", nextActionDate: DAY },
    });
    const old = new Date(DAY.getTime() - 8 * 24 * 3600_000);
    await prisma.missedCallRedial.create({
      data: { phone, clientId: c.id, status: "gave_up", closedReason: "attempts_exhausted", attempts: 3, lastAttemptAt: old, nextAttemptAt: old },
    });
    await runMissedCallRedialTick(DAY);
    expect((await prisma.interaction.findUnique({ where: { id: task.id } }))?.completedAt).not.toBeNull();
    expect((await rowFor(phone))?.status).toBe("junk");
    expect(await prisma.client.findUnique({ where: { id: c.id } })).not.toBeNull();
  });

  it("выключена: задача не трогается", async () => {
    const phone = mobile();
    const c = await client(phone);
    const task = await prisma.interaction.create({
      data: { actorKind: "AGENT", agentId: dutyId, clientId: c.id, type: "SYSTEM", notes: "перезвонить", autoTaskKind: "inbound_missed_callback", nextAction: "Перезвонить", nextActionDate: DAY },
    });
    const old = new Date(DAY.getTime() - 8 * 24 * 3600_000);
    await prisma.missedCallRedial.create({
      data: { phone, clientId: c.id, status: "gave_up", closedReason: "attempts_exhausted", attempts: 3, lastAttemptAt: old, nextAttemptAt: old },
    });
    await runMissedCallRedialTick(DAY);
    expect((await prisma.interaction.findUnique({ where: { id: task.id } }))?.completedAt).toBeNull();
  });

  it("клиент звонил снова после неудач: чистка не закрывает задачу", async () => {
    await setSettings({ missedCallRedialJunkEnabled: true });
    const phone = mobile();
    const c = await client(phone);
    const task = await prisma.interaction.create({
      data: { actorKind: "AGENT", agentId: dutyId, clientId: c.id, type: "SYSTEM", notes: "перезвонить", autoTaskKind: "inbound_missed_callback", nextAction: "Перезвонить", nextActionDate: DAY },
    });
    const old = new Date(DAY.getTime() - 8 * 24 * 3600_000);
    await prisma.missedCallRedial.create({
      data: { phone, clientId: c.id, status: "gave_up", closedReason: "attempts_exhausted", attempts: 3, lastAttemptAt: old, nextAttemptAt: old },
    });
    await prisma.incomingCall.create({ data: { channelId: `redial-l-${stamp}-${seq}`, phone, startedAt: new Date(DAY.getTime() - 24 * 3600_000) } });
    await runMissedCallRedialTick(DAY);
    expect((await prisma.interaction.findUnique({ where: { id: task.id } }))?.completedAt).toBeNull();
  });
});

describe("замечания ревью 28.11", () => {
  it("без карточки одна попытка: итог не виден, повторов нет (gave_up, outcome_unseen)", async () => {
    const phone = mobile();
    await dueRow(phone);
    expect(await runMissedCallRedialTick(DAY)).toBe("dialed");
    const row = await rowFor(phone);
    expect(row?.status).toBe("gave_up");
    expect(row?.closedReason).toBe("outcome_unseen");
    expect(row?.attempts).toBe(1);
    expect(await runMissedCallRedialTick(min(DAY, 600))).toBe("idle");
    expect(dialMock).toHaveBeenCalledTimes(1);
  });

  it("сбой базы после набора: срок сдвигается вторым запросом, номер не набирается каждую минуту", async () => {
    const phone = mobile();
    const c = await client(phone);
    await dueRow(phone, { clientId: c.id });
    const spy = vi.spyOn(prisma.missedCallRedial, "update").mockRejectedValueOnce(new Error("база моргнула"));
    expect(await runMissedCallRedialTick(DAY)).toBe("failed");
    spy.mockRestore();
    const row = await rowFor(phone);
    expect(row?.attempts).toBe(1);
    expect(row?.nextAttemptAt).toEqual(min(DAY, 15));
    expect(await runMissedCallRedialTick(min(DAY, 1))).toBe("idle");
    expect(dialMock).toHaveBeenCalledTimes(1);
  });

  it("база не отвечает и на второй запрос: номер под замком в памяти, второго набора нет", async () => {
    const phone = mobile();
    const c = await client(phone);
    await dueRow(phone, { clientId: c.id });
    const spy = vi.spyOn(prisma.missedCallRedial, "update").mockRejectedValue(new Error("база лежит"));
    expect(await runMissedCallRedialTick(DAY)).toBe("failed");
    spy.mockRestore();
    expect(await runMissedCallRedialTick(min(DAY, 1))).toBe("idle");
    expect(dialMock).toHaveBeenCalledTimes(1);
  });

  it("дежурный не снял трубку: попытка клиента не тратится, пауза 2 минуты, потом 30, потом сдаёмся", async () => {
    const phone = mobile();
    const c = await client(phone);
    const call = await prisma.interaction.create({
      data: { actorKind: "AGENT", agentId: dutyId, clientId: c.id, type: "CALL", notes: "авто", callAttempt: "AGENT_NO_PICKUP" },
    });
    const row = await dueRow(phone, { clientId: c.id, attempts: 1, lastAttemptAt: DAY, lastInteractionId: call.id, nextAttemptAt: DAY });
    const at = min(DAY, 1);
    await runMissedCallRedialTick(at);
    let cur = await prisma.missedCallRedial.findUnique({ where: { id: row.id } });
    expect(cur?.attempts).toBe(0);
    expect(cur?.operatorNoPickups).toBe(1);
    expect(cur?.status).toBe("pending");
    expect(cur?.nextAttemptAt).toEqual(min(at, 2));

    // Четвёртое молчание подряд: пауза подлиннее.
    await prisma.missedCallRedial.update({ where: { id: row.id }, data: { attempts: 1, operatorNoPickups: 3, lastOutcome: null, lastAttemptAt: DAY } });
    await runMissedCallRedialTick(at);
    cur = await prisma.missedCallRedial.findUnique({ where: { id: row.id } });
    expect(cur?.nextAttemptAt).toEqual(min(at, 30));

    // Восьмое: звонить некому.
    await prisma.missedCallRedial.update({ where: { id: row.id }, data: { attempts: 1, operatorNoPickups: 7, lastOutcome: null, lastAttemptAt: DAY } });
    await runMissedCallRedialTick(at);
    cur = await prisma.missedCallRedial.findUnique({ where: { id: row.id } });
    expect(cur?.status).toBe("gave_up");
    expect(cur?.closedReason).toBe("operator_unreachable");
    expect(dialMock).not.toHaveBeenCalled();
  });

  it("голосовое: замок VoicemailMessage (он встаёт раньше, чем имя файла в звонке) тоже останавливает перезвон", async () => {
    const phone = mobile();
    const r = await dueRow(phone);
    await prisma.voicemailMessage.create({ data: { file: `vm-${stamp}-${seq}.wav`, phone, recordedAt: DAY } });
    expect(await runMissedCallRedialTick(DAY)).toBe("closed");
    expect((await prisma.missedCallRedial.findUnique({ where: { id: r.id } }))?.closedReason).toBe("voicemail");
    expect(dialMock).not.toHaveBeenCalled();
    await prisma.voicemailMessage.deleteMany({ where: { phone } });
  });

  it("открыта просьба «перезвоните»: не звоним (skipped, причина)", async () => {
    const phone = mobile();
    const r = await dueRow(phone);
    const req = await prisma.callbackRequest.create({ data: { channel: "LIVE_VOICE", phone, topic: "позвоните", byClientRequest: true } });
    expect(await runMissedCallRedialTick(DAY)).toBe("closed");
    const cur = await prisma.missedCallRedial.findUnique({ where: { id: r.id } });
    expect([cur?.status, cur?.closedReason]).toEqual(["skipped", "open_callback_request"]);
    await prisma.callbackRequest.delete({ where: { id: req.id } });
  });

  it("у агента висит его задача «перезвонить»: не звоним; общая задача без агента не мешает", async () => {
    const mine = mobile();
    const c1 = await client(mine);
    const r1 = await dueRow(mine, { clientId: c1.id });
    await prisma.interaction.create({
      data: {
        actorKind: "AGENT",
        agentId: dutyId,
        subjectAgentId: dutyId,
        clientId: c1.id,
        type: "SYSTEM",
        notes: "перезвонить",
        autoTaskKind: "inbound_missed_callback",
        nextAction: "Перезвонить",
        nextActionDate: DAY,
      },
    });
    expect(await runMissedCallRedialTick(DAY)).toBe("closed");
    expect((await prisma.missedCallRedial.findUnique({ where: { id: r1.id } }))?.closedReason).toBe("agent_task");
    expect(dialMock).not.toHaveBeenCalled();

    const shared = mobile();
    const c2 = await client(shared);
    await dueRow(shared, { clientId: c2.id });
    await prisma.interaction.create({
      data: { actorKind: "AGENT", agentId: dutyId, clientId: c2.id, type: "SYSTEM", notes: "перезвонить", autoTaskKind: "inbound_missed_callback", nextAction: "Перезвонить", nextActionDate: DAY },
    });
    expect(await runMissedCallRedialTick(DAY)).toBe("dialed");
  });
});
