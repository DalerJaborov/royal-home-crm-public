import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { createHash, randomUUID } from "node:crypto";
import { Prisma } from "../src/generated/prisma/client.js";
import { isUiShellEnabled, parseUiShellRollout, uiShellRolloutSchema } from "@royal-home/shared";

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  upsert: vi.fn(),
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
  settings: { findUnique: mocks.findUnique, upsert: mocks.upsert, create: mocks.create, updateMany: mocks.updateMany },
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
const config = { enabled: true, agentIds: ["AGENT"], roles: ["DIRECTOR"] };
const etag = (raw: unknown) => `"legacy-${createHash("sha256").update(JSON.stringify(raw ?? null)).digest("hex")}"`;
const auth = (role: string, raw: unknown = config) => ({ Authorization: `Bearer ${role}`, "If-Match": etag(raw) });

beforeEach(() => {
  vi.clearAllMocks();
  invalidateAgentAccess();
  for (const id of ["DIRECTOR", "ADMIN", "MANAGER", "AGENT", "MARKETING", "EDITOR", "SECURITY"]) revokeElevation(id);
  mocks.findUnique.mockResolvedValue({ uiShellRollout: config });
  mocks.upsert.mockResolvedValue({ uiShellRollout: config });
  mocks.updateMany.mockResolvedValue({ count: 1 });
  mocks.create.mockResolvedValue({});
  mocks.audit.mockResolvedValue({});
  mocks.transaction.mockImplementation(async (fn) => fn({
    settings: { findUnique: mocks.findUnique, updateMany: mocks.updateMany, create: mocks.create },
    agent: { findMany: mocks.findAgents, findUnique: mocks.agent },
    auditLog: { create: mocks.audit },
  }));
  mocks.findAgents.mockResolvedValue([{ id: "AGENT" }]);
  mocks.agent.mockImplementation(async ({ where }: { where: { id: string } }) => ({
    role: where.id, fullName: where.id, isActive: where.id !== "disabled", permissions: null,
    sipExtension: null, mustChangePassword: false,
  }));
});

describe("desktop shell rollout contract", () => {
  it("defaults OFF for absent, legacy or malformed values", () => {
    for (const value of [null, undefined, "clean", {}, { ...config, enabled: "true" }, { ...config, roles: ["OWNER"] }]) {
      expect(parseUiShellRollout(value)).toEqual({ enabled: false, agentIds: [], roles: [] });
      expect(isUiShellEnabled(value, { id: "AGENT", role: "AGENT" })).toBe(false);
    }
  });

  it("allows a selected ID or role, but kill switch always wins", () => {
    expect(isUiShellEnabled(config, { id: "AGENT", role: "AGENT" })).toBe(true);
    expect(isUiShellEnabled(config, { id: "owner", role: "DIRECTOR" })).toBe(true);
    expect(isUiShellEnabled(config, { id: "other", role: "AGENT" })).toBe(false);
    expect(isUiShellEnabled({ ...config, enabled: false }, { id: "AGENT", role: "DIRECTOR" })).toBe(false);
  });

  it("rejects unknown config keys, unknown roles and empty IDs", () => {
    for (const value of [{ ...config, permission: true }, { ...config, roles: ["OWNER"] }, { ...config, agentIds: [" "] }]) {
      expect(uiShellRolloutSchema.safeParse(value).success).toBe(false);
    }
  });

  it("reads versioned storage without allowing version metadata in a PUT configuration", () => {
    const stored = { revision: "9fad0ac6-9d6c-4777-a802-9c8e49fdac33", config };
    expect(parseUiShellRollout(stored)).toEqual(config);
    expect(isUiShellEnabled(stored, { id: "AGENT", role: "AGENT" })).toBe(true);
    expect(uiShellRolloutSchema.safeParse({ ...config, version: stored.revision }).success).toBe(false);
    expect(parseUiShellRollout({ ...stored, revision: "invalid" }).enabled).toBe(false);
  });
});

describe("desktop shell API authorization", () => {
  it("requires authentication", async () => {
    const response = await request(app).get("/api/v1/ui-shell");
    expect(response.status).toBe(401);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect((await request(app).put("/api/v1/ui-shell/config").send(config)).status).toBe(401);
  });

  it("effective endpoint exposes only current actor boolean without config", async () => {
    const allowed = await request(app).get("/api/v1/ui-shell?agentId=DIRECTOR").set("Authorization", "Bearer AGENT");
    expect(allowed.status).toBe(200);
    expect(allowed.body).toEqual({ enabled: true });
    expect(allowed.headers["cache-control"]).toBe("no-store");
    const denied = await request(app).get("/api/v1/ui-shell?agentId=AGENT").set("Authorization", "Bearer MANAGER");
    expect(denied.body).toEqual({ enabled: false });
  });

  it.each(["AGENT", "MANAGER", "MARKETING", "EDITOR", "SECURITY"])("%s cannot read or change rollout configuration", async (role) => {
    grantElevation(role);
    expect((await request(app).get("/api/v1/ui-shell/config").set("Authorization", `Bearer ${role}`)).status).toBe(403);
    expect((await request(app).put("/api/v1/ui-shell/config").set("Authorization", `Bearer ${role}`).send(config)).status).toBe(403);
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("rejects inactive accounts", async () => {
    expect((await request(app).get("/api/v1/ui-shell").set("Authorization", "Bearer disabled")).status).toBe(403);
  });

  it.each(["ADMIN", "DIRECTOR"])("%s requires elevation for writes and audits updates", async (role) => {
    const headers = auth(role);
    expect((await request(app).get("/api/v1/ui-shell/config").set(headers)).status).toBe(200);
    expect((await request(app).put("/api/v1/ui-shell/config").set(headers).send(config)).status).toBe(428);
    grantElevation(role);
    expect((await request(app).put("/api/v1/ui-shell/config").set(headers).send({ ...config, agentIds: ["AGENT", "AGENT"] })).status).toBe(200);
    expect(mocks.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { uiShellRollout: { config, revision: expect.any(String) } } }));
    expect(mocks.audit).toHaveBeenCalledWith({ data: expect.objectContaining({ meta: { uiShellRollout: config, before: config, after: config, version: expect.any(String) } }) });
  });

  it("ADMIN without settings.manage cannot change configuration", async () => {
    mocks.agent.mockResolvedValue({ role: "ADMIN", isActive: true, permissions: { revoked: ["settings.manage"], granted: [] }, sipExtension: null, mustChangePassword: false });
    grantElevation("ADMIN");
    expect((await request(app).put("/api/v1/ui-shell/config").set("Authorization", "Bearer ADMIN").send(config)).status).toBe(403);
  });

  it("a non-administrator granted settings.manage still cannot change rollout", async () => {
    mocks.agent.mockResolvedValue({ role: "AGENT", isActive: true, permissions: { granted: ["settings.manage"], revoked: [] }, sipExtension: null, mustChangePassword: false });
    grantElevation("AGENT");
    expect((await request(app).put("/api/v1/ui-shell/config").set("Authorization", "Bearer AGENT").send(config)).status).toBe(403);
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("invalid writes do not touch persistent settings", async () => {
    grantElevation("DIRECTOR");
    const res = await request(app).put("/api/v1/ui-shell/config").set("Authorization", "Bearer DIRECTOR").send({ ...config, enabled: "yes" });
    expect(res.status).toBe(400);
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("validates deduplicated employee IDs in one query and rejects missing IDs without mutation/audit", async () => {
    grantElevation("DIRECTOR");
    const res = await request(app).put("/api/v1/ui-shell/config").set(auth("DIRECTOR"))
      .send({ ...config, agentIds: ["AGENT", "missing", "AGENT"] });
    expect(res.status).toBe(400);
    expect(res.body.missingAgentIds).toEqual(["missing"]);
    expect(mocks.findAgents).toHaveBeenCalledExactlyOnceWith({ where: { id: { in: ["AGENT", "missing"] }, isActive: true }, select: { id: true } });
    expect(mocks.upsert).not.toHaveBeenCalled();
    expect(mocks.updateMany).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("audits the previous configuration and new deduplicated selection", async () => {
    const previous = { enabled: false, agentIds: [], roles: [] };
    mocks.findUnique.mockResolvedValue({ uiShellRollout: previous });
    grantElevation("DIRECTOR");
    const res = await request(app).put("/api/v1/ui-shell/config").set(auth("DIRECTOR", previous))
      .send({ ...config, roles: ["DIRECTOR", "DIRECTOR"] });
    expect(res.status).toBe(200);
    expect(mocks.audit).toHaveBeenCalledWith({ data: expect.objectContaining({ meta: {
      uiShellRollout: config, before: previous, after: config, version: expect.any(String),
    } }) });
  });

  it("rejects selected employees that are no longer active", async () => {
    mocks.findAgents.mockResolvedValue([]);
    grantElevation("DIRECTOR");
    const res = await request(app).put("/api/v1/ui-shell/config").set(auth("DIRECTOR")).send(config);
    expect(res.status).toBe(400);
    expect(res.body.missingAgentIds).toEqual(["AGENT"]);
    expect(mocks.updateMany).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("allows role-only rollout without an employee lookup and audits absent baseline as OFF", async () => {
    mocks.findUnique.mockResolvedValue(null);
    grantElevation("DIRECTOR");
    const next = { enabled: true, agentIds: [], roles: ["ADMIN"] };
    const res = await request(app).put("/api/v1/ui-shell/config").set(auth("DIRECTOR", null)).send(next);
    expect(res.status).toBe(200);
    expect(mocks.findAgents).not.toHaveBeenCalled();
    expect(mocks.create).toHaveBeenCalledOnce();
    expect(mocks.audit).toHaveBeenCalledWith({ data: expect.objectContaining({ meta: {
      uiShellRollout: next, before: { enabled: false, agentIds: [], roles: [] }, after: next, version: expect.any(String),
    } }) });
  });

  it("returns a stable legacy version and ETag, then the persisted UUID for versioned storage", async () => {
    const first = await request(app).get("/api/v1/ui-shell/config").set(auth("DIRECTOR"));
    const second = await request(app).get("/api/v1/ui-shell/config").set(auth("DIRECTOR"));
    expect(first.body.version).toBe(second.body.version);
    expect(first.headers.etag).toBe(etag(config));
    const revision = "9fad0ac6-9d6c-4777-a802-9c8e49fdac33";
    mocks.findUnique.mockResolvedValue({ uiShellRollout: { revision, config } });
    const versioned = await request(app).get("/api/v1/ui-shell/config").set(auth("DIRECTOR"));
    expect(versioned.body).toEqual({ ...config, version: revision });
    expect(versioned.headers.etag).toBe(`"${revision}"`);
  });

  it("atomically replaces a null JSON field on an existing singleton", async () => {
    mocks.findUnique.mockResolvedValue({ uiShellRollout: null });
    grantElevation("DIRECTOR");
    const res = await request(app).put("/api/v1/ui-shell/config").set(auth("DIRECTOR", null)).send({ ...config, agentIds: [] });
    expect(res.status).toBe(200);
    expect(mocks.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "singleton", uiShellRollout: { equals: Prisma.AnyNull } } }));
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("rejects missing If-Match separately from step-up without starting a transaction", async () => {
    grantElevation("DIRECTOR");
    const res = await request(app).put("/api/v1/ui-shell/config").set("Authorization", "Bearer DIRECTOR").send(config);
    expect(res.status).toBe(428);
    expect(res.body.code).toBe("UI_SHELL_VERSION_REQUIRED");
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it.each(["*", '"stale"', etag(config).slice(1, -1)])("rejects a stale or invalid precondition %s without writes", async (match) => {
    grantElevation("DIRECTOR");
    const res = await request(app).put("/api/v1/ui-shell/config").set({ Authorization: "Bearer DIRECTOR", "If-Match": match }).send(config);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("UI_SHELL_CONFLICT");
    expect(mocks.updateMany).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("returns one success and one conflict when simultaneous writers lose the database CAS", async () => {
    grantElevation("DIRECTOR");
    mocks.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
    const writes = await Promise.all([true, false].map((enabled) => request(app).put("/api/v1/ui-shell/config").set(auth("DIRECTOR")).send({ ...config, enabled })));
    expect(writes.map((res) => res.status).sort()).toEqual([200, 409]);
    expect(mocks.audit).toHaveBeenCalledOnce();
    expect(mocks.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "singleton", uiShellRollout: { equals: config } } }));
    const successful = writes.find((res) => res.status === 200)!;
    expect(successful.body.version).toMatch(/^[0-9a-f-]{36}$/);
    expect(successful.headers.etag).toBe(`"${successful.body.version}"`);
  });

  it("maps a concurrent singleton creation collision to a conflict without audit", async () => {
    mocks.findUnique.mockResolvedValue(null);
    mocks.create.mockRejectedValue(new Prisma.PrismaClientKnownRequestError("duplicate", { code: "P2002", clientVersion: "test" }));
    grantElevation("DIRECTOR");
    const res = await request(app).put("/api/v1/ui-shell/config").set(auth("DIRECTOR", null)).send({ ...config, agentIds: [] });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("UI_SHELL_CONFLICT");
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("does not acknowledge a write when its transactional audit fails", async () => {
    mocks.audit.mockRejectedValueOnce(new Error("audit unavailable"));
    grantElevation("DIRECTOR");
    const res = await request(app).put("/api/v1/ui-shell/config").set(auth("DIRECTOR")).send(config);
    expect(res.status).toBe(500);
    expect(mocks.transaction).toHaveBeenCalledOnce();
  });

  it("does not resurrect a legacy precondition after the configuration returns to the same values", async () => {
    mocks.findUnique.mockResolvedValue({ uiShellRollout: { revision: "9fad0ac6-9d6c-4777-a802-9c8e49fdac33", config } });
    grantElevation("DIRECTOR");
    const res = await request(app).put("/api/v1/ui-shell/config").set(auth("DIRECTOR")).send(config);
    expect(res.status).toBe(409);
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });

  it("real Postgres CAS admits one writer and rolls back configuration when audit fails", async () => {
    const { prisma: real } = await vi.importActual<typeof import("../src/db.js")>("../src/db.js");
    const previous = await real.settings.findUnique({ where: { id: "singleton" }, select: { uiShellRollout: true } });
    const actorId = randomUUID();
    const baseline = { enabled: false, agentIds: [], roles: [] };
    try {
      await real.agent.create({ data: { id: actorId, fullName: "Shell CAS integration", phone: `+cas-${actorId}`, role: "DIRECTOR", passwordHash: "unused-test-auth" } });
      await real.settings.upsert({ where: { id: "singleton" }, create: { id: "singleton", uiShellRollout: baseline }, update: { uiShellRollout: baseline } });
      mocks.agent.mockResolvedValue({ role: "DIRECTOR", isActive: true, permissions: null, sipExtension: null, mustChangePassword: false });
      mocks.findUnique.mockImplementation((args) => real.settings.findUnique(args));
      mocks.transaction.mockImplementation((operation) => real.$transaction(operation));
      grantElevation(actorId);
      // Read the actual ETag: JSONB may reorder keys from the input object.
      const current = await request(app).get("/api/v1/ui-shell/config").set("Authorization", `Bearer ${actorId}`);
      expect(current.status).toBe(200);
      const next = { ...baseline, enabled: true, roles: ["DIRECTOR"] };
      const writes = await Promise.all([next, { ...next, roles: ["ADMIN"] }].map((body) => request(app).put("/api/v1/ui-shell/config").set({ Authorization: `Bearer ${actorId}`, "If-Match": current.headers.etag }).send(body)));
      expect(writes.map((res) => res.status).sort()).toEqual([200, 409]);
      const accepted = writes.find((res) => res.status === 200)!;
      const after = await real.settings.findUniqueOrThrow({ where: { id: "singleton" }, select: { uiShellRollout: true } });
      expect(after.uiShellRollout).toEqual({ revision: accepted.body.version, config: { enabled: accepted.body.enabled, agentIds: accepted.body.agentIds, roles: accepted.body.roles } });
      const audits = await real.auditLog.findMany({ where: { agentId: actorId, action: "SETTINGS_UPDATE", entityType: "Settings" } });
      expect(audits).toHaveLength(1);
      expect(audits[0].meta).toMatchObject({ before: baseline, version: accepted.body.version });
      mocks.transaction.mockImplementation((operation) => real.$transaction((tx) => operation(new Proxy(tx, {
        get(target, prop, receiver) {
          if (prop === "auditLog") return { create: async () => { throw new Error("forced audit failure"); } };
          return Reflect.get(target, prop, receiver);
        },
      }))));
      const failed = await request(app).put("/api/v1/ui-shell/config").set({ Authorization: `Bearer ${actorId}`, "If-Match": `"${accepted.body.version}"` }).send(baseline);
      expect(failed.status).toBe(500);
      const rolledBack = await real.settings.findUniqueOrThrow({ where: { id: "singleton" }, select: { uiShellRollout: true } });
      expect(rolledBack.uiShellRollout).toEqual(after.uiShellRollout);
      expect(await real.auditLog.count({ where: { agentId: actorId, action: "SETTINGS_UPDATE", entityType: "Settings" } })).toBe(1);
    } finally {
      revokeElevation(actorId);
      invalidateAgentAccess(actorId);
      await real.auditLog.deleteMany({ where: { agentId: actorId } });
      await real.agent.deleteMany({ where: { id: actorId } });
      if (previous) await real.settings.update({ where: { id: "singleton" }, data: { uiShellRollout: previous.uiShellRollout == null ? Prisma.DbNull : previous.uiShellRollout as Prisma.InputJsonValue } });
      else await real.settings.deleteMany({ where: { id: "singleton" } });
      await real.$disconnect();
    }
  });

  it("absent, corrupted config and kill switch all return OFF", async () => {
    for (const value of [null, { unexpected: true }, { ...config, enabled: false }]) {
      mocks.findUnique.mockResolvedValue(value === null ? null : { uiShellRollout: value });
      expect((await request(app).get("/api/v1/ui-shell").set("Authorization", "Bearer AGENT")).body).toEqual({ enabled: false });
    }
  });
});
