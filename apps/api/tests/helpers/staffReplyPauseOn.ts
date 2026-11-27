/**
 * Рубильник «ответ сотрудника останавливает бота» (botPauseOnStaffReplyEnabled) с 27.11.2026 по умолчанию ВЫКЛ.
 * Тесты, проверяющие САМУ паузу после ответа сотрудника, включают его подменой модуля, а не записью в общую строку
 * Settings: тесты идут в несколько процессов на одной базе, и записанное значение уронило бы соседний файл.
 *
 * Подключение (vi.mock поднимается наверх файла, поэтому фабрика берёт помощник динамическим import):
 *   vi.mock("../src/lib/automationSwitches.js", async (importOriginal) =>
 *     (await import("./helpers/staffReplyPauseOn.js")).withStaffReplyPauseOn(await importOriginal()));
 */
export function withStaffReplyPauseOn<T extends object>(original: T): T {
  const real = (original as unknown as { automationSwitchOn: (key: string, db?: unknown) => Promise<boolean> }).automationSwitchOn;
  return {
    ...original,
    automationSwitchOn: async (key: string, db?: unknown) => (key === "botPauseOnStaffReplyEnabled" ? true : real(key, db)),
  } as T;
}
