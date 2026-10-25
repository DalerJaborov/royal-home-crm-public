import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
const state = vi.hoisted(() => ({ role: "AGENT", broad: true, findMany: vi.fn(), count: vi.fn(), property: vi.fn(), privateLessons: vi.fn(), deletedLessons: vi.fn() }));
vi.mock("../src/db.js", () => ({ prisma: {
  $disconnect: vi.fn(), auditLog: { findMany: (args: any) => args.select?.entityId ? state.deletedLessons(args) : state.findMany(args), count: state.count },
  botLesson: { findMany: state.privateLessons },
  property: { findUnique: state.property, findMany: vi.fn().mockResolvedValue([]) },
} }));
vi.mock("../src/auth/middleware.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/auth/middleware.js")>()),
  requireAuth: (req: any, _res: any, next: () => void) => { req.agent = { id: "staff", role: state.role }; next(); },
  can: (_req: unknown, permission: string) => permission === "auditLog.view" ? state.broad : true,
}));
vi.mock("../src/lib/ownerContact.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/ownerContact.js")>()), stripOwnerContact: () => ({ ownerContactHidden: false }),
}));
vi.mock("../src/lib/propertyChanges.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/propertyChanges.js")>()), hideOwnerContactInChanges: (v: unknown) => v,
}));
vi.mock("../src/lib/clientPhone.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/clientPhone.js")>()), maskPhonesDeep: (v: unknown) => v,
}));
import { auditLogRouter } from "../src/routes/auditLog.js";
import { visibleAuditWhere } from "../src/lib/investigationAudit.js";
const app = express(); app.use("/audit", auditLogRouter);

describe("audit privacy before pagination", () => {
  beforeEach(() => {
    vi.clearAllMocks(); state.role = "AGENT"; state.broad = true;
    state.findMany.mockResolvedValue([]); state.count.mockResolvedValue(0);
    state.privateLessons.mockResolvedValue([]); state.deletedLessons.mockResolvedValue([]);
    state.property.mockResolvedValue({ assignedAgentId: "staff" });
  });
  it("does not allow broad audit permission to disclose investigation rows/counts", async () => {
    expect((await request(app).get("/audit")).status).toBe(200);
    expect(state.findMany.mock.calls[0][0].where).toEqual(visibleAuditWhere("AGENT"));
    expect(state.count.mock.calls[0][0].where).toEqual(visibleAuditWhere("AGENT"));
  });
  it("keeps the private boundary inside the own-property history exception", async () => {
    state.broad = false;
    expect((await request(app).get("/audit?entityType=Property&entityId=property")).status).toBe(200);
    expect(state.findMany.mock.calls[0][0].where).toMatchObject({ ...visibleAuditWhere("AGENT"), entityType: "Property", entityId: "property" });
  });
  it("strips historical investigation metadata without hiding ordinary refusal history", async () => {
    state.findMany.mockResolvedValue([{ entityType: "Client", meta: { reason: "EXPENSIVE", securityReview: true, securityNote: "private" } }]);
    const response = await request(app).get("/audit");
    expect(response.body.items[0].meta).toEqual({ reason: "EXPENSIVE" });
  });
  it("keeps complete audit evidence for a director", async () => {
    state.role = "DIRECTOR";
    state.findMany.mockResolvedValue([{ entityType: "Client", meta: { securityReview: true } }]);
    const response = await request(app).get("/audit");
    expect(state.findMany.mock.calls[0][0].where).toEqual({});
    expect(response.body.items[0].meta.securityReview).toBe(true);
  });
  it("filters quarantined and previously deleted audit lesson history before count and page", async () => {
    state.privateLessons.mockResolvedValue([{ id: "quarantined" }]);
    state.deletedLessons.mockResolvedValue([{ entityId: "deleted-private" }]);
    const response = await request(app).get("/audit");
    expect(response.status).toBe(200);
    const expected = visibleAuditWhere("AGENT", ["quarantined", "deleted-private"]);
    expect(state.findMany.mock.calls[0][0].where).toEqual(expected);
    expect(state.count.mock.calls[0][0].where).toEqual(expected);
  });
});
