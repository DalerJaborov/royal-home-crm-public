import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import bcrypt from "bcrypt";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";

/**
 * ИДЕМПОТЕНТНОСТЬ /website-lead — ЗАМОК СДЕЛАН ПОСТОЯННЫМ (CLAUDE.md, пункт 3
 * разведки 22.09.2026).
 *
 * До правки замок был окном в 30 секунд: ручной повтор админа сайта позже
 * (заметил зависшую форму не сразу) проходил насквозь и заводил в хронологии
 * клиента лишнюю запись «Клиент снова обратился» + лишний push агенту. Тест
 * эмулирует «позже окна» прямой правкой `createdAt` замка — ждать реальные
 * секунды не нужно, а старое поведение воспроизводится детерминированно.
 */

const runId = Date.now();
const API_KEY = `test-lead-lock-${runId}`;

let agentId: string;
const createdClientIds: string[] = [];
let savedWorkHours: { workHoursStart: string; workHoursEnd: string } | null = null;

beforeAll(async () => {
  process.env.WEBSITE_LEAD_API_KEY = API_KEY;
  const settings = await prisma.settings.upsert({ where: { id: "singleton" }, update: {}, create: { id: "singleton" } });
  savedWorkHours = { workHoursStart: settings.workHoursStart, workHoursEnd: settings.workHoursEnd };
  // Круглые сутки — это "00:00"–"24:00", а НЕ "00:00"–"23:59": минута 23:59 у
  // второго остаётся закрытой, и тест падает одну минуту в сутки
  // (isWithinDushanbeWindow → false, заявка уходит в общую очередь без агента).
  // "00:00"–"00:00" тоже нельзя: у isWithinDushanbeWindow пустое окно значит
  // «никогда». Разбор — docs/journal/2026-09-24-krugolosutochnoe-okno-24-00.md.
  await prisma.settings.update({ where: { id: "singleton" }, data: { workHoursStart: "00:00", workHoursEnd: "24:00" } });
  const passwordHash = await bcrypt.hash("testpass123", 10);
  const agent = await prisma.agent.create({
    data: { fullName: "Замок Заявки Агент", phone: `+992885${runId}`, role: "AGENT", passwordHash },
  });
  agentId = agent.id;
});

afterAll(async () => {
  delete process.env.WEBSITE_LEAD_API_KEY;
  if (savedWorkHours) await prisma.settings.update({ where: { id: "singleton" }, data: savedWorkHours }).catch(() => {});
  await prisma.interaction.deleteMany({ where: { clientId: { in: createdClientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: createdClientIds } } });
  await prisma.agent.delete({ where: { id: agentId } }).catch(() => {});
  await prisma.processedMessage.deleteMany({ where: { channel: "WEBSITE_LEAD" } });
});

describe("POST /website-lead — замок держится дольше 30 секунд", () => {
  it("ручной повтор позже старого окна больше не пишет «повторное обращение» второй раз", async () => {
    const phoneTail = String(Math.floor(Math.random() * 1_000_000)).padStart(6, "0");
    const phone = `+992886${phoneTail}`;
    const payload = { fullName: "Позже Окна", phone, comment: "Хочу 3-комн" };

    const first = await request(app).post("/api/v1/webhooks/website-lead").set("X-Api-Key", API_KEY).send(payload);
    expect(first.status).toBe(201);
    createdClientIds.push(first.body.clientId);

    // Состариваем отметку дальше старого 30-секундного окна, но заметно младше
    // STALE_AFTER_MS (10 минут у общего замка) — раньше в этой точке isRepeatDelivery
    // уже считала бы доставку НЕ дублем и обрабатывала бы её заново.
    await prisma.processedMessage.updateMany({
      where: { channel: "WEBSITE_LEAD" },
      data: { createdAt: new Date(Date.now() - 60_000) },
    });

    const second = await request(app).post("/api/v1/webhooks/website-lead").set("X-Api-Key", API_KEY).send(payload);
    expect(second.status).toBe(200);
    expect(second.body.created).toBe(false);
    expect(second.body.clientId).toBe(first.body.clientId);

    const clients = await prisma.client.findMany({ where: { phone } });
    expect(clients.length).toBe(1);

    const repeatNotes = await prisma.interaction.count({
      where: { clientId: clients[0].id, notes: { contains: "Клиент снова обратился" } },
    });
    // Главная проверка: повтор НЕ породил «повторное обращение» — до правки
    // здесь была бы запись и лишний push агенту.
    expect(repeatNotes).toBe(0);
  });

  it("настоящая новая заявка (другой текст) от того же телефона в любой момент проходит как раньше", async () => {
    // Номер должен быть по-настоящему НЕ похож на телефон из соседнего теста —
    // почти совпадающие номера (тот же runId, отличается одна цифра) собьют с
    // толку встроенный поиск похожих карточек клиента (duplicateReview*), а это
    // отдельная эвристика бизнес-логики, не имеющая отношения к дедупу вебхука,
    // который проверяет этот файл.
    const phoneTail = String(Math.floor(Math.random() * 1_000_000)).padStart(6, "0");
    const phone = `+992887${phoneTail}`;
    const first = await request(app)
      .post("/api/v1/webhooks/website-lead")
      .set("X-Api-Key", API_KEY)
      .send({ fullName: "Другая Заявка", phone, comment: "Хочу 2-комн" });
    expect(first.status).toBe(201);
    createdClientIds.push(first.body.clientId);

    await prisma.processedMessage.updateMany({
      where: { channel: "WEBSITE_LEAD" },
      data: { createdAt: new Date(Date.now() - 60_000) },
    });

    // Другой комментарий — другой ключ доставки, не дубль: это законная вторая
    // заявка того же человека, не повтор вебхука.
    const second = await request(app)
      .post("/api/v1/webhooks/website-lead")
      .set("X-Api-Key", API_KEY)
      .send({ fullName: "Другая Заявка", phone, comment: "А теперь хочу 4-комн" });
    expect(second.status).toBe(200);

    const clients = await prisma.client.findMany({ where: { phone } });
    expect(clients.length).toBe(1);
    const repeatNotes = await prisma.interaction.count({
      where: { clientId: clients[0].id, notes: { contains: "Клиент снова обратился" } },
    });
    expect(repeatNotes).toBe(1);
  });
});
