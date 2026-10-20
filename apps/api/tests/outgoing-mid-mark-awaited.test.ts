import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { rememberOutgoingMid, resetOutgoingMids, wasSentByUs } from "../src/messengers/outgoingMids.js";

/**
 * ОТМЕТКА «ЭТО ОТПРАВИЛИ МЫ» ОБЯЗАНА БЫТЬ ДОЖДАННОЙ.
 *
 * Жалоба владельца 20.09.2026: бот присылает по нескольку сообщений подряд на
 * одно обращение и «висит». Одна из причин — здесь: отметка писалась в базу
 * без ожидания (`void prisma…create()`). Сообщение шлёт worker, а эхо Meta
 * разбирает api, и общая правда для двух процессов — только база. Пока вставка
 * стоит в очереди пула (или не удалась вовсе), собственная реплика бота сходит
 * за ручной ответ сотрудника: пауза бота на 10 минут и вторая копия в переписке.
 *
 * Проверяется САМ КОНТРАКТ, а не гонка по времени: тест на «кто успел раньше»
 * был бы плавающим, а поломка от плавающего теста прячется. Здесь утверждение
 * простое: функция возвращает обещание, и после его ожидания отметку видит
 * ДРУГОЙ процесс — то есть база, а не память этого.
 */
describe("Отметка исходящего mid доступна другому процессу сразу после ожидания", () => {
  beforeEach(() => {
    resetOutgoingMids();
  });

  it("rememberOutgoingMid возвращает обещание записи, а не пустоту", () => {
    const mid = `mid-await-${process.pid}-1`;
    const pending = rememberOutgoingMid(mid);
    // Без этого вызывающему нечего ждать, и он уходит дальше, пока записи нет.
    expect(typeof (pending as Promise<void> | undefined)?.then).toBe("function");
    return pending;
  });

  it("после ожидания отметку видно в базе, даже если память процесса пуста", async () => {
    const mid = `mid-await-${process.pid}-2`;
    await rememberOutgoingMid(mid);

    // Память другого процесса (api, разбирающего эхо) про эту отправку не знает.
    resetOutgoingMids();

    expect(await wasSentByUs(mid)).toBe(true);
  });

  it("повторная отметка того же mid не ошибка", async () => {
    const mid = `mid-await-${process.pid}-3`;
    await rememberOutgoingMid(mid);
    await rememberOutgoingMid(mid);
    resetOutgoingMids();
    expect(await wasSentByUs(mid)).toBe(true);
  });

  it("чужой mid по-прежнему считается ручным ответом сотрудника", async () => {
    // Обратная сторона: без отметки бот обязан замолчать, иначе защита
    // превратилась бы в «эхо игнорируем всегда».
    expect(await wasSentByUs(`mid-await-${process.pid}-never-sent`)).toBe(false);
  });

  it("пустой mid ничего не пишет", async () => {
    const before = await prisma.processedMessage.count({ where: { channel: "out:meta" } });
    await rememberOutgoingMid(null);
    await rememberOutgoingMid(undefined);
    await rememberOutgoingMid("");
    expect(await prisma.processedMessage.count({ where: { channel: "out:meta" } })).toBe(before);
  });
});
