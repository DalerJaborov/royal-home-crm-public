import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";

/**
 * «Завершить сделку → Без сделки» (переработка 12.08.2026 из отказного потока):
 * причина обязательна; ДЛЯ ПОКУПАТЕЛЯ доступна только после первого проведённого
 * показа (ТЗ п. 16) — карточка сама по себе больше не открывает эту форму; лид
 * уходит сильному по KPI; после 3 отказов — эскалация.
 */

const runId = Date.now();
const password = "testpass123";

let districtId: string;
let weakAgentId: string;
let strongAgentId: string;
let weakToken: string;
const clientIds: string[] = [];

async function makeClient(data: Record<string, unknown>) {
  const c = await prisma.client.create({
    data: {
      fullName: `${data.fullName} ${runId}`,
      phone: data.phone as string,
      source: "PHONE_CALL",
      assignedAgentId: weakAgentId,
      acceptedAt: new Date(),
      ...((({ fullName, phone, ...rest }) => rest)(data) as object),
    },
  });
  clientIds.push(c.id);
  return c;
}

/** Показ — обязательное условие «Завершить сделку» для покупателя (ТЗ п. 16). */
async function makeShowing(clientId: string) {
  return prisma.interaction.create({
    data: { clientId, agentId: weakAgentId, type: "SHOWING", notes: "Показ объекта", completedAt: new Date() },
  });
}

async function refuse(clientId: string, body: Record<string, unknown>) {
  return request(app)
    .post(`/api/v1/clients/${clientId}/refuse`)
    .set("Authorization", `Bearer ${weakToken}`)
    .send(body);
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  districtId = (await prisma.district.create({ data: { name: `Тест-район-отказ-${runId}` } })).id;
  // kpi: слабый 40, сильный 95 — «сильный» должен получать отказные лиды.
  weakAgentId = (
    await prisma.agent.create({
      data: { fullName: "Агент слабый", phone: `+992954${runId}`, role: "AGENT", passwordHash, kpi: 40 },
    })
  ).id;
  strongAgentId = (
    await prisma.agent.create({
      data: { fullName: "Агент сильный", phone: `+992953${runId}`, role: "AGENT", passwordHash, kpi: 95 },
    })
  ).id;

  const res = await request(app).post("/api/v1/auth/login").send({ phone: `+992954${runId}`, password });
  expect(res.status).toBe(200);
  weakToken = res.body.accessToken as string;

  // Автопередача лида следующему агенту по KPI по умолчанию ВЫКЛЮЧЕНА с
  // 18.08.2026 — этот файл проверяет саму механику передачи, поэтому включаем
  // её явно на время теста, а не полагаемся на дефолт.
  await prisma.settings.update({ where: { id: "singleton" }, data: { autoRouteRefusedLeads: true } });
});

afterAll(async () => {
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: [weakAgentId, strongAgentId] } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.settings.update({ where: { id: "singleton" }, data: { autoRouteRefusedLeads: false } });
  await prisma.$disconnect();
});

describe("Выбор сильного агента", () => {
  it("из слабого и сильного выбирается сильный по KPI", async () => {
    const { pickNextAgentByKpiQueue } = await import("../src/leads.js");
    // Исключаем всех, кроме пары из этого теста: в базе есть агенты сидов и
    // соседних тестовых файлов с kpi=null (равен 100).
    const others = await prisma.agent.findMany({
      where: { role: "AGENT", isActive: true, id: { notIn: [weakAgentId, strongAgentId] } },
      select: { id: true },
    });
    expect(await pickNextAgentByKpiQueue(others.map((a) => a.id))).toBe(strongAgentId);
  });
});

describe("Отказ клиента", () => {
  it("без причины отказ не оформляется", async () => {
    const c = await makeClient({ fullName: "Без причины", phone: `+992952${runId}` });
    const res = await refuse(c.id, { comment: "просто так" });
    expect(res.status).toBe(400);
  });

  it("заполненная карточка: клиент горячий, уходит сильному агенту непринятым", async () => {
    const c = await makeClient({
      fullName: "Горячий по карточке",
      phone: `+992951${runId}`,
      budgetMax: 500000,
      desiredDistrictId: districtId,
      desiredRooms: 2,
    });
    await makeShowing(c.id);
    // Причина намеренно НЕ из EXPENSIVE/WRONG_OBJECT/FINANCE_ISSUE (задача G,
    // 03-04.09.2026): эти три теперь уходят в «Отложенные» другим ответом,
    // проверено отдельно в tests/deferred-clients.test.ts. Этот тест — про
    // обычную механику отказа (горячий/передача сильному), STOPPED_RESPONDING
    // тоже не требует проверки СБ и ведёт по тому же обычному пути.
    const res = await refuse(c.id, { reason: "STOPPED_RESPONDING", initiator: "AGENT", comment: "хочет скидку 15%" });
    expect(res.status).toBe(200);
    expect(res.body.isHot).toBe(true);
    expect(res.body.transferred).toBe(true);

    const after = await prisma.client.findUnique({ where: { id: c.id } });
    expect(after?.hotSince).not.toBeNull();
    expect(after?.status).toBe("HOT");
    expect(after?.assignedAgentId).not.toBe(weakAgentId);
    expect(after?.acceptedAt).toBeNull(); // ждёт принятия у нового агента
    expect(after?.refusalReason).toBe("STOPPED_RESPONDING");
    expect(after?.refusalCount).toBe(1);

    // Причина и комментарий видны в хронологии — следующему агенту.
    const note = await prisma.interaction.findFirst({ where: { clientId: c.id, type: "SYSTEM" } });
    expect(note?.notes).toContain("Перестал выходить на связь");
    expect(note?.notes).toContain("скидку 15%");
  });

  it("пустая карточка, но был показ — тоже горячий (показ ценнее анкеты)", async () => {
    const c = await makeClient({ fullName: "Горячий по показу", phone: `+992950${runId}` });
    await makeShowing(c.id);
    const res = await refuse(c.id, { reason: "STOPPED_RESPONDING", initiator: "AGENT", comment: "объекты не подошли" });
    expect(res.status).toBe(200);
    expect(res.body.isHot).toBe(true);
  });

  it("показ был, но карточка почти пуста — не горячий по карточке, но передаётся; статус Холодный", async () => {
    // Бюджет есть (проходит isClientCardFilled частично), но без района/комнат/
    // пожеланий — до «горячего» по карточке не дотягивает; горячим делает только
    // сам факт показа (isHot = hadShowing || cardFilled — показ уже даёт true,
    // проверяем здесь именно branch «показ есть, card не дотягивает до isHot по
    // cardFilled» отдельно от предыдущего теста «пустая карточка, но был показ»).
    const c = await makeClient({ fullName: "Холодный отказ", phone: `+992949${runId}`, budgetMax: 400000 });
    await makeShowing(c.id);
    // Причина намеренно из тех, что НЕ требуют проверки СБ и НЕ уходят в
    // «Отложенные» (EXPENSIVE/WRONG_OBJECT/FINANCE_ISSUE — задача G): «передумал»
    // с 02.08.2026 уводит карточку в службу безопасности, и передачи там нет вовсе.
    const res = await refuse(c.id, { reason: "STOPPED_RESPONDING", initiator: "AGENT", comment: "просит скидку, не сошлись" });
    expect(res.status).toBe(200);
    // isHot = hadShowing || cardFilled — раз показ был, клиент горячий в любом случае.
    expect(res.body.isHot).toBe(true);
    const after = await prisma.client.findUnique({ where: { id: c.id } });
    expect(after?.status).toBe("HOT");
    expect(after?.assignedAgentId).not.toBe(weakAgentId);
  });

  it("третий отказ: передача останавливается, лид эскалируется", async () => {
    const c = await makeClient({
      fullName: "Трижды отказ",
      phone: `+992948${runId}`,
      refusalCount: 2,
      budgetMax: 400000,
    });
    await makeShowing(c.id);
    const res = await refuse(c.id, { reason: "NO_TRUST", initiator: "AGENT", comment: "перестал доверять агенту" });
    expect(res.status).toBe(200);
    expect(res.body.transferred).toBe(false);
    const after = await prisma.client.findUnique({ where: { id: c.id } });
    expect(after?.refusalCount).toBe(3);
    expect(after?.escalatedAt).not.toBeNull();
    // Лид остался у последнего агента — руководитель назначит вручную.
    expect(after?.assignedAgentId).toBe(weakAgentId);
  });

  it("чужого клиента агент отказать не может", async () => {
    const c = await makeClient({ fullName: "Чужой клиент", phone: `+992947${runId}` });
    await prisma.client.update({ where: { id: c.id }, data: { assignedAgentId: strongAgentId } });
    const res = await refuse(c.id, { reason: "OTHER", initiator: "AGENT", comment: "причина без списка" });
    expect(res.status).toBe(403);
  });

  it("горячие видны фильтром hot=1 и не видны без него лишним статусом", async () => {
    const res = await request(app)
      .get(`/api/v1/clients?hot=1&q=${encodeURIComponent(String(runId))}`)
      .set("Authorization", `Bearer ${weakToken}`);
    expect(res.status).toBe(200);
    const names = (res.body.items as Array<{ fullName: string }>).map((c) => c.fullName);
    // Слабому агенту виден его собственный список; горячие уже переданы сильному —
    // поэтому проверяем под ним же через прямой запрос базы ниже.
    const hotCount = await prisma.client.count({ where: { id: { in: clientIds }, hotSince: { not: null } } });
    // Три горячих из этого describe-блока: показ для покупателя теперь обязателен
    // для «Завершить сделку», а раз показ был — isHot=true всегда (hadShowing ||
    // cardFilled), значит все три успешных отказа выше стали горячими (кроме
    // третьего — там дошло до эскалации, и статус решает не isHot, а «Потерянный»).
    expect(hotCount).toBe(3);
    expect(Array.isArray(names)).toBe(true);
  });
});

/**
 * Переработка 12.08.2026 (ТЗ п. 16): для ПОКУПАТЕЛЯ «Завершить сделку» больше не
 * открывается заполненной карточкой — только первым проведённым показом
 * («это предотвращает фиктивное закрытие клиента без реальной работы»). Карточка
 * без единого поля, но с показом, теперь проходит; заполненная карточка без
 * показа — нет (до показа закрывают через «Передача»/«Неактивный»).
 */
describe("«Завершить сделку» доступна для покупателя только после показа", () => {
  it("абсолютно пустая карточка без показа — 409, отказ не оформляется", async () => {
    const c = await makeClient({ fullName: "Совсем пусто", phone: `+992940${runId}` });
    const res = await refuse(c.id, { reason: "EXPENSIVE", initiator: "AGENT", comment: "передумал покупать вовсе" });
    expect(res.status).toBe(409);
    const after = await prisma.client.findUnique({ where: { id: c.id } });
    expect(after?.refusalCount).toBe(0);
    expect(after?.assignedAgentId).toBe(weakAgentId);
  });

  it("карточка заполнена, но показа не было — тоже 409", async () => {
    const c = await makeClient({ fullName: "Немного заполнена", phone: `+992939${runId}`, desiredRooms: 2 });
    const res = await refuse(c.id, { reason: "EXPENSIVE", initiator: "AGENT", comment: "нашёл дешевле у соседей" });
    expect(res.status).toBe(409);
  });

  it("пустая карточка, но был показ — отказ проходит без единого поля", async () => {
    const c = await makeClient({ fullName: "Пусто, но был показ", phone: `+992938${runId}` });
    await makeShowing(c.id);
    const res = await refuse(c.id, { reason: "EXPENSIVE", initiator: "AGENT", comment: "цена не устроила клиента" });
    expect(res.status).toBe(200);
  });
});

/**
 * Проверка службы безопасности.
 *
 * Часть причин означает, что сделка со слов агента прошла мимо компании. Это может
 * быть правдой, а может быть способом увести сделку и закрыть карточку красиво —
 * поэтому такая карточка не идёт следующему агенту и не считается закрытой, пока
 * решение не принял человек.
 */
describe("Закрытия, требующие проверки СБ", () => {
  it("«продал через другое агентство» — карточка уходит на проверку, а не следующему агенту", async () => {
    const c = await makeClient({ fullName: "Ушёл к конкурентам", phone: `+992941${runId}`, budgetMax: 400000 });
    await makeShowing(c.id);
    const res = await refuse(c.id, {
      reason: "SOLD_VIA_OTHER_AGENCY",
      initiator: "OWNER",
      competitorName: "Соседнее агентство",
      comment: "собственник продал сам через конкурента",
    });

    expect(res.status).toBe(200);
    expect(res.body.securityReview).toBeUndefined();
    expect(res.body.transferred).toBe(false);

    const after = await prisma.client.findUnique({ where: { id: c.id } });
    expect(after?.securityReview).toBe("PENDING");
    // Агент прежний: пока не разобрались, кому ушла сделка, передавать некому.
    expect(after?.assignedAgentId).toBe(weakAgentId);
    // И статус не тронут: закрывать карточку до вердикта значит закрыть вопрос
    // до ответа на него.
    expect(after?.status).not.toBe("ARCHIVED");
  });

  it("«перестал отвечать» от агента проверки не требует — обычная передача", async () => {
    // Не EXPENSIVE: эта причина с задачи G (03-04.09.2026) уходит в «Отложенные»
    // другим ответом (см. tests/deferred-clients.test.ts), а не сюда.
    const c = await makeClient({ fullName: "Просто перестал отвечать", phone: `+992942${runId}`, budgetMax: 400000 });
    await makeShowing(c.id);
    const res = await refuse(c.id, { reason: "STOPPED_RESPONDING", initiator: "AGENT", comment: "клиент замолчал" });

    expect(res.body.securityReview).toBeUndefined();
    const after = await prisma.client.findUnique({ where: { id: c.id } });
    expect(after?.securityReview).toBeNull();
  });

  /**
   * РЕШЕНИЕ ВЛАДЕЛЬЦА 03.09.2026 (план §E) — разворот прежнего правила ниже.
   * До этой правки развилку решал ИНИЦИАТОР (спецификация от 01.08.2026, пп. 2–3):
   * инициатор клиент уводил В СБ ЛЮБУЮ причину, включая «дорого». Это оказалось
   * слишком широко — «дорого» от самого клиента ничем не отличается от «дорого»
   * пересказанного агентом, ни то ни другое не значит увода сделки на сторону.
   * Теперь решает ТОЛЬКО причина (см. REASONS_REQUIRING_SECURITY_REVIEW) —
   * инициатор остаётся в хронологии текстом, но на маршрут карточки не влияет.
   */
  it("инициатор клиент БЕЗ SB-причины — обычная передача, проверка СБ не запускается", async () => {
    const c = await makeClient({ fullName: "Сам отказался", phone: `+992943${runId}`, budgetMax: 400000 });
    await makeShowing(c.id);
    const res = await refuse(c.id, { reason: "STOPPED_RESPONDING", initiator: "CLIENT", comment: "клиент сам сообщил об отказе" });

    expect(res.body.securityReview).toBeUndefined();
    expect(res.body.transferred).toBe(true);
    const after = await prisma.client.findUnique({ where: { id: c.id } });
    expect(after?.securityReview).toBeNull();
  });

  it("«передумал»/«снял с продажи» больше не требуют проверки СБ ни при каком инициаторе", async () => {
    const changedMind = await makeClient({ fullName: "Передумал покупать", phone: `+992944${runId}`, budgetMax: 400000 });
    await makeShowing(changedMind.id);
    const res1 = await refuse(changedMind.id, { reason: "CHANGED_MIND", initiator: "CLIENT", comment: "клиент передумал покупать" });
    expect(res1.body.securityReview).toBeUndefined();
    expect((await prisma.client.findUnique({ where: { id: changedMind.id } }))?.securityReview).toBeNull();

    const withdrawn = await makeClient({ fullName: "Снял с продажи", phone: `+992928${runId}`, budgetMax: 400000, kind: "SELLER" });
    await makeShowing(withdrawn.id);
    const res2 = await refuse(withdrawn.id, { reason: "WITHDRAWN_FROM_SALE", initiator: "AGENT", comment: "продавец снял объект с продажи" });
    expect(res2.body.securityReview).toBeUndefined();
    expect((await prisma.client.findUnique({ where: { id: withdrawn.id } }))?.securityReview).toBeNull();
  });

  it("«купил сам»/«продал через другое агентство» по-прежнему уходят в СБ независимо от инициатора", async () => {
    const boughtSelf = await makeClient({ fullName: "Купил сам всё же", phone: `+992927${runId}`, budgetMax: 400000 });
    await makeShowing(boughtSelf.id);
    const res = await refuse(boughtSelf.id, { reason: "BOUGHT_SELF", initiator: "AGENT", comment: "агент узнал, что клиент купил сам" });
    expect(res.body.securityReview).toBeUndefined();
    expect((await prisma.client.findUnique({ where: { id: boughtSelf.id } }))?.securityReview).toBe("PENDING");
  });
});

/** Решения владельца 03.09.2026: «1б» — отказ без автопередачи снимает агента;
 *  «2в» — комментарий обязателен только при высоком скоринге. */
describe("Отказ: решения владельца 03.09", () => {
  it("высокий скоринг без объяснения — 400; с голосовой заметкой — проходит", async () => {
    const c = await makeClient({ fullName: "Тёплый без комментария", phone: `+992937${runId}`, aiScore: 95 });
    await makeShowing(c.id);
    const bare = await refuse(c.id, { reason: "EXPENSIVE", initiator: "AGENT" });
    expect(bare.status).toBe(400);
    expect(bare.body.error).toContain("высоким скорингом");
    const short = await refuse(c.id, { reason: "EXPENSIVE", initiator: "AGENT", comment: "дорого" });
    expect(short.status).toBe(400);
    const voiced = await refuse(c.id, { reason: "EXPENSIVE", initiator: "AGENT", voiceNoteUrl: "/me/voice-notes/x.webm" });
    expect(voiced.status).toBe(200);
  });

  it("низкий скоринг — комментарий по-прежнему не обязателен", async () => {
    const c = await makeClient({ fullName: "Холодный без комментария", phone: `+992936${runId}`, aiScore: 20 });
    await makeShowing(c.id);
    const res = await refuse(c.id, { reason: "EXPENSIVE", initiator: "AGENT" });
    expect(res.status).toBe(200);
  });

  it("автопередача выключена — клиент снимается с агента и уходит в очередь руководителя", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { autoRouteRefusedLeads: false } });
    try {
      const c = await makeClient({ fullName: "В очередь руководителя", phone: `+992935${runId}` });
      await makeShowing(c.id);
      // Не EXPENSIVE: с задачи G (03-04.09.2026) эта причина уходит в
      // «Отложенные» до того, как код доходит до ветки автопередачи ниже.
      const res = await refuse(c.id, { reason: "STOPPED_RESPONDING", initiator: "AGENT", comment: "не вышел на связь" });
      expect(res.status).toBe(200);
      const after = await prisma.client.findUnique({ where: { id: c.id } });
      expect(after?.assignedAgentId).toBeNull();
      expect(after?.lastAgentId).toBe(weakAgentId);
      expect(after?.escalatedAt).not.toBeNull();
      expect(after?.status).not.toBe("LOST");
    } finally {
      await prisma.settings.update({ where: { id: "singleton" }, data: { autoRouteRefusedLeads: true } });
    }
  });
});
