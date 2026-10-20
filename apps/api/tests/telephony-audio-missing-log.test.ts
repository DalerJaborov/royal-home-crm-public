import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { waitForCount, waitForSettled } from "./helpers/waitFor.js";
import request from "supertest";
import path from "node:path";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { app } from "../src/app.js";
import { uploadsDir } from "../src/upload.js";
import { prisma } from "../src/db.js";

/**
 * СТАТИКА /uploads/telephony/*.wav|mp3 БЕЗ СЛЕДА В ЖУРНАЛЕ — docs/TASKS.md:
 * «Файлы озвучки телефонии отдают 404 (~100 обращений за 20 часов)».
 *
 * Станция забирает музыку ожидания/приветствие/приветствие очереди/«агент
 * перезвонит» по постоянным адресам `/uploads/telephony/(moh|greeting|queue|
 * agentDeclined).(wav|mp3)` (routes/settings.ts). Файлы кладёт ТОЛЬКО ручная
 * загрузка в Настройках — если владелец не загрузил звук, express.static честно
 * отвечает 404, но раздача статики не имеет обработчика маршрута: раньше отказ
 * не оставлял ни следа в ErrorLog, «Здоровье системы» о нём не знало (найдено
 * при разборе скриншотов 07.09.2026, «отдельно, вне скриншотов»). Ловушка в
 * app.ts после express.static логирует расхождение один раз (дедуп
 * logSystemError, 10 минут), не выдумывая сам файл.
 */

afterAll(async () => {
  await prisma.errorLog.deleteMany({ where: { source: "telephony", message: { contains: "звук телефонии" } } });
  await prisma.$disconnect();
});

describe("GET /uploads/telephony/*.wav|mp3 — файла нет", () => {
  /**
   * Каталог `uploads/telephony` общий на весь прогон, и соседний тест
   * (`telephony-audio-upload`) кладёт туда настоящие файлы. Берём звук
   * `agentDeclined`, которого тот не трогает, и всё равно подчищаем: остаток
   * от прошлого запуска превращал 404 в 200 и валил проверку (полный прогон
   * 11.09).
   */
  beforeAll(async () => {
    const dir = path.join(uploadsDir, "telephony");
    await mkdir(dir, { recursive: true });
    await rm(path.join(dir, "agentDeclined.wav"), { force: true });
    await rm(path.join(dir, "agentDeclined.mp3"), { force: true });
  });

  it("404, и запись уходит в журнал системных ошибок", async () => {
    const res = await request(app).get("/uploads/telephony/agentDeclined.wav");
    expect(res.status).toBe(404);

    await waitForCount(
      () =>
        prisma.errorLog.count({
          where: { source: "telephony", message: { contains: "«agentDeclined»" } },
        }),
      1,
      { label: "запись в журнале про звук agentDeclined" }
    );
  });

  it("повторный заход не плодит вторую запись (дедуп 10 минут)", async () => {
    await request(app).get("/uploads/telephony/agentDeclined.wav");
    await request(app).get("/uploads/telephony/agentDeclined.wav");

    const logged = await prisma.errorLog.findMany({
      where: { source: "telephony", message: { contains: "«agentDeclined»" } },
    });
    expect(logged.length).toBe(1);
  });

  /**
   * Станция опрашивает оба расширения подряд и берёт то, которое нашлось: на
   * проде лежат только `.wav`, и 404 на `.mp3` — штатное состояние настроенной
   * телефонии. Записывать его значит класть в журнал около шестисот строк в
   * сутки на пустом месте, поэтому запись идёт, только когда звука нет ни в
   * одном расширении.
   */
  it("второе расширение существует — записи нет", async () => {
    const dir = path.join(uploadsDir, "telephony");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "agentDeclined.wav"), "проверка");
    try {
      // Считаем ИЗМЕНЕНИЕ, а не общее число: запись про этот же звук уже оставил
      // первый случай выше, и проверка «ровно ноль» ловила бы его, а не новую.
      const where = { source: "telephony", message: { contains: "«agentDeclined»" } };
      const before = await waitForSettled(() => prisma.errorLog.count({ where }));
      const res = await request(app).get("/uploads/telephony/agentDeclined.mp3");
      expect(res.status).toBe(404);
      const after = await waitForSettled(() => prisma.errorLog.count({ where }));
      expect(after).toBe(before);
    } finally {
      await rm(path.join(dir, "agentDeclined.wav"), { force: true });
    }
  });

  it("не срабатывает на посторонний путь под /uploads/telephony", async () => {
    const res = await request(app).get("/uploads/telephony/something-else.txt");
    expect(res.status).toBe(404);

    const logged = await prisma.errorLog.findMany({
      where: { source: "telephony", message: { contains: "something-else.txt" } },
    });
    expect(logged.length).toBe(0);
  });
});
