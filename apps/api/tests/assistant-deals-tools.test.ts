import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomInt } from "node:crypto";

/**
 * «СДЕЛКИ» У ШАБНАМ (10.11.2026): чтение и запись раздела сделок через личку.
 *
 * Держим: агент видит только свои доли, руководство — все; в группе — ничего;
 * запись — карточкой и ровно один раз при двойном «Подтвердить»; изменившаяся
 * сделка — STALE; переоценка закрытой — до копейки как REST (одна функция);
 * повторная выплата — отказ; доллары — только с курсом и в валюте сделки.
 * Исполнение — те же lib/dealWrites.ts, что у REST, поэтому журнал действий —
 * строки REST (DEAL_PAYOUT и т.п.) плюс строка брокера ASSISTANT_*.
 */

const { push } = vi.hoisted(() => ({ push: vi.fn(async () => undefined) }));
vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent: push,
  sendPushToAgents: push,
}));

const { prisma } = await import("../src/db.js");
await import("../src/ai/assistant/tools/index.js");
const { findAssistantToolPlugin } = await import("../src/ai/assistant/tools/index.js");
const { createPendingAssistantAction, confirmAssistantAction, AssistantActionError } = await import("../src/lib/assistantActions.js");
const { loadAgentAccess, invalidateAgentAccess } = await import("../src/auth/middleware.js");
const { actorFromAccess } = await import("../src/ai/assistant/actor.js");
const { pluginDeclarations } = await import("../src/ai/assistant.js");
const { cleanupAssistantActionAgents } = await import("./helpers/assistantActionFixture.js");
const { waitForCount, waitForSettled } = await import("./helpers/waitFor.js");
const request = (await import("supertest")).default;
const { app } = await import("../src/app.js");
const { signAccessToken } = await import("../src/auth/jwt.js");
const { upsertSalaryExpenses } = await import("../src/lib/financeAutomation.js");
const { dealSalaryAutoKey } = await import("../src/lib/companyProfit.js");
const { monthKeyOfInstant } = await import("../src/lib/dealPayouts.js");
type ReadPlugin = import("../src/ai/assistant/tools/types.js").AssistantReadToolPlugin;
type Surface = "crm-private" | "telegram-private" | "telegram-group";

const runId = `${Date.now()}`.slice(-7) + randomInt(100, 999);
const phone = () => `+99291${randomInt(1_000_000, 9_999_999)}`;
const agentIds: string[] = [];
const clientIds: string[] = [];
const propertyIds: string[] = [];
const dealIds: string[] = [];
let districtId = "";
let agentA = "";
let agentB = "";
let director = "";
let savedRate: unknown = null;

async function agent(role: string, name: string) {
  const row = await prisma.agent.create({ data: { fullName: `${name} ${runId}`, phone: phone(), role: role as never, passwordHash: "x" } });
  agentIds.push(row.id);
  return row.id;
}

async function readActor(id: string, surface: Surface = "telegram-private") {
  const access = await loadAgentAccess(id);
  return actorFromAccess(id, access!, surface);
}

async function writeActor(id: string, privateChat = true) {
  const access = await loadAgentAccess(id);
  return { agentId: id, channel: "telegram" as const, telegramPrivate: privateChat, can: (p: string) => access!.permissions.has(p as never) };
}

const read = (name: string) => findAssistantToolPlugin(name) as ReadPlugin;

interface DealOpts {
  agentId: string;
  stage: "NEGOTIATION" | "CONTRACT_SIGNED" | "PENDING_APPROVAL" | "COMPLETED";
  currency?: "TJS" | "USD";
  commission?: number;
  intake?: number | null;
  realtor?: number | null;
  company?: number | null;
  soldPrice?: number | null;
  showing?: boolean;
}

async function makeDeal(o: DealOpts) {
  const currency = o.currency ?? "TJS";
  const client = await prisma.client.create({
    data: {
      fullName: `Покупатель сделки ${runId} ${clientIds.length}`,
      phone: phone(),
      source: "PHONE_CALL",
      kind: "BUYER",
      status: "HOT",
      assignedAgentId: o.agentId,
      acceptedAt: new Date(),
    },
  });
  clientIds.push(client.id);
  const closed = o.stage === "COMPLETED";
  const property = await prisma.property.create({
    data: {
      title: `Объект сделки ${runId} ${propertyIds.length}`,
      type: "APARTMENT",
      areaSqm: 60,
      price: currency === "USD" ? 75000 : 100000,
      currency,
      districtId,
      address: "Тестовая, сделки помощницы",
      condition: "GOOD",
      status: closed ? "SOLD" : "RESERVED",
      assignedAgentId: o.agentId,
      reservedForClientId: closed ? null : client.id,
      reservedAt: closed ? null : new Date(),
    },
  });
  propertyIds.push(property.id);
  const deal = await prisma.deal.create({
    data: {
      clientId: client.id,
      propertyId: property.id,
      agentId: o.agentId,
      stage: o.stage,
      currency,
      commissionAmount: o.commission ?? 2000,
      commissionPercent: 2,
      commissionIntakeAmount: o.intake === undefined ? (closed ? 0 : null) : o.intake,
      commissionRealtorAmount: o.realtor === undefined ? (closed ? 500 : null) : o.realtor,
      commissionCompanyAmount: o.company === undefined ? (closed ? 1500 : null) : o.company,
      soldPrice: o.soldPrice === undefined ? (closed ? 100000 : null) : o.soldPrice,
      closedAt: closed ? new Date() : null,
    },
  });
  dealIds.push(deal.id);
  if (o.showing) {
    await prisma.interaction.create({
      data: { clientId: client.id, propertyId: property.id, agentId: o.agentId, type: "SHOWING", notes: "Показ проведён", completedAt: new Date() },
    });
  }
  return { deal, client, property };
}

async function setRate(rate: number | null) {
  await prisma.settings.update({ where: { id: "singleton" }, data: { usdToTjsRate: rate } });
}

async function expectError(promise: Promise<unknown>, status: number, code?: string) {
  const err = await promise.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(AssistantActionError);
  const e = err as InstanceType<typeof AssistantActionError>;
  expect({ status: e.status, code: code ? e.code : undefined, message: e.message }).toMatchObject({ status, ...(code ? { code } : {}) });
  return e;
}

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Тест-район-сделки-Шабнам-${runId}` } })).id;
  agentA = await agent("AGENT", "Агент А сделки");
  agentB = await agent("AGENT", "Агент Б сделки");
  director = await agent("DIRECTOR", "Директор сделки");
  const settings = await prisma.settings.upsert({ where: { id: "singleton" }, update: {}, create: { id: "singleton" } });
  savedRate = settings.usdToTjsRate;
  await prisma.settings.update({ where: { id: "singleton" }, data: { usdToTjsRate: 11.15, dealRequiredDocuments: [] } });
});

afterAll(async () => {
  await prisma.settings.update({ where: { id: "singleton" }, data: { usdToTjsRate: savedRate as never } });
  await prisma.royalScoreEvent.deleteMany({ where: { agentId: { in: agentIds } } });
  await prisma.expense.deleteMany({ where: { agentId: { in: agentIds } } });
  await prisma.backgroundJob.deleteMany({ where: { dedupeKey: { in: dealIds.flatMap((id) => [`deal-close-followup:${id}`, `deal-review-ask:${id}`]) } } }).catch(() => undefined);
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.deal.deleteMany({ where: { OR: [{ id: { in: dealIds } }, { clientId: { in: clientIds } }] } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await cleanupAssistantActionAgents(agentIds);
  await prisma.district.deleteMany({ where: { id: districtId } });
});

describe("Шабнам: чтение сделок и долей", () => {
  it("агент видит только свои доли; чужую сделку и выплаты команде — нет", async () => {
    const mine = await makeDeal({ agentId: agentA, stage: "COMPLETED", realtor: 500, company: 1500 });
    await makeDeal({ agentId: agentB, stage: "COMPLETED", realtor: 700, company: 1300 });
    const actor = await readActor(agentA);

    const commission = (await read("get_my_commission").run({}, { actor })) as Record<string, any>;
    expect(commission.scope).toBe("только ваши доли");
    expect(commission.earned.byCurrency).toEqual([expect.objectContaining({ currency: "TJS", amount: 500 })]);
    expect(mine.deal.agentId).toBe(agentA);
    // Ни общей комиссии, ни доли компании в ответе агенту нет.
    expect(JSON.stringify(commission)).not.toMatch(/1 500|1500|компани/u);
    expect(commission.unpaidAllTime.byCurrency[0]).toMatchObject({ currency: "TJS", amount: 500 });

    const foreign = (await read("get_deal_card").run({ dealId: dealIds[1] }, { actor })) as Record<string, unknown>;
    expect(foreign).toEqual({ error: "Сделка не найдена" });

    expect(read("get_payouts_due").allowed!(actor)).toBe(false);
    expect(await read("get_payouts_due").run({}, { actor })).toEqual({ error: "Выплаты команде видит только руководство" });
  });

  it("руководство видит всё: доли всех агентов и долю компании", async () => {
    const actor = await readActor(director);
    const due = (await read("get_payouts_due").run({}, { actor })) as Record<string, any>;
    const names = due.agents.map((a: { agent: string }) => a.agent);
    expect(names).toEqual(expect.arrayContaining([`Агент А сделки ${runId}`, `Агент Б сделки ${runId}`]));
    expect(due.display).toContain("💰");

    const card = (await read("get_deal_card").run({ dealId: dealIds[1] }, { actor })) as Record<string, any>;
    expect(card.money.companyShare).toBe("1 300 с.");
    expect(card.display).toContain("🏢");
    expect(card.display).toContain("⏳");
  });

  it("доллары: сумма, курс и итог в сомони явно", async () => {
    const { deal } = await makeDeal({ agentId: agentA, stage: "COMPLETED", currency: "USD", commission: 2000, realtor: 1500, company: 500, soldPrice: 75000 });
    const card = (await read("get_deal_card").run({ dealId: deal.id }, { actor: await readActor(agentA) })) as Record<string, any>;
    expect(card.money.realtorShare).toBe("1 500 $ × 11,15 = 16 725 с.");
    const tg = (await read("get_deal_card").run({ dealId: deal.id, lang: "tg" }, { actor: await readActor(agentA) })) as Record<string, any>;
    expect(tg.display).toContain("16 725 сомонӣ");
    expect(tg.display).toContain("Муомила");
  });

  it("группа — ничего: ни объявления, ни ответа, ни карточки записи", async () => {
    const group = await readActor(director, "telegram-group");
    const names = ["get_deal_card", "get_my_commission", "get_payouts_due", "create_deal", "change_deal_stage", "close_deal",
      "fix_deal_commission", "annul_deal", "mark_deal_payout"];
    const declared = new Set(pluginDeclarations(group, true, "telegram").map((d) => d.name));
    for (const name of names) expect(declared.has(name), name).toBe(false);
    expect(await read("get_my_commission").run({}, { actor: group })).toEqual({ error: "Сделки и деньги — только в личном чате с Шабнам" });
    const closed = await makeDeal({ agentId: agentA, stage: "COMPLETED" });
    await expectError(
      createPendingAssistantAction(await writeActor(director, false), "mark_deal_payout", { dealId: closed.deal.id }),
      403,
      "PRIVATE_CHAT_REQUIRED",
    );
  });
});

describe("Шабнам: запись сделок карточкой", () => {
  it("агент заводит сделку по своему клиенту — как POST /deals", async () => {
    const client = await prisma.client.create({
      data: { fullName: `Новый покупатель ${runId}`, phone: phone(), source: "PHONE_CALL", kind: "BUYER", status: "HOT", assignedAgentId: agentA, acceptedAt: new Date() },
    });
    clientIds.push(client.id);
    const property = await prisma.property.create({
      data: { title: `Свободный объект ${runId}`, type: "APARTMENT", areaSqm: 50, price: 123457, currency: "TJS", districtId, address: "Тестовая", condition: "GOOD" },
    });
    propertyIds.push(property.id);
    const actor = await writeActor(agentA);
    const pending = await createPendingAssistantAction(actor, "create_deal", { clientId: client.id, propertyId: property.id });
    expect(pending.status).toBe("PENDING");
    expect(await prisma.deal.count({ where: { propertyId: property.id } })).toBe(0);
    expect(pending.preview.becomes["💰 Комиссия (оценка)"]).toBe("2 469,14 с.");
    const { action } = await confirmAssistantAction(pending.id, actor);
    const deal = await prisma.deal.findFirstOrThrow({ where: { propertyId: property.id } });
    dealIds.push(deal.id);
    expect(action.status).toBe("EXECUTED");
    expect(deal).toMatchObject({ agentId: agentA, stage: "NEGOTIATION" });
    expect((await prisma.property.findUniqueOrThrow({ where: { id: property.id } })).status).toBe("RESERVED");
    expect(await waitForCount(() => prisma.auditLog.count({ where: { action: "DEAL_CREATE", entityId: deal.id } }), 1)).toBe(1);
  });

  it("агент отправляет на закрытие, руководитель одобряет; двойное «Подтвердить» — одно исполнение", async () => {
    const { deal } = await makeDeal({ agentId: agentA, stage: "CONTRACT_SIGNED", showing: true });
    const agentActor = await writeActor(agentA);
    const sent = await createPendingAssistantAction(agentActor, "close_deal", {
      dealId: deal.id, currency: "TJS", soldPrice: 95000, realtorAmount: 475, companyAmount: 1425,
    });
    expect(sent.preview.becomes["Этап"]).toBe("Ждёт одобрения");
    await confirmAssistantAction(sent.id, agentActor);
    expect((await prisma.deal.findUniqueOrThrow({ where: { id: deal.id } })).stage).toBe("PENDING_APPROVAL");

    const boss = await writeActor(director);
    const approve = await createPendingAssistantAction(boss, "close_deal", { dealId: deal.id, currency: "TJS" });
    expect(approve.preview.irreversible).toBe(true);
    expect(approve.preview.becomes["💰 Комиссия"]).toBe("1 900 с.");
    const results = await Promise.allSettled([confirmAssistantAction(approve.id, boss), confirmAssistantAction(approve.id, boss)]);
    const fulfilled = results.filter((r) => r.status === "fulfilled") as PromiseFulfilledResult<{ replay: boolean }>[];
    expect(fulfilled.filter((r) => !r.value.replay)).toHaveLength(1);
    const after = await prisma.deal.findUniqueOrThrow({ where: { id: deal.id } });
    expect(after).toMatchObject({ stage: "COMPLETED" });
    expect(Number(after.commissionAmount)).toBe(1900);
    expect(await waitForCount(() => prisma.auditLog.count({ where: { action: "DEAL_COMPLETE", entityId: deal.id } }), 1)).toBe(1);
  });

  it("сделку изменили после превью — STALE и новое превью, запись не уходит", async () => {
    const { deal } = await makeDeal({ agentId: agentA, stage: "CONTRACT_SIGNED", showing: true });
    const boss = await writeActor(director);
    const pending = await createPendingAssistantAction(boss, "close_deal", {
      dealId: deal.id, currency: "TJS", soldPrice: 90000, realtorAmount: 450, companyAmount: 1350,
    });
    await prisma.deal.update({ where: { id: deal.id }, data: { notes: "правка с канбана", version: { increment: 1 } } });
    const err = await expectError(confirmAssistantAction(pending.id, boss), 409, "STALE");
    expect(err.extra.stale).toBe(true);
    expect((await prisma.deal.findUniqueOrThrow({ where: { id: deal.id } })).stage).toBe("CONTRACT_SIGNED");
  });

  it("исправление комиссии закрытой сделки — доли до копейки, как в превью и как REST", async () => {
    const { deal } = await makeDeal({ agentId: agentA, stage: "COMPLETED", commission: 1000, intake: 0, realtor: 333.33, company: 666.67 });
    const boss = await writeActor(director);
    const pending = await createPendingAssistantAction(boss, "fix_deal_commission", { dealId: deal.id, currency: "TJS", commissionAmount: 1234.57 });
    expect(pending.preview.was["👤 Доля агента"]).toBe("333,33 с.");
    expect(pending.preview.becomes["👤 Доля агента"]).toBe("411,52 с.");
    expect(pending.preview.becomes["🏢 Доля компании"]).toBe("823,05 с.");
    await confirmAssistantAction(pending.id, boss);
    const after = await prisma.deal.findUniqueOrThrow({ where: { id: deal.id } });
    expect([Number(after.commissionAmount), Number(after.commissionRealtorAmount), Number(after.commissionCompanyAmount)]).toEqual([1234.57, 411.52, 823.05]);
    expect(await waitForCount(() => prisma.auditLog.count({ where: { action: "DEAL_REPRICE_CLOSED", entityId: deal.id } }), 1)).toBe(1);

    // Агенту — нельзя: то же право, что у REST (deals.setCommission).
    await expectError(
      createPendingAssistantAction(await writeActor(agentA), "fix_deal_commission", { dealId: deal.id, currency: "TJS", commissionAmount: 1500 }),
      403,
      "FORBIDDEN",
    );
  });

  it("выплата: одна отметка при двух нажатиях, повторная выплата — отказ", async () => {
    const { deal } = await makeDeal({ agentId: agentB, stage: "COMPLETED", realtor: 700, company: 1300 });
    const boss = await writeActor(director);
    const pending = await createPendingAssistantAction(boss, "mark_deal_payout", { dealId: deal.id });
    expect(pending.preview.becomes["👤 Доля агента"]).toBe("700 с. — ✅ Выплачено");
    const both = await Promise.allSettled([confirmAssistantAction(pending.id, boss), confirmAssistantAction(pending.id, boss)]);
    expect(both.some((r) => r.status === "fulfilled")).toBe(true);
    await waitForCount(() => prisma.auditLog.count({ where: { action: "DEAL_PAYOUT", entityId: deal.id } }), 1);
    expect(await waitForSettled(() => prisma.auditLog.count({ where: { action: "DEAL_PAYOUT", entityId: deal.id } }))).toBe(1);
    expect(await waitForCount(() => prisma.auditLog.count({ where: { action: "ASSISTANT_MARK_DEAL_PAYOUT", entityId: deal.id } }), 1)).toBe(1);
    expect((await prisma.deal.findUniqueOrThrow({ where: { id: deal.id } })).realtorPayoutAt).not.toBeNull();

    const again = await expectError(createPendingAssistantAction(boss, "mark_deal_payout", { dealId: deal.id, note: "ещё раз" }), 409, "DEAL_REFUSED");
    expect(again.message).toContain("уже отмечена выплаченной");
    // Агент сам себе выплату не отмечает: нет finance.manage / deals.setCommission.
    await expectError(createPendingAssistantAction(await writeActor(agentB), "mark_deal_payout", { dealId: deal.id }), 403);
  });

  it("доллары без курса не записываются; валюта просьбы обязана совпасть с валютой сделки", async () => {
    const { deal } = await makeDeal({ agentId: agentA, stage: "CONTRACT_SIGNED", currency: "USD", showing: true });
    const boss = await writeActor(director);
    await expectError(
      createPendingAssistantAction(boss, "close_deal", { dealId: deal.id, currency: "TJS", soldPrice: 70000, realtorAmount: 350, companyAmount: 1050 }),
      409,
      "CURRENCY_MISMATCH",
    );
    const ok = await createPendingAssistantAction(boss, "close_deal", { dealId: deal.id, currency: "USD", soldPrice: 70000, realtorAmount: 350, companyAmount: 1050 });
    expect(ok.preview.becomes["👤 Доля агента"]).toBe("350 $ × 11,15 = 3 902,5 с.");
    await setRate(null);
    try {
      await expectError(
        createPendingAssistantAction(boss, "close_deal", { dealId: deal.id, currency: "USD", soldPrice: 70000, realtorAmount: 351, companyAmount: 1050 }),
        409,
        "NO_RATE",
      );
      // Курс убрали между превью и нажатием — снимок другой, запись не уходит.
      await expectError(confirmAssistantAction(ok.id, boss), 409, "STALE");
    } finally {
      await setRate(11.15);
    }
    expect((await prisma.deal.findUniqueOrThrow({ where: { id: deal.id } })).stage).toBe("CONTRACT_SIGNED");
  });

  it("аннулирование — только руководство и только закрытой; смена этапа агентом", async () => {
    const { deal } = await makeDeal({ agentId: agentA, stage: "COMPLETED" });
    await expectError(createPendingAssistantAction(await writeActor(agentA), "annul_deal", { dealId: deal.id, reason: "ошибка ввода" }), 403);
    const boss = await writeActor(director);
    const pending = await createPendingAssistantAction(boss, "annul_deal", { dealId: deal.id, reason: "ошибка ввода" });
    expect(pending.preview.irreversible).toBe(true);
    await confirmAssistantAction(pending.id, boss);
    const after = await prisma.deal.findUniqueOrThrow({ where: { id: deal.id } });
    expect(after.stage).toBe("CANCELLED");
    expect(after.annulledAt).not.toBeNull();

    const live = await makeDeal({ agentId: agentA, stage: "NEGOTIATION" });
    const agentActor = await writeActor(agentA);
    const stage = await createPendingAssistantAction(agentActor, "change_deal_stage", { dealId: live.deal.id, stage: "CONTRACT_SIGNED", lang: "tg" });
    expect(stage.preview.becomes["Марҳила"]).toBe("Шартнома имзо шуд");
    await confirmAssistantAction(stage.id, agentActor);
    expect((await prisma.deal.findUniqueOrThrow({ where: { id: live.deal.id } })).stage).toBe("CONTRACT_SIGNED");
    // Чужая сделка агенту не видна вовсе.
    await expectError(createPendingAssistantAction(await writeActor(agentB), "change_deal_stage", { dealId: live.deal.id, stage: "CANCELLED" }), 404);
    invalidateAgentAccess(agentA);
  });
});

describe("Шабнам: ревью 10.11 — права, цель закрытия, превью без записи, выплаты одним правилом", () => {
  it("РОП без finance.view: в карточке выплаты нет суммы, в закрытии — только им введённые суммы", async () => {
    const rop = await agent("HEAD_OF_SALES", "РОП сделки");
    const ropRead = await readActor(rop);
    expect(ropRead.canViewFinance).toBe(false);
    const ropWrite = await writeActor(rop);

    const closed = await makeDeal({ agentId: agentB, stage: "COMPLETED", realtor: 700, company: 1300 });
    const payout = await createPendingAssistantAction(ropWrite, "mark_deal_payout", { dealId: closed.deal.id });
    expect(payout.preview.becomes["👤 Доля агента"]).toBe("✅ Выплачено");
    expect(JSON.stringify(payout.preview)).not.toMatch(/700|1 300|2 000/u);

    const live = await makeDeal({ agentId: agentA, stage: "CONTRACT_SIGNED", showing: true, commission: 2000 });
    const close = await createPendingAssistantAction(ropWrite, "close_deal", {
      dealId: live.deal.id, currency: "TJS", soldPrice: 90000, realtorAmount: 450, companyAmount: 1350,
    });
    expect(close.preview.becomes).toMatchObject({
      "Цена продажи": "90 000 с.",
      "💰 Комиссия": "1 800 с.",
      "👤 Доля агента": "450 с.",
      "🏢 Доля компании": "1 350 с.",
    });
    // Сумма из базы (2 000 с. оценки) ему в CRM закрыта — и в карточке её нет.
    expect(Object.keys(close.preview.was)).toEqual(["Этап"]);

    expect(read("get_payouts_due").allowed!(ropRead)).toBe(false);
    const res = await request(app).get("/api/v1/deals/payouts").set("Authorization", `Bearer ${signAccessToken({ sub: rop, role: "HEAD_OF_SALES" })}`);
    expect(res.status).toBe(200);
    expect(res.body.agents.every((a: { agentId: string }) => a.agentId === rop)).toBe(true);
  });

  it("close_deal не трогает закрытую и не шлёт повторно ждущую одобрения", async () => {
    const closed = await makeDeal({ agentId: agentA, stage: "COMPLETED" });
    await expectError(
      createPendingAssistantAction(await writeActor(director), "close_deal", { dealId: closed.deal.id, currency: "TJS", soldPrice: 1, realtorAmount: 0, companyAmount: 0 }),
      409,
      "ALREADY_CLOSED",
    );
    const waiting = await makeDeal({ agentId: agentA, stage: "PENDING_APPROVAL", showing: true, soldPrice: 95000, realtor: 475, company: 1425 });
    await expectError(createPendingAssistantAction(await writeActor(agentA), "close_deal", { dealId: waiting.deal.id, currency: "TJS" }), 409, "NO_CHANGE");
    expect((await prisma.deal.findUniqueOrThrow({ where: { id: waiting.deal.id } })).version).toBe(0);
  });

  it("права поменялись между превью и нажатием — «Отправить на закрытие» не становится прямым закрытием", async () => {
    const agentC = await agent("AGENT", "Агент В сделки");
    const { deal } = await makeDeal({ agentId: agentC, stage: "CONTRACT_SIGNED", showing: true });
    const pending = await createPendingAssistantAction(await writeActor(agentC), "close_deal", {
      dealId: deal.id, currency: "TJS", soldPrice: 90000, realtorAmount: 450, companyAmount: 1350,
    });
    expect(pending.preview.becomes["Этап"]).toBe("Ждёт одобрения");
    await prisma.agent.update({ where: { id: agentC }, data: { permissions: { granted: ["deals.complete"], revoked: [] } } });
    invalidateAgentAccess(agentC);
    await expectError(confirmAssistantAction(pending.id, await writeActor(agentC)), 409, "STALE");
    expect((await prisma.deal.findUniqueOrThrow({ where: { id: deal.id } })).stage).toBe("CONTRACT_SIGNED");
  });

  it("превью ничего не пишет: пропуск документов попадает в журнал только после «Подтвердить»", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { dealRequiredDocuments: ["CONTRACT"] } });
    try {
      const { deal } = await makeDeal({ agentId: agentA, stage: "CONTRACT_SIGNED", showing: true });
      const boss = await writeActor(director);
      const pending = await createPendingAssistantAction(boss, "close_deal", {
        dealId: deal.id, currency: "TJS", soldPrice: 90000, realtorAmount: 450, companyAmount: 1350, skipDocuments: true,
      });
      const skipped = () => prisma.auditLog.count({ where: { action: "DEAL_SKIP_DOCUMENTS", entityId: deal.id } });
      expect(await waitForSettled(skipped)).toBe(0);
      expect((await prisma.deal.findUniqueOrThrow({ where: { id: deal.id } })).version).toBe(0);
      await confirmAssistantAction(pending.id, boss);
      expect(await waitForCount(skipped, 1)).toBe(1);
      expect((await prisma.deal.findUniqueOrThrow({ where: { id: deal.id } })).stage).toBe("COMPLETED");
    } finally {
      await prisma.settings.update({ where: { id: "singleton" }, data: { dealRequiredDocuments: [] } });
    }
  });

  it("путь через CRM: та же карточка и то же исполнение без Telegram", async () => {
    const { deal } = await makeDeal({ agentId: agentA, stage: "NEGOTIATION" });
    const access = await loadAgentAccess(agentA);
    const crm = { agentId: agentA, channel: "crm" as const, can: (p: string) => access!.permissions.has(p as never) };
    const pending = await createPendingAssistantAction(crm, "change_deal_stage", { dealId: deal.id, stage: "AGREEMENT_PENDING" });
    await confirmAssistantAction(pending.id, crm);
    expect((await prisma.deal.findUniqueOrThrow({ where: { id: deal.id } })).stage).toBe("AGREEMENT_PENDING");
    const card = (await read("get_deal_card").run({ dealId: deal.id }, { actor: await readActor(agentA, "crm-private") })) as Record<string, unknown>;
    expect(card.stage).toBe("AGREEMENT_PENDING");
  });

  it("выплаты — одно правило с «Зарплатой из сделок»: долги всех месяцев, замороженная строка, доля приёмщика", async () => {
    // Месяц, где других сделок нет ни у кого: ночной тик ниже трогает только его.
    const twoMonthsAgo = new Date(Date.UTC(2001, 1, 15, 12));
    const old = await makeDeal({ agentId: agentA, stage: "COMPLETED", realtor: 400, company: 1600 });
    await prisma.deal.update({ where: { id: old.deal.id }, data: { closedAt: twoMonthsAgo, commissionIntakeAgentId: agentB, commissionIntakeAmount: 100 } });
    const oldMonth = monthKeyOfInstant(twoMonthsAgo);

    // Строку зарплаты того месяца заводит ночной тик — по тому же правилу долей.
    await upsertSalaryExpenses(oldMonth);
    const salaryA = await prisma.expense.findUniqueOrThrow({ where: { autoKey: dealSalaryAutoKey(agentA, oldMonth) } });
    expect(Number(salaryA.amount)).toBe(400);
    // Строку поправили в Финансах (заморожена) — отчёт показывает её, а не пересчёт.
    await prisma.expense.update({ where: { id: salaryA.id }, data: { amount: 401, manualEditedAt: new Date() } });

    const boss = await readActor(director);
    const open = (await read("get_payouts_due").run({}, { actor: boss })) as Record<string, any>;
    const a = open.agents.find((x: { agent: string }) => x.agent === `Агент А сделки ${runId}`);
    const oldRow = a.months.find((m: { month: string }) => m.month === oldMonth);
    expect(oldRow.due.text).toBe("400 с.");
    expect(oldRow.salaryRowTJS).toBe(401);
    expect(open.display).toContain(`(${oldMonth})`);

    const byMonth = (await read("get_payouts_due").run({ month: oldMonth }, { actor: boss })) as Record<string, any>;
    const b = byMonth.agents.find((x: { agent: string }) => x.agent === `Агент Б сделки ${runId}`);
    expect(b.months[0].intakeShare).toMatchObject({ text: "100 с.", note: "выплата приёмщику в CRM не отмечается" });
    expect(b.months[0].due.text).toBe("0 с.");
    expect(byMonth.display).toContain("в Финансах: 401 с.");

    const mine = (await read("get_my_commission").run({}, { actor: await readActor(agentA) })) as Record<string, any>;
    expect(mine.unpaidAllTime.deals).toBeGreaterThanOrEqual(1);
    expect(mine.unpaidAllTime.display ?? mine.display).toContain("все месяцы");

    const asAgent = await request(app).get("/api/v1/deals/payouts").set("Authorization", `Bearer ${signAccessToken({ sub: agentA, role: "AGENT" })}`);
    expect(asAgent.status).toBe(200);
    expect(asAgent.body.agents.map((x: { agentId: string }) => x.agentId)).toEqual([agentA]);
    const asBoss = await request(app).get(`/api/v1/deals/payouts?month=${oldMonth}`).set("Authorization", `Bearer ${signAccessToken({ sub: director, role: "DIRECTOR" })}`);
    expect(asBoss.body.agents.map((x: { agentId: string }) => x.agentId)).toEqual(expect.arrayContaining([agentA, agentB]));
    const bossA = asBoss.body.agents.find((x: { agentId: string }) => x.agentId === agentA);
    expect(bossA.months[0]).toMatchObject({ month: oldMonth, due: { TJS: 400 }, salaryRowTjs: 401 });
    expect((await request(app).get("/api/v1/deals/payouts?month=2026-13").set("Authorization", `Bearer ${signAccessToken({ sub: director, role: "DIRECTOR" })}`)).status).toBe(400);
  });
});
