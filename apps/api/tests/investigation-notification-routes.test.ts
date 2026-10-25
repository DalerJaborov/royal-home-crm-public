import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

const state = vi.hoisted(() => ({
  role: "AGENT", findMany: vi.fn(), count: vi.fn(), updateMany: vi.fn(),
}));
vi.mock("../src/db.js", () => ({ prisma: { $disconnect: vi.fn(), notification: {
  findMany: state.findMany, count: state.count, updateMany: state.updateMany,
} } }));
vi.mock("../src/auth/middleware.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/auth/middleware.js")>()),
  requireAuth: (req: any, _res: any, next: () => void) => {
    req.agent = { id: "staff", role: state.role, permissions: new Set(["clients.securityReview", "reports.view", "clients.assign"]) };
    next();
  },
  can: () => true,
}));
vi.mock("../src/lib/clientPhone.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/clientPhone.js")>()), maskPhonesInText: (s: string) => s,
}));
import { notificationsRouter } from "../src/routes/notifications.js";
import { visibleNotificationsWhere } from "../src/lib/investigationNotifications.js";

const app = express();
app.use(express.json());
app.use("/notifications", notificationsRouter);

describe("notification history privacy includes counters and mutations", () => {
  beforeEach(() => {
    state.role = "AGENT";
    vi.clearAllMocks();
    state.findMany.mockResolvedValue([]);
    state.count.mockResolvedValue(0);
    state.updateMany.mockResolvedValue({ count: 0 });
  });

  it.each(["AGENT", "SECURITY", "HEAD_OF_SALES"])("restricts every listing and counter for %s despite permissions", async (role) => {
    state.role = role;
    const result = await request(app).get("/notifications");
    expect(result.status).toBe(200);
    const boundary = visibleNotificationsWhere("staff", role);
    for (const [query] of [...state.findMany.mock.calls, ...state.count.mock.calls]) {
      expect(query.where).toMatchObject(boundary);
    }
    expect(state.count).toHaveBeenCalledTimes(4);
  });

  it("rechecks the current role on a subsequent request", async () => {
    state.role = "DIRECTOR";
    await request(app).get("/notifications");
    expect(state.findMany.mock.calls[0][0].where).toEqual({ agentId: "staff" });
    state.role = "AGENT";
    vi.clearAllMocks();
    await request(app).get("/notifications");
    expect(state.findMany.mock.calls[0][0].where).toEqual(visibleNotificationsWhere("staff", "AGENT"));
  });

  it("does not reveal a private notification by direct read id", async () => {
    const result = await request(app).post("/notifications/123e4567-e89b-42d3-a456-426614174000/read");
    expect(result.status).toBe(404);
    expect(state.updateMany.mock.calls[0][0].where).toMatchObject(visibleNotificationsWhere("staff", "AGENT"));
  });

  it("read-all and read-many preserve hidden investigation history", async () => {
    await request(app).post("/notifications/read-all");
    await request(app).post("/notifications/read-many").send({ ids: ["123e4567-e89b-42d3-a456-426614174000"] });
    for (const [query] of state.updateMany.mock.calls) expect(query.where).toMatchObject(visibleNotificationsWhere("staff", "AGENT"));
  });
});
