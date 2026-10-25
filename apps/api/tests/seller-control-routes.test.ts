import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
const state = vi.hoisted(() => ({ role: "AGENT", securityReview: true, read: vi.fn(), list: vi.fn(), episode: vi.fn(), update: vi.fn(), start: vi.fn(), command: vi.fn(), transaction: vi.fn(), lock: vi.fn(), audit: vi.fn() }));
vi.mock("../src/db.js", async importOriginal => ({ ...await importOriginal<typeof import("../src/db.js")>(), prisma: { $disconnect: vi.fn(), $transaction: state.transaction,
  settings: { findUnique: state.read, update: state.update }, sellerControlEpisode: { findMany: state.list, findUnique: state.episode } } }));
vi.mock("../src/auth/middleware.js", async importOriginal => ({ ...(await importOriginal<typeof import("../src/auth/middleware.js")>()),
  requireAuth: (req: any, _res: unknown, next: () => void) => { req.agent = { id: "actor", role: state.role,
    permissions: new Set(state.securityReview ? ["clients.securityReview"] : []) }; next(); },
  requirePermission: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("../src/lib/sellerControlEpisodes.js", async importOriginal => ({ ...(await importOriginal<typeof import("../src/lib/sellerControlEpisodes.js")>()),
  startSellerControl: state.start, commandSellerControl: state.command,
}));
import { sellerControlRouter } from "../src/routes/sellerControl.js";
const app = express(); app.use(express.json()); app.use("/control", sellerControlRouter);
describe("seller control private API", () => {
  beforeEach(() => { vi.clearAllMocks(); vi.unstubAllEnvs(); state.securityReview = true; state.read.mockResolvedValue({ sellerControlConfig: {} }); state.list.mockResolvedValue([]); state.update.mockResolvedValue({}); state.episode.mockResolvedValue({ executionMode: "PREVIEW" }); state.command.mockResolvedValue({ ok: true });
    state.transaction.mockImplementation(fn => fn({ $executeRaw: state.lock, settings: { findUnique: state.read, update: state.update }, auditLog: { create: state.audit } }));
  });
  it("revoked ADMIN cannot read, configure or command private control", async () => {
    state.role = "ADMIN"; state.securityReview = false;
    expect((await request(app).get("/control")).status).toBe(403);
    expect((await request(app).put("/control/config").send({ config: {} })).status).toBe(403);
    expect((await request(app).post("/control/00000000-0000-4000-8000-000000000001/commands").send({ requestKey: "00000000-0000-4000-8000-000000000002", revision: 1, action: "RESOLVE", note: "Decision" })).status).toBe(403);
    expect(state.read).not.toHaveBeenCalled(); expect(state.command).not.toHaveBeenCalled(); expect(state.update).not.toHaveBeenCalled();
  });
  it.each(["AGENT", "MANAGER", "SECURITY", "OPERATOR"])("%s cannot access private episodes even with a granted permission", async role => {
    state.role = role;
    expect((await request(app).get("/control")).status).toBe(403);
    expect((await request(app).put("/control/config").send({ config: {} })).status).toBe(403);
    expect(state.read).not.toHaveBeenCalled(); expect(state.update).not.toHaveBeenCalled();
    expect((await request(app).post("/control/00000000-0000-4000-8000-000000000001/commands").send({ requestKey: "00000000-0000-4000-8000-000000000002", revision: 1, action: "RESOLVE", note: "Decision" })).status).toBe(403);
    expect(state.command).not.toHaveBeenCalled();
  });
  it("server mode cannot be forged; preview decisions are distinct from gated real closure", async () => {
    state.role = "ADMIN";
    const path = "/control/00000000-0000-4000-8000-000000000001/commands";
    const body = { requestKey: "00000000-0000-4000-8000-000000000002", revision: 1, action: "RESOLVE", note: "Control completed" };
    expect((await request(app).post(path).send({ ...body, simulated: false, executionMode: "LIVE" })).status).toBe(400);
    expect((await request(app).post(path).send(body)).status).toBe(200);
    expect(state.command.mock.calls[0][3]).toEqual({ simulated: true });
    state.episode.mockResolvedValue({ executionMode: "LIVE" }); state.command.mockClear();
    expect((await request(app).post(path).send(body)).status).toBe(409);
    expect(state.command).not.toHaveBeenCalled();
    vi.stubEnv("SELLER_CONTROL_INTERNAL_LIVE", "explicitly-approved");
    expect((await request(app).post(path).send({ ...body, action: "RECEIPT" })).status).toBe(409);
    expect(state.command).not.toHaveBeenCalled();
    expect((await request(app).post(path).send(body)).status).toBe(200);
    expect(state.command.mock.calls[0][3]).toEqual({ simulated: false });
    vi.unstubAllEnvs();
  });
  it.each(["ADMIN", "DIRECTOR"])("%s sees honest unconfigured state and cannot activate through config", async role => {
    state.role = role;
    expect((await request(app).get("/control")).body).toMatchObject({ configurationState: "NOT_CONFIGURED", mode: "PREVIEW" });
    expect((await request(app).put("/control/config").send({ config: { agentDueWorkingDays: 1, ropReceiptDueWorkingDays: 2, ropActionDueWorkingDays: 3, executionMode: "LIVE" } })).status).toBe(400);
    expect(state.update).not.toHaveBeenCalled();
    expect((await request(app).put("/control/config").send({ config: {} })).status).toBe(200);
    expect(state.transaction).toHaveBeenCalledTimes(1); expect(state.lock).toHaveBeenCalledTimes(1);
    expect(state.update).toHaveBeenCalledWith({ where: { id: "singleton" }, data: { sellerControlConfig: {} } });
    expect(state.audit).not.toHaveBeenCalled();
  });
});
