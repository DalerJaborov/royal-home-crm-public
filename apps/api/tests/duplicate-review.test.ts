import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";

/**
 * РАЗДЕЛ L, ГЛАВНОЕ ПРАВИЛО (03.09.2026, план вечерней сессии §L) — похожая новая
 * заявка (похожее имя + похожий, но не идентичный, номер) не раздаётся другому
 * агенту, пока агент, ведущий похожую существующую карточку, не подтвердит, что
 * это разные люди. Проверяется весь цикл: intake.ts (придержка) → confirm (слияние)
 * / deny (в очередь) → sweepExpiredDuplicateReviews (таймаут) → аномалия «частые
 * подтверждения» → assignPendingLeads пропускает придержанное.
 *
 * Числа номеров подобраны намеренно: последние 9 цифр РАЗНЫЕ (не ловится уровнем 1
 * intake.ts / findClientByPhoneDigits), последние 7 — ОДИНАКОВЫЕ (ловится новым,
 * более мягким сигналом lib/duplicateReview.ts).
 */

const sendPushToAgent = vi.fn(async () => 1);
const sendPushToAgents = vi.fn(async () => 1);
vi.mock("../src/push.js", async (importOriginal) => ({
  // Подмена ДОПОЛНЯЕТ модуль, а не заменяет его целиком (19.09.2026):
  // фабрика без importOriginal убирает остальные экспорты у всего
  // процесса, и СОСЕДНИЙ тест падает на «No "…" export is defined».
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent, sendPushToAgents,
}));

const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");
const { createLeadFromChannel, assignPendingLeads } = await import("../src/leads.js");
const { sweepExpiredDuplicateReviews, checkDuplicateClaimAnomaly, runDuplicateFuzzyScanTick, DUPLICATE_REVIEW_CONFIRM_NOTE_PREFIX } =
  await import("../src/lib/duplicateReview.js");

const runId = Date.now();
const password = "testpass123";
/** Общий узнаваемый токен имени — гарантирует совпадение имени между записями
 *  этого файла, не полагаясь на распространённые таджикские имена (см. предупреждение
 *  в routes/clients/duplicates.ts про «Далер»/«Умед»). */
const sharedNameToken = `Тестдубль${runId}`;
const tail7Base = String(runId % 1000000).padStart(6, "0");
/** Хвост из 7 цифр, УНИКАЛЬНЫЙ на каждую пару кандидат/новая заявка (последний
 *  символ = suffix) — без этого все "кандидаты" файла делили бы один и тот же
 *  хвост номера и findFuzzyDuplicateCandidate находил бы СТАРЕЙШЕГО из них
 *  (ORDER BY createdAt ASC), а не именно того, что завела текущая проверка. */
function tailFor(suffix: string): string {
  return `${tail7Base}${suffix}`;
}
/** Номер карточки-кандидата для данного suffix. */
function candidatePhone(suffix: string): string {
  return `+99291${tailFor(suffix)}`;
}
/** Номер «похожей новой заявки» — те же последние 7 цифр, что у кандидата
 *  (см. tailFor), но другие первые 2 цифры местного номера — поэтому последние
 *  9 цифр РАЗНЫЕ (не ловится уровнем 1 intake.ts) при похожих последних 7. */
function similarNewPhone(suffix: string): string {
  return `+99292${tailFor(suffix)}`;
}

let existingAgentId: string;
let existingAgentToken: string;
let directorId: string;
const clientIds: string[] = [];
const agentIds: string[] = [];

async function login(phone: string) {
  const res = await request(app).post("/api/v1/auth/login").send({ phone, password });
  expect(res.status).toBe(200);
  return res.body.accessToken as string;
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  existingAgentId = (
    await prisma.agent.create({
      data: { fullName: "Агент с существующей карточкой", phone: `+992${runId}70`, role: "AGENT", passwordHash },
    })
  ).id;
  directorId = (
    await prisma.agent.create({
      data: { fullName: "Директор проверки дублей", phone: `+992${runId}71`, role: "DIRECTOR", passwordHash },
    })
  ).id;
  agentIds.push(existingAgentId, directorId);
  existingAgentToken = await login(`+992${runId}70`);
});

afterAll(async () => {
  // Широкий сброс по имени, а не только по clientIds: createLeadFromChannel создаёт
  // Client ДО того, как может выбросить (findFuzzyDuplicateCandidate после create) —
  // при упавшем тесте id в clientIds не попадал, карточка оставалась сиротой и на
  // следующем прогоне подбиралась глобальным assignPendingLeads() как чья-то чужая
  // непринятая заявка (живой случай, поймано при отладке этого же файла).
  const orphaned = await prisma.client.findMany({
    where: { OR: [{ id: { in: clientIds } }, { fullName: { contains: sharedNameToken } }] },
    select: { id: true },
  });
  const allClientIds = orphaned.map((c) => c.id);
  await prisma.interaction.deleteMany({ where: { OR: [{ clientId: { in: allClientIds } }, { agentId: { in: agentIds } }] } });
  await prisma.notification.deleteMany({ where: { agentId: { in: agentIds } } });
  await prisma.client.deleteMany({ where: { id: { in: allClientIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: agentIds } } });
  await prisma.$disconnect();
});

/** Существующая карточка, закреплённая за existingAgentId — «кандидат», по номеру
 *  которого будут приходить похожие новые заявки в тестах ниже. */
async function makeExistingCandidate(suffix: string) {
  const c = await prisma.client.create({
    data: {
      fullName: `${sharedNameToken} Каримов`,
      phone: candidatePhone(suffix),
      source: "PHONE_CALL",
      kind: "BUYER",
      assignedAgentId: existingAgentId,
    },
  });
  clientIds.push(c.id);
  return c;
}

describe("intake.ts — придержка похожей новой заявки (главное правило)", () => {
  it("похожее имя + похожий номер, другой агент — раздача придержана, не назначена", async () => {
    const candidate = await makeExistingCandidate("1");
    const result = await createLeadFromChannel({
      fullName: `${sharedNameToken} Каримов`,
      phone: similarNewPhone("1"),
      source: "INSTAGRAM",
      kind: "BUYER",
    });
    clientIds.push(result.clientId);

    const pending = await prisma.client.findUnique({ where: { id: result.clientId } });
    expect(pending?.assignedAgentId).toBeNull();
    expect(pending?.duplicateReviewOfClientId).toBe(candidate.id);
    expect(pending?.duplicateReviewAskedAgentId).toBe(existingAgentId);
    expect(pending?.duplicateReviewAskedAt).not.toBeNull();
    expect(pending?.duplicateReviewDueAt).not.toBeNull();

    // Существующая карточка получает системную запись-вопрос.
    const ask = await prisma.interaction.findFirst({
      where: { clientId: candidate.id, type: "SYSTEM", notes: { contains: "Раздача придержана" } },
    });
    expect(ask).not.toBeNull();
  });

  it("не похожий номер (последние 7 цифр разные) — обычная раздача, без придержки", async () => {
    await makeExistingCandidate("2");
    const result = await createLeadFromChannel({
      fullName: `${sharedNameToken} Каримов`,
      phone: `+992900${String(Date.now()).slice(-6)}`, // заведомо другой хвост
      source: "INSTAGRAM",
      kind: "BUYER",
    });
    clientIds.push(result.clientId);
    const after = await prisma.client.findUnique({ where: { id: result.clientId } });
    expect(after?.duplicateReviewOfClientId).toBeNull();
    expect(after?.assignedAgentId).not.toBeNull();
  });

  it("похожий номер, но разные имена — обычная раздача, ложных срабатываний на тёзках нет", async () => {
    await makeExistingCandidate("3");
    const result = await createLeadFromChannel({
      fullName: `Совсем Другое${runId} Имя`,
      phone: similarNewPhone("3"),
      source: "INSTAGRAM",
      kind: "BUYER",
    });
    clientIds.push(result.clientId);
    const after = await prisma.client.findUnique({ where: { id: result.clientId } });
    expect(after?.duplicateReviewOfClientId).toBeNull();
  });
});

describe("assignPendingLeads — придержанное не раздаётся утренней волной", () => {
  it("клиент с открытой проверкой на дубль пропущен волной", async () => {
    const candidate = await makeExistingCandidate("4");
    const result = await createLeadFromChannel({
      fullName: `${sharedNameToken} Каримов`,
      phone: similarNewPhone("4"),
      source: "INSTAGRAM",
      kind: "BUYER",
      deferAssignment: true,
    });
    clientIds.push(result.clientId);
    expect((await prisma.client.findUnique({ where: { id: result.clientId } }))?.duplicateReviewOfClientId).toBe(
      candidate.id
    );

    await assignPendingLeads();
    const stillPending = await prisma.client.findUnique({ where: { id: result.clientId } });
    expect(stillPending?.assignedAgentId).toBeNull();
    expect(stillPending?.duplicateReviewOfClientId).toBe(candidate.id);
  });
});

describe("POST /clients/:id/duplicate-review/confirm — «да, мой клиент»", () => {
  it("сливает карточки, придержанная карточка уходит в Корзину", async () => {
    const candidate = await makeExistingCandidate("5");
    const result = await createLeadFromChannel({
      fullName: `${sharedNameToken} Каримов`,
      phone: similarNewPhone("5"),
      source: "INSTAGRAM",
      kind: "BUYER",
    });
    clientIds.push(result.clientId);

    const res = await request(app)
      .post(`/api/v1/clients/${result.clientId}/duplicate-review/confirm`)
      .set("Authorization", `Bearer ${existingAgentToken}`)
      .send({});
    expect(res.status).toBe(200);

    const merged = await prisma.client.findUnique({ where: { id: candidate.id } });
    expect(merged).not.toBeNull(); // основная карточка жива

    const pending = await prisma.client.findUnique({ where: { id: result.clientId } });
    expect(pending?.deletedAt).not.toBeNull(); // придержанная ушла в Корзину как дубликат

    const confirmNote = await prisma.interaction.findFirst({
      where: { clientId: candidate.id, type: "SYSTEM", notes: { startsWith: DUPLICATE_REVIEW_CONFIRM_NOTE_PREFIX } },
    });
    expect(confirmNote).not.toBeNull();
  });

  it("чужой агент без права clients.merge — 403", async () => {
    const candidate = await makeExistingCandidate("6");
    const result = await createLeadFromChannel({
      fullName: `${sharedNameToken} Каримов`,
      phone: similarNewPhone("6"),
      source: "INSTAGRAM",
      kind: "BUYER",
    });
    clientIds.push(result.clientId);

    const passwordHash = await bcrypt.hash(password, 10);
    const strangerId = (
      await prisma.agent.create({ data: { fullName: "Посторонний агент", phone: `+992${runId}72`, role: "AGENT", passwordHash } })
    ).id;
    agentIds.push(strangerId);
    const strangerToken = await login(`+992${runId}72`);

    const res = await request(app)
      .post(`/api/v1/clients/${result.clientId}/duplicate-review/confirm`)
      .set("Authorization", `Bearer ${strangerToken}`)
      .send({});
    expect(res.status).toBe(403);
    void candidate;
  });
});

describe("POST /clients/:id/duplicate-review/deny — «нет, разные люди»", () => {
  it("снимает придержку, лид уходит в обычную раздачу", async () => {
    await makeExistingCandidate("7");
    const result = await createLeadFromChannel({
      fullName: `${sharedNameToken} Каримов`,
      phone: similarNewPhone("7"),
      source: "INSTAGRAM",
      kind: "BUYER",
    });
    clientIds.push(result.clientId);

    const res = await request(app)
      .post(`/api/v1/clients/${result.clientId}/duplicate-review/deny`)
      .set("Authorization", `Bearer ${existingAgentToken}`)
      .send({});
    expect(res.status).toBe(200);

    const after = await prisma.client.findUnique({ where: { id: result.clientId } });
    expect(after?.duplicateReviewOfClientId).toBeNull();
    expect(after?.assignedAgentId).not.toBeNull(); // назначен по очереди (единственный доступный — existingAgentId)
  });
});

describe("sweepExpiredDuplicateReviews — не ответили вовремя", () => {
  it("просроченная проверка снимается, лид уходит в очередь", async () => {
    const candidate = await makeExistingCandidate("8");
    const result = await createLeadFromChannel({
      fullName: `${sharedNameToken} Каримов`,
      phone: similarNewPhone("8"),
      source: "INSTAGRAM",
      kind: "BUYER",
    });
    clientIds.push(result.clientId);
    expect((await prisma.client.findUnique({ where: { id: result.clientId } }))?.duplicateReviewOfClientId).toBe(
      candidate.id
    );

    // Таймер уже истёк «вчера».
    await prisma.client.update({
      where: { id: result.clientId },
      data: { duplicateReviewDueAt: new Date(Date.now() - 60 * 60 * 1000) },
    });

    const { assignHeldLead } = await import("../src/leads.js");
    const { expired } = await sweepExpiredDuplicateReviews(new Date(), assignHeldLead);
    expect(expired).toBeGreaterThanOrEqual(1);

    const after = await prisma.client.findUnique({ where: { id: result.clientId } });
    expect(after?.duplicateReviewOfClientId).toBeNull();
    expect(after?.assignedAgentId).not.toBeNull();

    const expiredNote = await prisma.interaction.findFirst({
      where: { clientId: candidate.id, type: "SYSTEM", notes: { contains: "просрочена" } },
    });
    expect(expiredNote).not.toBeNull();
  });
});

describe("checkDuplicateClaimAnomaly — частые «это мой клиент» сигналят директору", () => {
  it("порог превышен — уведомление директору с дедупом по месяцу", async () => {
    const passwordHash = await bcrypt.hash(password, 10);
    const claimer = await prisma.agent.create({
      data: { fullName: "Частый подтверждающий", phone: `+992${runId}73`, role: "AGENT", passwordHash },
    });
    agentIds.push(claimer.id);

    const c = await prisma.client.create({
      data: { fullName: `Аномалия ${runId}`, phone: `+992${runId}74`, source: "PHONE_CALL", kind: "BUYER", assignedAgentId: claimer.id },
    });
    clientIds.push(c.id);

    // Три подтверждения за порог (Settings.duplicateClaimAnomalyThreshold по умолчанию 3).
    for (let i = 0; i < 3; i++) {
      await prisma.interaction.create({
        data: { clientId: c.id, agentId: claimer.id, type: "SYSTEM", notes: `${DUPLICATE_REVIEW_CONFIRM_NOTE_PREFIX} (тест ${i})` },
      });
    }

    // Рабочие часы по Душанбе (вторник, 12:00) — тест от времени суток на машине
    // CI зависеть не должен (04.09.2026, working-hours гейт добавлен в аларм).
    await checkDuplicateClaimAnomaly(claimer.id, new Date("2026-09-01T07:00:00Z"));

    const alarm = await prisma.notification.findFirst({
      where: { agentId: directorId, tag: { contains: `alarm-duplicate-claim-${claimer.id}` } },
    });
    expect(alarm).not.toBeNull();
    expect(alarm?.body).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/); // когда — видно без перехода по ссылке
  });

  it("вне рабочих часов молчит (директора не будим ночью)", async () => {
    const passwordHash = await bcrypt.hash(password, 10);
    const claimer = await prisma.agent.create({
      data: { fullName: "Ночной подтверждающий", phone: `+992${runId}75`, role: "AGENT", passwordHash },
    });
    agentIds.push(claimer.id);

    const c = await prisma.client.create({
      data: { fullName: `Аномалия ночь ${runId}`, phone: `+992${runId}76`, source: "PHONE_CALL", kind: "BUYER", assignedAgentId: claimer.id },
    });
    clientIds.push(c.id);

    for (let i = 0; i < 3; i++) {
      await prisma.interaction.create({
        data: { clientId: c.id, agentId: claimer.id, type: "SYSTEM", notes: `${DUPLICATE_REVIEW_CONFIRM_NOTE_PREFIX} (ночь ${i})` },
      });
    }

    // Явно НЕ рабочие часы (01:00 по Душанбе).
    await checkDuplicateClaimAnomaly(claimer.id, new Date("2026-09-01T20:00:00Z"));

    const alarm = await prisma.notification.findFirst({
      where: { agentId: directorId, tag: { contains: `alarm-duplicate-claim-${claimer.id}` } },
    });
    expect(alarm).toBeNull();
  });
});

describe("runDuplicateFuzzyScanTick — крон-скан похожих карточек директору", () => {
  it("похожая пара найдена днём — уведомление директору с датой обнаружения", async () => {
    const suffix = "fz1";
    const a = await makeExistingCandidate(suffix);
    const b = await prisma.client.create({
      data: { fullName: `${sharedNameToken} Рахимов`, phone: similarNewPhone(suffix), source: "PHONE_CALL", kind: "BUYER" },
    });
    clientIds.push(b.id);

    const { found } = await runDuplicateFuzzyScanTick(new Date("2026-09-01T07:00:00Z")); // рабочие часы (12:00 Душанбе)
    expect(found).toBeGreaterThanOrEqual(1);

    const tag = `alarm-duplicate-fuzzy-${[a.id, b.id].sort().join("-")}`;
    const alarm = await prisma.notification.findFirst({ where: { agentId: directorId, tag } });
    expect(alarm).not.toBeNull();
    expect(alarm?.body).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/); // когда — видно без перехода по ссылке
    expect(alarm?.body).toContain(a.fullName);
    expect(alarm?.body).toContain(b.fullName);
  });

  it("вне рабочих часов молчит (директора не будим ночью)", async () => {
    const suffix = "fz2";
    await makeExistingCandidate(suffix);
    const b = await prisma.client.create({
      data: { fullName: `${sharedNameToken} Ниёзов`, phone: similarNewPhone(suffix), source: "PHONE_CALL", kind: "BUYER" },
    });
    clientIds.push(b.id);

    const { found } = await runDuplicateFuzzyScanTick(new Date("2026-09-01T20:00:00Z")); // явно НЕ рабочие часы (01:00 Душанбе)
    expect(found).toBe(0);
  });
});
