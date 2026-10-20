import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";

/**
 * РАЗДЕЛ L, УРОВЕНЬ 3 (03.09.2026, план вечерней сессии §L) — при РУЧНОМ создании
 * карточки (routes/clients/card.ts, POST /) похожая по имени + близкому (не
 * идентичному) номеру карточка предупреждает ДО создания, тем же мягким приёмом
 * (200 + warning, не блок), что уже существовал для точного совпадения хвоста
 * номера (см. client-duplicate-phone-format.test.ts) — просто более слабый сигнал,
 * добавленный НИЖЕ по каскаду проверок, когда точное совпадение не нашлось.
 */

const runId = Date.now();
const password = "testpass123";
const tail7Base = String(runId % 100000).padStart(5, "0");
/** Хвост из 7 цифр, уникальный на каждый тест (двузначный код группы в конце) —
 *  иначе разные `it()` в этом файле делили бы один хвост номера, и проверка
 *  находила бы кандидата из СОСЕДНЕГО теста вместо (или вместе с) ожидаемого. */
function tailFor(group: string): string {
  return `${tail7Base}${group}`;
}

let agentId = "";
let token = "";
const clientIds: string[] = [];

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  const agent = await prisma.agent.create({
    data: { fullName: `Ручной ввод дублей ${runId}`, phone: `+992930${tailFor("00")}`, role: "DIRECTOR", passwordHash },
  });
  agentId = agent.id;
  const login = await request(app).post("/api/v1/auth/login").send({ phone: agent.phone, password });
  expect(login.status).toBe(200);
  token = login.body.accessToken as string;
});

afterAll(async () => {
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.$disconnect();
});

async function createClient(body: Record<string, unknown>) {
  const res = await request(app).post("/api/v1/clients").set("Authorization", `Bearer ${token}`).send(body);
  if (res.body?.id) clientIds.push(res.body.id);
  return res;
}

describe("POST /clients — уровень 3: похожее имя + похожий (не идентичный) номер", () => {
  it("предупреждает мягко (200 + warning), не блокирует создание", async () => {
    const tail = tailFor("01");
    const first = await createClient({
      fullName: `Ручной Дубль ${runId}`,
      phone: `+99291${tail}`,
      source: "PHONE_CALL",
    });
    expect(first.status).toBe(201);

    // Тот же хвост (7 цифр), другие первые 2 цифры местного номера — последние
    // 9 цифр РАЗНЫЕ (точная проверка выше по каскаду это пропустит).
    const second = await createClient({
      fullName: `Ручной Дубль ${runId}`,
      phone: `+99292${tail}`,
      source: "PHONE_CALL",
    });
    expect(second.status).toBe(200);
    expect(second.body.warning, `ответ: ${JSON.stringify(second.body)}`).toBeTruthy();
    expect(second.body.client?.id).toBe(first.body.id);
  });

  it("force=true создаёт карточку несмотря на предупреждение", async () => {
    const tail = tailFor("02");
    const first = await createClient({
      fullName: `Ручной Дубль Форс ${runId}`,
      phone: `+99293${tail}`,
      source: "PHONE_CALL",
    });
    expect(first.status).toBe(201);

    const second = await createClient({
      fullName: `Ручной Дубль Форс ${runId}`,
      phone: `+99294${tail}`,
      source: "PHONE_CALL",
      force: true,
    });
    expect(second.status).toBe(201);
    expect(second.body.id).not.toBe(first.body.id);
  });

  it("похожий номер, но другое имя — не предупреждает (не тёзки)", async () => {
    const tail = tailFor("03");
    await createClient({ fullName: `Ручной Дубль Имя${runId} А`, phone: `+99295${tail}`, source: "PHONE_CALL" });
    const res = await createClient({
      fullName: `Совершенно Другое${runId} Имя`,
      phone: `+99296${tail}`,
      source: "PHONE_CALL",
    });
    expect(res.status).toBe(201);
    expect(res.body.warning).toBeUndefined();
  });
});
