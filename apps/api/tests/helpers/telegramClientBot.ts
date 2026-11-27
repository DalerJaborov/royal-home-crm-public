import { afterAll, beforeAll } from "vitest";

/**
 * КЛИЕНТСКИЙ TELEGRAM-БОТ В ТЕСТАХ (27.11.2026).
 *
 * С рубильником «Telegram-бот только для сотрудников» (Settings.telegramStaffOnlyEnabled,
 * по умолчанию ВКЛ) незнакомый личный чат получает памятку вместо клиентского диалога.
 * Файлы, которые проверяют клиентский путь Telegram (приветствие, заявка, альбомы,
 * «Позвать агента»…), проверяют поведение при ВЫКЛЮЧЕННОМ рубильнике — оно сохранено
 * байт в байт. Этот помощник выключает рубильник на время файла и возвращает прежнее
 * значение после. Свои базы у процессов прогона (tests/dbPerWorker.ts), файлы в процессе
 * идут по очереди — соседей это не задевает.
 *
 * Прикладной код — только динамическим импортом внутри хука: адрес базы подменяет
 * tests/setup.ts до первого импорта src.
 */
export function useTelegramClientBot(): void {
  let previous: boolean | null = null;
  beforeAll(async () => {
    const { prisma } = await import("../../src/db.js");
    const row = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { telegramStaffOnlyEnabled: true } });
    previous = row?.telegramStaffOnlyEnabled ?? null;
    await prisma.settings.upsert({
      where: { id: "singleton" },
      create: { id: "singleton", telegramStaffOnlyEnabled: false },
      update: { telegramStaffOnlyEnabled: false },
    });
  });
  afterAll(async () => {
    const { prisma } = await import("../../src/db.js");
    await prisma.settings.updateMany({ where: { id: "singleton" }, data: { telegramStaffOnlyEnabled: previous ?? true } });
  });
}
