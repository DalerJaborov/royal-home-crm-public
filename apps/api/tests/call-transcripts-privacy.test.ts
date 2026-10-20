import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { signAccessToken } from "../src/auth/jwt.js";
// Права читаются из базы, но кэшируются в памяти на 15 секунд — иначе снятая в
// этом тесте галочка подействовала бы уже после его конца.
import { invalidateAgentAccess } from "../src/auth/middleware.js";

/**
 * Свой разговор агент читает, чужой — нет. Слушать не может НИКАКОЙ — ни свой,
 * ни чужой (04.09.2026, сужение решения ниже).
 *
 * ИСТОРИЯ. Решение владельца 07.08.2026 звучало дословно: «доступы для своих звонков
 * прослушивания и так далее не надо даже самим агентам, кроме админов никому».
 * 15.08.2026 владелец эту часть отменил: «его звонки он сам может и видеть, и
 * посмотреть расшифровку, или прослушать — пусть в хронологии тоже это будет».
 * 04.09.2026 владелец сузил ЕЩЁ РАЗ, но только звук: «слушать — больше нельзя,
 * читать (уже замаскированную) расшифровку и совет — можно оставить». Три роли
 * сохранили полный доступ, включая звук: DIRECTOR/ADMIN, SECURITY (право
 * clients.securityReview) и MARKETING — см. lib/callTranscripts.ts,
 * packages/shared/permissions.ts (calls.hearRecording).
 *
 * Смысл прежнего запрета сохранён целиком и проверяется здесь же: разбор работы
 * сотрудника не должен править тот, чью работу разбирают, а расшифровка — это ещё и
 * контакты, договорённости и формулировки, которым незачем расходиться по компании.
 * Поэтому ЧУЖОЙ разговор закрыт по-прежнему, и закрыт на каждом пути: карточка
 * клиента, лента активности, раздел «Звонки» и прослушивание записи. Правило,
 * записанное в одном маршруте, остальные обходят молча — этот урок в проекте уже был
 * с телефонами клиентов.
 */

const runId = Date.now();
const TRANSCRIPT = "Клиент: ищу двушку в Сино до пятидесяти тысяч.";
const TRANSCRIPT_RU = "Клиент: ищу двухкомнатную в Сино до пятидесяти тысяч.";
const OTHER_TRANSCRIPT = "Клиент: продаю дом в Гипроземе.";
const ROUTED_TRANSCRIPT = "Клиент: перезвоните завтра утром.";
let agentId = "";
let otherAgentId = "";
let operatorId = "";
let adminId = "";
let securityId = "";
let marketingId = "";
let managerId = "";
let clientId = "";
let clientShortId = 0;
let interactionId = "";
let otherInteractionId = "";
let routedInteractionId = "";
let agentToken = "";
let adminToken = "";
let securityToken = "";
let marketingToken = "";
let managerToken = "";

beforeAll(async () => {
  const agent = await prisma.agent.create({
    data: { fullName: `Агент тайны ${runId}`, phone: `+99297${String(runId).slice(-7)}`, role: "AGENT", passwordHash: "x" },
  });
  const otherAgent = await prisma.agent.create({
    data: { fullName: `Коллега тайны ${runId}`, phone: `+99296${String(runId).slice(-7)}`, role: "AGENT", passwordHash: "x" },
  });
  const admin = await prisma.agent.create({
    data: { fullName: `Админ тайны ${runId}`, phone: `+99298${String(runId).slice(-7)}`, role: "ADMIN", passwordHash: "x" },
  });
  // Три роли, сохранившие полный доступ к звуку 04.09.2026 (см. заголовок файла).
  const security = await prisma.agent.create({
    data: { fullName: `СБ тайны ${runId}`, phone: `+99294${String(runId).slice(-7)}`, role: "SECURITY", passwordHash: "x" },
  });
  const marketing = await prisma.agent.create({
    data: { fullName: `Маркетинг тайны ${runId}`, phone: `+99293${String(runId).slice(-7)}`, role: "MARKETING", passwordHash: "x" },
  });
  // Роль, НЕ названная владельцем среди трёх, — тоже читает свои разговоры
  // (calls.ownTranscripts), но слушать не должна, как и AGENT.
  const manager = await prisma.agent.create({
    data: { fullName: `Руководитель тайны ${runId}`, phone: `+99292${String(runId).slice(-7)}`, role: "MANAGER", passwordHash: "x" },
  });
  agentId = agent.id;
  otherAgentId = otherAgent.id;
  adminId = admin.id;
  securityId = security.id;
  marketingId = marketing.id;
  managerId = manager.id;
  agentToken = signAccessToken({ sub: agent.id, role: "AGENT" });
  adminToken = signAccessToken({ sub: admin.id, role: "ADMIN" });
  securityToken = signAccessToken({ sub: security.id, role: "SECURITY" });
  marketingToken = signAccessToken({ sub: marketing.id, role: "MARKETING" });
  managerToken = signAccessToken({ sub: manager.id, role: "MANAGER" });

  const client = await prisma.client.create({
    data: {
      fullName: `Клиент тайны ${runId}`,
      phone: `+99299${String(runId).slice(-7)}`,
      source: "PHONE_CALL",
      assignedAgentId: agent.id,
      acceptedAt: new Date(),
    },
  });
  clientId = client.id;
  clientShortId = client.shortId;

  const interaction = await prisma.interaction.create({
    data: {
      clientId: client.id,
      agentId: agent.id,
      type: "CALL",
      notes: "Звонок через CRM, разговор 2:51",
      transcript: TRANSCRIPT,
      transcriptRu: TRANSCRIPT_RU,
      recordingUrl: "2026/08/07/out-880001007-1004-20260807-181624-1786108584.84.mp3",
      recordingDurationSec: 171,
    },
  });
  interactionId = interaction.id;
  await prisma.callAnalysis.create({
    data: {
      interactionId: interaction.id,
      agentId: agent.id,
      score: 71,
      objections: ["дорого"],
      agreements: ["показ в четверг"],
      summary: "Клиент ищет двушку в Сино.",
      coaching: "Уточняйте бюджет до показа.",
    },
  });

  /**
   * Разговор ЧУЖОГО агента по той же карточке. Так бывает после передачи клиента:
   * история прежнего агента остаётся в хронологии, и она не должна открываться
   * новому вместе с карточкой.
   */
  const otherCall = await prisma.interaction.create({
    data: {
      clientId: client.id,
      agentId: otherAgent.id,
      type: "CALL",
      notes: "Звонок прежнего агента, разговор 1:10",
      transcript: OTHER_TRANSCRIPT,
      transcriptRu: OTHER_TRANSCRIPT,
      recordingUrl: "2026/08/07/out-880001007-1009-20260807-171624-1786108584.12.mp3",
      recordingDurationSec: 70,
    },
  });
  otherInteractionId = otherCall.id;
  await prisma.callAnalysis.create({
    data: {
      interactionId: otherCall.id,
      agentId: otherAgent.id,
      score: 22,
      objections: [],
      agreements: [],
      summary: "Разговор ни к чему не привёл.",
      coaching: "Договаривайтесь о следующем шаге.",
    },
  });

  /**
   * Входящий звонок КЛИЕНТА агента, принятый ДЕЖУРНЫМ ОПЕРАТОРОМ по очереди.
   *
   * Автор записи в хронологии — оператор (см. lib/telephony/incomingCalls.ts:
   * authorId = operator?.id ?? assignedAgentId), а не agent. Отличие от otherCall
   * выше принципиальное: там agentId — прежний живой агент, чья история закрыта
   * НАМЕРЕННО; здесь — дежурный, ответивший по очереди на клиента, который
   * по-прежнему закреплён за agent. Признак различия — связка IncomingCall →
   * interactionId (найдено 16.08.2026, см. шапку lib/callTranscripts.ts).
   */
  const operator = await prisma.agent.create({
    data: { fullName: `Оператор тайны ${runId}`, phone: `+99295${String(runId).slice(-7)}`, role: "AGENT", passwordHash: "x" },
  });
  operatorId = operator.id;
  const routedCall = await prisma.interaction.create({
    data: {
      clientId: client.id,
      agentId: operator.id,
      type: "CALL",
      notes: "Входящий звонок клиента: поговорил с оператором, 0:40",
      transcript: ROUTED_TRANSCRIPT,
      recordingUrl: "2026/08/16/q-1000-880001007-20260816-090000-1786108584.20.mp3",
      recordingDurationSec: 40,
    },
  });
  routedInteractionId = routedCall.id;
  await prisma.incomingCall.create({
    data: {
      channelId: `privacy-test-${runId}`,
      phone: "880001007",
      answered: true,
      answeredBy: "1000",
      clientId: client.id,
      interactionId: routedCall.id,
    },
  });
});

afterAll(async () => {
  await prisma.callAnalysis.deleteMany({ where: { interactionId: { in: [interactionId, otherInteractionId] } } });
  await prisma.incomingCall.deleteMany({ where: { channelId: `privacy-test-${runId}` } });
  await prisma.interaction.deleteMany({ where: { clientId } });
  await prisma.client.deleteMany({ where: { id: clientId } });
  await prisma.agent.deleteMany({
    where: { id: { in: [agentId, otherAgentId, operatorId, adminId, securityId, marketingId, managerId] } },
  });
  await prisma.$disconnect();
});

describe("Свой разговор — агенту, чужой — только администрации", () => {
  it("карточка клиента: свой разговор открыт, текст приходит ленивым запросом", async () => {
    // С 26.08.2026 карточка НЕ поднимает тексты расшифровок на все 200 записей
    // хронологии (мегабайты на открытие): в ответе — признаки hasTranscript/canHear
    // и разбор, а сам текст интерфейс берёт по клику из /interactions/:id/transcript.
    const res = await request(app)
      .get(`/api/v1/clients/${clientShortId}`)
      .set("Authorization", `Bearer ${agentToken}`);

    expect(res.status).toBe(200);
    const call = res.body.interactions.find((i: { id: string }) => i.id === interactionId);
    expect(call, "звонок не найден в хронологии").toBeDefined();
    expect(call.hasTranscript).toBe(true);
    // ЧТЕНИЕ открыто — как и раньше.
    expect(call.canRead).toBe(true);
    // ЗВУК закрыт даже для собственного разговора (04.09.2026) — см. заголовок файла.
    expect(call.canHear).toBe(false);
    expect(call.hasRecording).toBe(true);
    // Совет пишется агенту — значит агент его и читает.
    expect(call.callAnalysis.coaching).toContain("бюджет");

    const text = await request(app)
      .get(`/api/v1/interactions/${interactionId}/transcript`)
      .set("Authorization", `Bearer ${agentToken}`);
    expect(text.status).toBe(200);
    expect(text.body.transcript).toBe(TRANSCRIPT);
    expect(text.body.transcriptRu).toBe(TRANSCRIPT_RU);
  });

  it("карточка клиента: разговор коллеги закрыт — и текстом, и переводом, и разбором", async () => {
    const res = await request(app)
      .get(`/api/v1/clients/${clientShortId}`)
      .set("Authorization", `Bearer ${agentToken}`);

    const foreign = res.body.interactions.find((i: { id: string }) => i.id === otherInteractionId);
    expect(foreign, "чужой звонок пропал из хронологии").toBeDefined();
    expect(foreign.transcript).toBeNull();
    // Перевод закрывается вместе с оригиналом: пока про него забывали, весь
    // разговор утекал именно им.
    expect(foreign.transcriptRu).toBeNull();
    expect(foreign.recordingUrl).toBeNull();
    expect(foreign.callAnalysis).toBeNull();
    expect(foreign.canRead).toBe(false);
    expect(foreign.canHear).toBe(false);
    // Факт остаётся: иначе разговор выглядел бы пропавшим бесследно.
    expect(foreign.hasRecording).toBe(true);
    expect(foreign.hasTranscript).toBe(true);
  });

  it("карточка клиента: входящий, принятый оператором по очереди, открыт ответственному агенту — это его клиент", async () => {
    const res = await request(app)
      .get(`/api/v1/clients/${clientShortId}`)
      .set("Authorization", `Bearer ${agentToken}`);

    const routed = res.body.interactions.find((i: { id: string }) => i.id === routedInteractionId);
    expect(routed, "входящий разговор пропал из хронологии").toBeDefined();
    expect(routed.canRead).toBe(true);
    // Звук закрыт и здесь (04.09.2026) — маршрутизация делает разговор «своим»
    // для ЧТЕНИЯ, но не открывает calls.hearRecording.
    expect(routed.canHear).toBe(false);
    expect(routed.hasTranscript).toBe(true);
    // recordingUrl теперь пуст, раз слушать нельзя — факт записи виден через
    // hasRecording ниже.
    expect(routed.recordingUrl).toBeNull();
    expect(routed.hasRecording).toBe(true);
    // Текст — ленивым запросом, и он открыт ответственному агенту по тому же правилу.
    const text = await request(app)
      .get(`/api/v1/interactions/${routedInteractionId}/transcript`)
      .set("Authorization", `Bearer ${agentToken}`);
    expect(text.status).toBe(200);
    expect(text.body.transcript).toBe(ROUTED_TRANSCRIPT);
  });

  it("ленивый текст: чужой разговор отвечает 403, а не пустотой", async () => {
    const res = await request(app)
      .get(`/api/v1/interactions/${otherInteractionId}/transcript`)
      .set("Authorization", `Bearer ${agentToken}`);
    expect(res.status).toBe(403);
  });

  it("перевод: готовый перевод чужого разговора не отдаётся в обход прав (23.09.2026)", async () => {
    // Кэшированный transcriptRu возвращался ДО проверки прав: кто угодно с
    // входом получал текст чужого разговора одним POST.
    const res = await request(app)
      .post(`/api/v1/interactions/${otherInteractionId}/translate`)
      .set("Authorization", `Bearer ${agentToken}`);
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).not.toContain(OTHER_TRANSCRIPT);
  });

  it("прослушивание записи: входящий, принятый оператором, ЗАКРЫТ агенту (04.09.2026) — читать можно, слушать нет", async () => {
    const res = await request(app)
      .get(`/api/v1/interactions/${routedInteractionId}/recording`)
      .set("Authorization", `Bearer ${agentToken}`);

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/руководство|СБ|маркетинг/i);
  });

  it("карточка клиента: администратору приходит всё, включая чужие разговоры", async () => {
    const res = await request(app)
      .get(`/api/v1/clients/${clientShortId}`)
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    const own = res.body.interactions.find((i: { id: string }) => i.id === interactionId);
    const foreign = res.body.interactions.find((i: { id: string }) => i.id === otherInteractionId);
    // Администратору открыто всё — включая ЧУЖОЙ разговор ленивым запросом.
    // ADMIN не входит в тройку, названную владельцем поимённо (DIRECTOR/SECURITY/
    // MARKETING), но получает calls.hearRecording автоматически — тем же
    // правилом, что и остальные права (пресет ADMIN = все выдаваемые галочки,
    // см. packages/shared/permissions.ts). Звук у него остаётся, как и раньше.
    expect(own.canRead).toBe(true);
    expect(own.canHear).toBe(true);
    expect(foreign.canRead).toBe(true);
    expect(foreign.canHear).toBe(true);
    expect(foreign.hasTranscript).toBe(true);
    expect(foreign.recordingUrl).toBeTruthy();
    const text = await request(app)
      .get(`/api/v1/interactions/${otherInteractionId}/transcript`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(text.status).toBe(200);
    expect(text.body.transcript).toBe(OTHER_TRANSCRIPT);
  });

  it("лента активности: тот же разбор по строкам, а не по всему ответу", async () => {
    const res = await request(app).get("/api/v1/interactions").set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    const own = res.body.items.find((i: { id: string }) => i.id === interactionId);
    const foreign = res.body.items.find((i: { id: string }) => i.id === otherInteractionId);
    if (own) expect(own.transcript).toBe(TRANSCRIPT);
    if (foreign) expect(foreign.transcript).toBe(OTHER_TRANSCRIPT);
  });

  it("прослушивание записи: чужой разговор — отказ с объяснением, а не тишина", async () => {
    const res = await request(app)
      .get(`/api/v1/interactions/${otherInteractionId}/recording`)
      .set("Authorization", `Bearer ${agentToken}`);

    expect(res.status).toBe(403);
    // С 04.09.2026 у обычного агента нет calls.hearRecording вообще, поэтому
    // причина отказа — общая («слушать может только руководство…»), а не
    // «это чужой разговор»: та формулировка теперь для случая, когда право
    // слушать ЕСТЬ, но конкретно этот разговор не свой (спецкейс ручной выдачи
    // прав, не встречается в пресетах по умолчанию — см. calls-hear-scope.test.ts).
    expect(res.body.error).toMatch(/руководство|маркетинг/i);
  });

  it("прослушивание записи: СВОЙ разговор ТЕПЕРЬ ТОЖЕ закрыт (04.09.2026) — сужение решения 15.08.2026", async () => {
    const res = await request(app)
      .get(`/api/v1/interactions/${interactionId}/recording`)
      .set("Authorization", `Bearer ${agentToken}`);

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/руководство|маркетинг/i);
    // Текст того же разговора при этом по-прежнему открыт — проверено выше
    // («карточка клиента: свой разговор открыт»).
  });

  it("право можно снять конкретному человеку — и свой разговор снова закрыт", async () => {
    // Директор снимает галочку «свои звонки» одному сотруднику: уходит из компании,
    // спорная история. Роль при этом не меняется.
    await prisma.agent.update({
      where: { id: agentId },
      data: { permissions: { granted: [], revoked: ["calls.ownTranscripts"] } },
    });
    invalidateAgentAccess(agentId);
    try {
      const res = await request(app)
        .get(`/api/v1/clients/${clientShortId}`)
        .set("Authorization", `Bearer ${agentToken}`);
      const call = res.body.interactions.find((i: { id: string }) => i.id === interactionId);
      expect(call.transcript).toBeNull();
      expect(call.canRead).toBe(false);
      expect(call.canHear).toBe(false);
      // Факт записи остаётся всегда.
      expect(call.hasRecording).toBe(true);

      const recording = await request(app)
        .get(`/api/v1/interactions/${interactionId}/recording`)
        .set("Authorization", `Bearer ${agentToken}`);
      expect(recording.status).toBe(403);
      // Без calls.hearRecording причина отказа общая, независимо от того, снято
      // ли ещё и calls.ownTranscripts (04.09.2026, см. тесты выше).
      expect(recording.body.error).toMatch(/руководство|маркетинг/i);
    } finally {
      await prisma.agent.update({ where: { id: agentId }, data: { permissions: { granted: [], revoked: [] } } });
      invalidateAgentAccess(agentId);
    }
  });
});

describe("Слушать ЛЮБОЙ разговор (04.09.2026): DIRECTOR/ADMIN, SECURITY, MARKETING — да; AGENT/MANAGER — нет", () => {
  it("СБ (роль SECURITY) читает и слушает ЧУЖОЙ разговор целиком", async () => {
    const text = await request(app)
      .get(`/api/v1/interactions/${otherInteractionId}/transcript`)
      .set("Authorization", `Bearer ${securityToken}`);
    expect(text.status).toBe(200);
    expect(text.body.transcript).toBe(OTHER_TRANSCRIPT);

    const recording = await request(app)
      .get(`/api/v1/interactions/${otherInteractionId}/recording`)
      .set("Authorization", `Bearer ${securityToken}`);
    // Станции в тестах нет — важно, что отказа ИМЕННО ПО ПРАВАМ (403) нет.
    expect(recording.status).not.toBe(403);
  });

  it("маркетинг (роль MARKETING) читает и слушает ЧУЖОЙ разговор целиком", async () => {
    const text = await request(app)
      .get(`/api/v1/interactions/${otherInteractionId}/transcript`)
      .set("Authorization", `Bearer ${marketingToken}`);
    expect(text.status).toBe(200);
    expect(text.body.transcript).toBe(OTHER_TRANSCRIPT);

    const recording = await request(app)
      .get(`/api/v1/interactions/${otherInteractionId}/recording`)
      .set("Authorization", `Bearer ${marketingToken}`);
    expect(recording.status).not.toBe(403);
  });

  it("руководитель (роль MANAGER, calls.ownTranscripts БЕЗ calls.hearRecording) — читает свой разговор, слушать не может", async () => {
    // MANAGER не назван владельцем среди трёх ролей с полным доступом — только
    // читает СВОИ разговоры (как AGENT), звук закрыт так же, как у AGENT.
    // Разговор interactionId принадлежит agentId, не managerId — значит для
    // MANAGER это ЧУЖОЙ разговор уже по чтению, что и проверяем.
    const text = await request(app)
      .get(`/api/v1/interactions/${interactionId}/transcript`)
      .set("Authorization", `Bearer ${managerToken}`);
    expect(text.status).toBe(403);

    const recording = await request(app)
      .get(`/api/v1/interactions/${interactionId}/recording`)
      .set("Authorization", `Bearer ${managerToken}`);
    expect(recording.status).toBe(403);
  });
});
