import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";

/**
 * Смена монтажёра в Настройках при объекте на руках (B4, 23.09.2026 — находка
 * разведки «звонок → лид → агент»; переписано 25.09.2026, А1). До 23.09
 * Settings.videoMontajerAgentId был обычным полем: смена монтажёра, пока объект
 * уже отправлен старому (EDITOR_HOLDER_WHERE, lib/videoHandoff.ts), никому
 * ничего не доставляла — новый монтажёр молчал, очередь стояла до суточного
 * сторожа (24 ч). 23.09 это починили, но передача шла прямо внутри PATCH
 * (`await dispatchToEditor`) — запрос висел минуты на тяжёлых исходниках.
 *
 * 25.09.2026: PATCH запускает передачу держателя новому монтажёру через
 * `dispatchInBackground` (fire-and-forget, как и у releaseQueueIfClear) — не
 * `dispatchToEditor` напрямую. Мокаем именно `dispatchInBackground`: мокать
 * `dispatchToEditor` здесь бессмысленно — `dispatchInBackground` вызывает его
 * как локальную функцию ТОГО ЖЕ модуля, мимо экспортной подмены (классическая
 * ловушка `vi.mock` с self-import). Сама доставка ролика (файлы, публикация)
 * покрыта video-handoff.test.ts и video-handoff-queue-order.test.ts, здесь
 * важно только то, что маршрут PATCH /settings зовёт dispatchInBackground с
 * правильными параметрами ровно при смене монтажёра, не ждёт её и не зовёт,
 * если поле не менялось.
 */

const { dispatchInBackground, sendMessage } = vi.hoisted(() => ({
  dispatchInBackground: vi.fn((_propertyId: string, _montajerAgentId: string) => {
    // Симулируем медленную фоновую отправку — реальная функция тоже её не
    // ждёт (25.09.2026, тест «PATCH отвечает быстро» ниже).
    void new Promise((resolve) => setTimeout(resolve, 3000));
  }),
  sendMessage: vi.fn(async (_chatId: string, _text: string) => {}),
}));

vi.mock("../src/lib/videoHandoff.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/videoHandoff.js")>()),
  dispatchInBackground,
}));
vi.mock("../src/telegram/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/telegram/api.js")>()),
  sendMessage,
}));

const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");
const { grantElevation } = await import("../src/lib/stepUp.js");

const runId = Date.now();
const password = "testpass123";

let adminId: string;
let adminToken: string;
let oldMontajerId: string;
let newMontajerId: string;
let districtId: string;
const propertyIds: string[] = [];
let savedSettings: { videoMontajerAgentId: string | null } | null = null;
const OLD_MONTAJER_CHAT_ID = `old-montajer-${runId}`;

function patch(body: Record<string, unknown>) {
  return request(app).patch("/api/v1/settings").set("Authorization", `Bearer ${adminToken}`).send(body);
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  const admin = await prisma.agent.create({
    data: { fullName: "Админ смены монтажёра", phone: `+992936${runId}`, role: "ADMIN", passwordHash },
  });
  adminId = admin.id;
  const res = await request(app).post("/api/v1/auth/login").send({ phone: admin.phone, password });
  adminToken = res.body.accessToken;
  grantElevation(adminId);

  const oldMontajer = await prisma.agent.create({
    data: {
      fullName: "Старый монтажёр",
      phone: `+992937${runId}`,
      role: "AGENT",
      passwordHash: "x",
      telegramChatId: OLD_MONTAJER_CHAT_ID,
    },
  });
  oldMontajerId = oldMontajer.id;
  const newMontajer = await prisma.agent.create({
    // telegramChatId обязателен (25.09.2026, А5) — PATCH /settings теперь
    // отказывает 400 назначению монтажёра без привязанного Telegram.
    data: {
      fullName: "Новый монтажёр",
      phone: `+992938${runId}`,
      role: "AGENT",
      passwordHash: "x",
      telegramChatId: `new-montajer-${runId}`,
    },
  });
  newMontajerId = newMontajer.id;

  const district = await prisma.district.create({ data: { name: `Смена монтажёра-${runId}` } });
  districtId = district.id;

  savedSettings = await prisma.settings.upsert({
    where: { id: "singleton" },
    update: {},
    create: { id: "singleton" },
    select: { videoMontajerAgentId: true },
  });
});

beforeEach(async () => {
  dispatchInBackground.mockClear();
  sendMessage.mockClear();
  // Место монтажёра общее на всю таблицу Property (EDITOR_HOLDER_WHERE) —
  // объект, оставшийся SENT_TO_EDITOR от предыдущего теста (dispatchInBackground
  // подменена и реальный статус не меняет), иначе ложно считался бы держателем
  // места в следующем тесте.
  if (propertyIds.length) {
    await prisma.property.updateMany({ where: { id: { in: propertyIds } }, data: { videoHandoffStatus: "NONE" } });
  }
});

afterAll(async () => {
  if (savedSettings) await prisma.settings.update({ where: { id: "singleton" }, data: savedSettings });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.agent.deleteMany({ where: { id: { in: [adminId, oldMontajerId, newMontajerId] } } });
  await prisma.$disconnect();
});

async function createHolderProperty(address: string) {
  const property = await prisma.property.create({
    data: {
      title: `Держит место монтажёра-${runId}`,
      type: "APARTMENT",
      areaSqm: 40,
      price: 200000,
      currency: "TJS",
      districtId,
      address,
      condition: "GOOD",
      videoHandoffStatus: "SENT_TO_EDITOR",
    },
  });
  propertyIds.push(property.id);
  return property;
}

describe("Смена монтажёра при объекте на руках", () => {
  it("объект держит место — dispatchInBackground вызывается с новым id, старому уходит сообщение, PATCH отвечает быстро", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { videoMontajerAgentId: oldMontajerId } });
    const property = await createHolderProperty("Тестовая, 30");

    const start = Date.now();
    const res = await patch({ videoMontajerAgentId: newMontajerId });
    const elapsedMs = Date.now() - start;

    expect(res.status).toBe(200);
    // 25.09.2026, А1: отправка держателя новому монтажёру идёт в фоне — PATCH
    // не ждёт её, даже когда сама отправка медленная (мок выше — 3 секунды).
    expect(elapsedMs).toBeLessThan(2000);
    expect(dispatchInBackground).toHaveBeenCalledWith(property.id, newMontajerId);
    expect(sendMessage).toHaveBeenCalledWith(OLD_MONTAJER_CHAT_ID, expect.stringContaining("передан другому монтажёру"));
  });

  it("монтажёр не менялся — dispatchInBackground не вызывается", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { videoMontajerAgentId: oldMontajerId } });
    await createHolderProperty("Тестовая, 31");

    const res = await patch({ videoMontajerAgentId: oldMontajerId });

    expect(res.status).toBe(200);
    expect(dispatchInBackground).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("монтажёра сняли (null) — dispatchInBackground не вызывается, ролик остаётся ждать назначения", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { videoMontajerAgentId: oldMontajerId } });
    await createHolderProperty("Тестовая, 32");

    const res = await patch({ videoMontajerAgentId: null });

    expect(res.status).toBe(200);
    expect(dispatchInBackground).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("никто место не держит — смена монтажёра проходит без обращения к dispatchInBackground", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { videoMontajerAgentId: oldMontajerId } });

    const res = await patch({ videoMontajerAgentId: newMontajerId });

    expect(res.status).toBe(200);
    expect(dispatchInBackground).not.toHaveBeenCalled();
  });
});
