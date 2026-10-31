import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

/**
 * ConfirmationBroker ИИ-помощника (lib/assistantActions.ts, П2 задача 2.3;
 * тест-план 6.2 в docs/design/internal-assistant-architecture-2026-10-31.md).
 *
 * Что держим: двойное «Подтвердить» и гонка параллельных подтверждений
 * исполняют действие ОДИН раз; устаревший снимок «было» — 409 и новое превью;
 * истёкшее — 410; чужое — 403; откат после изменения сущности — отказ.
 */

const { prisma } = await import("../src/db.js");
const {
  AssistantActionError,
  ASSISTANT_ACTION_TTL_MS,
  ASSISTANT_ACTION_UNDO_WINDOW_MS,
  cancelAssistantAction,
  confirmAssistantAction,
  createPendingAssistantAction,
  undoAssistantAction,
} = await import("../src/lib/assistantActions.js");
const { createTestAgent } = await import("./helpers/ownAgent.js");
const { actorFor, cleanupAssistantActionAgents, makeTestExecutor } = await import("./helpers/assistantActionFixture.js");

const runId = String(Date.now()).slice(-8);
let ownerId = "";
let strangerId = "";
const unregisters: Array<() => void> = [];
let toolSeq = 0;

/** Свой инструмент на каждый тест: реестр общий на процесс, счётчики — нет. */
function freshExecutor(opts: Parameters<typeof makeTestExecutor>[1] = {}) {
  const tool = `test_price_${runId}_${toolSeq++}`;
  const fx = makeTestExecutor(tool, opts);
  unregisters.push(fx.unregister);
  fx.store.set("p1", { price: 450_000 });
  return { tool, ...fx };
}

async function rejection(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (err) {
    return err as InstanceType<typeof AssistantActionError>;
  }
  throw new Error("ожидался отказ, а действие прошло");
}

beforeAll(async () => {
  ownerId = await createTestAgent(`Помощник-хозяин ${runId}`);
  strangerId = await createTestAgent(`Помощник-чужой ${runId}`);
});

afterEach(() => {
  while (unregisters.length) unregisters.pop()!();
});

afterAll(async () => {
  await cleanupAssistantActionAgents([ownerId, strangerId]);
  await prisma.$disconnect();
});

describe("Действия помощника: создание", () => {
  it("кладёт PENDING с превью «было → станет» и ничего не исполняет", async () => {
    const fx = freshExecutor();
    const action = await createPendingAssistantAction(actorFor(ownerId), fx.tool, { key: "p1", price: 420_000 });
    expect(action.status).toBe("PENDING");
    expect(action.preview.was).toEqual({ price: 450_000 });
    expect(action.preview.becomes).toEqual({ price: 420_000 });
    expect(fx.calls.execute).toBe(0);
    expect(fx.store.get("p1")!.price).toBe(450_000);
  });

  it("та же просьба над тем же состоянием — то же действие (идемпотентность)", async () => {
    const fx = freshExecutor();
    const a = await createPendingAssistantAction(actorFor(ownerId), fx.tool, { key: "p1", price: 420_000 });
    const b = await createPendingAssistantAction(actorFor(ownerId), fx.tool, { key: "p1", price: 420_000 });
    const [c, d] = await Promise.all([
      createPendingAssistantAction(actorFor(ownerId), fx.tool, { price: 420_000, key: "p1" }),
      createPendingAssistantAction(actorFor(ownerId), fx.tool, { key: "p1", price: 420_000 }),
    ]);
    expect(new Set([a.id, b.id, c.id, d.id]).size).toBe(1);
  });

  it("без нужного права — 403, строка не создаётся", async () => {
    const fx = freshExecutor({ requires: ["clients.assign"] });
    const err = await rejection(createPendingAssistantAction(actorFor(ownerId), fx.tool, { key: "p1", price: 1 }));
    expect(err.status).toBe(403);
    expect(await prisma.assistantAction.count({ where: { tool: fx.tool } })).toBe(0);
  });

  it("неверные аргументы — 400; неизвестный инструмент — 422", async () => {
    const fx = freshExecutor();
    expect((await rejection(createPendingAssistantAction(actorFor(ownerId), fx.tool, { key: "p1" }))).status).toBe(400);
    expect((await rejection(createPendingAssistantAction(actorFor(ownerId), `nope_${runId}`, {}))).status).toBe(422);
  });
});

describe("Действия помощника: подтверждение", () => {
  it("двойное «Подтвердить» подряд — один запуск, второй отдаёт прежний результат", async () => {
    const fx = freshExecutor();
    const action = await createPendingAssistantAction(actorFor(ownerId), fx.tool, { key: "p1", price: 420_000 });
    const first = await confirmAssistantAction(action.id, actorFor(ownerId));
    const second = await confirmAssistantAction(action.id, actorFor(ownerId));
    expect(fx.calls.execute).toBe(1);
    expect(first.replay).toBe(false);
    expect(first.action.status).toBe("EXECUTED");
    expect(second.replay).toBe(true);
    expect(second.action.result).toEqual(first.action.result);
    expect(fx.store.get("p1")!.price).toBe(420_000);
  });

  it("гонка параллельных подтверждений (Promise.all) — исполняет ровно один", async () => {
    const fx = freshExecutor();
    const action = await createPendingAssistantAction(actorFor(ownerId), fx.tool, { key: "p1", price: 420_000 });
    const settled = await Promise.allSettled(
      Array.from({ length: 6 }, () => confirmAssistantAction(action.id, actorFor(ownerId)))
    );
    expect(fx.calls.execute).toBe(1);
    const fresh = settled.filter((s) => s.status === "fulfilled" && !s.value.replay);
    expect(fresh).toHaveLength(1);
    for (const s of settled) {
      if (s.status === "rejected") {
        expect((s.reason as InstanceType<typeof AssistantActionError>).code).toBe("IN_PROGRESS");
      }
    }
    const row = await prisma.assistantAction.findUniqueOrThrow({ where: { id: action.id } });
    expect(row.status).toBe("EXECUTED");
    expect(row.idempotencyKey).toBeNull();
  });

  it("устаревший снимок «было» — 409 со свежим превью, старое не исполняется ни сейчас, ни повторным нажатием", async () => {
    const fx = freshExecutor();
    const action = await createPendingAssistantAction(actorFor(ownerId), fx.tool, { key: "p1", price: 420_000 });
    fx.store.get("p1")!.price = 470_000; // кто-то поменял цену, пока карточка висела
    const err = await rejection(confirmAssistantAction(action.id, actorFor(ownerId)));
    expect(err.status).toBe(409);
    expect(err.code).toBe("STALE");
    expect(err.extra.stale).toBe(true);
    const freshAction = err.extra.action as { id: string; preview: { was: unknown } };
    expect(freshAction.id).not.toBe(action.id);
    expect(freshAction.preview.was).toEqual({ price: 470_000 });
    expect(fx.calls.execute).toBe(0);

    const again = await rejection(confirmAssistantAction(action.id, actorFor(ownerId)));
    expect(again.status).toBe(409);
    expect(fx.calls.execute).toBe(0);
    expect((await prisma.assistantAction.findUniqueOrThrow({ where: { id: action.id } })).status).toBe("CANCELLED");

    const ok = await confirmAssistantAction(freshAction.id, actorFor(ownerId));
    expect(ok.action.status).toBe("EXECUTED");
    expect(fx.store.get("p1")!.price).toBe(420_000);
  });

  it("истёкшее — 410 и статус EXPIRED", async () => {
    const fx = freshExecutor();
    const action = await createPendingAssistantAction(actorFor(ownerId), fx.tool, { key: "p1", price: 420_000 });
    const later = new Date(Date.now() + ASSISTANT_ACTION_TTL_MS + 1_000);
    const err = await rejection(confirmAssistantAction(action.id, actorFor(ownerId), { now: later }));
    expect(err.status).toBe(410);
    expect(fx.calls.execute).toBe(0);
    const row = await prisma.assistantAction.findUniqueOrThrow({ where: { id: action.id } });
    expect(row.status).toBe("EXPIRED");
    expect(row.idempotencyKey).toBeNull();
  });

  it("чужой agentId — 403 на подтверждение, отмену и откат; действие не тронуто", async () => {
    const fx = freshExecutor();
    const action = await createPendingAssistantAction(actorFor(ownerId), fx.tool, { key: "p1", price: 420_000 });
    expect((await rejection(confirmAssistantAction(action.id, actorFor(strangerId)))).status).toBe(403);
    expect((await rejection(cancelAssistantAction(action.id, actorFor(strangerId)))).status).toBe(403);
    expect((await rejection(undoAssistantAction(action.id, actorFor(strangerId)))).status).toBe(403);
    expect(fx.calls.execute).toBe(0);
    expect((await prisma.assistantAction.findUniqueOrThrow({ where: { id: action.id } })).status).toBe("PENDING");
  });

  it("право отозвано между превью и нажатием — 403, не исполняется", async () => {
    const fx = freshExecutor({ requires: ["clients.assign"] });
    const action = await createPendingAssistantAction(actorFor(ownerId, ["clients.assign"]), fx.tool, {
      key: "p1",
      price: 420_000,
    });
    expect((await rejection(confirmAssistantAction(action.id, actorFor(ownerId)))).status).toBe(403);
    expect(fx.calls.execute).toBe(0);
  });

  it("исполнитель упал — FAILED и 500, ключ освобождён", async () => {
    const fx = freshExecutor({ failWith: new Error("сервис недоступен") });
    const action = await createPendingAssistantAction(actorFor(ownerId), fx.tool, { key: "p1", price: 420_000 });
    const err = await rejection(confirmAssistantAction(action.id, actorFor(ownerId)));
    expect(err.status).toBe(500);
    const row = await prisma.assistantAction.findUniqueOrThrow({ where: { id: action.id } });
    expect(row.status).toBe("FAILED");
    expect(row.idempotencyKey).toBeNull();
  });
});

describe("Действия помощника: отмена и откат", () => {
  it("«Отмена» — CANCELLED, подтвердить после неё нельзя, та же просьба заводит новое действие", async () => {
    const fx = freshExecutor();
    const action = await createPendingAssistantAction(actorFor(ownerId), fx.tool, { key: "p1", price: 420_000 });
    const cancelled = await cancelAssistantAction(action.id, actorFor(ownerId));
    expect(cancelled.action.status).toBe("CANCELLED");
    expect((await cancelAssistantAction(action.id, actorFor(ownerId))).replay).toBe(true);
    expect((await rejection(confirmAssistantAction(action.id, actorFor(ownerId)))).status).toBe(409);
    expect(fx.calls.execute).toBe(0);
    const again = await createPendingAssistantAction(actorFor(ownerId), fx.tool, { key: "p1", price: 420_000 });
    expect(again.id).not.toBe(action.id);
  });

  it("откат возвращает «было»; двойной откат — один запуск", async () => {
    const fx = freshExecutor();
    const action = await createPendingAssistantAction(actorFor(ownerId), fx.tool, { key: "p1", price: 420_000 });
    const done = await confirmAssistantAction(action.id, actorFor(ownerId));
    expect(done.action.undoUntil).not.toBeNull();
    const [a, b] = await Promise.allSettled([
      undoAssistantAction(action.id, actorFor(ownerId)),
      undoAssistantAction(action.id, actorFor(ownerId)),
    ]);
    expect(fx.calls.undo).toBe(1);
    expect([a, b].some((s) => s.status === "fulfilled" && !s.value.replay)).toBe(true);
    expect(fx.store.get("p1")!.price).toBe(450_000);
    const row = await prisma.assistantAction.findUniqueOrThrow({ where: { id: action.id } });
    expect(row.status).toBe("UNDONE");
    expect((await undoAssistantAction(action.id, actorFor(ownerId))).replay).toBe(true);
  });

  it("откат после изменения сущности — отказ 409, чужая правка не затирается", async () => {
    const fx = freshExecutor();
    const action = await createPendingAssistantAction(actorFor(ownerId), fx.tool, { key: "p1", price: 420_000 });
    await confirmAssistantAction(action.id, actorFor(ownerId));
    fx.store.get("p1")!.price = 400_000; // коллега поменял цену после помощника
    const err = await rejection(undoAssistantAction(action.id, actorFor(ownerId)));
    expect(err.status).toBe(409);
    expect(err.code).toBe("UNDO_STALE");
    expect(fx.calls.undo).toBe(0);
    expect(fx.store.get("p1")!.price).toBe(400_000);
    const row = await prisma.assistantAction.findUniqueOrThrow({ where: { id: action.id } });
    expect(row.status).toBe("EXECUTED");
    expect(row.undoClaimedAt).toBeNull();
  });

  it("откат после окна — 410; необратимое — 409; не исполненное — 409", async () => {
    const fx = freshExecutor();
    const action = await createPendingAssistantAction(actorFor(ownerId), fx.tool, { key: "p1", price: 420_000 });
    expect((await rejection(undoAssistantAction(action.id, actorFor(ownerId)))).code).toBe("NOT_EXECUTED");
    await confirmAssistantAction(action.id, actorFor(ownerId));
    const later = new Date(Date.now() + ASSISTANT_ACTION_UNDO_WINDOW_MS + 1_000);
    expect((await rejection(undoAssistantAction(action.id, actorFor(ownerId), { now: later }))).status).toBe(410);

    const fxIrr = freshExecutor({ irreversible: true });
    const irr = await createPendingAssistantAction(actorFor(ownerId), fxIrr.tool, { key: "p1", price: 420_000 });
    const done = await confirmAssistantAction(irr.id, actorFor(ownerId));
    expect(done.action.undoUntil).toBeNull();
    expect((await rejection(undoAssistantAction(irr.id, actorFor(ownerId)))).code).toBe("NOT_UNDOABLE");
    expect(fxIrr.calls.undo).toBe(0);
  });
});
