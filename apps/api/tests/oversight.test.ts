import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";

/**
 * «Контроль руководителя» (GET /oversight/*, routes/oversight.ts) — сводный
 * дашборд по просроченным задачам, агентам у лимита лидов, зависшим горячим
 * клиентам и журналам «Неактивные»/передачи. Всё — чтение существующих
 * моделей, без новых таблиц.
 */

const runId = Date.now();
const password = "testpass123";

let managerId: string;
let managerToken: string;
let plainAgentId: string;
let plainAgentToken: string;
let limitAgentId: string;

const agentIds: string[] = [];
const clientIds: string[] = [];
const interactionIds: string[] = [];
let savedLimit: number | null = null;
let savedSilenceDays: number | null = null;
let savedHotScoreThreshold: number | null = null;

let agentFromId: string;
let agentToId: string;

const pendingSummaryIds: string[] = [];
let savedNegotiationMaxRounds: number | null = null;
let savedLossSeriesThreshold: number | null = null;
let negotiatingClientFullName: string;
let calmNegotiationClientFullName: string;
let lossSeriesAgentId: string;
let trafficLightAgentId: string;

async function login(phone: string) {
  const res = await request(app).post("/api/v1/auth/login").send({ phone, password });
  expect(res.status).toBe(200);
  return res.body.accessToken as string;
}

beforeAll(async () => {
  const settings = await prisma.settings.findUnique({ where: { id: "singleton" } });
  savedLimit = settings?.leadActiveLimit ?? null;
  savedSilenceDays = settings?.sellerSilenceAfterShowingDays ?? null;
  savedHotScoreThreshold = settings?.hotScoreThreshold ?? null;
  savedNegotiationMaxRounds = settings?.sellerNegotiationMaxRounds ?? null;
  savedLossSeriesThreshold = settings?.agentLossSeriesThreshold ?? null;
  // Лимит 2 — тесту хватает двух клиентов на агента, чтобы упереться в лимит.
  // Тишина после показа — порог 5 дней и скоринговый порог 70, чтобы фикстуры
  // ниже (10 дней тишины / балл 85) были однозначно по обе стороны черты.
  // «Вечные переговоры» — порог 2 круга, «Серия у агента» — порог 3 случая:
  // фикстуры ниже строятся ровно под эти числа.
  await prisma.settings.update({
    where: { id: "singleton" },
    data: { leadActiveLimit: 2, sellerSilenceAfterShowingDays: 5, hotScoreThreshold: 70, sellerNegotiationMaxRounds: 2, agentLossSeriesThreshold: 3 },
  });

  const passwordHash = await bcrypt.hash(password, 10);
  managerId = (
    await prisma.agent.create({
      data: { fullName: "Руководитель оверсайт-теста", phone: `+992950${runId}`, role: "MANAGER", passwordHash },
    })
  ).id;
  plainAgentId = (
    await prisma.agent.create({
      data: { fullName: "Агент без права", phone: `+992951${runId}`, role: "AGENT", passwordHash },
    })
  ).id;
  limitAgentId = (
    await prisma.agent.create({
      data: { fullName: "Агент у лимита", phone: `+992952${runId}`, role: "AGENT", passwordHash },
    })
  ).id;
  agentIds.push(managerId, plainAgentId, limitAgentId);
  managerToken = await login(`+992950${runId}`);
  plainAgentToken = await login(`+992951${runId}`);

  const now = Date.now();
  const DAY = 24 * 60 * 60 * 1000;

  // Два активных лида у limitAgentId — «упирается» в лимит 2.
  for (let i = 0; i < 2; i++) {
    const c = await prisma.client.create({
      data: {
        fullName: `Лид лимита-оверсайт ${i} ${runId}`,
        phone: `+99295${i}${runId}`,
        source: "PHONE_CALL",
        assignedAgentId: limitAgentId,
        status: "NEW",
      },
    });
    clientIds.push(c.id);
  }

  // Просроченная задача — должна попасть в /overdue-tasks.
  const overdueClient = await prisma.client.create({
    data: { fullName: `Клиент с просрочкой ${runId}`, phone: `+992953${runId}`, source: "PHONE_CALL", assignedAgentId: limitAgentId },
  });
  clientIds.push(overdueClient.id);
  const overdueInteraction = await prisma.interaction.create({
    data: {
      clientId: overdueClient.id,
      agentId: limitAgentId,
      type: "CALL",
      notes: "Перезвонить завтра",
      nextAction: "Перезвонить клиенту",
      nextActionDate: new Date(now - DAY),
      completedAt: null,
    },
  });
  interactionIds.push(overdueInteraction.id);

  // Задача с будущим сроком — НЕ должна попасть в /overdue-tasks.
  const futureInteraction = await prisma.interaction.create({
    data: {
      clientId: overdueClient.id,
      agentId: limitAgentId,
      type: "CALL",
      notes: "Показ на следующей неделе",
      nextAction: "Показать вариант",
      nextActionDate: new Date(now + DAY),
      completedAt: null,
    },
  });
  interactionIds.push(futureInteraction.id);

  // Выполненная просроченная задача — НЕ должна попасть.
  const completedInteraction = await prisma.interaction.create({
    data: {
      clientId: overdueClient.id,
      agentId: limitAgentId,
      type: "CALL",
      notes: "Уже сделано",
      nextAction: "Позвонить",
      nextActionDate: new Date(now - DAY),
      completedAt: new Date(),
    },
  });
  interactionIds.push(completedInteraction.id);

  // Высокий скоринг, давно без контакта — должен попасть в /stalled-clients.
  const staleHot = await prisma.client.create({
    data: {
      fullName: `Горячий без прогресса ${runId}`,
      phone: `+992954${runId}`,
      source: "PHONE_CALL",
      assignedAgentId: limitAgentId,
      status: "NEW",
      aiScore: 92,
      lastContactAt: new Date(now - 10 * DAY),
    },
  });
  clientIds.push(staleHot.id);

  // Высокий скоринг, контакт был только что — НЕ должен попасть.
  const freshHot = await prisma.client.create({
    data: {
      fullName: `Горячий свежий ${runId}`,
      phone: `+992955${runId}`,
      source: "PHONE_CALL",
      assignedAgentId: limitAgentId,
      status: "NEW",
      aiScore: 92,
      lastContactAt: new Date(now),
    },
  });
  clientIds.push(freshHot.id);

  // Низкий скоринг, давно без контакта — НЕ должен попасть (порог по баллу).
  const staleCold = await prisma.client.create({
    data: {
      fullName: `Холодный без прогресса ${runId}`,
      phone: `+992956${runId}`,
      source: "PHONE_CALL",
      assignedAgentId: limitAgentId,
      status: "NEW",
      aiScore: 40,
      lastContactAt: new Date(now - 10 * DAY),
    },
  });
  clientIds.push(staleCold.id);

  // Событие «переведён в Неактивные» — должно попасть в /inactive-clients.
  const inactiveClient = await prisma.client.create({
    data: {
      fullName: `Клиент в Неактивные ${runId}`,
      phone: `+992957${runId}`,
      source: "PHONE_CALL",
      assignedAgentId: limitAgentId,
      workStatus: "INACTIVE",
    },
  });
  clientIds.push(inactiveClient.id);
  const inactiveInteraction = await prisma.interaction.create({
    data: {
      clientId: inactiveClient.id,
      agentId: limitAgentId,
      type: "SYSTEM",
      notes: "Клиент переведён в Неактивные: Думает (инициатор: Клиент). Актуальные потребности: пока не готов.",
    },
  });
  interactionIds.push(inactiveInteraction.id);

  // Событие передачи — должно попасть в /lead-transfers.
  const transferredClient = await prisma.client.create({
    data: { fullName: `Переданный клиент ${runId}`, phone: `+992958${runId}`, source: "PHONE_CALL", assignedAgentId: managerId },
  });
  clientIds.push(transferredClient.id);
  const transferInteraction = await prisma.interaction.create({
    data: {
      clientId: transferredClient.id,
      agentId: managerId,
      type: "SYSTEM",
      notes: "Передан другому агенту: Не может дозвониться",
    },
  });
  interactionIds.push(transferInteraction.id);

  // ─── Красные флаги (антифрод, мозговой штурм владельца 20-21.08.2026) ───

  // «Тишина после показа»: показ проведён 10 дней назад (порог теста — 5),
  // после него ни одной новой записи — должен попасть в /silent-after-showing.
  const silentClient = await prisma.client.create({
    data: {
      fullName: `Тишина после показа ${runId}`,
      phone: `+992959${runId}`,
      source: "PHONE_CALL",
      assignedAgentId: limitAgentId,
      status: "NEW",
      lastContactAt: new Date(now - 10 * DAY),
    },
  });
  clientIds.push(silentClient.id);
  const silentShowing = await prisma.interaction.create({
    data: {
      clientId: silentClient.id,
      agentId: limitAgentId,
      type: "SHOWING",
      notes: "Показ проведён",
      createdAt: new Date(now - 10 * DAY),
      completedAt: new Date(now - 10 * DAY),
    },
  });
  interactionIds.push(silentShowing.id);

  // Тот же старый показ, но ПОСЛЕ него был звонок — последним касанием стал
  // звонок, а не показ, поэтому сигналу попадать сюда нельзя.
  const touchedClient = await prisma.client.create({
    data: {
      fullName: `Показ, но был звонок ${runId}`,
      phone: `+992960${runId}`,
      source: "PHONE_CALL",
      assignedAgentId: limitAgentId,
      status: "NEW",
      lastContactAt: new Date(now - 8 * DAY),
    },
  });
  clientIds.push(touchedClient.id);
  const touchedShowing = await prisma.interaction.create({
    data: {
      clientId: touchedClient.id,
      agentId: limitAgentId,
      type: "SHOWING",
      notes: "Показ проведён",
      // createdAt тоже отодвинут в прошлое: в реальности он и есть момент, когда
      // показ забронировали/записали (см. lib/showingBooking.ts) — именно по нему,
      // а не по completedAt, определяется порядок «что было последним касанием».
      createdAt: new Date(now - 12 * DAY),
      completedAt: new Date(now - 12 * DAY),
    },
  });
  interactionIds.push(touchedShowing.id);
  const touchedCall = await prisma.interaction.create({
    data: {
      clientId: touchedClient.id,
      agentId: limitAgentId,
      type: "CALL",
      notes: "Позвонили после показа",
      createdAt: new Date(now - 8 * DAY),
    },
  });
  interactionIds.push(touchedCall.id);

  // Показ отменён (declinedAt) — не проведён, сигналу попадать нельзя, даже
  // если формально «давно и без контакта».
  const cancelledClient = await prisma.client.create({
    data: {
      fullName: `Показ отменён ${runId}`,
      phone: `+992961${runId}`,
      source: "PHONE_CALL",
      assignedAgentId: limitAgentId,
      status: "NEW",
      lastContactAt: new Date(now - 10 * DAY),
    },
  });
  clientIds.push(cancelledClient.id);
  const cancelledShowing = await prisma.interaction.create({
    data: {
      clientId: cancelledClient.id,
      agentId: limitAgentId,
      type: "SHOWING",
      notes: "Показ отменён",
      createdAt: new Date(now - 10 * DAY),
      declinedAt: new Date(now - 10 * DAY),
    },
  });
  interactionIds.push(cancelledShowing.id);

  // «Отказ при хорошем скоринге»: aiScore 85 ≥ порога 70, ещё не в СБ —
  // должен попасть в /refused-high-score.
  const refusedHighClient = await prisma.client.create({
    data: {
      fullName: `Отказ при скоринге 85 ${runId}`,
      phone: `+992962${runId}`,
      source: "PHONE_CALL",
      assignedAgentId: limitAgentId,
      status: "COLD",
      aiScore: 85,
      refusalReason: "NO_TRUST",
    },
  });
  clientIds.push(refusedHighClient.id);
  const refusedHighInteraction = await prisma.interaction.create({
    data: {
      clientId: refusedHighClient.id,
      agentId: limitAgentId,
      type: "SYSTEM",
      outcome: "NEGATIVE",
      notes: "Клиент отказался (Нет доверия). Инициатор: Клиент. Отказ №1",
    },
  });
  interactionIds.push(refusedHighInteraction.id);

  // Тот же сценарий, но балл ниже порога — не должен попасть.
  const refusedLowClient = await prisma.client.create({
    data: {
      fullName: `Отказ при скоринге 40 ${runId}`,
      phone: `+992963${runId}`,
      source: "PHONE_CALL",
      assignedAgentId: limitAgentId,
      status: "COLD",
      aiScore: 40,
      refusalReason: "NO_TRUST",
    },
  });
  clientIds.push(refusedLowClient.id);
  const refusedLowInteraction = await prisma.interaction.create({
    data: {
      clientId: refusedLowClient.id,
      agentId: limitAgentId,
      type: "SYSTEM",
      outcome: "NEGATIVE",
      notes: "Клиент отказался (Нет доверия). Инициатор: Клиент. Отказ №1",
    },
  });
  interactionIds.push(refusedLowInteraction.id);

  // Высокий балл, но уже видит СБ (securityReview не пуст) — уже пойман
  // существующим механизмом, дублировать сигнал не должны.
  const refusedInSecurityClient = await prisma.client.create({
    data: {
      fullName: `Отказ уже в СБ ${runId}`,
      phone: `+992964${runId}`,
      source: "PHONE_CALL",
      assignedAgentId: limitAgentId,
      status: "COLD",
      aiScore: 90,
      refusalReason: "BOUGHT_SELF",
      securityReview: "PENDING",
    },
  });
  clientIds.push(refusedInSecurityClient.id);
  const refusedInSecurityInteraction = await prisma.interaction.create({
    data: {
      clientId: refusedInSecurityClient.id,
      agentId: limitAgentId,
      type: "SYSTEM",
      outcome: "NEGATIVE",
      notes: "Клиент отказался (Купил сам). Инициатор: Клиент. Отказ №1 — причина требует проверки службы безопасности",
    },
  });
  interactionIds.push(refusedInSecurityInteraction.id);

  // «Маршруты передач между агентами»: agentFromId вёл клиента (звонок), затем
  // клиента передали agentToId — пара должна попасть в /transfer-pairs.
  const passwordHash2 = await bcrypt.hash(password, 10);
  agentFromId = (
    await prisma.agent.create({
      data: { fullName: "Агент-источник передачи", phone: `+992965${runId}`, role: "AGENT", passwordHash: passwordHash2 },
    })
  ).id;
  agentToId = (
    await prisma.agent.create({
      data: { fullName: "Агент-получатель передачи", phone: `+992966${runId}`, role: "AGENT", passwordHash: passwordHash2 },
    })
  ).id;
  agentIds.push(agentFromId, agentToId);

  const transferPairClient = await prisma.client.create({
    data: { fullName: `Клиент пары передачи ${runId}`, phone: `+992967${runId}`, source: "PHONE_CALL", assignedAgentId: agentToId },
  });
  clientIds.push(transferPairClient.id);
  const pairCall = await prisma.interaction.create({
    data: {
      clientId: transferPairClient.id,
      agentId: agentFromId,
      type: "CALL",
      notes: "Звонок до передачи",
      createdAt: new Date(now - 3 * DAY),
    },
  });
  interactionIds.push(pairCall.id);
  const pairTransfer = await prisma.interaction.create({
    data: {
      clientId: transferPairClient.id,
      agentId: agentToId,
      type: "SYSTEM",
      notes: "Передан другому агенту: Не может дозвониться",
      createdAt: new Date(now - 2 * DAY),
    },
  });
  interactionIds.push(pairTransfer.id);

  // ─── «Вечные переговоры» (владелец 01.09.2026, порог теста — 2 круга) ───

  // Продавец с двумя кругами «Переговоры» подряд после встречи — должен
  // попасть в /endless-negotiations: открытое требование kind="seller_showing"
  // + две SYSTEM-записи с меткой NEGOTIATION_NOTE_MARKER, обе ПОСЛЕ встречи.
  negotiatingClientFullName = `Вечные переговоры ${runId}`;
  const negotiatingClient = await prisma.client.create({
    data: { fullName: negotiatingClientFullName, phone: `+992968${runId}`, source: "PHONE_CALL", assignedAgentId: limitAgentId, kind: "SELLER" },
  });
  clientIds.push(negotiatingClient.id);
  const negotiatingMeeting = await prisma.interaction.create({
    data: {
      clientId: negotiatingClient.id,
      agentId: limitAgentId,
      type: "MEETING",
      outcome: "SELLER_MEETING",
      notes: "Встреча с продавцом на объекте",
      createdAt: new Date(now - 3 * DAY),
    },
  });
  interactionIds.push(negotiatingMeeting.id);
  const negotiationRound1 = await prisma.interaction.create({
    data: {
      clientId: negotiatingClient.id,
      agentId: limitAgentId,
      type: "SYSTEM",
      notes: "Итог приёмки: Переговоры — обсуждают цену",
      createdAt: new Date(now - 2 * DAY),
    },
  });
  interactionIds.push(negotiationRound1.id);
  const negotiationRound2 = await prisma.interaction.create({
    data: {
      clientId: negotiatingClient.id,
      agentId: limitAgentId,
      type: "SYSTEM",
      notes: "Итог приёмки: Переговоры — всё ещё думает",
      createdAt: new Date(now - DAY),
    },
  });
  interactionIds.push(negotiationRound2.id);
  const negotiatingSummary = await prisma.pendingSummary.create({
    data: {
      agentId: limitAgentId,
      kind: "seller_showing",
      subjectId: negotiatingMeeting.id,
      subjectName: `Итог приёмки: ${negotiatingClientFullName}`,
      dueAt: new Date(now + DAY),
    },
  });
  pendingSummaryIds.push(negotiatingSummary.id);

  // Тот же сценарий, но только ОДИН круг «Переговоры» — ниже порога (2),
  // попадать в сигнал не должен.
  calmNegotiationClientFullName = `Один круг переговоров ${runId}`;
  const calmNegotiationClient = await prisma.client.create({
    data: { fullName: calmNegotiationClientFullName, phone: `+992969${runId}`, source: "PHONE_CALL", assignedAgentId: limitAgentId, kind: "SELLER" },
  });
  clientIds.push(calmNegotiationClient.id);
  const calmMeeting = await prisma.interaction.create({
    data: {
      clientId: calmNegotiationClient.id,
      agentId: limitAgentId,
      type: "MEETING",
      outcome: "SELLER_MEETING",
      notes: "Встреча с продавцом на объекте",
      createdAt: new Date(now - 2 * DAY),
    },
  });
  interactionIds.push(calmMeeting.id);
  const calmRound1 = await prisma.interaction.create({
    data: {
      clientId: calmNegotiationClient.id,
      agentId: limitAgentId,
      type: "SYSTEM",
      notes: "Итог приёмки: Переговоры — обсуждают цену",
      createdAt: new Date(now - DAY),
    },
  });
  interactionIds.push(calmRound1.id);
  const calmSummary = await prisma.pendingSummary.create({
    data: {
      agentId: limitAgentId,
      kind: "seller_showing",
      subjectId: calmMeeting.id,
      subjectName: `Итог приёмки: ${calmNegotiationClientFullName}`,
      dueAt: new Date(now + DAY),
    },
  });
  pendingSummaryIds.push(calmSummary.id);

  // ─── «Серия у одного агента» (владелец 01.09.2026, порог теста — 3 случая) ───

  const passwordHash3 = await bcrypt.hash(password, 10);
  lossSeriesAgentId = (
    await prisma.agent.create({
      data: { fullName: "Агент серии потерь", phone: `+992970${runId}`, role: "AGENT", passwordHash: passwordHash3 },
    })
  ).id;
  agentIds.push(lossSeriesAgentId);

  // Два перевода в «Неактивные» + одна прямая потеря (LOST, lastAgentId) за
  // 7 дней — суммарно три случая, должен попасть в /agent-loss-series.
  for (let i = 0; i < 2; i++) {
    const c = await prisma.client.create({
      data: {
        fullName: `Серия потерь — неактивный ${i} ${runId}`,
        phone: `+99297${i}${runId}`,
        source: "PHONE_CALL",
        assignedAgentId: lossSeriesAgentId,
        workStatus: "INACTIVE",
      },
    });
    clientIds.push(c.id);
    const interaction = await prisma.interaction.create({
      data: {
        clientId: c.id,
        agentId: lossSeriesAgentId,
        type: "SYSTEM",
        notes: "Клиент переведён в Неактивные: Думает (инициатор: Клиент).",
        createdAt: new Date(now - DAY),
      },
    });
    interactionIds.push(interaction.id);
  }
  const lostBySeriesAgent = await prisma.client.create({
    data: {
      fullName: `Серия потерь — LOST ${runId}`,
      phone: `+992972${runId}`,
      source: "PHONE_CALL",
      assignedAgentId: null,
      lastAgentId: lossSeriesAgentId,
      status: "LOST",
      lostAt: new Date(now - DAY),
    },
  });
  clientIds.push(lostBySeriesAgent.id);

  // Тот же агент, но потеря случилась ДО окна в 7 дней — не должна попасть
  // (проверяет, что окно действительно фильтрует по lostAt).
  const oldLoss = await prisma.client.create({
    data: {
      fullName: `Старая потеря — не считается ${runId}`,
      phone: `+992973${runId}`,
      source: "PHONE_CALL",
      assignedAgentId: null,
      lastAgentId: lossSeriesAgentId,
      status: "LOST",
      lostAt: new Date(now - 30 * DAY),
    },
  });
  clientIds.push(oldLoss.id);

  // ─── «Светофор неактивных — сейчас» (GET /oversight/traffic-light-summary) ───

  const passwordHash4 = await bcrypt.hash(password, 10);
  trafficLightAgentId = (
    await prisma.agent.create({
      data: { fullName: "Агент светофора", phone: `+992974${runId}`, role: "AGENT", passwordHash: passwordHash4 },
    })
  ).id;
  agentIds.push(trafficLightAgentId);

  // Два RED, один YELLOW, один GREEN у этого агента — должны сложиться в
  // { red: 2, yellow: 1, green: 1 } и попасть в totals той же суммой.
  for (let i = 0; i < 2; i++) {
    const c = await prisma.client.create({
      data: {
        fullName: `Светофор RED ${i} ${runId}`,
        phone: `+99297${5 + i}${runId}`,
        source: "PHONE_CALL",
        assignedAgentId: trafficLightAgentId,
        workStatus: "INACTIVE",
        inactiveLevel: "RED",
      },
    });
    clientIds.push(c.id);
  }
  const yellowClient = await prisma.client.create({
    data: {
      fullName: `Светофор YELLOW ${runId}`,
      phone: `+992977${runId}`,
      source: "PHONE_CALL",
      assignedAgentId: trafficLightAgentId,
      workStatus: "INACTIVE",
      inactiveLevel: "YELLOW",
    },
  });
  clientIds.push(yellowClient.id);
  const greenClient = await prisma.client.create({
    data: {
      fullName: `Светофор GREEN ${runId}`,
      phone: `+992978${runId}`,
      source: "PHONE_CALL",
      assignedAgentId: trafficLightAgentId,
      workStatus: "INACTIVE",
      inactiveLevel: "GREEN",
    },
  });
  clientIds.push(greenClient.id);

  // Активный клиент того же агента с ПРОШЛЫМ inactiveLevel (уже возвращён в
  // работу) — не должен попасть в сводку: workStatus=ACTIVE, светофор смотрит
  // только на ТЕКУЩЕЕ состояние (см. комментарий у Client.inactiveLevel).
  const returnedToActive = await prisma.client.create({
    data: {
      fullName: `Светофор — вернулся в работу ${runId}`,
      phone: `+992979${runId}`,
      source: "PHONE_CALL",
      assignedAgentId: trafficLightAgentId,
      workStatus: "ACTIVE",
      inactiveLevel: "RED",
    },
  });
  clientIds.push(returnedToActive.id);

  // Неактивный без агента (карточка, у которой предел попыток светофора уже
  // исчерпан и её увели в LOST, assignedAgentId=null, см. promoteToLost) — не
  // должна попасть ни в чей портфель.
  const orphanedInactive = await prisma.client.create({
    data: {
      fullName: `Светофор — без агента ${runId}`,
      phone: `+992980${runId}`,
      source: "PHONE_CALL",
      assignedAgentId: null,
      status: "LOST",
      workStatus: "INACTIVE",
      inactiveLevel: "RED",
    },
  });
  clientIds.push(orphanedInactive.id);
});

afterAll(async () => {
  if (savedLimit !== null) {
    await prisma.settings.update({
      where: { id: "singleton" },
      data: {
        leadActiveLimit: savedLimit,
        ...(savedSilenceDays !== null ? { sellerSilenceAfterShowingDays: savedSilenceDays } : {}),
        ...(savedHotScoreThreshold !== null ? { hotScoreThreshold: savedHotScoreThreshold } : {}),
        ...(savedNegotiationMaxRounds !== null ? { sellerNegotiationMaxRounds: savedNegotiationMaxRounds } : {}),
        ...(savedLossSeriesThreshold !== null ? { agentLossSeriesThreshold: savedLossSeriesThreshold } : {}),
      },
    });
  }
  await prisma.pendingSummary.deleteMany({ where: { id: { in: pendingSummaryIds } } });
  await prisma.interaction.deleteMany({ where: { id: { in: interactionIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: agentIds } } });
  await prisma.$disconnect();
});

describe("GET /oversight/*", () => {
  it("без права dashboard.analytics — 403", async () => {
    const res = await request(app).get("/api/v1/oversight/summary").set("Authorization", `Bearer ${plainAgentToken}`);
    expect(res.status).toBe(403);
  });

  it("/summary отдаёт числовую сводку", async () => {
    const res = await request(app).get("/api/v1/oversight/summary").set("Authorization", `Bearer ${managerToken}`);
    expect(res.status).toBe(200);
    expect(typeof res.body.overdueTasks).toBe("number");
    expect(typeof res.body.agentsAtLimit).toBe("number");
    expect(res.body.leadLimit).toBe(2);
  });

  it("/agents-at-limit находит агента, упёршегося в лимит", async () => {
    const res = await request(app).get("/api/v1/oversight/agents-at-limit").set("Authorization", `Bearer ${managerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(2);
    const row = res.body.items.find((a: { id: string }) => a.id === limitAgentId);
    expect(row).toBeTruthy();
    expect(row.total).toBeGreaterThanOrEqual(2);
  });

  it("/overdue-tasks возвращает просроченную задачу и не возвращает будущую/выполненную", async () => {
    const res = await request(app)
      .get("/api/v1/oversight/overdue-tasks?pageSize=50")
      .set("Authorization", `Bearer ${managerToken}`);
    expect(res.status).toBe(200);
    const ids = res.body.items.map((i: { id: string }) => i.id);
    expect(ids).toContain(interactionIds[0]); // просроченная
    expect(ids).not.toContain(interactionIds[1]); // в будущем
    expect(ids).not.toContain(interactionIds[2]); // выполненная
  });

  it("/stalled-clients находит высокий скоринг без прогресса, отсеивает свежий контакт и низкий балл", async () => {
    const res = await request(app)
      .get("/api/v1/oversight/stalled-clients?pageSize=50")
      .set("Authorization", `Bearer ${managerToken}`);
    expect(res.status).toBe(200);
    const ids = res.body.items.map((i: { id: string }) => i.id);
    expect(ids).toContain(clientIds[3]); // staleHot (индекс: 0,1 — лимит, 2 — overdueClient, 3 — staleHot)
    expect(ids).not.toContain(clientIds[4]); // freshHot
    expect(ids).not.toContain(clientIds[5]); // staleCold
  });

  it("/inactive-clients находит событие перевода в Неактивные", async () => {
    const res = await request(app)
      .get("/api/v1/oversight/inactive-clients?pageSize=50")
      .set("Authorization", `Bearer ${managerToken}`);
    expect(res.status).toBe(200);
    const ids = res.body.items.map((i: { id: string }) => i.id);
    expect(ids).toContain(interactionIds[3]);
  });

  it("/lead-transfers находит событие передачи агенту", async () => {
    const res = await request(app)
      .get("/api/v1/oversight/lead-transfers?pageSize=50")
      .set("Authorization", `Bearer ${managerToken}`);
    expect(res.status).toBe(200);
    const ids = res.body.items.map((i: { id: string }) => i.id);
    expect(ids).toContain(interactionIds[4]);
  });

  it("/silent-after-showing находит только клиента, у которого показ БЫЛ последним касанием", async () => {
    const res = await request(app)
      .get("/api/v1/oversight/silent-after-showing?pageSize=50")
      .set("Authorization", `Bearer ${managerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.days).toBe(5);
    const ids = res.body.items.map((c: { fullName: string }) => c.fullName);
    expect(ids).toContain(`Тишина после показа ${runId}`);
    // Был звонок после показа — сигналу попадать нельзя, последнее касание не показ.
    expect(ids).not.toContain(`Показ, но был звонок ${runId}`);
    // Показ отменён — не проведён, сигналу попадать нельзя.
    expect(ids).not.toContain(`Показ отменён ${runId}`);
  });

  it("/refused-high-score находит отказ с высоким скорингом, отсеивает низкий балл и уже пойманное СБ", async () => {
    const res = await request(app)
      .get("/api/v1/oversight/refused-high-score?pageSize=50")
      .set("Authorization", `Bearer ${managerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.threshold).toBe(70);
    const names = res.body.items.map((r: { client: { fullName: string } }) => r.client.fullName);
    expect(names).toContain(`Отказ при скоринге 85 ${runId}`);
    expect(names).not.toContain(`Отказ при скоринге 40 ${runId}`);
    // aiScore 90, но уже securityReview=PENDING — существующий механизм СБ уже поймал.
    expect(names).not.toContain(`Отказ уже в СБ ${runId}`);
  });

  it("/transfer-pairs восстанавливает пару «от кого → кому» по записи перед передачей", async () => {
    const res = await request(app).get("/api/v1/oversight/transfer-pairs").set("Authorization", `Bearer ${managerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.windowDays).toBe(30);
    const pair = res.body.pairs.find((p: { from: { id: string }; to: { id: string } }) => p.from.id === agentFromId && p.to.id === agentToId);
    expect(pair).toBeTruthy();
    expect(pair.count).toBeGreaterThanOrEqual(1);
  });

  it("/endless-negotiations находит клиента с 2+ кругами «Переговоры» подряд, отсеивает одиночный круг", async () => {
    const res = await request(app)
      .get("/api/v1/oversight/endless-negotiations?pageSize=50")
      .set("Authorization", `Bearer ${managerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.maxRounds).toBe(2);
    const names = res.body.items.map((n: { client: { fullName: string } }) => n.client.fullName);
    expect(names).toContain(negotiatingClientFullName);
    expect(names).not.toContain(calmNegotiationClientFullName);
    const row = res.body.items.find((n: { client: { fullName: string } }) => n.client.fullName === negotiatingClientFullName);
    expect(row.rounds).toBeGreaterThanOrEqual(2);
  });

  it("/agent-loss-series находит агента с 3+ переводами/потерями за 7 дней, не считает старую потерю", async () => {
    const res = await request(app).get("/api/v1/oversight/agent-loss-series").set("Authorization", `Bearer ${managerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.threshold).toBe(3);
    expect(res.body.windowDays).toBe(7);
    const row = res.body.items.find((a: { agentId: string }) => a.agentId === lossSeriesAgentId);
    expect(row).toBeTruthy();
    expect(row.count).toBe(3);
  });

  it("/traffic-light-summary группирует неактивных клиентов по агенту и цвету, не считает вернувшихся в работу и осиротевших", async () => {
    const res = await request(app).get("/api/v1/oversight/traffic-light-summary").set("Authorization", `Bearer ${managerToken}`);
    expect(res.status).toBe(200);

    const row = res.body.agents.find((a: { agentId: string }) => a.agentId === trafficLightAgentId);
    expect(row).toBeTruthy();
    // Ровно 2/1/1 — не 3 RED (если бы вернувшийся в ACTIVE клиент посчитался
    // по старому inactiveLevel) и не пусто (если бы agentId=null не отфильтровался).
    expect(row.red).toBe(2);
    expect(row.yellow).toBe(1);
    expect(row.green).toBe(1);
    expect(row.total).toBe(4);

    // Осиротевшая карточка (assignedAgentId=null, LOST) не привязана ни к
    // одному агенту в выдаче — ищем строку без агента, её быть не должно.
    expect(res.body.agents.every((a: { agentId: string | null }) => a.agentId)).toBe(true);

    // Итоги — не строгое равенство (другие тестовые файлы могут добавлять свои
    // цветные карточки параллельно), но обязаны включать хотя бы наш агент.
    expect(res.body.totals.red).toBeGreaterThanOrEqual(2);
    expect(res.body.totals.yellow).toBeGreaterThanOrEqual(1);
    expect(res.body.totals.green).toBeGreaterThanOrEqual(1);
  });

  it("/traffic-light-summary без права dashboard.analytics — 403", async () => {
    const res = await request(app).get("/api/v1/oversight/traffic-light-summary").set("Authorization", `Bearer ${plainAgentToken}`);
    expect(res.status).toBe(403);
  });

  it("/summary включает endlessNegotiations и agentLossSeries", async () => {
    const res = await request(app).get("/api/v1/oversight/summary").set("Authorization", `Bearer ${managerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.endlessNegotiations).toBeGreaterThanOrEqual(1);
    expect(res.body.sellerNegotiationMaxRounds).toBe(2);
    expect(res.body.agentLossSeries).toBeGreaterThanOrEqual(1);
    expect(res.body.agentLossSeriesThreshold).toBe(3);
  });
});
