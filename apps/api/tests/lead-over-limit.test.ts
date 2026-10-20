import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";

/**
 * Лимит активных лидов и лиды по СВОИМ объектам (решение владельца 11.08.2026).
 *
 * Правило целиком: лимит ограничивает СМЕШАННЫЙ портфель. Пришёл лид по своему
 * объекту при полном портфеле — агенту предлагается отдать один ОБЫЧНЫЙ лид
 * (кого именно, решает он сам либо CRM случайно — настройка). Обычных не
 * осталось — свои берутся сверх лимита без всяких предложений: дословно
 * «максимум можно много брать лидов, если твои собственные объекты».
 *
 * Лиды по своим объектам не освобождаются НИКОГДА: ради них всё и затевалось.
 */

const runId = Date.now();
const password = "testpass123";

let agentId: string;
let agentToken: string;
let otherAgentId: string;
const clientIds: string[] = [];
let saved: Record<string, unknown> = {};

const TOUCHED = [
  "leadActiveLimit",
  "ownPropertyOverLimitEnabled",
  "ownPropertyReleaseEnabled",
  "ownPropertyReleaseMode",
] as const;

async function setRules(patch: Record<string, unknown>) {
  await prisma.settings.update({ where: { id: "singleton" }, data: patch });
}

async function makeClient(opts: { own: boolean; accepted: boolean; name: string }) {
  const c = await prisma.client.create({
    data: {
      fullName: `${opts.name} ${runId}`,
      phone: `+99287${clientIds.length}${runId}`,
      source: "PHONE_CALL",
      status: "NEW",
      assignedAgentId: agentId,
      acceptedAt: opts.accepted ? new Date() : null,
      ownPropertyLead: opts.own,
    },
  });
  clientIds.push(c.id);
  return c;
}

function accept(clientId: string, body: Record<string, unknown> = {}) {
  return request(app)
    .post(`/api/v1/clients/${clientId}/accept`)
    .set("Authorization", `Bearer ${agentToken}`)
    .send(body);
}

/**
 * Освобождение места после приёма идёт фоном (`void releaseClient(...)` в
 * lib/leadAccept.ts) — путь до записи в базе не короткий: выбор нового агента
 * (pickAgentForLead) сам по себе несколько последовательных запросов
 * (настройки, кандидаты, cooldown, занятость, лимиты, очередь), затем перенос.
 * Фиксированный `setTimeout` угадывает это время — под нагрузкой (несколько
 * тестовых файлов бьют в один контейнер Postgres) угадывает через раз, отсюда
 * и «падает только вместе». Опрашиваем результат вместо угадывания.
 */
async function waitFor<T>(check: () => Promise<T>, isDone: (v: T) => boolean, timeoutMs = 5000): Promise<T> {
  const start = Date.now();
  let last: T;
  do {
    last = await check();
    if (isDone(last)) return last;
    await new Promise((r) => setTimeout(r, 40));
  } while (Date.now() - start < timeoutMs);
  return last;
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  agentId = (
    await prisma.agent.create({
      data: { fullName: "Агент лимита", phone: `+992875${runId}`, role: "AGENT", passwordHash },
    })
  ).id;
  otherAgentId = (
    await prisma.agent.create({
      data: { fullName: "Агент-получатель", phone: `+992874${runId}`, role: "AGENT", passwordHash },
    })
  ).id;
  const login = await request(app).post("/api/v1/auth/login").send({ phone: `+992875${runId}`, password });
  agentToken = login.body.accessToken;

  const current = await prisma.settings.upsert({ where: { id: "singleton" }, update: {}, create: { id: "singleton" } });
  saved = Object.fromEntries(TOUCHED.map((k) => [k, (current as Record<string, unknown>)[k]]));
  // Лимит 2 — тесту хватает двух клиентов, чтобы «заполнить» агента.
  await setRules({
    leadActiveLimit: 2,
    ownPropertyOverLimitEnabled: true,
    ownPropertyReleaseEnabled: true,
    ownPropertyReleaseMode: "agent_choice",
  });
});

beforeEach(async () => {
  // Между тестами портфель агента очищается: каждый набирает свой.
  await prisma.client.updateMany({
    where: { id: { in: clientIds } },
    data: { status: "ARCHIVED", assignedAgentId: null },
  });
});

afterAll(async () => {
  await prisma.settings.update({ where: { id: "singleton" }, data: saved });
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.pendingSummary.deleteMany({ where: { subjectId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: [agentId, otherAgentId] } } });
  await prisma.$disconnect();
});

describe("Портфель полон, есть обычные лиды", () => {
  it("приём лида по своему объекту требует выбрать, кого освободить", async () => {
    await makeClient({ own: false, accepted: true, name: "Обычный 1" });
    await makeClient({ own: false, accepted: true, name: "Обычный 2" });
    const ownLead = await makeClient({ own: true, accepted: false, name: "Свой объект" });

    const res = await accept(ownLead.id);
    expect(res.status).toBe(409);
    expect(res.body.requiresRelease).toBe(true);
    // Предлагаются только ОБЫЧНЫЕ лиды, и сам принимаемый в список не попадает.
    const ids = (res.body.candidates as Array<{ id: string }>).map((c) => c.id);
    expect(ids).toHaveLength(2);
    expect(ids).not.toContain(ownLead.id);

    // Приём не состоялся — карточка по-прежнему ждёт.
    const after = await prisma.client.findUnique({ where: { id: ownLead.id } });
    expect(after?.acceptedAt).toBeNull();
  });

  it("с выбором место освобождается: ровно один обычный лид уходит другому агенту", async () => {
    const regular1 = await makeClient({ own: false, accepted: true, name: "Обычный А" });
    const regular2 = await makeClient({ own: false, accepted: true, name: "Обычный Б" });
    const ownLead = await makeClient({ own: true, accepted: false, name: "Свой объект Б" });

    const res = await accept(ownLead.id, { releaseClientId: regular1.id });
    expect(res.status).toBe(200);

    const accepted = await prisma.client.findUnique({ where: { id: ownLead.id } });
    expect(accepted?.acceptedAt).not.toBeNull();

    // Освобождение идёт фоном уже после приёма — ждём результат, а не гадаем срок.
    const released = await waitFor(
      () => prisma.client.findUnique({ where: { id: regular1.id } }),
      (c) => c?.assignedAgentId !== agentId
    );
    expect(released?.assignedAgentId).not.toBe(agentId);
    // Новому агенту это НЕ принятый лид — он должен принять его сам.
    expect(released?.acceptedAt).toBeNull();

    // Второй обычный остался на месте: освобождается ровно один.
    const untouched = await prisma.client.findUnique({ where: { id: regular2.id } });
    expect(untouched?.assignedAgentId).toBe(agentId);
  });

  it("нельзя освободить чужого или уже свой (1%) лид", async () => {
    await makeClient({ own: false, accepted: true, name: "Обычный В" });
    await makeClient({ own: false, accepted: true, name: "Обычный Г" });
    const otherOwn = await makeClient({ own: true, accepted: true, name: "Свой существующий" });
    const ownLead = await makeClient({ own: true, accepted: false, name: "Свой объект В" });

    const res = await accept(ownLead.id, { releaseClientId: otherOwn.id });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain("освободить нельзя");
  });

  /**
   * П-4/П-6 (17.09.2026, `docs/audit/lead-ownership-17-09.md` §2, §4): режим
   * «CRM выбирает случайно» убран целиком — система жертву больше не выбирает
   * сама. Настройка ownPropertyReleaseMode="random" в БД теперь просто
   * игнорируется — поведение то же, что и «агент выбирает».
   */
  it("настройка random в БД больше ничего не даёт — CRM всё равно просит агента выбрать", async () => {
    await setRules({ ownPropertyReleaseMode: "random" });
    await makeClient({ own: false, accepted: true, name: "Обычный Д" });
    await makeClient({ own: false, accepted: true, name: "Обычный Е" });
    const ownLead = await makeClient({ own: true, accepted: false, name: "Свой объект Г" });

    const res = await accept(ownLead.id);
    expect(res.status).toBe(409);
    expect(res.body.requiresRelease).toBe(true);
    await setRules({ ownPropertyReleaseMode: "agent_choice" });
  });
});

/**
 * П-4/П-6 (17.09.2026): кандидатов на освобождение НЕТ, если с клиентом уже
 * был контакт — система такого клиента не выбирает и агенту не предлагает,
 * его автопередача запрещена законом П-3.
 */
describe("Кандидаты на освобождение — только клиенты без контакта", () => {
  async function makeContactedClient(name: string) {
    const c = await prisma.client.create({
      data: {
        fullName: `${name} ${runId}`,
        phone: `+99288${clientIds.length}${runId}`,
        source: "PHONE_CALL",
        status: "NEW",
        assignedAgentId: agentId,
        acceptedAt: new Date(),
        ownPropertyLead: false,
        firstContactAt: new Date(),
      },
    });
    clientIds.push(c.id);
    return c;
  }

  it("оба клиента портфеля с контактом — приём сверх лимита без вопросов, с пометкой в хронологии", async () => {
    await makeContactedClient("С контактом 1");
    await makeContactedClient("С контактом 2");
    const ownLead = await makeClient({ own: true, accepted: false, name: "Свой при контактном портфеле" });

    const res = await accept(ownLead.id);
    expect(res.status).toBe(200);

    const after = await prisma.client.findUnique({ where: { id: ownLead.id } });
    expect(after?.acceptedAt).not.toBeNull();

    const note = await prisma.interaction.findFirst({
      where: { clientId: ownLead.id, type: "SYSTEM", notes: { contains: "все клиенты портфеля с контактом" } },
    });
    expect(note).not.toBeNull();
  });

  it("один с контактом, один без — список кандидатов не включает контактного", async () => {
    await makeContactedClient("С контактом 3");
    const noContact = await makeClient({ own: false, accepted: true, name: "Без контакта" });
    const ownLead = await makeClient({ own: true, accepted: false, name: "Свой при смешанном портфеле" });

    const res = await accept(ownLead.id);
    expect(res.status).toBe(409);
    expect(res.body.requiresRelease).toBe(true);
    const ids = (res.body.candidates as Array<{ id: string }>).map((c) => c.id);
    expect(ids).toEqual([noContact.id]);
  });
});

describe("Портфель целиком из своих объектов", () => {
  it("новый свой лид берётся сверх лимита без всяких предложений", async () => {
    await makeClient({ own: true, accepted: true, name: "Свой 1" });
    await makeClient({ own: true, accepted: true, name: "Свой 2" });
    const ownLead = await makeClient({ own: true, accepted: false, name: "Свой третий сверх лимита" });

    const res = await accept(ownLead.id);
    expect(res.status).toBe(200);

    const after = await prisma.client.findUnique({ where: { id: ownLead.id } });
    expect(after?.acceptedAt).not.toBeNull();
    // Три активных при лимите два — ровно то, чего хотел владелец.
    const active = await prisma.client.count({
      where: { assignedAgentId: agentId, status: { in: ["NEW", "CONTACTED", "HOT"] }, deletedAt: null },
    });
    expect(active).toBe(3);
  });
});

/**
 * ПОТОЛОК СЧИТАЕТСЯ ПО ВСЕМУ ПОРТФЕЛЮ (исправлено 14.08.2026).
 *
 * Проверка стояла по числу СВОИХ лидов: `own < activeLimit + cap`. В смешанном
 * портфеле это означало, что обычные лиды не считаются вовсе — при лимите 6 и
 * надбавке 1 агент мог держать 6 обычных и ещё до 7 своих, тринадцать активных
 * при потолке «не более 7» (ТЗ п. 5.2). Здесь тот же расклад в миниатюре:
 * лимит 2, надбавка 1, потолок 3.
 */
describe("Смешанный портфель не выходит за потолок", () => {
  it("свой лид добирает портфель до потолка, а не встаёт поверх обычных", async () => {
    await makeClient({ own: false, accepted: true, name: "Смеш обычный 1" });
    await makeClient({ own: false, accepted: true, name: "Смеш обычный 2" });
    await makeClient({ own: true, accepted: true, name: "Смеш свой 1" });
    const extra = await makeClient({ own: true, accepted: false, name: "Смеш свой 2" });

    const res = await accept(extra.id);
    // Молча принять нельзя: потолок уже выбран. CRM либо отказывает, либо просит
    // освободить место — но портфель за три активных не выходит ни при каком исходе.
    expect(res.status).not.toBe(200);

    const active = await prisma.client.count({
      where: { assignedAgentId: agentId, status: { in: ["NEW", "CONTACTED", "HOT"] }, deletedAt: null, acceptedAt: { not: null } },
    });
    expect(active).toBe(3);
  });
});

describe("Регресс-щит", () => {
  it("обычный лид принимается как раньше, без всяких освобождений", async () => {
    await makeClient({ own: false, accepted: true, name: "Обычный Ж" });
    await makeClient({ own: false, accepted: true, name: "Обычный З" });
    const plain = await makeClient({ own: false, accepted: false, name: "Обычный новый" });

    const res = await accept(plain.id);
    expect(res.status).toBe(200);
    const after = await prisma.client.findUnique({ where: { id: plain.id } });
    expect(after?.acceptedAt).not.toBeNull();
  });

  it("рубильник выключен — свой лид ведёт себя как обычный", async () => {
    await setRules({ ownPropertyOverLimitEnabled: false });
    await makeClient({ own: false, accepted: true, name: "Обычный И" });
    await makeClient({ own: false, accepted: true, name: "Обычный К" });
    const ownLead = await makeClient({ own: true, accepted: false, name: "Свой при выключенном" });

    const res = await accept(ownLead.id);
    expect(res.status).toBe(200);
    // Никого не освободили — правило выключено целиком.
    const stillMine = await prisma.client.count({
      where: { assignedAgentId: agentId, ownPropertyLead: false, status: { in: ["NEW", "CONTACTED", "HOT"] } },
    });
    expect(stillMine).toBe(2);
    await setRules({ ownPropertyOverLimitEnabled: true });
  });

  it("повторный приём того же лида ничего не ломает", async () => {
    const plain = await makeClient({ own: false, accepted: false, name: "Двойной клик" });
    expect((await accept(plain.id)).status).toBe(200);
    expect((await accept(plain.id)).status).toBe(200);
  });
});
