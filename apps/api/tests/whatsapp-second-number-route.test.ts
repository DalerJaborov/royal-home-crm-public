import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";

/**
 * Подключение ВТОРОГО номера WhatsApp (12.11.2026, дочерняя компания «Арван»).
 *
 * Сервер давно умел несколько номеров (таблица MessengerAccount, externalId =
 * phone_number_id), но маршрут принимал номер на веру: вписанный из панели Meta
 * идентификатор мог быть телефоном или кабинетом, а маркер — мёртвым, и ответы тогда
 * молча шли в никуда. Теперь маркер и номер сверяются у Meta, а маркер, уже занятый
 * основным номером или другим аккаунтом, не принимается: отправка выбирает аккаунт по
 * маркеру (customerMetaTransport.resolveLegacyMetaSendTransport), и совпадение ломает
 * отправку у ОБОИХ номеров.
 */
const meta = vi.hoisted(() => ({
  identity: vi.fn(),
}));
vi.mock("../src/messengers/meta.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/messengers/meta.js")>()),
  whatsappNumberIdentity: meta.identity,
}));

const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");
const { encryptSecret, decryptSecretSafe } = await import("../src/crypto.js");
const { grantElevation } = await import("../src/lib/stepUp.js");
const { resetAccountsCache } = await import("../src/messengers/accounts.js");

const run = randomUUID().replaceAll("-", "").slice(0, 10);
const password = "testpass123";
const MAIN_ID = `7700${Date.now()}`.slice(0, 16);
const SECOND_ID = `7701${Date.now()}`.slice(0, 16);
const THIRD_ID = `7702${Date.now()}`.slice(0, 16);
const MAIN_TOKEN = `EAA-main-${run}`;
const SECOND_TOKEN = `EAA-second-${run}`;
let adminId = "";
let adminToken = "";
const createdIds: string[] = [];
let original: { metaWaPhoneId: string | null; metaWaToken: string | null } = { metaWaPhoneId: null, metaWaToken: null };

const post = (body: Record<string, unknown>) =>
  request(app).post("/api/v1/settings/messenger-accounts").set("Authorization", `Bearer ${adminToken}`).send(body);

beforeAll(async () => {
  const admin = await prisma.agent.create({
    data: {
      fullName: `Админ второго номера ${run}`,
      phone: `+992965${String(Date.now()).slice(-7)}`,
      role: "ADMIN",
      passwordHash: await bcrypt.hash(password, 10),
    },
  });
  adminId = admin.id;
  adminToken = (await request(app).post("/api/v1/auth/login").send({ phone: admin.phone, password })).body.accessToken;
  grantElevation(adminId);
  const s = await prisma.settings.findUniqueOrThrow({
    where: { id: "singleton" },
    select: { metaWaPhoneId: true, metaWaToken: true },
  });
  original = s;
  // Основной номер — в Настройках, как у боевой установки.
  await prisma.settings.update({
    where: { id: "singleton" },
    data: { metaWaPhoneId: MAIN_ID, metaWaToken: encryptSecret(MAIN_TOKEN) },
  });
  resetAccountsCache();
});

beforeEach(() => {
  meta.identity.mockReset();
  meta.identity.mockResolvedValue({ ok: true, id: SECOND_ID, displayPhoneNumber: "+992 90 000 00 00", verifiedName: "Арван" });
});

afterAll(async () => {
  await prisma.messengerAccount.deleteMany({ where: { id: { in: createdIds } } });
  await prisma.settings.update({ where: { id: "singleton" }, data: original });
  await prisma.agent.deleteMany({ where: { id: adminId } });
  resetAccountsCache();
});

describe("подключение номера WhatsApp", () => {
  it("маркер и номер сверяются у Meta, аккаунт сохраняется с именем компании и не становится «основным»", async () => {
    const res = await post({
      channel: "WHATSAPP",
      title: `Арван WhatsApp ${run}`,
      externalId: SECOND_ID,
      token: SECOND_TOKEN,
      brandName: "Арван",
      isDefault: false,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    createdIds.push(res.body.id);
    // Именно этим маркером и именно по этому идентификатору — иначе проверка ни о чём.
    expect(meta.identity).toHaveBeenCalledWith(SECOND_TOKEN, SECOND_ID);
    const saved = await prisma.messengerAccount.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(saved.channel).toBe("WHATSAPP");
    expect(saved.externalId).toBe(SECOND_ID);
    expect(saved.brandName).toBe("Арван");
    expect(saved.isDefault).toBe(false);
    expect(saved.token).not.toContain(SECOND_TOKEN); // в базе маркер зашифрован
    expect(decryptSecretSafe(saved.token)).toBe(SECOND_TOKEN);
  });

  it("мёртвый маркер: 400 «Маркер не принят», аккаунт не создаётся", async () => {
    meta.identity.mockResolvedValue({ ok: false, kind: "token", error: "Error validating access token: Session has expired" });
    const res = await post({ channel: "WHATSAPP", title: `Мёртвый ${run}`, externalId: THIRD_ID, token: `EAA-dead-${run}` });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/^Маркер не принят/);
    expect(await prisma.messengerAccount.count({ where: { externalId: THIRD_ID } })).toBe(0);
  });

  it("номера нет или маркеру не выдан доступ к нему: 400 «Номер не найден»", async () => {
    meta.identity.mockResolvedValue({ ok: false, kind: "number", error: "Unsupported get request. Object does not exist" });
    const res = await post({ channel: "WHATSAPP", title: `Нет номера ${run}`, externalId: THIRD_ID, token: `EAA-other-${run}` });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Номер не найден/);
    expect(await prisma.messengerAccount.count({ where: { externalId: THIRD_ID } })).toBe(0);
  });

  it("сбой связи с Meta не выдаётся за ошибку маркера", async () => {
    meta.identity.mockResolvedValue({ ok: false, kind: "network", error: "Meta ответила 503" });
    const res = await post({ channel: "WHATSAPP", title: `Сеть ${run}`, externalId: THIRD_ID, token: `EAA-net-${run}` });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Не удалось проверить номер у Meta/);
    expect(res.body.error).not.toMatch(/Маркер не принят/);
  });

  it("маркер, равный маркеру основного номера, не принимается — и Meta даже не спрашиваем", async () => {
    const res = await post({ channel: "WHATSAPP", title: `Тот же маркер ${run}`, externalId: THIRD_ID, token: MAIN_TOKEN });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/основного номера/);
    expect(res.body.error).toMatch(/новый маркер/);
    expect(meta.identity).not.toHaveBeenCalled();
    expect(await prisma.messengerAccount.count({ where: { externalId: THIRD_ID } })).toBe(0);
  });

  it("маркер, равный маркеру другого подключённого номера, не принимается", async () => {
    // К этому тесту «Арван» уже подключён первым тестом файла.
    const res = await post({ channel: "WHATSAPP", title: `Копия маркера ${run}`, externalId: THIRD_ID, token: SECOND_TOKEN });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Арван WhatsApp/);
    expect(await prisma.messengerAccount.count({ where: { externalId: THIRD_ID } })).toBe(0);
  });

  it("основной номер из Настроек второй раз не подключается", async () => {
    const res = await post({ channel: "WHATSAPP", title: `Дубль основного ${run}`, externalId: MAIN_ID, token: `EAA-dup-${run}` });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/уже подключён как основной/);
  });

  it("идентификатор из букв или телефон с плюсом отвергается до запроса к Meta", async () => {
    for (const bad of ["+992900000000", "abc12345", "123"]) {
      const res = await post({ channel: "WHATSAPP", title: `Плохой ${run}`, externalId: bad, token: `EAA-bad-${run}` });
      expect(res.status, bad).toBe(400);
      expect(res.body.error).toMatch(/Phone number ID/);
    }
    expect(meta.identity).not.toHaveBeenCalled();
  });

  it("без идентификатора номера — понятная подсказка про Phone number ID", async () => {
    const res = await post({ channel: "WHATSAPP", title: `Без номера ${run}`, token: `EAA-no-id-${run}` });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Phone number ID/);
  });

  it("без названия по-прежнему нельзя", async () => {
    const res = await post({ channel: "WHATSAPP", title: "  ", externalId: THIRD_ID, token: `EAA-x-${run}` });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/название/i);
  });

  it("замена маркера у существующего номера: идентификатор берётся из записи и сверяется у Meta", async () => {
    const id = createdIds[0];
    const fresh = `EAA-fresh-${run}`;
    const res = await post({ id, channel: "WHATSAPP", title: `Арван WhatsApp ${run}`, token: fresh });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(meta.identity).toHaveBeenCalledWith(fresh, SECOND_ID);
    expect(decryptSecretSafe((await prisma.messengerAccount.findUniqueOrThrow({ where: { id } })).token)).toBe(fresh);
  });

  it("правка без маркера (название, тумблер) Meta не трогает", async () => {
    const id = createdIds[0];
    const res = await post({ id, channel: "WHATSAPP", title: `Арван WhatsApp ${run}`, enabled: true });
    expect(res.status).toBe(200);
    expect(meta.identity).not.toHaveBeenCalled();
  });
});

describe("зеркало: маркер основного номера в Настройках", () => {
  const patch = (body: Record<string, unknown>) =>
    request(app).patch("/api/v1/settings").set("Authorization", `Bearer ${adminToken}`).send(body);

  it("нельзя вписать в Настройки маркер, уже стоящий у второго номера", async () => {
    const res = await patch({ metaWaToken: `EAA-fresh-${run}` });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Арван WhatsApp/);
    // Основной маркер остался прежним.
    const s = await prisma.settings.findUniqueOrThrow({ where: { id: "singleton" }, select: { metaWaToken: true } });
    expect(decryptSecretSafe(s.metaWaToken)).toBe(MAIN_TOKEN);
  });
});
