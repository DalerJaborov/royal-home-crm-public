import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { prisma } from "../src/db.js";

/**
 * ИДЕМПОТЕНТНОСТЬ /site-cover-image (CLAUDE.md, «Идемпотентность», пункт 1
 * разведки 22.09.2026).
 *
 * Защиты не было вовсе: повторная доставка (ретрай сайта на плохой связи) —
 * второй платный вызов рисующей модели (~20с у настоящей), второй файл-сирота
 * `uploads/covers/cover-*.jpg` и вторая ссылка сайту. Самое дорогое из всех
 * найденных разрывов.
 */

let coverImageCalls = 0;
/** Что вернуть на следующий вызов — управляется из теста. */
let coverImageResult: { ok: boolean; image: Buffer | null; error: string | null; status: number | null } = {
  ok: true,
  image: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
  error: null,
  status: 200,
};

vi.mock("../src/ai/coverImage.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/ai/coverImage.js")>();
  return {
    ...actual,
    generateCoverImage: vi.fn(async (_topic: string) => {
      coverImageCalls += 1;
      return coverImageResult;
    }),
  };
});

const runId = Date.now().toString(36);
const API_KEY = `test-cover-key-${runId}`;

/**
 * СВОЙ КАТАЛОГ ЗАГРУЗОК НА ЭТОТ ФАЙЛ.
 *
 * Нужен ради теста отказа диска ниже: тот кладёт ФАЙЛ на место каталога
 * `covers`, а делать такое в общем `./uploads` нельзя — там лежат чужие
 * загрузки. Заодно перестают копиться сироты `cover-*.jpg` от остальных
 * тестов этого файла.
 *
 * ПОДМЕНА ИМЕННО В ТЕЛЕ МОДУЛЯ, А НЕ В `beforeAll` — как `VIDEO_TMP_DIR` в
 * tests/setup.ts и по той же причине. `uploadsDir` вычисляется в теле
 * src/upload.ts, один раз при загрузке, а загружается тот заметно раньше
 * первого `import("../src/app.js")` в тесте — из хука подготовки. К моменту
 * `beforeAll` модуль уже в кэше, и подмена там опаздывает МОЛЧА: тест уходит
 * писать в общий `./uploads` (адрес задан в apps/api/.env), а блокирующий файл
 * остаётся лежать во временном каталоге, которого никто не читает. Проверено
 * 23.09.2026: с подменой в `beforeAll` тест зелёный и при снятой правке.
 *
 * Тело модуля выполняется до любых хуков, поэтому здесь подмена успевает.
 * Файлы прогона идут по одному в процессе (`fileParallelism: false`), и
 * значение возвращается на место в `afterAll`.
 */
const uploadsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rh-cover-uploads-"));
const previousUploadsDir = process.env.UPLOADS_DIR;
process.env.UPLOADS_DIR = uploadsRoot;

beforeAll(() => {
  process.env.WEBSITE_LEAD_API_KEY = API_KEY;
  process.env.CRM_PUBLIC_URL = process.env.CRM_PUBLIC_URL ?? "https://crm.test";
});

afterAll(async () => {
  delete process.env.WEBSITE_LEAD_API_KEY;
  if (previousUploadsDir === undefined) delete process.env.UPLOADS_DIR;
  else process.env.UPLOADS_DIR = previousUploadsDir;
  await fs.promises.rm(uploadsRoot, { recursive: true, force: true });
  await prisma.processedMessage.deleteMany({ where: { channel: "SITE_COVER_IMAGE" } });
});

afterEach(() => {
  coverImageCalls = 0;
  coverImageResult = { ok: true, image: Buffer.from([0xff, 0xd8, 0xff, 0xd9]), error: null, status: 200 };
});

describe("POST /site-cover-image — повторная доставка не рисует обложку дважды", () => {
  it("вторая доставка той же темы не вызывает дорогую генерацию второй раз", async () => {
    const { app } = await import("../src/app.js");
    const topic = `Тема обложки ${runId}`;

    const first = await request(app).post("/api/v1/webhooks/site-cover-image").set("X-Api-Key", API_KEY).send({ topic });
    expect(first.status).toBe(200);
    expect(first.body.url).toBeTruthy();
    expect(coverImageCalls).toBe(1);

    // Ретрай сайта на плохой связи — тот же самый вызов уходит второй раз.
    const second = await request(app).post("/api/v1/webhooks/site-cover-image").set("X-Api-Key", API_KEY).send({ topic });
    expect(second.status).toBe(409);
    // Главная проверка: рисующая модель не вызвана повторно.
    expect(coverImageCalls).toBe(1);
  });

  it("разные темы — обе доставки рисуют", async () => {
    const { app } = await import("../src/app.js");
    await request(app)
      .post("/api/v1/webhooks/site-cover-image")
      .set("X-Api-Key", API_KEY)
      .send({ topic: `Первая тема ${runId}` });
    await request(app)
      .post("/api/v1/webhooks/site-cover-image")
      .set("X-Api-Key", API_KEY)
      .send({ topic: `Вторая тема ${runId}` });
    expect(coverImageCalls).toBe(2);
  });

  it("отказ рисования снимает замок — повтор после исправления проходит", async () => {
    const { app } = await import("../src/app.js");
    const topic = `Тема с отказом ${runId}`;
    coverImageResult = { ok: false, image: null, error: "квота исчерпана", status: 429 };

    const first = await request(app).post("/api/v1/webhooks/site-cover-image").set("X-Api-Key", API_KEY).send({ topic });
    expect(first.status).toBe(502);

    coverImageResult = { ok: true, image: Buffer.from([0xff, 0xd8, 0xff, 0xd9]), error: null, status: 200 };
    const second = await request(app).post("/api/v1/webhooks/site-cover-image").set("X-Api-Key", API_KEY).send({ topic });
    expect(second.status).toBe(200);
    expect(coverImageCalls).toBe(2);
  });

  /**
   * ЗАПИСЬ НА ДИСК — ЕДИНСТВЕННЫЙ ШАГ ОБРАБОТЧИКА, КОТОРЫЙ УМЕЕТ БРОСИТЬ ПРИ
   * ЗДОРОВОЙ БАЗЕ. Без ветки в routes/webhooks.ts исключение уходило наверх
   * мимо замка: отметка оставалась в состоянии «обработка идёт», и честный
   * повтор сайта получал 409 «уже генерируется», хотя обложки нет и никто её
   * не рисует. Тот же класс, что разобран в lib/videoHandoff.ts.
   */
  it("запись на диск упала — замок снят, повтор после починки проходит", async () => {
    const { app } = await import("../src/app.js");
    const topic = `Тема с отказом диска ${runId}`;

    // Отказ настоящий, а не подменённый `fs`: на месте каталога `covers` лежит
    // ФАЙЛ, и `mkdir(..., { recursive: true })` на таком пути бросает так же,
    // как бросил бы кончившийся диск или том только на чтение.
    const coversPath = path.join(uploadsRoot, "covers");
    await fs.promises.rm(coversPath, { recursive: true, force: true });
    await fs.promises.writeFile(coversPath, "это файл, а не каталог");

    const failed = await request(app).post("/api/v1/webhooks/site-cover-image").set("X-Api-Key", API_KEY).send({ topic });
    expect(failed.status).toBe(503);
    expect(coverImageCalls).toBe(1);

    // Главная проверка: замок снят. Окно ключа — пять минут, и без снятия
    // повтор все эти пять минут получал бы 409 вместо обложки.
    await fs.promises.rm(coversPath, { force: true });
    const second = await request(app).post("/api/v1/webhooks/site-cover-image").set("X-Api-Key", API_KEY).send({ topic });
    expect(second.status).toBe(200);
    expect(second.body.url).toBeTruthy();
    expect(coverImageCalls).toBe(2);
  });
});
