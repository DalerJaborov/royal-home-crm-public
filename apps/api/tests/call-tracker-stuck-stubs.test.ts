import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * checkStuckCallStubs (apps/api/src/lib/telephony/callTracker.ts) — найдено
 * 24.09.2026 на живом случае: заготовка #478 заведена в 10:45, а запись
 * «Звонок потерян» появилась только в 16:10, хотя порог STUCK_CALL_MINUTES=20
 * и тик крона раз в 5 минут (cron.ts). Причины (обе тут же и чинятся):
 *
 * (а) `findMany` без `orderBy` — при >50 висящих заготовках `take: 50` мог не
 *     захватить самую старую тик за тиком.
 * (б) `prisma.interaction.update` в ветке «восстановлено» ничем не был
 *     прикрыт — отказ базы на ОДНОЙ заготовке рвал исключением всю функцию
 *     ДО цикла, который пишет/пушит про unresolved.
 *
 * База подменена целиком через vi.mock("../src/db.js") — тем же приёмом,
 * что и instagram-token-refresh.test.ts: цель — проверить именно аргументы
 * запроса и живучесть цикла при отказе одной записи, а не гонять реальный
 * Postgres ради двух моковых заготовок. Станция (ingestCallRecording) и
 * журнал/пуши подменены тоже — сеть и реальные получатели тут не нужны.
 */

vi.mock("../src/db.js", () => ({
  prisma: {
    interaction: {
      findMany: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
    },
    $disconnect: vi.fn().mockResolvedValue(undefined),
  },
}));

const ingestCallRecording = vi.fn();
vi.mock("../src/lib/telephony/callRecordings.js", () => ({
  ingestCallRecording,
  // Ненулевой конфиг обязателен — иначе checkStuckCallStubs даже не пытается
  // спросить станцию и все заготовки уходят в unresolved без вызова ingest.
  recordingFetchConfig: () => ({ baseUrl: "http://pbx.local", token: null }),
}));

const logSystemError = vi.fn().mockResolvedValue(undefined);
vi.mock("../src/lib/systemError.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/systemError.js")>()),
  logSystemError }));

vi.mock("../src/lib/recipients.js", () => ({ findAgentsWithPermission: async () => ["agent-1"] }));

const sendPushToAgents = vi.fn().mockResolvedValue(1);
vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgents }));

const { checkStuckCallStubs, trackCall, resetCalls } = await import("../src/lib/telephony/callTracker.js");
const { prisma } = await import("../src/db.js");

/** Заготовка ровно в форме `select` из checkStuckCallStubs. */
function stub(id: string, shortId: number) {
  return {
    id,
    clientId: `client-${id}`,
    agentId: `agent-${id}`,
    createdAt: new Date("2026-09-24T10:45:00Z"),
    client: { shortId, fullName: `Клиент ${shortId}`, phone: `+99290000${shortId}` },
    agent: { sipExtension: "1009" },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  (prisma.interaction.update as ReturnType<typeof vi.fn>).mockResolvedValue({});
  // `calls` — модульный синглтон (память процесса, см. докстринг callTracker.ts) и
  // переживает между тестами этого файла: без сброса живой канал, заведённый в
  // одном тесте (в), утекал бы в следующие.
  resetCalls();
});

describe("checkStuckCallStubs", () => {
  it("(а) выборка заготовок идёт от самой старой — findMany с orderBy: createdAt asc", async () => {
    (prisma.interaction.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    await checkStuckCallStubs();

    expect(prisma.interaction.findMany).toHaveBeenCalledTimes(1);
    const args = (prisma.interaction.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(args.orderBy).toEqual({ createdAt: "asc" });
    expect(args.take).toBe(50);
  });

  it("(б) падение update у одной ВОССТАНОВЛЕННОЙ заготовки не мешает обработке остальных", async () => {
    const recovered = stub("call-recovered", 478);
    const lost = stub("call-lost", 479);
    (prisma.interaction.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([recovered, lost]);

    // Станция нашла файл для первой заготовки, для второй — нет (и файла,
    // и события «канал закончен» не было, ровно случай #478).
    ingestCallRecording.mockImplementation(async ({ interactionId }: { interactionId: string }) => {
      if (interactionId === recovered.id) return { ok: true };
      return { ok: false, reason: "не найдено на станции" };
    });

    // Запись найдена, но карточку обновить не удалось — гонка/отказ пула,
    // ровно то, что раньше рвало всю функцию до цикла с unresolved.
    (prisma.interaction.update as ReturnType<typeof vi.fn>).mockImplementation(
      async ({ where }: { where: { id: string } }) => {
        if (where.id === recovered.id) throw new Error("connection pool timeout");
        return {};
      }
    );

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await checkStuckCallStubs();

    // Обе заготовки обработаны до конца — исключение на одной не оборвало функцию.
    expect(prisma.interaction.update).toHaveBeenCalledTimes(2);

    // Провал update у восстановленной заготовки — предупреждён и залогирован
    // с постоянным dedupKey вида поломки (с 02.10.2026 без id заготовки — E11),
    // а не потерян молча.
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(
      logSystemError.mock.calls.some(
        ([source, message, ctx]) =>
          source === "telephony" &&
          typeof message === "string" &&
          message.includes("не удалось обновить") &&
          ctx?.dedupKey === "stuck-call-update-failed"
      )
    ).toBe(true);

    // Вторая заготовка (не найдена на станции) всё равно дошла до записи в
    // журнал и пуша руководству — цикл unresolved НЕ пропущен из-за провала
    // update у первой заготовки.
    expect(
      logSystemError.mock.calls.some(
        ([source, message]) =>
          source === "telephony" && typeof message === "string" && message.includes("Звонок потерян") && message.includes(String(lost.client.shortId))
      )
    ).toBe(true);
    expect(sendPushToAgents).toHaveBeenCalledTimes(1);

    // recovered.id всё же посчитан восстановленным (файл на станции нашёлся),
    // lost.id — единственный, что остался unresolved.
    expect(result).toBe(1);
  });

  it("(в) заготовка с живым каналом в Map (calls) пропускается целиком — не помечается «потерянной»", async () => {
    const live = stub("call-live", 480);
    const dead = stub("call-dead", 481);
    (prisma.interaction.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([live, dead]);
    ingestCallRecording.mockResolvedValue({ ok: false, reason: "не найдено на станции" });

    // Канал этого interactionId ещё жив в памяти процесса (retiring-звонок,
    // например) — ChannelDestroyed просто не пришёл, разговор не потерян.
    trackCall({
      channelId: "chan-live-480",
      agentId: live.agentId,
      clientId: live.clientId,
      clientShortId: live.client.shortId,
      clientName: live.client.fullName,
      dialingTo: "1009",
      interactionId: live.id,
    });

    const result = await checkStuckCallStubs();

    // Живую заготовку не тронули вовсе: ни поиском записи на станции...
    expect(ingestCallRecording).not.toHaveBeenCalledWith(expect.objectContaining({ interactionId: live.id }));
    // ...ни пометкой «потерян».
    expect(prisma.interaction.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: live.id } })
    );

    // Мёртвая заготовка (канала для неё в Map нет) обработана как обычно.
    expect(prisma.interaction.update).toHaveBeenCalledWith({
      where: { id: dead.id },
      data: { notes: expect.stringContaining("станция не подтвердила его завершение") },
    });
    expect(result).toBe(1);
  });

  it("(г) падение update у ЗАВИСШЕЙ (unresolved) заготовки не рвёт цикл — пуш руководству всё равно уходит", async () => {
    const failing = stub("call-mark-fail", 482);
    const ok = stub("call-mark-ok", 483);
    (prisma.interaction.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([failing, ok]);
    ingestCallRecording.mockResolvedValue({ ok: false, reason: "не найдено на станции" });

    (prisma.interaction.update as ReturnType<typeof vi.fn>).mockImplementation(
      async ({ where }: { where: { id: string } }) => {
        if (where.id === failing.id) throw new Error("connection pool timeout");
        return {};
      }
    );

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await checkStuckCallStubs();

    // Обе заготовки дошли до попытки пометки «потерян» — исключение на первой
    // не оборвало цикл до второй и до пуша (найдено ревью 24.09.2026, тот же
    // класс, что уже чинили для ветки recovered выше).
    expect(prisma.interaction.update).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(
      logSystemError.mock.calls.some(
        ([source, message, ctx]) =>
          source === "telephony" &&
          typeof message === "string" &&
          message.includes("не удалось пометить") &&
          ctx?.dedupKey === "stuck-call-mark-lost-failed"
      )
    ).toBe(true);
    // Вторая заготовка отмечена «потерян» как обычно...
    expect(
      logSystemError.mock.calls.some(
        ([source, message]) =>
          source === "telephony" &&
          typeof message === "string" &&
          message.includes("Звонок потерян") &&
          message.includes(String(ok.client.shortId))
      )
    ).toBe(true);
    // ...и пуш руководству ушёл несмотря на отказ записи по первой.
    expect(sendPushToAgents).toHaveBeenCalledTimes(1);
    expect(result).toBe(2);
  });
});
