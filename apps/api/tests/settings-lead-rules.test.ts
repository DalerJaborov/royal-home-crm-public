import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { grantElevation } from "../src/lib/stepUp.js";
import { activeLeadCounts, loadLeadLimits, DEFAULT_LEAD_ACTIVE_LIMIT } from "../src/lib/leadLimits.js";

/** Настройки правил «свой объект» (решение владельца 11.08.2026). Требование
 *  дословно: «все эти настройки должны быть прописаны в настройках и работать,
 *  чтобы не было сложностей с кодом». Значит проверяем ровно две вещи: что
 *  значения правятся через маршрут и что мусор он не принимает.
 *
 *  Отдельно — раздельный счёт лидов: на нём держится всё правило лимита, и
 *  ошибка в нём тихо отдала бы агенту лишних клиентов. */

const runId = Date.now();
const password = "testpass123";

let adminId: string;
let adminToken: string;
let agentId: string;
const clientIds: string[] = [];

/** Что было в базе до теста — вернуть в afterAll, файлы делят одну базу. */
let saved: Record<string, unknown> = {};

const TOUCHED = [
  "ownPropertyPriorityEnabled",
  "ownPropertyMatchThreshold",
  "ownPropertyShownExceptionEnabled",
  "ownPropertyShownWindowDays",
  "ownPropertyOverLimitEnabled",
  "ownPropertyReleaseEnabled",
  "ownPropertyReleaseMode",
  "ownPropertyLeadCap",
  "handoverClientsToHighKpi",
  "handoverPropertiesToLowKpi",
  "pushLeadActionsEnabled",
  "pushActionTtlMinutes",
  "botTopicLockEnabled",
  "botTopicDriftTurns",
  "askClientsToConfirmShowings",
  "autoRouteRefusedLeads",
] as const;

function patch(body: Record<string, unknown>) {
  return request(app).patch("/api/v1/settings").set("Authorization", `Bearer ${adminToken}`).send(body);
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  const admin = await prisma.agent.create({
    data: { fullName: "Админ правил лидов", phone: `+992935${runId}`, role: "ADMIN", passwordHash },
  });
  adminId = admin.id;
  const res = await request(app).post("/api/v1/auth/login").send({ phone: admin.phone, password });
  adminToken = res.body.accessToken;
  grantElevation(adminId);

  const agent = await prisma.agent.create({
    data: { fullName: "Агент счёта лидов", phone: `+992934${runId}`, role: "AGENT", passwordHash: "x" },
  });
  agentId = agent.id;

  const current = await prisma.settings.upsert({
    where: { id: "singleton" },
    update: {},
    create: { id: "singleton" },
  });
  saved = Object.fromEntries(TOUCHED.map((k) => [k, (current as Record<string, unknown>)[k]]));
});

afterAll(async () => {
  await prisma.settings.update({ where: { id: "singleton" }, data: saved });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: [adminId, agentId] } } });
  await prisma.$disconnect();
});

describe("Правила «свой объект» правятся в Настройках", () => {
  it("маршрут принимает и сохраняет весь набор", async () => {
    const res = await patch({
      ownPropertyPriorityEnabled: false,
      ownPropertyMatchThreshold: 70,
      ownPropertyShownExceptionEnabled: false,
      ownPropertyShownWindowDays: 14,
      ownPropertyOverLimitEnabled: false,
      ownPropertyReleaseEnabled: false,
      ownPropertyLeadCap: 9,
      handoverClientsToHighKpi: false,
      handoverPropertiesToLowKpi: false,
      pushLeadActionsEnabled: false,
      pushActionTtlMinutes: 10,
      botTopicLockEnabled: false,
      botTopicDriftTurns: 3,
    });
    expect(res.status).toBe(200);
    expect(res.body.ownPropertyMatchThreshold).toBe(70);
    // ownPropertyReleaseMode больше НЕ в наборе (закон П-4/П-6, 17.09.2026, см.
    // комментарий у settingsUpdateSchema) — см. тест ниже «несуществующий способ
    // освобождения не принимается» про новое поведение этого поля.
    expect(res.body.ownPropertyLeadCap).toBe(9);
    expect(res.body.ownPropertyPriorityEnabled).toBe(false);

    // И читается обратно тем же значением — правка дошла до базы, а не только до ответа.
    const fresh = await prisma.settings.findUnique({ where: { id: "singleton" } });
    expect(fresh?.botTopicDriftTurns).toBe(3);
    expect(fresh?.pushActionTtlMinutes).toBe(10);
  });

  it("loadLeadLimits отдаёт то, что стоит в Настройках", async () => {
    await patch({
      ownPropertyOverLimitEnabled: true,
      ownPropertyReleaseEnabled: true,
      ownPropertyReleaseMode: "agent_choice",
      ownPropertyLeadCap: 0,
    });
    const limits = await loadLeadLimits();
    expect(limits.overLimitEnabled).toBe(true);
    expect(limits.releaseMode).toBe("agent_choice");
    expect(limits.ownPropertyCap).toBe(0);
    expect(limits.activeLimit).toBeGreaterThan(0);
  });

  it("умолчание лимита — шесть, как в спецификации, а не пять", () => {
    // Пятёрка жила в трёх местах сразу и расходилась со схемой: агент видел
    // «5 из 5» и получал шестой лид. Число теперь одно на всю систему.
    expect(DEFAULT_LEAD_ACTIVE_LIMIT).toBe(6);
  });

  it("тумблер подтверждения показов сохраняется", async () => {
    // До 26.08.2026 этого ключа не было в settingsUpdateSchema: Zod молча выбрасывал
    // его из PATCH, маршрут отвечал 200, тост показывал «Сохранено», а тумблер в
    // веб-клиенте откатывался. Проверяем оба направления и что правка дошла до базы.
    for (const value of [false, true]) {
      const res = await patch({ askClientsToConfirmShowings: value });
      expect(res.status).toBe(200);
      const fresh = await prisma.settings.findUnique({
        where: { id: "singleton" },
        select: { askClientsToConfirmShowings: true },
      });
      expect(fresh?.askClientsToConfirmShowings).toBe(value);
    }
  });

  /**
   * П-6/Р-6 (17.09.2026, `docs/audit/lead-ownership-17-09.md` §4): autoRouteRefusedLeads
   * убран из PATCH и из формы Настроек намеренно — кнопочный отказ агента
   * (lib/clientRefuse.ts) продолжает читать значение, уже лежащее в БД, но
   * менять его через API/UI больше нельзя (см. комментарий у settingsUpdateSchema
   * в routes/settings.ts). Раньше этот тумблер сохранялся через PATCH — теперь
   * PATCH его молча игнорирует, значение в базе не меняется.
   */
  it("autoRouteRefusedLeads больше не меняется через PATCH (Р-6) — значение в базе не трогается", async () => {
    const before = await prisma.settings.findUnique({
      where: { id: "singleton" },
      select: { autoRouteRefusedLeads: true },
    });
    const res = await patch({ autoRouteRefusedLeads: !before?.autoRouteRefusedLeads });
    expect(res.status).toBe(200);
    expect(res.body.autoRouteRefusedLeads).toBeUndefined();
    const fresh = await prisma.settings.findUnique({
      where: { id: "singleton" },
      select: { autoRouteRefusedLeads: true },
    });
    expect(fresh?.autoRouteRefusedLeads).toBe(before?.autoRouteRefusedLeads);
  });

  it("порог совпадения вне 0..100 не принимается", async () => {
    expect((await patch({ ownPropertyMatchThreshold: 101 })).status).toBe(400);
    expect((await patch({ ownPropertyMatchThreshold: -1 })).status).toBe(400);
  });

  /**
   * П-4/П-6 (17.09.2026): режим random убран по закону владения — система
   * больше не выбирает жертву сама. Поле нарочно НЕ валидируется и НЕ
   * принимается вовсе (см. комментарий у settingsUpdateSchema в
   * routes/settings.ts) — раньше он отвергался как «неверное значение» (400),
   * теперь Zod просто отбрасывает неизвестный ключ, запрос проходит как
   * обычно, а значение в базе не меняется.
   */
  it("ownPropertyReleaseMode из PATCH исключён — любое значение молча игнорируется, а не отвергается", async () => {
    const before = await prisma.settings.findUnique({
      where: { id: "singleton" },
      select: { ownPropertyReleaseMode: true },
    });
    const res = await patch({ ownPropertyReleaseMode: "whatever" });
    expect(res.status).toBe(200);
    expect(res.body.ownPropertyReleaseMode).toBeUndefined();
    const fresh = await prisma.settings.findUnique({
      where: { id: "singleton" },
      select: { ownPropertyReleaseMode: true },
    });
    expect(fresh?.ownPropertyReleaseMode).toBe(before?.ownPropertyReleaseMode);
  });

  it("срок жизни кнопок в уведомлении ограничен часом", async () => {
    // Маркер действия вкладывается в само уведомление. Живущий сутки — это уже
    // не одноразовое действие, а ключ, лежащий в шторке.
    expect((await patch({ pushActionTtlMinutes: 240 })).status).toBe(400);
    expect((await patch({ pushActionTtlMinutes: 1 })).status).toBe(400);
    expect((await patch({ pushActionTtlMinutes: 60 })).status).toBe(200);
  });

  it("окно показов меньше суток не принимается", async () => {
    expect((await patch({ ownPropertyShownWindowDays: 0 })).status).toBe(400);
  });
});

describe("Раздельный счёт активных лидов", () => {
  it("делит портфель на свои и обычные", async () => {
    for (const [i, own] of [true, true, false].entries()) {
      const c = await prisma.client.create({
        data: {
          fullName: `Лид счёта ${i} ${runId}`,
          phone: `+99293${i}${runId}`,
          source: "PHONE_CALL",
          assignedAgentId: agentId,
          acceptedAt: new Date(),
          status: "NEW",
          ownPropertyLead: own,
        },
      });
      clientIds.push(c.id);
    }

    const counts = await activeLeadCounts([agentId]);
    expect(counts.get(agentId)).toEqual({ total: 3, own: 2, regular: 1, weighted: 3 });
  });

  it("клиент из Корзины в счёт не идёт", async () => {
    const deleted = await prisma.client.create({
      data: {
        fullName: `Лид в корзине ${runId}`,
        phone: `+992939${runId}`,
        source: "PHONE_CALL",
        assignedAgentId: agentId,
        acceptedAt: new Date(),
        status: "NEW",
        deletedAt: new Date(),
      },
    });
    clientIds.push(deleted.id);

    const counts = await activeLeadCounts([agentId]);
    expect(counts.get(agentId)?.total).toBe(3);
  });

  it("закрытая сделка и потерянный лид места не занимают, а холодный — занимает", async () => {
    // Переработка 12.08.2026 (ТЗ владельца, «Логика Статус + Итог»): раньше COLD
    // сознательно не считался занятым слотом — «позвонить через месяц» не должен
    // был запирать приём новых. Теперь единственный сигнал «слот свободен» — это
    // явное действие агента (workStatus=INACTIVE, «Передача», «Завершить сделку»),
    // а не то, что клиент остыл сам по себе: агент, который просто не разобрался с
    // клиентом, не должен получать шестого нового, пока не решил, что с этим делать.
    // DEAL_CLOSED/LOST — состояния окончательные, слот освобождают всегда.
    for (const [i, status] of (["COLD", "DEAL_CLOSED", "LOST"] as const).entries()) {
      const c = await prisma.client.create({
        data: {
          fullName: `Лид ${status} ${runId}`,
          phone: `+99292${i}${runId}`,
          source: "PHONE_CALL",
          assignedAgentId: agentId,
          acceptedAt: new Date(),
          status,
        },
      });
      clientIds.push(c.id);
    }

    // 3 из beforeEach (NEW) + COLD (занимает) = 4; DEAL_CLOSED/LOST не считаются.
    const counts = await activeLeadCounts([agentId]);
    expect(counts.get(agentId)?.total).toBe(4);
  });

  it("workStatus=INACTIVE освобождает слот, даже если Состояние ещё не остыло", async () => {
    // Файл делит клиентов между тестами (clientIds копится, а не сбрасывается),
    // поэтому сверяемся с ПРЕДЫДУЩИМ счётом, а не абсолютным числом — важно только,
    // что именно этот клиент в счёт не попал.
    const before = (await activeLeadCounts([agentId])).get(agentId)?.total ?? 0;
    const c = await prisma.client.create({
      data: {
        fullName: `Лид неактивный ${runId}`,
        phone: `+992928${runId}`,
        source: "PHONE_CALL",
        assignedAgentId: agentId,
        acceptedAt: new Date(),
        status: "HOT",
        workStatus: "INACTIVE",
      },
    });
    clientIds.push(c.id);

    // HOT+INACTIVE в счёт не идёт, хотя Состояние «Горячий» — счёт не должен вырасти.
    const counts = await activeLeadCounts([agentId]);
    expect(counts.get(agentId)?.total).toBe(before);
  });

  it("агент без лидов возвращается нулём, а не отсутствует", async () => {
    // Иначе каждое место вызова обязано было бы помнить про undefined —
    // и одно из них рано или поздно забыло бы.
    const counts = await activeLeadCounts([adminId]);
    expect(counts.get(adminId)).toEqual({ total: 0, own: 0, regular: 0, weighted: 0 });
  });
});
