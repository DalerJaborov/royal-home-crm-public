import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";

/** Опечатко-устойчивый fallback на pg_trgm (lib/fuzzySearch.ts, docs/lead-lifecycle-plan.md
 *  п.5): токенный поиск (searchTokens.ts) переживает порядок слов и раскладку, но не
 *  переживает саму опечатку/гласную-вариацию написания — «воданасос»/«ваданасос» это
 *  ровно требование владельца. */

const runId = Date.now();
const password = "testpass123";

let districtId: string;
let agentId: string;
let token: string;
const propertyIds: string[] = [];
const clientIds: string[] = [];

async function searchProperties(q: string) {
  const res = await request(app)
    .get(`/api/v1/properties?q=${encodeURIComponent(q)}`)
    .set("Authorization", `Bearer ${token}`);
  expect(res.status).toBe(200);
  return (res.body.items as Array<{ title: string }>).map((p) => p.title);
}

async function searchClients(q: string) {
  const res = await request(app)
    .get(`/api/v1/clients?q=${encodeURIComponent(q)}`)
    .set("Authorization", `Bearer ${token}`);
  expect(res.status).toBe(200);
  return (res.body.items as Array<{ fullName: string }>).map((c) => c.fullName);
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  const district = await prisma.district.create({ data: { name: `Тест-район-fuzzy-${runId}` } });
  districtId = district.id;

  const agent = await prisma.agent.create({
    data: { fullName: "Тест Фаззи", phone: `+992996${runId}`, role: "ADMIN", passwordHash },
  });
  agentId = agent.id;

  const title = `Воданасос-склад-${runId}`;
  const p = await prisma.property.create({
    data: {
      title,
      type: "COMMERCIAL",
      areaSqm: 200,
      price: 40000,
      currency: "USD",
      districtId,
      address: `Промзона, ${runId}`,
      condition: "GOOD",
      assignedAgentId: agentId,
    },
  });
  propertyIds.push(p.id);

  const fullName = `Воданасоев Далер ${runId}`;
  const c = await prisma.client.create({
    data: { fullName, phone: `+992997${runId}`, kind: "BUYER", assignedAgentId: agentId, source: "PHONE_CALL" },
  });
  clientIds.push(c.id);

  // Карточка ровно под ПОРОГ: word_similarity('шахло', 'Шохло …') ≈ 0.33 — выше
  // нашего 0.3 и ниже умолчания Postgres 0.6. Нужна, чтобы тесты замечали потерю
  // установки порога: без неё оператор `%>` молча становится строже, и такие
  // опечатки перестают находиться (см. fuzzySearch.ts, withThreshold).
  const nearThreshold = await prisma.client.create({
    data: {
      fullName: `Шохло Каримова ${runId}`,
      phone: `+992998${runId}`,
      kind: "BUYER",
      assignedAgentId: agentId,
      source: "PHONE_CALL",
    },
  });
  clientIds.push(nearThreshold.id);

  const res = await request(app).post("/api/v1/auth/login").send({ phone: agent.phone, password });
  expect(res.status).toBe(200);
  token = res.body.accessToken as string;
});

afterAll(async () => {
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.$disconnect();
});

describe("pg_trgm fallback — объекты", () => {
  it("точное совпадение находится обычным токенным поиском (fallback не нужен)", async () => {
    expect(await searchProperties(`Воданасос-склад-${runId}`)).toContain(`Воданасос-склад-${runId}`);
  });

  it("опечатка в гласной («ваданасос» вместо «воданасос») находится через pg_trgm", async () => {
    const found = await searchProperties(`Ваданасос-склад-${runId}`);
    expect(found).toContain(`Воданасос-склад-${runId}`);
  });
});

describe("pg_trgm fallback — клиенты", () => {
  it("опечатка в фамилии находится через pg_trgm", async () => {
    const found = await searchClients(`Ваданасоев ${runId}`);
    expect(found).toContain(`Воданасоев Далер ${runId}`);
  });

  /**
   * Порог у оператора `%>` берётся из настройки сессии, а не из выражения, и если
   * её забыть, Postgres молча применит своё умолчание 0.6 — вдвое строже нашего 0.3.
   * Эта пара («шахло» → «Шохло», сходство ≈ 0.33) лежит ровно между: при верном
   * пороге находится, при умолчании — нет. Гласная-вариация написания имени и есть
   * тот случай, ради которого порог занижали.
   */
  it("гласная-вариация у самого порога («Шахло» → «Шохло») всё ещё находится", async () => {
    const found = await searchClients(`Шахло ${runId}`);
    expect(found).toContain(`Шохло Каримова ${runId}`);
  });

  it("непохожее имя не подхватывает чужую карточку по совпадению цифр", async () => {
    // Общий суффикс-runId есть у всех карточек теста — проверяем, что triграммное
    // сходство одних лишь цифр не перетягивает fallback: непохожее по буквам имя
    // не должно найти «Воданасоев».
    const found = await searchClients(`Каримзода Шахло ${runId}`);
    expect(found).not.toContain(`Воданасоев Далер ${runId}`);
  });
});
