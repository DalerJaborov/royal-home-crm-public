import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import { prisma } from "../src/db.js";
import { runSellerNoPropertyAlarmTick, ALARM_DAYS } from "../src/lib/sellerNoPropertyAlarm.js";
import { loadHotScoreThreshold } from "../src/lib/hotScoreThreshold.js";

/**
 * Регрессионный тест аларма «продавец без объекта после съёмки» (требование 7,
 * аудит 02.09.2026). Проверяет логику детектора через возвращаемое значение alerted,
 * а не через записи в Notification (те зависят от внутренней гонки upsertByTag
 * в notifications.ts при параллельных пушах).
 *
 * Точки проверки:
 *  1) Точка отсчёта — completedAt проведённой встречи SELLER_MEETING, не propertyAcceptedAt.
 *  2) Фильтр по aiScore >= HIGH_SCORE_THRESHOLD.
 *  3) Объект создан → аларм не срабатывает.
 *  4) Прошло меньше ALARM_DAYS → аларм не срабатывает.
 *  5) Fallback на propertyAcceptedAt, если встреча не проведена.
 */

const runId = Date.now();
// Тик молчит вне рабочих часов (решение владельца 03.09): фиксируем вторник 12:00 по Душанбе.
const NOW = new Date("2026-09-01T07:00:00Z");
const password = "testpass123";
const DAY_MS = 86_400_000;
// Порог берётся из Settings.hotScoreThreshold — единый на всю CRM (lib/hotScoreThreshold.ts).
let HIGH_SCORE_THRESHOLD = 70;

let districtId: string;
let agentId: string;
let directorId: string;
const clientIds: string[] = [];
const interactionIds: string[] = [];
const propertyIds: string[] = [];

/**
 * Тревога дедуплицируется тегом `alarm-seller-no-prop-{clientId}`, поэтому по нему
 * же и проверяем: попал КОНКРЕТНЫЙ продавец под тревогу или нет. Общий счётчик
 * alerted для этого не годится — в базе живут продавцы из соседних проверок.
 */
async function alarmSentFor(clientId: string): Promise<boolean> {
  const n = await prisma.notification.findFirst({ where: { tag: `alarm-seller-no-prop-${clientId}` } });
  return n !== null;
}

async function makeSeller(opts: {
  daysSinceMeeting: number;
  aiScore: number;
  hasProperty?: boolean;
  meetingCompleted?: boolean;
  /** false — продавец без исхода «Объект принят»: точка отсчёта только встреча. */
  propertyAccepted?: boolean;
  /** По умолчанию SELLER — владелец 06.09.2026 (разбор слепых зон п.4): BUYER +
   *  dualIntent=true тоже обязан попадать в этот аларм. */
  kind?: "SELLER" | "BUYER";
  dualIntent?: boolean;
}) {
  const idx = clientIds.length;
  const c = await prisma.client.create({
    data: {
      fullName: `Продавец аларм ${runId}-${idx}`,
      phone: `+992917${runId}${idx}`,
      source: "PHONE_CALL",
      kind: opts.kind ?? "SELLER",
      dualIntent: opts.dualIntent ?? false,
      workStatus: "ACTIVE",
      status: "NEW",
      assignedAgentId: agentId,
      acceptedAt: new Date(),
      propertyAcceptedAt:
        opts.propertyAccepted === false ? null : new Date(NOW.getTime() - (opts.daysSinceMeeting + 5) * DAY_MS),
      aiScore: opts.aiScore,
    },
  });
  clientIds.push(c.id);

  if (opts.meetingCompleted !== false) {
    const meeting = await prisma.interaction.create({
      data: {
        clientId: c.id,
        agentId,
        type: "MEETING",
        outcome: "SELLER_MEETING",
        notes: "Тестовая встреча продавца",
        completedAt: new Date(NOW.getTime() - opts.daysSinceMeeting * DAY_MS),
      },
    });
    interactionIds.push(meeting.id);
  }

  if (opts.hasProperty) {
    const p = await prisma.property.create({
      data: {
        title: `Тест-объект-аларм-${runId}-${idx}`,
        type: "APARTMENT",
        areaSqm: 50,
        price: 40000,
        currency: "USD",
        districtId,
        address: "Тестовая, 1",
        condition: "GOOD",
        assignedAgentId: agentId,
        ownerContact: `+99290000${runId}${idx}`,
        sellerClientId: c.id,
      },
    });
    propertyIds.push(p.id);
  }

  return c;
}

beforeAll(async () => {
  HIGH_SCORE_THRESHOLD = await loadHotScoreThreshold();
  const passwordHash = await bcrypt.hash(password, 10);
  districtId = (await prisma.district.create({ data: { name: `Тест-район-аларм-${runId}` } })).id;
  const agent = await prisma.agent.create({
    data: { fullName: "Агент аларма", phone: `+992964${runId}0`, role: "AGENT", passwordHash },
  });
  agentId = agent.id;
  const director = await prisma.agent.create({
    data: { fullName: "Директор аларма", phone: `+992964${runId}1`, role: "DIRECTOR", passwordHash },
  });
  directorId = director.id;
});

afterAll(async () => {
  await prisma.notification.deleteMany({
    where: { tag: { startsWith: "alarm-seller-no-prop-" } },
  });
  await prisma.interaction.deleteMany({ where: { id: { in: interactionIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: [agentId, directorId] } } });
  await prisma.district.delete({ where: { id: districtId } });
});

describe("runSellerNoPropertyAlarmTick", () => {
  /**
   * Ревью 03.09.2026: выборка кандидатов фильтровала propertyAcceptedAt IS NOT NULL,
   * и продавец с проведённой встречей, но без исхода «Объект принят» (ровно тот
   * случай, ради которого точка отсчёта переехала на дату встречи) в аларм не
   * попадал никогда. Проверяем по Notification с тегом именно этого клиента.
   */
  it("встреча проведена, propertyAcceptedAt пуст → аларм всё равно уходит (по дате встречи)", async () => {
    const c = await makeSeller({ daysSinceMeeting: ALARM_DAYS + 1, aiScore: HIGH_SCORE_THRESHOLD, propertyAccepted: false });
    const { alerted } = await runSellerNoPropertyAlarmTick(NOW);
    expect(alerted).toBeGreaterThanOrEqual(1);
    const note = await prisma.notification.findFirst({ where: { tag: `alarm-seller-no-prop-${c.id}` } });
    expect(note).not.toBeNull();
  });

  it("ни встречи, ни propertyAcceptedAt → отсчитывать не от чего, аларма нет", async () => {
    const c = await makeSeller({ daysSinceMeeting: ALARM_DAYS + 1, aiScore: HIGH_SCORE_THRESHOLD, propertyAccepted: false, meetingCompleted: false });
    await runSellerNoPropertyAlarmTick(NOW);
    const note = await prisma.notification.findFirst({ where: { tag: `alarm-seller-no-prop-${c.id}` } });
    expect(note).toBeNull();
  });

  it("продавец ACTIVE + shootingDate 3 дня назад + нет объекта → alerted >= 1", async () => {
    await makeSeller({ daysSinceMeeting: ALARM_DAYS + 1, aiScore: HIGH_SCORE_THRESHOLD });
    const { alerted } = await runSellerNoPropertyAlarmTick(NOW);
    expect(alerted).toBeGreaterThanOrEqual(1);
  });

  /**
   * ФИЛЬТР ПО СКОРИНГУ СНЯТ (владелец 09.09.2026). Он ставил контроль за агентом в
   * зависимость от оценки, которую ИИ дал КЛИЕНТУ, — а продавец с низкой оценкой
   * как раз тот, кого удобнее всего забросить.
   */
  it("продавец с низким скорингом теперь тоже под присмотром", async () => {
    const low = await makeSeller({ daysSinceMeeting: ALARM_DAYS + 1, aiScore: 5 });
    await runSellerNoPropertyAlarmTick(NOW);
    expect(await alarmSentFor(low.id)).toBe(true);
  });

  it("продавец вовсе без оценки ИИ — под присмотром", async () => {
    const noScore = await makeSeller({ daysSinceMeeting: ALARM_DAYS + 1, aiScore: 0 });
    await prisma.client.update({ where: { id: noScore.id }, data: { aiScore: null } });
    await runSellerNoPropertyAlarmTick(NOW);
    expect(await alarmSentFor(noScore.id)).toBe(true);
  });

  it("объект уже создан → продавец не попадает в alerted", async () => {
    const c = await makeSeller({
      daysSinceMeeting: ALARM_DAYS + 1,
      aiScore: HIGH_SCORE_THRESHOLD,
      hasProperty: true,
    });
    // Создаём ещё одного без объекта для контроля.
    const control = await makeSeller({
      daysSinceMeeting: ALARM_DAYS + 1,
      aiScore: HIGH_SCORE_THRESHOLD,
    });

    await runSellerNoPropertyAlarmTick(NOW);
    // Проверяем именно этих клиентов по их тегу (№203: раньше здесь стояло
    // `alerted >= 1`, и сломанный отбор, не пропускающий продавцов с объектом, тест не замечал).
    expect(await alarmSentFor(control.id)).toBe(true);
    expect(await alarmSentFor(c.id)).toBe(false);
  });

  it("прошло меньше ALARM_DAYS дней → продавец не попадает", async () => {
    const c = await makeSeller({ daysSinceMeeting: 1, aiScore: HIGH_SCORE_THRESHOLD });
    // Контроль: старый продавец рядом попадает — значит тик реально работал, а не промолчал.
    const control = await makeSeller({ daysSinceMeeting: ALARM_DAYS + 1, aiScore: HIGH_SCORE_THRESHOLD });
    await runSellerNoPropertyAlarmTick(NOW);
    expect(await alarmSentFor(control.id)).toBe(true);
    expect(await alarmSentFor(c.id)).toBe(false);
  });

  it("встреча не проведена (completedAt=null) → fallback на propertyAcceptedAt", async () => {
    // propertyAcceptedAt = now - (daysSinceMeeting+5) = now - (ALARM_DAYS+1+5) = now - 8 дней.
    // Это старше ALARM_DAYS, значит fallback сработает и клиент попадёт в alerted.
    const c = await makeSeller({
      daysSinceMeeting: ALARM_DAYS + 1,
      aiScore: HIGH_SCORE_THRESHOLD,
      meetingCompleted: false,
    });

    const { alerted } = await runSellerNoPropertyAlarmTick(NOW);
    expect(alerted).toBeGreaterThanOrEqual(1);
  });

  it("kind=BUYER + dualIntent=true → всё равно попадает (владелец 06.09.2026, разбор слепых зон п.4)", async () => {
    const c = await makeSeller({ daysSinceMeeting: ALARM_DAYS + 1, aiScore: HIGH_SCORE_THRESHOLD, kind: "BUYER", dualIntent: true });
    const { alerted } = await runSellerNoPropertyAlarmTick(NOW);
    expect(alerted).toBeGreaterThanOrEqual(1);
    const note = await prisma.notification.findFirst({ where: { tag: `alarm-seller-no-prop-${c.id}` } });
    expect(note).not.toBeNull();
  });
});
/**
 * ГЛАВНАЯ ДЫРА, КОТОРУЮ ЗАКРЫВАЛИ 09.09.2026. Тревога гасилась самим фактом
 * существования строки объекта — ни статуса, ни фотографий не проверялось. Агент,
 * не поехавший на съёмку, мог завести пустую карточку, и тревога замолкала
 * навсегда: десять секунд работы закрывали весь контроль.
 */
describe("Объект считается принятым только с материалами", () => {
  async function attachProperty(clientId: string, status: "AWAITING_PHOTOS" | "AWAITING_VIDEO" | "PENDING_REVIEW" | "AVAILABLE") {
    const p = await prisma.property.create({
      data: {
        title: `Объект материалов ${runId}-${propertyIds.length}`,
        type: "APARTMENT",
        areaSqm: 50,
        price: 40000,
        currency: "USD",
        districtId,
        address: "Тестовая, 2",
        condition: "GOOD",
        status,
        sellerClientId: clientId,
      },
    });
    propertyIds.push(p.id);
    return p;
  }

  it("пустая карточка «ожидает фото» тревогу НЕ гасит", async () => {
    const c = await makeSeller({ daysSinceMeeting: ALARM_DAYS + 1, aiScore: 90 });
    await attachProperty(c.id, "AWAITING_PHOTOS");
    await runSellerNoPropertyAlarmTick(NOW);
    expect(await alarmSentFor(c.id)).toBe(true);
  });

  it("фото сданы, ждём видео — тоже не гасит", async () => {
    const c = await makeSeller({ daysSinceMeeting: ALARM_DAYS + 1, aiScore: 90 });
    await attachProperty(c.id, "AWAITING_VIDEO");
    await runSellerNoPropertyAlarmTick(NOW);
    expect(await alarmSentFor(c.id)).toBe(true);
  });

  it("материалы ушли на одобрение — объект ПРИНЯТ, тревоги нет", async () => {
    const c = await makeSeller({ daysSinceMeeting: ALARM_DAYS + 1, aiScore: 90 });
    await attachProperty(c.id, "PENDING_REVIEW");
    await runSellerNoPropertyAlarmTick(NOW);
    expect(await alarmSentFor(c.id)).toBe(false);
  });

  it("объект уже в продаже — тревоги нет", async () => {
    const c = await makeSeller({ daysSinceMeeting: ALARM_DAYS + 1, aiScore: 90 });
    await attachProperty(c.id, "AVAILABLE");
    await runSellerNoPropertyAlarmTick(NOW);
    expect(await alarmSentFor(c.id)).toBe(false);
  });
});

/**
 * Якорь приёмки. ИИ пишет исход SELLER_MEETING с услышанной датой на запись
 * ЗВОНКА (lib/aiCallOutcome.ts), а не на запись типа MEETING — такие создавало
 * только всплывающее окно, а окна выключены. Раньше тревога искала именно
 * MEETING и услышанную дату не видела вовсе.
 */
describe("Якорь приёмки — там, где его пишет ИИ", () => {
  async function makeBareSeller() {
    const idx = clientIds.length;
    const c = await prisma.client.create({
      data: {
        fullName: `Продавец якоря ${runId}-${idx}`,
        phone: `+992919${runId}${idx}`,
        source: "PHONE_CALL",
        kind: "SELLER",
        workStatus: "ACTIVE",
        status: "NEW",
        assignedAgentId: agentId,
        acceptedAt: new Date(),
        // Именно тот случай, что раньше проваливался: объект в работу формально
        // не принимали, только договорились приехать снимать.
        propertyAcceptedAt: null,
        aiScore: 80,
      },
    });
    clientIds.push(c.id);
    return c;
  }

  async function heardMeeting(clientId: string, daysAgo: number) {
    const i = await prisma.interaction.create({
      data: {
        clientId,
        agentId,
        type: "CALL",
        outcome: "SELLER_MEETING",
        outcomeSource: "AI_AUTO",
        notes: "Итог (ИИ): договорились о приёмке",
        nextAction: "Встреча с продавцом на объекте (осмотр/видеосъёмка)",
        nextActionDate: new Date(NOW.getTime() - daysAgo * DAY_MS),
      },
    });
    interactionIds.push(i.id);
    return i;
  }

  it("услышанная дата приёмки прошла, объекта нет — тревога есть", async () => {
    const c = await makeBareSeller();
    await heardMeeting(c.id, ALARM_DAYS + 1);
    await runSellerNoPropertyAlarmTick(NOW);
    expect(await alarmSentFor(c.id)).toBe(true);
  });

  it("срок ещё не вышел — молчим", async () => {
    const c = await makeBareSeller();
    await heardMeeting(c.id, 1);
    await runSellerNoPropertyAlarmTick(NOW);
    expect(await alarmSentFor(c.id)).toBe(false);
  });

  /** Перенос приёмки обязан отодвинуть и тревогу, иначе перенос сам её и вызовет. */
  it("приёмку перенесли на более поздний срок — тревоги нет", async () => {
    const c = await makeBareSeller();
    await heardMeeting(c.id, ALARM_DAYS + 3);
    await heardMeeting(c.id, 0);
    await runSellerNoPropertyAlarmTick(NOW);
    expect(await alarmSentFor(c.id)).toBe(false);
  });

  it("договорённость отменена — отсчитывать не от чего", async () => {
    const c = await makeBareSeller();
    const i = await heardMeeting(c.id, ALARM_DAYS + 1);
    await prisma.interaction.update({ where: { id: i.id }, data: { declinedAt: new Date() } });
    await runSellerNoPropertyAlarmTick(NOW);
    expect(await alarmSentFor(c.id)).toBe(false);
  });
});

/**
 * Лесенка перед тем, как будить владельца (владелец 09.09.2026). Тревога уходит
 * только когда агент перестал пытаться И объяснения нет: «агент звонит, клиент не
 * берёт» — это работа, а не тишина.
 */
describe("Общение продолжается — не будим", () => {
  async function bareSeller(daysAgoMeeting: number) {
    const idx = clientIds.length;
    const c = await prisma.client.create({
      data: {
        fullName: `Продавец лесенки ${runId}-${idx}`,
        phone: `+992920${runId}${idx}`,
        source: "PHONE_CALL",
        kind: "SELLER",
        workStatus: "ACTIVE",
        status: "NEW",
        assignedAgentId: agentId,
        acceptedAt: new Date(),
        propertyAcceptedAt: null,
        aiScore: 80,
      },
    });
    clientIds.push(c.id);
    const i = await prisma.interaction.create({
      data: {
        clientId: c.id,
        agentId,
        type: "CALL",
        outcome: "SELLER_MEETING",
        notes: "Договорились о приёмке",
        nextActionDate: new Date(NOW.getTime() - daysAgoMeeting * DAY_MS),
      },
    });
    interactionIds.push(i.id);
    return c;
  }

  it("агент писал или звонил ПОСЛЕ назначенной даты — договариваются заново, тревоги нет", async () => {
    const c = await bareSeller(ALARM_DAYS + 2);
    await prisma.client.update({
      where: { id: c.id },
      data: { lastAgentAttemptAt: new Date(NOW.getTime() - 1 * DAY_MS) },
    });
    await runSellerNoPropertyAlarmTick(NOW);
    expect(await alarmSentFor(c.id)).toBe(false);
  });

  it("клиент сам написал после назначенной даты — тоже ждём", async () => {
    const c = await bareSeller(ALARM_DAYS + 2);
    await prisma.client.update({
      where: { id: c.id },
      data: { lastClientMessageAt: new Date(NOW.getTime() - 1 * DAY_MS) },
    });
    await runSellerNoPropertyAlarmTick(NOW);
    expect(await alarmSentFor(c.id)).toBe(false);
  });

  it("следы общения ДО назначенной даты не считаются — тревога уходит", async () => {
    const c = await bareSeller(ALARM_DAYS + 2);
    await prisma.client.update({
      where: { id: c.id },
      data: { lastAgentAttemptAt: new Date(NOW.getTime() - (ALARM_DAYS + 5) * DAY_MS) },
    });
    await runSellerNoPropertyAlarmTick(NOW);
    expect(await alarmSentFor(c.id)).toBe(true);
  });
});

/**
 * АУДИТ CODEX 04.10.2026, CHANNEL-NEW-10: ПРОСТОЙ СТАНЦИИ УСКОРЯЛ АЛАРМ ВМЕСТО ПРОДЛЕНИЯ СРОКА.
 *
 * Условие пропуска сравнивало встречу с `cutoff + downMs` (вместо `cutoff - downMs`, как в
 * agentOffCrmAlarm.ts): чем дольше станция лежала в рабочие часы, тем РАНЬШЕ уходила
 * критическая тревога «два дня без объекта». С того же момента встречи прошло 47 часов,
 * внутри — 2 рабочих часа простоя станции, значит эффективный срок 45 ч < 48 ч, тревоги быть не должно.
 */
describe("простой станции продлевает срок, а не сокращает его", () => {
  let outageId = "";
  let savedWork: { workHoursStart: string; workHoursEnd: string } | null = null;

  beforeAll(async () => {
    const s = await prisma.settings.findUnique({
      where: { id: "singleton" },
      select: { workHoursStart: true, workHoursEnd: true },
    });
    savedWork = s;
    await prisma.settings.update({ where: { id: "singleton" }, data: { workHoursStart: "09:30", workHoursEnd: "18:00" } });
    // Понедельник 31.08.2026, 10:00–12:00 по Душанбе (05:00–07:00Z): два рабочих часа внутри периода.
    outageId = (
      await prisma.stationOutage.create({
        data: { startedAt: new Date("2026-08-31T05:00:00Z"), endedAt: new Date("2026-08-31T07:00:00Z") },
      })
    ).id;
  });

  afterAll(async () => {
    await prisma.stationOutage.deleteMany({ where: { id: outageId } });
    if (savedWork) await prisma.settings.update({ where: { id: "singleton" }, data: savedWork });
  });

  it("47 часов с встречи, из них 2 рабочих часа простоя: эффективный срок 45 ч < 48 ч, тревоги нет", async () => {
    const c = await makeSeller({ daysSinceMeeting: 47 / 24, aiScore: 90 });
    await runSellerNoPropertyAlarmTick(NOW);
    expect(await alarmSentFor(c.id)).toBe(false);
  });

  it("51 час с встречи, из них 2 часа простоя: эффективный срок 49 ч >= 48 ч, тревога уходит", async () => {
    const c = await makeSeller({ daysSinceMeeting: 51 / 24, aiScore: 90 });
    await runSellerNoPropertyAlarmTick(NOW);
    expect(await alarmSentFor(c.id)).toBe(true);
  });
});
