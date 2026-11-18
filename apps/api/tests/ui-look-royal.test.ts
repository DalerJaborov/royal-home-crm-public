import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { createHash } from "node:crypto";
import { parseUiShellRollout, uiLookFor, uiShellEffectiveSchema, uiShellRolloutSchema } from "@royal-home/shared";

/**
 * «Новый вид» (облик royal) — поверх чистой оболочки, поимённо.
 * Закрыто по умолчанию: признак получает только сотрудник из списка, и только
 * пока для него включена чистая оболочка. Чужой ответ не меняется ни на байт.
 */
const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  create: vi.fn(),
  updateMany: vi.fn(),
  transaction: vi.fn(),
  agent: vi.fn(),
  findAgents: vi.fn(),
  audit: vi.fn(),
}));
vi.mock("../src/db.js", () => ({ prisma: {
  $disconnect: vi.fn().mockResolvedValue(undefined),
  $transaction: mocks.transaction,
  settings: { findUnique: mocks.findUnique, create: mocks.create, updateMany: mocks.updateMany },
  agent: { findUnique: mocks.agent, findMany: mocks.findAgents, update: vi.fn().mockResolvedValue({}) },
  auditLog: { create: mocks.audit },
} }));
vi.mock("../src/auth/jwt.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/auth/jwt.js")>(),
  verifyAccessToken: (token: string) => ({ sub: token, role: "DIRECTOR" }),
}));

import { uiShellRouter } from "../src/routes/uiShell.js";
import { invalidateAgentAccess } from "../src/auth/middleware.js";
import { grantElevation, revokeElevation } from "../src/lib/stepUp.js";

const app = express();
app.use(express.json());
app.use("/api/v1/ui-shell", uiShellRouter);
app.use((_error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => { res.status(500).json({ error: "TEST_INTERNAL" }); });

// Clean shell for the whole ADMIN/DIRECTOR role, «Новый вид» only for the account OWNER.
const withLook = { enabled: true, agentIds: [], roles: ["ADMIN", "DIRECTOR"], royalLookAgentIds: ["OWNER"] };
const etag = (raw: unknown) => `"legacy-${createHash("sha256").update(JSON.stringify(raw ?? null)).digest("hex")}"`;
const roleOf: Record<string, string> = { OWNER: "ADMIN", OTHER_ADMIN: "ADMIN", DIRECTOR: "DIRECTOR", AGENT: "AGENT", MANAGER: "MANAGER" };

beforeEach(() => {
  vi.clearAllMocks();
  invalidateAgentAccess();
  for (const id of Object.keys(roleOf)) revokeElevation(id);
  mocks.findUnique.mockResolvedValue({ uiShellRollout: withLook });
  mocks.updateMany.mockResolvedValue({ count: 1 });
  mocks.create.mockResolvedValue({});
  mocks.audit.mockResolvedValue({});
  mocks.transaction.mockImplementation(async (fn) => fn({
    settings: { findUnique: mocks.findUnique, updateMany: mocks.updateMany, create: mocks.create },
    agent: { findMany: mocks.findAgents, findUnique: mocks.agent },
    auditLog: { create: mocks.audit },
  }));
  mocks.findAgents.mockImplementation(async ({ where }: { where: { id: { in: string[] } } }) =>
    where.id.in.filter((id) => id in roleOf).map((id) => ({ id })));
  mocks.agent.mockImplementation(async ({ where }: { where: { id: string } }) => ({
    role: roleOf[where.id] ?? "AGENT", fullName: where.id, isActive: true, permissions: null,
    sipExtension: null, mustChangePassword: false,
  }));
});

const effective = (who: string) => request(app).get("/api/v1/ui-shell").set("Authorization", `Bearer ${who}`);

describe("royal look rule", () => {
  it("is off by default: absent list, empty list, corrupted values", () => {
    for (const value of [null, undefined, {}, { enabled: true, agentIds: ["OWNER"], roles: [] },
      { enabled: true, agentIds: ["OWNER"], roles: [], royalLookAgentIds: [] },
      { enabled: true, agentIds: ["OWNER"], roles: [], royalLookAgentIds: "OWNER" }]) {
      expect(uiLookFor(value, { id: "OWNER", role: "ADMIN" })).toBeUndefined();
    }
  });

  it("needs both the clean shell and a personal entry; the kill switch wins", () => {
    expect(uiLookFor(withLook, { id: "OWNER", role: "ADMIN" })).toBe("royal");
    expect(uiLookFor(withLook, { id: "OTHER_ADMIN", role: "ADMIN" })).toBeUndefined();
    // Listed, but clean shell not granted to this person: no look either.
    expect(uiLookFor({ ...withLook, roles: [] }, { id: "OWNER", role: "ADMIN" })).toBeUndefined();
    expect(uiLookFor({ ...withLook, enabled: false }, { id: "OWNER", role: "ADMIN" })).toBeUndefined();
  });

  it("keeps old configurations readable and rejects malformed lists", () => {
    const old = { enabled: true, agentIds: ["A"], roles: [] };
    expect(parseUiShellRollout(old)).toEqual(old);
    expect(uiShellRolloutSchema.safeParse({ ...old, royalLookAgentIds: [" "] }).success).toBe(false);
    expect(uiShellEffectiveSchema.safeParse({ enabled: true, look: "dark" }).success).toBe(false);
  });
});

describe("GET /ui-shell look flag", () => {
  it("is sent only to the listed employee", async () => {
    expect((await effective("OWNER")).body).toEqual({ enabled: true, look: "royal" });
    // Another administrator with the same clean shell gets the old, unchanged answer.
    expect((await effective("OTHER_ADMIN")).body).toEqual({ enabled: true });
    expect((await effective("DIRECTOR")).body).toEqual({ enabled: true });
    expect((await effective("AGENT")).body).toEqual({ enabled: false });
  });

  it("disappears with the kill switch and with an absent configuration", async () => {
    mocks.findUnique.mockResolvedValue({ uiShellRollout: { ...withLook, enabled: false } });
    expect((await effective("OWNER")).body).toEqual({ enabled: false });
    mocks.findUnique.mockResolvedValue(null);
    expect((await effective("OWNER")).body).toEqual({ enabled: false });
  });

  it("never leaks the list to anyone", async () => {
    const body = (await effective("OWNER")).body;
    expect(body).not.toHaveProperty("royalLookAgentIds");
    expect(uiShellEffectiveSchema.safeParse(body).success).toBe(true);
  });
});

describe("PUT /ui-shell/config royal list", () => {
  it("stores a deduplicated list and validates the employees", async () => {
    grantElevation("OWNER");
    const res = await request(app).put("/api/v1/ui-shell/config")
      .set({ Authorization: "Bearer OWNER", "If-Match": etag(withLook) })
      .send({ ...withLook, royalLookAgentIds: ["OWNER", "OWNER", "DIRECTOR"] });
    expect(res.status).toBe(200);
    expect(res.body.royalLookAgentIds).toEqual(["OWNER", "DIRECTOR"]);
    // OWNER is already stored; only the newly added DIRECTOR is looked up.
    expect(mocks.findAgents).toHaveBeenCalledWith({ where: { id: { in: ["DIRECTOR"] }, isActive: true }, select: { id: true } });
  });

  it("rejects an unknown employee in the royal list without writing", async () => {
    grantElevation("OWNER");
    const res = await request(app).put("/api/v1/ui-shell/config")
      .set({ Authorization: "Bearer OWNER", "If-Match": etag(withLook) })
      .send({ ...withLook, royalLookAgentIds: ["missing"] });
    expect(res.status).toBe(400);
    expect(res.body.missingAgentIds).toEqual(["missing"]);
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });

  it("an older client without the field does not erase the stored list", async () => {
    grantElevation("OWNER");
    const { royalLookAgentIds: _omit, ...legacyBody } = withLook;
    const res = await request(app).put("/api/v1/ui-shell/config")
      .set({ Authorization: "Bearer OWNER", "If-Match": etag(withLook) })
      .send(legacyBody);
    expect(res.status).toBe(200);
    expect(mocks.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: { uiShellRollout: { revision: expect.any(String), config: { ...legacyBody, royalLookAgentIds: ["OWNER"] } } },
    }));
  });

  it("an explicit empty list switches the look off and is NOT stored (safe code rollback)", async () => {
    grantElevation("OWNER");
    const res = await request(app).put("/api/v1/ui-shell/config")
      .set({ Authorization: "Bearer OWNER", "If-Match": etag(withLook) })
      .send({ ...withLook, royalLookAgentIds: [] });
    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty("royalLookAgentIds");
    const stored = mocks.updateMany.mock.calls[0][0].data.uiShellRollout.config;
    expect(stored).not.toHaveProperty("royalLookAgentIds");
    // Exactly the shape the previous strict schema accepted.
    const { royalLookAgentIds: _omit, ...previousShape } = withLook;
    expect(stored).toEqual(previousShape);
  });

  it("a later-disabled employee already in the list does not block saving", async () => {
    mocks.findUnique.mockResolvedValue({ uiShellRollout: { ...withLook, royalLookAgentIds: ["OWNER", "gone"] } });
    grantElevation("OWNER");
    const res = await request(app).put("/api/v1/ui-shell/config")
      .set({ Authorization: "Bearer OWNER", "If-Match": etag({ ...withLook, royalLookAgentIds: ["OWNER", "gone"] }) })
      .send({ ...withLook, royalLookAgentIds: ["OWNER", "gone", "DIRECTOR"] });
    expect(res.status).toBe(200);
    // Only the newly added person is checked.
    expect(mocks.findAgents).toHaveBeenCalledWith({ where: { id: { in: ["DIRECTOR"] }, isActive: true }, select: { id: true } });
  });

  it("the emergency OFF is never blocked by unknown employees", async () => {
    mocks.findUnique.mockResolvedValue({ uiShellRollout: { ...withLook, agentIds: ["gone"] } });
    grantElevation("OWNER");
    const res = await request(app).put("/api/v1/ui-shell/config")
      .set({ Authorization: "Bearer OWNER", "If-Match": etag({ ...withLook, agentIds: ["gone"] }) })
      .send({ ...withLook, agentIds: ["gone"], royalLookAgentIds: ["OWNER", "missing"], enabled: false });
    expect(res.status).toBe(200);
    expect(mocks.findAgents).not.toHaveBeenCalled();
  });

  it("only administrators can change it (same gate as the shell list)", async () => {
    grantElevation("AGENT");
    const res = await request(app).put("/api/v1/ui-shell/config")
      .set({ Authorization: "Bearer AGENT", "If-Match": etag(withLook) })
      .send({ ...withLook, royalLookAgentIds: ["AGENT"] });
    expect(res.status).toBe(403);
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });
});
