import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";

/**
 * Повторная отправка пачки фотографий не создаёт вторые копии.
 *
 * ЗАЧЕМ. Очередь загрузки на клиенте (web: lib/uploadQueue.ts) повторяет пачку,
 * если не дождалась ответа. Но «не дождалась» и «не сохранилось» — разные вещи:
 * связь рвётся и ПОСЛЕ того, как снимки записаны, но ДО того, как ответ дошёл до
 * телефона. На мобильном интернете это происходит регулярно, и без ключа
 * повторной отправки обещание «ничего не пропадает» превратилось бы в
 * «всё задваивается» — тридцать фотографий вместо пятнадцати.
 *
 * Видео тем же ключом защищено симметрично, но маршрут видео без настроенного
 * R2 отвечает 503 и до этой логики не доходит — проверяется здесь только фото.
 */

const runId = Date.now();
const password = "testpass123";

// Минимальный валидный PNG 1×1 — sharp обрабатывает его без файла-фикстуры.
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);

let districtId: string;
let agentId: string;
let token: string;
const propertyIds: string[] = [];

async function makeProperty() {
  const p = await prisma.property.create({
    data: {
      title: `Объект загрузки ${runId}-${propertyIds.length}`,
      type: "APARTMENT",
      areaSqm: 50,
      price: 40000,
      currency: "TJS",
      districtId,
      address: "Тестовая, 1",
      condition: "GOOD",
      status: "EDITING",
      intakeAgentId: agentId,
      createdById: agentId,
    },
  });
  propertyIds.push(p.id);
  return p;
}

/** Отправка пачки так, как её шлёт очередь: ключи полем формы, по одному на файл. */
function upload(propertyId: string, keys: (string | null)[]) {
  const req = request(app).post(`/api/v1/properties/${propertyId}/photos`).set("Authorization", `Bearer ${token}`);
  for (const key of keys) if (key !== null) req.field("uploadKeys", key);
  keys.forEach((_, i) => req.attach("photos", TINY_PNG, `photo-${i}.png`));
  return req;
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  districtId = (await prisma.district.create({ data: { name: `Тест-район-загрузка-${runId}` } })).id;
  agentId = (
    await prisma.agent.create({
      data: { fullName: "Агент загрузки", phone: `+992952${runId}`, role: "AGENT", passwordHash },
    })
  ).id;
  const res = await request(app).post("/api/v1/auth/login").send({ phone: `+992952${runId}`, password });
  expect(res.status).toBe(200);
  token = res.body.accessToken as string;
});

afterAll(async () => {
  await prisma.propertyPhoto.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.$disconnect();
});

describe("Повтор загрузки фотографий", () => {
  it("та же пачка с теми же ключами не создаёт вторые копии", async () => {
    const p = await makeProperty();
    const keys = [`${runId}-a-1`, `${runId}-a-2`, `${runId}-a-3`];

    const first = await upload(p.id, keys);
    expect(first.status).toBe(201);
    expect(first.body).toHaveLength(3);

    // Ровно то, что делает очередь, не дождавшись ответа на первую попытку.
    const retry = await upload(p.id, keys);
    expect(retry.status).toBe(201);
    expect(retry.body).toHaveLength(3);

    const photos = await prisma.propertyPhoto.findMany({ where: { propertyId: p.id } });
    expect(photos).toHaveLength(3);
    // И те же самые записи, а не новые с теми же ключами.
    expect(new Set(retry.body.map((ph: { id: string }) => ph.id))).toEqual(new Set(photos.map((ph) => ph.id)));
  });

  it("повтор наполовину: досылается только недостающее, порядок идёт без дыр", async () => {
    const p = await makeProperty();
    const firstKeys = [`${runId}-b-1`, `${runId}-b-2`];
    expect((await upload(p.id, firstKeys)).status).toBe(201);

    // Связь оборвалась на середине следующей пачки: два ключа те же, два новых.
    const mixed = [...firstKeys, `${runId}-b-3`, `${runId}-b-4`];
    const second = await upload(p.id, mixed);
    expect(second.status).toBe(201);
    expect(second.body).toHaveLength(4);

    const photos = await prisma.propertyPhoto.findMany({ where: { propertyId: p.id }, orderBy: { order: "asc" } });
    expect(photos).toHaveLength(4);
    // Порядок без дыр. Нумеруйся новые по индексу файла в пачке (как было до
    // ключей), два досланных получили бы order 2+2=4 и 2+3=5 — то есть [0,1,4,5].
    expect(photos.map((ph) => ph.order)).toEqual([0, 1, 2, 3]);
  });

  it("без ключей ведёт себя как раньше — старая вкладка продолжает работать", async () => {
    const p = await makeProperty();
    expect((await upload(p.id, [null, null])).status).toBe(201);
    expect((await upload(p.id, [null, null])).status).toBe(201);
    // Защиты от повтора нет и не было: у старого клиента ключа просто нет.
    expect(await prisma.propertyPhoto.count({ where: { propertyId: p.id } })).toBe(4);
  });

  it("ключей не столько, сколько файлов — 400, а не тихая рассинхронизация", async () => {
    const p = await makeProperty();
    const res = await request(app)
      .post(`/api/v1/properties/${p.id}/photos`)
      .set("Authorization", `Bearer ${token}`)
      .field("uploadKeys", `${runId}-c-1`)
      .attach("photos", TINY_PNG, "one.png")
      .attach("photos", TINY_PNG, "two.png");
    expect(res.status).toBe(400);
    expect(await prisma.propertyPhoto.count({ where: { propertyId: p.id } })).toBe(0);
  });

  it("одинаковые ключи внутри одного запроса — 400, а не падение на уникальном индексе", async () => {
    const p = await makeProperty();
    const res = await upload(p.id, [`${runId}-d-1`, `${runId}-d-1`]);
    expect(res.status).toBe(400);
    expect(await prisma.propertyPhoto.count({ where: { propertyId: p.id } })).toBe(0);
  });

  it("ключ чужого объекта не выдаёт чужую фотографию", async () => {
    const mine = await makeProperty();
    const other = await makeProperty();
    const key = `${runId}-e-1`;

    const first = await upload(other.id, [key]);
    expect(first.status).toBe(201);

    // Тот же ключ на ДРУГОМ объекте. Ответ обязан быть ВНЯТНЫМ отказом (409), а
    // не пятисотой с уникального индекса: на 5xx очередь повторяет отправку и
    // повторяла бы вечно. И уж точно не чужой фотографией.
    const res = await upload(mine.id, [key]);
    expect(res.status).toBe(409);
    expect(await prisma.propertyPhoto.count({ where: { propertyId: mine.id } })).toBe(0);
  });
});
