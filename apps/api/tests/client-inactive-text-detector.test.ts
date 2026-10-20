import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const callAiText = vi.fn();
vi.mock("../src/ai/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/client.js")>()),
  callAiText }));

const { prisma } = await import("../src/db.js");
const { checkClientInactiveSignal } = await import("../src/lib/clientInactiveTextDetector.js");
const { dushanbeWallClock } = await import("../src/lib/dushanbeTime.js");

/**
 * Раздел B плана 19-plan-03-09-evening.md: финальная реплика уже принятого
 * клиента в переписке проверяется ИИ на признаки одной из 8 причин Неактивности
 * либо на конкретную дату/час связи. Модель для сравнения — тесты
 * ai/callAnalysis.ts (call-analysis-auto-inactive.test.ts), тот же приём: мокаем
 * callAiText, проверяем три границы (причина сработала / не сработала / выдумана),
 * плюс то, что специфично для текстового детектора — взаимоисключающая ветка
 * даты и гейт «след работы» (canDeactivateWithReason).
 */

const runId = Date.now();

/**
 * ДАТА СВЯЗИ — ВСЕГДА ОТ СЕГОДНЯ, НИКОГДА ХАРДКОДОМ.
 *
 * parseScheduledContactAt отбрасывает всё, что раньше «час назад» (см.
 * lib/clientInactiveTextDetector.ts), поэтому зашитая в мок календарная дата
 * работает ровно до того дня, когда она наступит, а потом файл краснеет каждый
 * прогон и выглядит поломкой кода. Считаем от текущего дня по стенным часам
 * Душанбе — в том же формате «YYYY-MM-DDTHH:MM», в каком дату возвращает модель.
 */
function scheduledInDays(days: number, time: string): string {
  const wall = dushanbeWallClock(new Date(Date.now() + days * 86_400_000));
  return `${wall.toISOString().slice(0, 10)}T${time}`;
}
let n = 0;
let agentId = "";
const clientIds: string[] = [];

async function makeClient(overrides: Record<string, unknown> = {}) {
  const c = await prisma.client.create({
    data: {
      fullName: `Клиент переписки ${runId}-${n}`,
      phone: `+992970${runId}${n++}`,
      source: "WHATSAPP",
      kind: "BUYER",
      assignedAgentId: agentId,
      workStatus: "ACTIVE",
      // По факту к моменту, когда детектор реально вызывается в проде, сообщение
      // клиента уже сохранено и lib/clientMessageAlert.ts успел проставить эту
      // отметку (см. вызов notifyAgentOfClientMessage раньше в processMessengerTurn) —
      // без неё countContactTrace посчитает ноль попыток и гейт не пропустит НИЧЕГО,
      // даже открытую причину. Воспроизводим то же условие здесь.
      lastClientMessageAt: new Date(),
      ...overrides,
    },
  });
  clientIds.push(c.id);
  return c;
}

beforeEach(() => {
  callAiText.mockReset();
});

afterAll(async () => {
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.$disconnect();
});

async function ensureAgent() {
  if (agentId) return;
  const agent = await prisma.agent.create({
    data: { fullName: `Агент переписки ${runId}`, phone: `+992971${runId}`, role: "AGENT", passwordHash: "x" },
  });
  agentId = agent.id;
}

describe("checkClientInactiveSignal — причина без даты", () => {
  it("уверенная причина из списка переводит клиента в Неактивные", async () => {
    await ensureAgent();
    const client = await makeClient();
    callAiText.mockResolvedValueOnce({ reason: "THINKING", confidence: 0.9 });

    await checkClientInactiveSignal(client.id, "Спасибо, мне надо подумать ещё немного");

    const after = await prisma.client.findUnique({
      where: { id: client.id },
      select: { workStatus: true, inactiveReasonKey: true },
    });
    expect(after?.workStatus).toBe("INACTIVE");
    expect(after?.inactiveReasonKey).toBe("THINKING");

    const note = await prisma.interaction.findFirst({
      where: { clientId: client.id, type: "SYSTEM", notes: { contains: "Неактивные" } },
    });
    expect(note?.notes).toContain("Клиент");
  });

  it("причины нет — клиент остаётся активным, ИИ вызван", async () => {
    await ensureAgent();
    const client = await makeClient();
    callAiText.mockResolvedValueOnce({});

    await checkClientInactiveSignal(client.id, "А фото объекта ещё актуальны?");

    expect(callAiText).toHaveBeenCalledTimes(1);
    const after = await prisma.client.findUnique({ where: { id: client.id }, select: { workStatus: true } });
    expect(after?.workStatus).toBe("ACTIVE");
  });

  it("выдуманный код причины игнорируется", async () => {
    await ensureAgent();
    const client = await makeClient();
    callAiText.mockResolvedValueOnce({ reason: "CLIENT_IS_BUSY_TODAY", confidence: 0.95 });

    await checkClientInactiveSignal(client.id, "Не сейчас, занят немного");

    const after = await prisma.client.findUnique({ where: { id: client.id }, select: { workStatus: true } });
    expect(after?.workStatus).toBe("ACTIVE");
  });

  it("низкая уверенность — не переводит", async () => {
    await ensureAgent();
    const client = await makeClient();
    callAiText.mockResolvedValueOnce({ reason: "NO_MONEY_YET", confidence: 0.4 });

    await checkClientInactiveSignal(client.id, "Пока не знаю с деньгами");

    const after = await prisma.client.findUnique({ where: { id: client.id }, select: { workStatus: true } });
    expect(after?.workStatus).toBe("ACTIVE");
  });

  it("STOPPED_RESPONDING и OTHER не входят в допустимый набор — enum их не пропустит", async () => {
    await ensureAgent();
    const client = await makeClient();
    // Модель теоретически может ошибиться и вернуть значение вне енама схемы —
    // .includes() на TEXT_INACTIVE_REASONS отсеет и такое.
    callAiText.mockResolvedValueOnce({ reason: "STOPPED_RESPONDING", confidence: 0.99 });

    await checkClientInactiveSignal(client.id, "Ладно проехали");

    const after = await prisma.client.findUnique({ where: { id: client.id }, select: { workStatus: true } });
    expect(after?.workStatus).toBe("ACTIVE");
  });

  it("гейт «след работы» не пропустил (нет ни одной попытки) — тихий отказ, не падает", async () => {
    await ensureAgent();
    // lastClientMessageAt НЕ ставим — ноль попыток по countContactTrace.
    const client = await makeClient({ lastClientMessageAt: null });
    callAiText.mockResolvedValueOnce({ reason: "THINKING", confidence: 0.9 });

    await expect(checkClientInactiveSignal(client.id, "Подумаю ещё")).resolves.toBeUndefined();

    const after = await prisma.client.findUnique({ where: { id: client.id }, select: { workStatus: true } });
    expect(after?.workStatus).toBe("ACTIVE");
  });
});

describe("checkClientInactiveSignal — конкретная дата связи", () => {
  it("дата без причины: клиент остаётся ACTIVE, заводится задача-напоминание", async () => {
    await ensureAgent();
    const client = await makeClient();
    const soon = scheduledInDays(2, "20:00");
    callAiText.mockResolvedValueOnce({ scheduledContactAt: soon });

    await checkClientInactiveSignal(client.id, "Буду послезавтра в 20:00, тогда и поговорим");

    const after = await prisma.client.findUnique({ where: { id: client.id }, select: { workStatus: true } });
    expect(after?.workStatus).toBe("ACTIVE");

    const task = await prisma.interaction.findFirst({
      where: { clientId: client.id, type: "SYSTEM", notes: { contains: "назначил дату связи" } },
    });
    expect(task?.nextAction).toBe("Связаться с клиентом");
    expect(task?.nextActionDate?.toISOString()).toContain(soon.slice(0, 10));
  });

  it("дата ПОБЕЖДАЕТ причину, если модель по ошибке вернула оба поля разом", async () => {
    await ensureAgent();
    const client = await makeClient();
    callAiText.mockResolvedValueOnce({
      reason: "ASKED_LATER",
      confidence: 0.95,
      scheduledContactAt: scheduledInDays(7, "12:00"),
    });

    await checkClientInactiveSignal(client.id, "Через неделю буду в городе, тогда и обсудим");

    // Ключевая проверка: клиент НЕ ушёл в Неактивные, хотя reason был валиден и уверен.
    const after = await prisma.client.findUnique({ where: { id: client.id }, select: { workStatus: true } });
    expect(after?.workStatus).toBe("ACTIVE");
    const task = await prisma.interaction.findFirst({
      where: { clientId: client.id, type: "SYSTEM", notes: { contains: "назначил дату связи" } },
    });
    expect(task).toBeTruthy();
  });

  it("дата в прошлом (модель ошиблась) — не заводит задачу", async () => {
    await ensureAgent();
    const client = await makeClient();
    callAiText.mockResolvedValueOnce({ scheduledContactAt: "2020-01-01T12:00" });

    await checkClientInactiveSignal(client.id, "Как-нибудь потом");

    const task = await prisma.interaction.findFirst({
      where: { clientId: client.id, type: "SYSTEM", notes: { contains: "назначил дату связи" } },
    });
    expect(task).toBeNull();
  });

  it("повтор одного и того же хода не плодит вторую задачу (дедуп)", async () => {
    await ensureAgent();
    const client = await makeClient();
    callAiText.mockResolvedValue({ scheduledContactAt: scheduledInDays(4, "18:00") });

    await checkClientInactiveSignal(client.id, "Давайте через четыре дня в 18:00");
    await checkClientInactiveSignal(client.id, "Давайте через четыре дня в 18:00");

    const tasks = await prisma.interaction.count({
      where: { clientId: client.id, type: "SYSTEM", notes: { contains: "назначил дату связи" } },
    });
    expect(tasks).toBe(1);
  });
});

describe("checkClientInactiveSignal — дешёвые фильтры до вызова ИИ", () => {
  it("клиент без назначенного агента — ИИ не вызывается", async () => {
    const client = await prisma.client.create({
      data: {
        fullName: `Клиент без агента ${runId}-${n++}`,
        phone: `+992972${runId}${n}`,
        source: "WHATSAPP",
        kind: "BUYER",
        workStatus: "ACTIVE",
        lastClientMessageAt: new Date(),
      },
    });
    clientIds.push(client.id);

    await checkClientInactiveSignal(client.id, "Мне надо подумать ещё");
    expect(callAiText).not.toHaveBeenCalled();
  });

  it("клиент уже Неактивен — ИИ не вызывается", async () => {
    await ensureAgent();
    const client = await makeClient({ workStatus: "INACTIVE" });

    await checkClientInactiveSignal(client.id, "Мне надо подумать ещё");
    expect(callAiText).not.toHaveBeenCalled();
  });

  it("голая реакция-эмодзи — ИИ не вызывается", async () => {
    await ensureAgent();
    const client = await makeClient();

    await checkClientInactiveSignal(client.id, "👍");
    expect(callAiText).not.toHaveBeenCalled();
  });
});
