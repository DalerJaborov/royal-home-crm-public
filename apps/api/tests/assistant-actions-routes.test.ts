import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";

/**
 * Маршруты «Подтвердить / Отмена / Отменить» действий помощника
 * (routes/ai.ts → lib/assistantActions.ts). Логику брокера держит
 * assistant-actions-broker.test.ts; здесь — граница HTTP: Zod на :id, рубильник
 * помощника, вход, перевод ошибок брокера в коды и актор из req.agent.
 *
 * Рубильник подменяется, а не включается в Settings: Settings одна на базу, и
 * соседние файлы тестов читают её параллельно.
 */

let assistantEnabled = true;
vi.mock("../src/ai/assistant.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/assistant.js")>()),
  isAiAssistantEnabled: async () => assistantEnabled,
}));

const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");
const { signAccessToken } = await import("../src/auth/jwt.js");
const { createPendingAssistantAction } = await import("../src/lib/assistantActions.js");
const { createTestAgent } = await import("./helpers/ownAgent.js");
const { actorFor, cleanupAssistantActionAgents, makeTestExecutor } = await import("./helpers/assistantActionFixture.js");

const runId = String(Date.now()).slice(-8);
const tool = `route_price_${runId}`;
let ownerId = "";
let strangerId = "";
let ownerToken = "";
let strangerToken = "";
let fx: ReturnType<typeof makeTestExecutor>;

const post = (path: string, token: string) =>
  request(app).post(`/api/v1/ai/assistant/actions/${path}`).set("Authorization", `Bearer ${token}`);

const pending = () => createPendingAssistantAction(actorFor(ownerId), tool, { key: "p1", price: 420_000 });

beforeAll(async () => {
  ownerId = await createTestAgent(`Маршрут-хозяин ${runId}`);
  strangerId = await createTestAgent(`Маршрут-чужой ${runId}`);
  ownerToken = signAccessToken({ sub: ownerId, role: "AGENT" });
  strangerToken = signAccessToken({ sub: strangerId, role: "AGENT" });
  fx = makeTestExecutor(tool);
});

afterEach(() => {
  assistantEnabled = true;
  fx.store.set("p1", { price: 450_000 });
});

afterAll(async () => {
  fx.unregister();
  await cleanupAssistantActionAgents([ownerId, strangerId]);
  await prisma.$disconnect();
});

describe("POST /ai/assistant/actions/:id/*", () => {
  it("без входа — 401", async () => {
    const res = await request(app).post(`/api/v1/ai/assistant/actions/${crypto.randomUUID()}/confirm`);
    expect(res.status).toBe(401);
  });

  it(":id не uuid — 400, помощник выключен — 403, нет такого — 404", async () => {
    fx.store.set("p1", { price: 450_000 });
    expect((await post("not-a-uuid/confirm", ownerToken)).status).toBe(400);
    expect((await post(`${crypto.randomUUID()}/confirm`, ownerToken)).status).toBe(404);
    const action = await pending();
    assistantEnabled = false;
    const off = await post(`${action.id}/confirm`, ownerToken);
    expect(off.status).toBe(403);
    expect(fx.calls.execute).toBe(0);
  });

  it("подтверждение исполняет, повтор отдаёт прежний результат; чужому — 403", async () => {
    fx.store.set("p1", { price: 450_000 });
    const action = await pending();
    const foreign = await post(`${action.id}/confirm`, strangerToken);
    expect(foreign.status).toBe(403);
    expect(foreign.body.code).toBe("FORBIDDEN");

    const before = fx.calls.execute;
    const ok = await post(`${action.id}/confirm`, ownerToken);
    expect(ok.status).toBe(200);
    expect(ok.body.replay).toBe(false);
    expect(ok.body.action.status).toBe("EXECUTED");
    const again = await post(`${action.id}/confirm`, ownerToken);
    expect(again.status).toBe(200);
    expect(again.body.replay).toBe(true);
    expect(fx.calls.execute - before).toBe(1);

    const undo = await post(`${action.id}/undo`, ownerToken);
    expect(undo.status).toBe(200);
    expect(undo.body.action.status).toBe("UNDONE");
    expect(fx.store.get("p1")!.price).toBe(450_000);
  });

  it("устаревший снимок — 409 {stale: true} с новым действием; отмена — 200", async () => {
    fx.store.set("p1", { price: 450_000 });
    const action = await pending();
    fx.store.set("p1", { price: 470_000 });
    const stale = await post(`${action.id}/confirm`, ownerToken);
    expect(stale.status).toBe(409);
    expect(stale.body.stale).toBe(true);
    expect(stale.body.action.preview.was).toEqual({ price: 470_000 });

    const cancel = await post(`${stale.body.action.id}/cancel`, ownerToken);
    expect(cancel.status).toBe(200);
    expect(cancel.body.action.status).toBe("CANCELLED");
  });
});
