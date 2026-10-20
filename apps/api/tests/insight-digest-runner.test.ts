import { describe, it, expect, vi, beforeEach } from "vitest";

// Мокаем prisma до импорта тестируемого модуля
vi.mock("../src/db.js", () => {
  const mock = {
    settings: { findFirst: vi.fn() },
    insightDigest: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    insightCase: {
      create: vi.fn(),
      update: vi.fn(),
      count: vi.fn().mockResolvedValue(2),
      deleteMany: vi.fn(),
    },
    agent: { findMany: vi.fn() },
    // 07.09.2026: путь по умолчанию (не immediate) кладёт аларм в общую
    // очередь (lib/directorAlertQueue.ts) вместо прямой отправки.
    pendingDirectorAlert: { create: vi.fn().mockResolvedValue(undefined) },
    $disconnect: vi.fn().mockResolvedValue(undefined),
  };
  return { prisma: mock };
});

// Мокаем push и notifications
vi.mock("../src/push.js", async (importOriginal) => ({
  // Подмена ДОПОЛНЯЕТ модуль, а не заменяет его целиком (19.09.2026):
  // фабрика без importOriginal убирает остальные экспорты у всего
  // процесса, и СОСЕДНИЙ тест падает на «No "…" export is defined».
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgents: vi.fn().mockResolvedValue(0),
}));

vi.mock("../src/lib/notifications.js", () => ({
  createNotifications: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/lib/systemError.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/systemError.js")>()),
  logSystemError: vi.fn().mockResolvedValue(undefined),
}));

// Мокаем динамические импорты insightDigest.js и insightJudge.js
const mockCollectCandidates = vi.fn();
const mockRankAndPick = vi.fn();
const mockGenerateVerdicts = vi.fn();

vi.mock("../src/lib/insightDigest.js", () => ({
  collectCandidates: (...args: unknown[]) => mockCollectCandidates(...args),
  rankAndPick: (...args: unknown[]) => mockRankAndPick(...args),
}), { virtual: true });

vi.mock("../src/lib/insightJudge.js", () => ({
  generateVerdicts: (...args: unknown[]) => mockGenerateVerdicts(...args),
}), { virtual: true });

import { prisma } from "../src/db.js";
import { sendPushToAgents } from "../src/push.js";
import { createNotifications } from "../src/lib/notifications.js";
import { generateInsightDigest, notifyDirectorsAboutInsightDigest } from "../src/lib/insightDigestRunner.js";

const mockedPrisma = vi.mocked(prisma);
const mockedSendPush = vi.mocked(sendPushToAgents);
const mockedCreateNotifications = vi.mocked(createNotifications);

describe("generateInsightDigest", () => {
  const periodStart = new Date("2026-09-01T00:00:00Z");
  const periodEnd = new Date("2026-09-15T23:59:59Z");
  const meetingAt = new Date("2026-09-15T04:00:00Z");

  beforeEach(() => {
    vi.clearAllMocks();
    // По умолчанию рубильник включён
    mockedPrisma.settings.findFirst.mockResolvedValue({ insightDigestEnabled: true } as never);
    // По умолчанию диджест не существует
    mockedPrisma.insightDigest.findUnique.mockResolvedValue(null);
    // Создаём диджест с фиксированным id
    mockedPrisma.insightDigest.create.mockResolvedValue({
      id: "digest-001",
      periodStart,
      periodEnd,
      meetingAt,
      status: "GENERATING",
      coverage: {},
    } as never);
    // collectCandidates возвращает двух кандидатов (тип CaseCandidate из insightDigest.ts)
    mockCollectCandidates.mockResolvedValue([
      { agentId: "a1", clientId: "c1", kind: "call_low_score", severity: 3, rankScore: 60, sourceKey: "call-1", raw: {} },
      { agentId: "a2", clientId: "c2", kind: "score_penalty", severity: 4, rankScore: 80, sourceKey: "penalty-1", raw: {} },
    ]);
    // rankAndPick возвращает тех же
    mockRankAndPick.mockImplementation((c: unknown[]) => Promise.resolve(c));
    // insightCase.create возвращает созданные кейсы
    mockedPrisma.insightCase.create.mockImplementation((args: { data: { sourceKey: string; kind: string; timeline: unknown } }) =>
      Promise.resolve({
        id: `case-${args.data.sourceKey}`,
        sourceKey: args.data.sourceKey,
        kind: args.data.kind,
        timeline: args.data.timeline,
      } as never)
    );
    // generateVerdicts возвращает void (обновляет БД напрямую через prisma.insightCase.update)
    mockGenerateVerdicts.mockResolvedValue(undefined);
    // Захват застрявшей сборки по умолчанию удаётся, недособранных кейсов нет.
    mockedPrisma.insightDigest.updateMany.mockResolvedValue({ count: 1 } as never);
    mockedPrisma.insightCase.deleteMany.mockResolvedValue({ count: 0 } as never);
    mockedPrisma.insightDigest.update.mockResolvedValue({} as never);
  });

  it("возвращает DISABLED когда рубильник выключен", async () => {
    mockedPrisma.settings.findFirst.mockResolvedValue({ insightDigestEnabled: false } as never);
    const result = await generateInsightDigest(periodStart, periodEnd, meetingAt);
    expect(result).toBe("DISABLED");
    expect(mockedPrisma.insightDigest.create).not.toHaveBeenCalled();
  });

  it("возвращает существующий id при повторном вызове (идемпотентность)", async () => {
    mockedPrisma.insightDigest.findUnique.mockResolvedValue({ id: "existing-id" } as never);
    const result = await generateInsightDigest(periodStart, periodEnd, meetingAt);
    expect(result).toBe("existing-id");
    expect(mockedPrisma.insightDigest.create).not.toHaveBeenCalled();
  });

  /**
   * Соседний баг того же класса, что и зависшая стадия расшифровки (21.09.2026):
   * статус GENERATING снимал только тот процесс, который его поставил, а выкат
   * перезапускает контейнеры по каждому мержу в main.
   */
  describe("Оборванная рестартом сборка", () => {
    const stale = new Date(Date.now() - 45 * 60_000);
    const fresh = new Date(Date.now() - 60_000);

    it("вечное «собирается…» пересобирается, а не отдаётся как готовое", async () => {
      mockedPrisma.insightDigest.findUnique.mockResolvedValue({
        id: "stuck-id",
        status: "GENERATING",
        createdAt: stale,
      } as never);

      const result = await generateInsightDigest(periodStart, periodEnd, meetingAt);

      // Та же строка, а не новая: уникальный индекс periodStart всё равно не дал бы завести вторую.
      expect(result).toBe("stuck-id");
      expect(mockedPrisma.insightDigest.create).not.toHaveBeenCalled();
      // Сборка правда пошла заново.
      expect(mockCollectCandidates).toHaveBeenCalledTimes(1);
      expect(mockedPrisma.insightDigest.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: "READY" }) })
      );
    });

    it("недособранные кейсы прошлой попытки убираются, разобранные остаются", async () => {
      mockedPrisma.insightDigest.findUnique.mockResolvedValue({
        id: "stuck-id",
        status: "GENERATING",
        createdAt: stale,
      } as never);

      await generateInsightDigest(periodStart, periodEnd, meetingAt);

      // sourceKey уникален глобально: не убрать их — и каждый create новой
      // сборки упёрся бы в дубль, а выпуск вышел бы пустым и «готовым».
      expect(mockedPrisma.insightCase.deleteMany).toHaveBeenCalledWith({
        where: { digestId: "stuck-id", reviewedAt: null },
      });
    });

    it("сборка, которая идёт прямо сейчас, не трогается", async () => {
      mockedPrisma.insightDigest.findUnique.mockResolvedValue({
        id: "running-id",
        status: "GENERATING",
        createdAt: fresh,
      } as never);

      const result = await generateInsightDigest(periodStart, periodEnd, meetingAt);

      expect(result).toBe("running-id");
      expect(mockedPrisma.insightCase.deleteMany).not.toHaveBeenCalled();
      expect(mockCollectCandidates).not.toHaveBeenCalled();
    });

    it("захват проигран параллельному претенденту — вторая пересборка не идёт", async () => {
      mockedPrisma.insightDigest.findUnique.mockResolvedValue({
        id: "stuck-id",
        status: "GENERATING",
        createdAt: stale,
      } as never);
      // Крон в 09:00 и кнопка «Собрать сейчас» могут совпасть: захват меняет
      // createdAt, и опоздавшему его updateMany не находит уже ничего.
      mockedPrisma.insightDigest.updateMany.mockResolvedValue({ count: 0 } as never);

      const result = await generateInsightDigest(periodStart, periodEnd, meetingAt);

      expect(result).toBe("stuck-id");
      expect(mockedPrisma.insightCase.deleteMany).not.toHaveBeenCalled();
      expect(mockCollectCandidates).not.toHaveBeenCalled();
    });
  });

  it("успешная генерация → статус READY, кейсы созданы", async () => {
    mockedPrisma.insightDigest.update.mockResolvedValue({} as never);
    // count возвращает 2 (все вердикты применены)
    mockedPrisma.insightCase.count.mockResolvedValue(2);
    const result = await generateInsightDigest(periodStart, periodEnd, meetingAt);
    expect(result).toBe("digest-001");
    // Два кейса созданы
    expect(mockedPrisma.insightCase.create).toHaveBeenCalledTimes(2);
    // Финальный статус READY
    expect(mockedPrisma.insightDigest.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "digest-001" },
        data: expect.objectContaining({ status: "READY" }),
      })
    );
  });

  /**
   * HELPER-FINAL03 (аудит Codex, 04.10.2026): сбой записи кейса глотался, выпуск уходил в
   * READY без этого кейса, а повторная генерация отдавала тот же id и ничего не пересобирала.
   */
  describe("Потеря кейса при записи (HELPER-FINAL03)", () => {
    const old = new Date(Date.now() - 5 * 24 * 60 * 60_000);

    it("сбой записи кейса (не дубль sourceKey) даёт PARTIAL и считается в coverage.failedCases", async () => {
      mockedPrisma.insightCase.create.mockRejectedValueOnce(new Error("база моргнула"));
      mockedPrisma.insightCase.count.mockResolvedValue(1);

      await generateInsightDigest(periodStart, periodEnd, meetingAt);

      expect(mockedPrisma.insightDigest.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: "PARTIAL",
            coverage: expect.objectContaining({ failedCases: 1 }),
          }),
        })
      );
    });

    it("дубль sourceKey (P2002) — штатный пропуск: выпуск остаётся READY", async () => {
      const { Prisma } = await import("../src/generated/prisma/client.js");
      mockedPrisma.insightCase.create.mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "test" })
      );
      mockedPrisma.insightCase.count.mockResolvedValue(1);

      await generateInsightDigest(periodStart, periodEnd, meetingAt);

      expect(mockedPrisma.insightDigest.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: "READY" }) })
      );
    });

    it("выпуск PARTIAL с потерянными кейсами пересобирается повторной генерацией, разобранные кейсы остаются", async () => {
      mockedPrisma.insightDigest.findUnique.mockResolvedValue({
        id: "partial-id",
        status: "PARTIAL",
        createdAt: old,
        coverage: { calls: 2, analyzed: 1, findings: 1, penalties: 0, failedCases: 1 },
      } as never);

      const result = await generateInsightDigest(periodStart, periodEnd, meetingAt);

      expect(result).toBe("partial-id");
      expect(mockCollectCandidates).toHaveBeenCalledTimes(1);
      expect(mockedPrisma.insightDigest.create).not.toHaveBeenCalled();
      // Захват атомарный: по статусу, который читали.
      expect(mockedPrisma.insightDigest.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ id: "partial-id", status: "PARTIAL" }) })
      );
      expect(mockedPrisma.insightCase.deleteMany).toHaveBeenCalledWith({
        where: { digestId: "partial-id", reviewedAt: null },
      });
    });

    it("выпуск FAILED пересобирается повторной генерацией", async () => {
      mockedPrisma.insightDigest.findUnique.mockResolvedValue({
        id: "failed-id",
        status: "FAILED",
        createdAt: old,
        coverage: { calls: 0, analyzed: 0, findings: 0, penalties: 0, error: "x" },
      } as never);

      const result = await generateInsightDigest(periodStart, periodEnd, meetingAt);

      expect(result).toBe("failed-id");
      expect(mockCollectCandidates).toHaveBeenCalledTimes(1);
    });

    it("PARTIAL только из-за вердиктов (кейсы целы) не пересобирается: бюджет ИИ не тратится зря", async () => {
      mockedPrisma.insightDigest.findUnique.mockResolvedValue({
        id: "verdict-partial-id",
        status: "PARTIAL",
        createdAt: old,
        coverage: { calls: 2, analyzed: 2, findings: 2, penalties: 0, verdictError: "429" },
      } as never);

      const result = await generateInsightDigest(periodStart, periodEnd, meetingAt);

      expect(result).toBe("verdict-partial-id");
      expect(mockCollectCandidates).not.toHaveBeenCalled();
    });

    it("захват пересборки проигран параллельному претенденту — вторая пересборка не идёт", async () => {
      mockedPrisma.insightDigest.findUnique.mockResolvedValue({
        id: "failed-id",
        status: "FAILED",
        createdAt: old,
        coverage: {},
      } as never);
      mockedPrisma.insightDigest.updateMany.mockResolvedValue({ count: 0 } as never);

      await generateInsightDigest(periodStart, periodEnd, meetingAt);

      expect(mockCollectCandidates).not.toHaveBeenCalled();
      expect(mockedPrisma.insightCase.deleteMany).not.toHaveBeenCalled();
    });
  });
  it("статус PARTIAL когда часть вердиктов не получена", async () => {
    // count возвращает 1 из 2 (один вердикт пропущен)
    mockedPrisma.insightCase.count.mockResolvedValue(1);
    mockedPrisma.insightDigest.update.mockResolvedValue({} as never);
    await generateInsightDigest(periodStart, periodEnd, meetingAt);
    expect(mockedPrisma.insightDigest.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "PARTIAL" }),
      })
    );
  });
});

describe("notifyDirectorsAboutInsightDigest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("immediate:true (кнопка «Собрать сейчас») — отправляет пуш директорам сразу", async () => {
    mockedPrisma.insightDigest.findUnique.mockResolvedValue({
      id: "digest-001",
      meetingAt: new Date("2026-09-15T04:00:00Z"),
      periodStart: new Date("2026-09-01T00:00:00Z"),
      _count: { cases: 5 },
    } as never);
    mockedPrisma.agent.findMany.mockResolvedValue([
      { id: "dir-1" },
      { id: "dir-2" },
    ] as never);

    await notifyDirectorsAboutInsightDigest("digest-001", true);

    expect(mockedSendPush).toHaveBeenCalledWith(
      ["dir-1", "dir-2"],
      expect.objectContaining({
        kind: "oversight",
        title: "📊 Инсайты от ИИ готовы",
        body: "5 кейсов для собрания 2026-09-15",
        url: "/insights",
      })
    );
    expect(mockedCreateNotifications).toHaveBeenCalled();
  });

  it("по умолчанию (крон) — ставит в очередь алармов руководству, не шлёт мгновенно", async () => {
    mockedPrisma.insightDigest.findUnique.mockResolvedValue({
      id: "digest-002",
      meetingAt: new Date("2026-09-15T04:00:00Z"),
      periodStart: new Date("2026-09-01T00:00:00Z"),
      _count: { cases: 3 },
    } as never);

    await notifyDirectorsAboutInsightDigest("digest-002");

    expect(mockedSendPush).not.toHaveBeenCalled();
    expect(mockedCreateNotifications).not.toHaveBeenCalled();
    expect(mockedPrisma.pendingDirectorAlert.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          title: "📊 Инсайты от ИИ готовы",
          body: "3 кейсов для собрания 2026-09-15",
          recipientRoles: ["DIRECTOR", "ADMIN"],
        }),
      })
    );
  });

  it("ничего не делает если диджест не найден", async () => {
    mockedPrisma.insightDigest.findUnique.mockResolvedValue(null);
    await notifyDirectorsAboutInsightDigest("nonexistent");
    expect(mockedSendPush).not.toHaveBeenCalled();
    expect(mockedPrisma.pendingDirectorAlert.create).not.toHaveBeenCalled();
  });
});