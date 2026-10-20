import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * translateChatMessage (13.09.2026) — перевод одной реплики клиента в переписке
 * по клику, тот же приём, что и у звонков. См. messengers/translateChatMessage.ts.
 *
 * Гейт — detectClientLanguage (настоящий, НЕ мокаем: это ровно то, ради чего
 * функция вообще написана — использовать боевой определитель языка переписки,
 * а не грубый looksTajik). Мокаем только сеть (сам вызов модели) и базу.
 */
vi.mock("../src/db.js", () => ({
  prisma: {
    $executeRaw: vi.fn().mockResolvedValue(undefined),
    // tests/setup.ts зовёт $disconnect в afterAll независимо от того, дошёл ли
    // тест до базы — без него падает на самом обращении к полю (см. тот же
    // приём в recording-log-noise.test.ts).
    $disconnect: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock("../src/ai/translateTranscript.js", () => ({
  translateToRussian: vi.fn(),
}));

const { prisma } = await import("../src/db.js");
const { translateToRussian } = await import("../src/ai/translateTranscript.js");
const { translateChatMessage } = await import("../src/messengers/translateChatMessage.js");

beforeEach(() => {
  vi.mocked(prisma.$executeRaw).mockReset().mockResolvedValue(undefined as never);
  vi.mocked(translateToRussian).mockReset();
});

describe("translateChatMessage", () => {
  it("русский текст — модель не зовём, база не пишется", async () => {
    const result = await translateChatMessage("conv1", "2026-09-13T10:00:00.000Z", "Здравствуйте, квартира ещё продаётся?");
    expect(result).toBeNull();
    expect(translateToRussian).not.toHaveBeenCalled();
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it("таджикский текст — переводит через ту же модель, что и звонки, помечает свою метку расхода", async () => {
    vi.mocked(translateToRussian).mockResolvedValue("Дом ещё продаётся?");
    const result = await translateChatMessage("conv1", "2026-09-13T10:00:00.000Z", "Хонаи ин ҳанӯз фурӯхта мешавад?");
    expect(result).toBe("Дом ещё продаётся?");
    expect(translateToRussian).toHaveBeenCalledWith("Хонаи ин ҳанӯз фурӯхта мешавад?", "chat-message-translate");
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
  });

  it("смешанная реплика (mixed) — тоже переводит", async () => {
    vi.mocked(translateToRussian).mockResolvedValue("Хочу квартиру в центре");
    const result = await translateChatMessage("conv1", "2026-09-13T10:00:00.000Z", "Ман мехоҳам квартира в центре");
    expect(result).toBe("Хочу квартиру в центре");
    expect(translateToRussian).toHaveBeenCalled();
  });

  it("модель не ответила (null) — база не пишется, результат null", async () => {
    vi.mocked(translateToRussian).mockResolvedValue(null);
    const result = await translateChatMessage("conv1", "2026-09-13T10:00:00.000Z", "Хона дар Сино доред?");
    expect(result).toBeNull();
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });
});
