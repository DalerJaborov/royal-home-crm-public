import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { waitFor } from "./helpers/waitFor.js";
import bcrypt from "bcrypt";
import { prisma } from "../src/db.js";
import { detectExplicitRefusal, checkExplicitRefusal } from "../src/lib/explicitRefusalDetector.js";

/**
 * Детектор явного отказа в переписке (план 03.09.2026, §D). Планка уверенности
 * выше, чем у детектора неактивности — только прямые, недвусмысленные фразы.
 *
 * Первый describe — чистая функция, без базы (тот же приём, что у
 * agent-phone-ask-detector.test.ts::detectPhoneAsk). Второй — интеграция:
 * checkExplicitRefusal реально закрывает карточку тем же путём, что и кнопка
 * агента (lib/clientRefuse.ts::refuseClient).
 */
describe("detectExplicitRefusal (чистая функция)", () => {
  // ─── Покупатель: должно сработать ───────────────────────────────────────

  it("«уже купил» → BOUGHT_SELF", () => {
    const r = detectExplicitRefusal("Уже купили квартиру, спасибо за помощь", "BUYER");
    expect(r?.reason).toBe("BOUGHT_SELF");
  });

  it("«купил сам» → BOUGHT_SELF", () => {
    expect(detectExplicitRefusal("Купил сам, без агентства", "BUYER")?.reason).toBe("BOUGHT_SELF");
  });

  it("«купили через другое агентство Sitora» → BOUGHT_VIA_OTHER_AGENCY с именем конкурента", () => {
    const r = detectExplicitRefusal("Купили через другое агентство Sitora на прошлой неделе", "BUYER");
    expect(r?.reason).toBe("BOUGHT_VIA_OTHER_AGENCY");
    expect(r?.competitorName).toBe("Sitora");
  });

  it("«купили у других риелторов» без имени → BOUGHT_VIA_OTHER_AGENCY, конкурент не определён", () => {
    const r = detectExplicitRefusal("Купили у других риелторов, извините", "BUYER");
    expect(r?.reason).toBe("BOUGHT_VIA_OTHER_AGENCY");
    expect(r?.competitorName).toBeNull();
  });

  it("«не буду покупать» → CHANGED_MIND", () => {
    expect(detectExplicitRefusal("Не буду покупать, извините за беспокойство", "BUYER")?.reason).toBe("CHANGED_MIND");
  });

  it("«не хочу с вами работать» → CHANGED_MIND", () => {
    expect(detectExplicitRefusal("Не хочу с вами больше работать", "BUYER")?.reason).toBe("CHANGED_MIND");
  });

  it("голое «Передумал.» коротким сообщением → CHANGED_MIND", () => {
    expect(detectExplicitRefusal("Передумал.", "BUYER")?.reason).toBe("CHANGED_MIND");
  });

  // ─── Покупатель: НЕ должно сработать ────────────────────────────────────

  it("«передумал ехать в 5, приеду в 6» — про время показа, не про сделку", () => {
    expect(detectExplicitRefusal("Передумал, приеду не в 5, а в 6 на показ", "BUYER")).toBeNull();
  });

  it("обычное обсуждение объекта не ловится", () => {
    expect(detectExplicitRefusal("Квартира понравилась, но хочу посмотреть ещё один вариант", "BUYER")).toBeNull();
  });

  it("пустая строка и слишком короткий текст не ловятся", () => {
    expect(detectExplicitRefusal("", "BUYER")).toBeNull();
    expect(detectExplicitRefusal("Ок", "BUYER")).toBeNull();
  });

  it("продавческие фразы у покупателя не срабатывают", () => {
    expect(detectExplicitRefusal("Уже продал через другое агентство", "BUYER")).toBeNull();
  });

  // ─── Продавец: должно сработать ─────────────────────────────────────────

  it("«уже продал» → SOLD_SELF", () => {
    expect(detectExplicitRefusal("Уже продал квартиру на прошлой неделе", "SELLER")?.reason).toBe("SOLD_SELF");
  });

  it("«продал через другое агентство» → SOLD_VIA_OTHER_AGENCY", () => {
    expect(detectExplicitRefusal("Продал через другое агентство в итоге", "SELLER")?.reason).toBe("SOLD_VIA_OTHER_AGENCY");
  });

  it("«не буду продавать» → WITHDRAWN_FROM_SALE", () => {
    expect(detectExplicitRefusal("Не буду продавать, оставлю себе", "SELLER")?.reason).toBe("WITHDRAWN_FROM_SALE");
  });

  it("«снимаю объект с продажи» → WITHDRAWN_FROM_SALE", () => {
    expect(detectExplicitRefusal("Снимаю объект с продажи, спасибо", "SELLER")?.reason).toBe("WITHDRAWN_FROM_SALE");
  });

  it("голое «передумала» у продавца → WITHDRAWN_FROM_SALE", () => {
    expect(detectExplicitRefusal("Передумала", "SELLER")?.reason).toBe("WITHDRAWN_FROM_SALE");
  });

  // ─── Продавец: НЕ должно сработать ──────────────────────────────────────

  it("покупательские фразы у продавца не срабатывают", () => {
    expect(detectExplicitRefusal("Уже купила квартиру сама", "SELLER")).toBeNull();
  });

  it("бытовое сообщение продавца не ловится", () => {
    expect(detectExplicitRefusal("Ключи ещё не готовы, приеду позже", "SELLER")).toBeNull();
  });
});

/**
 * Р-6 (17.09.2026, `docs/audit/lead-ownership-17-09.md` §4): детектор больше
 * НЕ закрывает карточку сам — только подсказывает (SYSTEM-запись + пуш
 * держателю), подтверждает кнопкой агент. Раньше здесь проверялось, что
 * checkExplicitRefusal реально ставит refusalReason/refusalCount/securityReview
 * — с этой правки все эти поля обязаны остаться НЕТРОНУТЫМИ.
 */
describe("checkExplicitRefusal — Р-6: только подсказка, карточку не закрывает", () => {
  const runId = Date.now();
  const password = "testpass123";
  let agentId: string;
  const clientIds: string[] = [];

  async function makeClient(data: Record<string, unknown>) {
    const c = await prisma.client.create({
      data: {
        fullName: `${data.fullName} ${runId}`,
        phone: data.phone as string,
        source: "PHONE_CALL",
        assignedAgentId: agentId,
        acceptedAt: new Date(),
        ...((({ fullName, phone, ...rest }) => rest)(data) as object),
      },
    });
    clientIds.push(c.id);
    return c;
  }

  beforeAll(async () => {
    const passwordHash = await bcrypt.hash(password, 10);
    agentId = (
      await prisma.agent.create({
        data: { fullName: "Агент детектора отказов", phone: `+992958${runId}`, role: "AGENT", passwordHash, kpi: 50 },
      })
    ).id;
  });

  afterAll(async () => {
    await prisma.auditLog.deleteMany({ where: { entityId: { in: clientIds } } });
    await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
    await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
    await prisma.agent.deleteMany({ where: { id: agentId } });
    await prisma.$disconnect();
  });

  it("покупатель без единого показа: явный отказ создаёт подсказку, карточку не закрывает", async () => {
    const c = await makeClient({ fullName: "Без показа но отказался", phone: `+992957${runId}` });
    // Ни одного Interaction type=SHOWING — раньше это было исключением (bypassPreCloseGates),
    // сейчас неважно вовсе: карточка в любом случае не закрывается.
    await checkExplicitRefusal({ clientId: c.id, text: "Уже купили в другом месте, спасибо" });

    const after = await prisma.client.findUnique({ where: { id: c.id } });
    expect(after?.refusalReason).toBeNull();
    expect(after?.refusalCount).toBe(0);
    expect(after?.status).not.toBe("LOST");
    expect(after?.securityReview).toBeNull();

    const note = await prisma.interaction.findFirst({ where: { clientId: c.id, type: "SYSTEM" } });
    expect(note?.notes).toContain("Похоже на отказ");
    expect(note?.notes).toContain("Уже купили в другом месте, спасибо");
    expect(note?.nextAction).not.toBeNull();

    /**
     * Короткий опрос, а не мгновенная проверка (20.09.2026): `logSystemAudit`
     * (lib/audit.ts) пишет строку БЕЗ await — «выстрелил и забыл», — поэтому
     * `checkExplicitRefusal` возвращается раньше, чем строка доезжает до базы.
     * На свободной машине она успевала, а под соседними файлами прогона нет: CI
     * ронял этот тест на «expected null not to be null» при исправном коде.
     */
    const auditWhere = { action: "CLIENT_REFUSAL_SUSPECTED", entityType: "Client", entityId: c.id };
    const auditRow = await waitFor(() => prisma.auditLog.findFirst({ where: auditWhere }));
    expect(auditRow).not.toBeNull();
  });

  it("«не буду покупать» через детектор — тоже только подсказка", async () => {
    const c = await makeClient({ fullName: "Передумал через переписку", phone: `+992934${runId}` });
    await checkExplicitRefusal({ clientId: c.id, text: "Не буду покупать, извините за беспокойство" });

    const after = await prisma.client.findUnique({ where: { id: c.id } });
    expect(after?.refusalReason).toBeNull();
    expect(after?.securityReview).toBeNull();
    const note = await prisma.interaction.findFirst({ where: { clientId: c.id, type: "SYSTEM" } });
    expect(note).not.toBeNull();
  });

  it("«не буду продавать» через детектор (продавец) — тоже только подсказка", async () => {
    const c = await makeClient({ fullName: "Продавец передумал через переписку", phone: `+992930${runId}`, kind: "SELLER" });
    await checkExplicitRefusal({ clientId: c.id, text: "Не буду продавать, решили оставить себе" });

    const after = await prisma.client.findUnique({ where: { id: c.id } });
    expect(after?.refusalReason).toBeNull();
    expect(after?.assignedAgentId).toBe(agentId);
  });

  it("дословная цитата попадает в хронологию клиента", async () => {
    const c = await makeClient({ fullName: "Дословная цитата", phone: `+992956${runId}` });
    await checkExplicitRefusal({ clientId: c.id, text: "Не буду покупать, честно говоря" });

    const note = await prisma.interaction.findFirst({ where: { clientId: c.id, type: "SYSTEM" }, orderBy: { createdAt: "desc" } });
    expect(note?.notes).toContain("Не буду покупать, честно говоря");
  });

  it("повторное такое же сообщение не плодит вторую подсказку (дедуп 24ч)", async () => {
    const c = await makeClient({ fullName: "Дубль сообщения", phone: `+992955${runId}` });
    await checkExplicitRefusal({ clientId: c.id, text: "Уже купил, спасибо большое" });
    await checkExplicitRefusal({ clientId: c.id, text: "Уже купил, спасибо большое" });

    const count = await prisma.interaction.count({ where: { clientId: c.id, type: "SYSTEM" } });
    expect(count).toBe(1);
  });

  it("клиент уже LOST — детектор его не трогает", async () => {
    const c = await makeClient({ fullName: "Уже потерян", phone: `+992933${runId}`, status: "LOST" });
    await checkExplicitRefusal({ clientId: c.id, text: "Уже купил у соседей" });

    const count = await prisma.interaction.count({ where: { clientId: c.id, type: "SYSTEM" } });
    expect(count).toBe(0);
  });

  it("без назначенного агента — подсказать некому, детектор молчит", async () => {
    const c = await makeClient({ fullName: "Ничей клиент", phone: `+992932${runId}` });
    await prisma.client.update({ where: { id: c.id }, data: { assignedAgentId: null } });
    await checkExplicitRefusal({ clientId: c.id, text: "Уже купил у соседей" });

    const count = await prisma.interaction.count({ where: { clientId: c.id, type: "SYSTEM" } });
    expect(count).toBe(0);
  });

  it("обычное сообщение без признаков отказа ничего не меняет", async () => {
    const c = await makeClient({ fullName: "Просто вопрос", phone: `+992931${runId}` });
    await checkExplicitRefusal({ clientId: c.id, text: "А сколько стоит трёхкомнатная в центре?" });

    const after = await prisma.client.findUnique({ where: { id: c.id } });
    expect(after?.refusalCount).toBe(0);
    expect(after?.refusalReason).toBeNull();
    const count = await prisma.interaction.count({ where: { clientId: c.id, type: "SYSTEM" } });
    expect(count).toBe(0);
  });
});
