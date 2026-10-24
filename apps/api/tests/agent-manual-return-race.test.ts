import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";

const effects = vi.hoisted(() => ({
  sms: vi.fn(async () => ({ ok: false as const, error: "Synthetic no-provider SMS failure" })),
  push: vi.fn(async () => 0), batch: vi.fn(async () => 0), queue: vi.fn(async () => undefined),
}));
vi.mock("../src/lib/sms/index.js", async (importOriginal) => ({ ...await importOriginal<typeof import("../src/lib/sms/index.js")>(), sendSms: effects.sms }));
vi.mock("../src/push.js", async (importOriginal) => ({ ...await importOriginal<typeof import("../src/push.js")>(), sendPushToAgent: effects.push, sendPushToAgents: effects.batch }));
vi.mock("../src/lib/telephony/operatorQueue.js", async (importOriginal) => ({ ...await importOriginal<typeof import("../src/lib/telephony/operatorQueue.js")>(), syncAgentQueuePresence: effects.queue }));

import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { waitFor } from "./helpers/waitFor.js";

const DAY = 86400000;
const subjects: string[] = [], clients: string[] = [];
const auditReads: PromiseLike<unknown>[] = [], auditWrites: PromiseLike<unknown>[] = [];
const noExternal = vi.fn(async () => { throw new Error("No external fetch in manual-return regression"); });
vi.stubGlobal("fetch", noExternal);
let actorId: string, token: string;
let afterTargetRead: ((id: string) => Promise<void>) | undefined;

beforeAll(async () => {
  expect(process.env.NODE_ENV).toBe("test");
  vi.stubEnv("LOGIN_CODE_DEV_ECHO", "1");
  const id = randomUUID(), phone = `test-${randomUUID().slice(0, 20)}`;
  await prisma.agent.create({ data: { id, fullName: "Synthetic manual-return director", phone, passwordHash: "test-unused", role: "DIRECTOR" } });
  actorId = id;
  const login = await request(app).post("/api/v1/auth/login/code").send({ phone, channel: "sms" });
  expect(login.status).toBe(200);
  expect(login.body.devCode).toMatch(/^\d{6}$/);
  const issued = await prisma.loginSmsCode.findFirstOrThrow({ where: { agentId: id }, orderBy: { createdAt: "desc" } });
  expect(issued.consumedAt).toBeNull();
  expect(issued.codeHash).not.toBe(login.body.devCode);
  const verified = await request(app).post("/api/v1/auth/login/verify-code").send({ pendingToken: login.body.pendingToken, code: login.body.devCode });
  expect(verified.status).toBe(200);
  token = verified.body.accessToken;
  expect((await prisma.loginSmsCode.findUniqueOrThrow({ where: { id: issued.id } })).consumedAt).not.toBeNull();
  const fresh = await request(app).get("/api/v1/auth/step-up").set("Authorization", `Bearer ${token}`);
  expect(fresh.status).toBe(200);
  expect(fresh.body.elevated).toBe(true);
  await waitFor(() => prisma.loginLog.count({ where: { agentId: id } }));
});

beforeEach(() => {
  effects.queue.mockClear();
  const findUnique = prisma.agent.findUnique.bind(prisma.agent);
  vi.spyOn(prisma.agent, "findUnique").mockImplementation((args) => {
    const query = findUnique(args);
    if (args.where.id === actorId && args.select?.fullName === true && Object.keys(args.select).length === 1) auditReads.push(query);
    if (!subjects.includes(String(args.where.id)) || args.select?.frozenAt !== true || !afterTargetRead) return query;
    return query.then(async row => { await afterTargetRead?.(String(args.where.id)); return row; }) as typeof query;
  });
  const createAudit = prisma.auditLog.create.bind(prisma.auditLog);
  vi.spyOn(prisma.auditLog, "create").mockImplementation((args) => {
    const query = createAudit(args);
    if (args.data.agentId === actorId && subjects.includes(String(args.data.entityId))) auditWrites.push(query);
    return query;
  });
});

async function flushOwnAudit() {
  // logAudit chains its real create after the real author lookup's catch/then.
  // Drain those queued continuations, then await the captured database writes.
  await Promise.all(auditReads);
  await Promise.resolve();
  await Promise.resolve();
  await Promise.all(auditWrites);
}
afterEach(async () => {
  await flushOwnAudit();
  vi.restoreAllMocks();
  await prisma.stageEvent.deleteMany({ where: { entityType: "CLIENT", entityId: { in: clients } } });
  await prisma.client.deleteMany({ where: { id: { in: clients } } });
  await prisma.auditLog.deleteMany({ where: { agentId: actorId, entityId: { in: subjects } } });
  await prisma.agent.deleteMany({ where: { id: { in: subjects } } });
  subjects.length = 0; clients.length = 0; auditReads.length = 0; auditWrites.length = 0; afterTargetRead = undefined;
  expect(noExternal).not.toHaveBeenCalled();
});
afterAll(async () => {
  if (actorId) {
    await prisma.loginSmsCode.deleteMany({ where: { agentId: actorId } });
    await prisma.session.deleteMany({ where: { agentId: actorId } });
    await prisma.loginLog.deleteMany({ where: { agentId: actorId } });
    await prisma.auditLog.deleteMany({ where: { agentId: actorId } });
    await prisma.agent.delete({ where: { id: actorId } });
  }
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function fixture() {
  const id = randomUUID(), frozenAt = new Date(Date.now() - 8 * DAY), inactiveSince = new Date(frozenAt.getTime() - 6 * DAY);
  const agent = await prisma.agent.create({ data: { id, fullName: "Synthetic manual-return subject", phone: `test-return-${id}`, passwordHash: "test-unused", role: "AGENT", frozenAt, frozenReason: "Synthetic absence", absenceKind: "VACATION" } });
  subjects.push(id);
  const cid = randomUUID();
  const client = await prisma.client.create({ data: { id: cid, fullName: "Synthetic manual-return client", phone: `test-return-client-${cid}`, source: "PHONE_CALL", kind: "BUYER", assignedAgentId: id, workStatus: "INACTIVE", inactiveSince } });
  clients.push(cid);
  await waitFor(() => prisma.stageEvent.count({ where: { entityType: "CLIENT", entityId: cid } }));
  return { agent, client };
}
function unfreeze(id: string) { return request(app).post(`/api/v1/agents/${id}/unfreeze`).set("Authorization", `Bearer ${token}`).send({}); }
function shiftedOnce(since: Date, frozenAt: Date, actual: Date | null, began: number, ended: number) {
  return actual !== null && actual.getTime() >= since.getTime() + began - frozenAt.getTime() - 2
    && actual.getTime() <= since.getTime() + ended - frozenAt.getTime() + 2;
}

it("single manual return shifts the absence once and a sequential repeat is 409", async () => {
  const { agent, client } = await fixture();
  const began = Date.now();
  expect((await unfreeze(agent.id)).status).toBe(200);
  const ended = Date.now(), first = await prisma.client.findUniqueOrThrow({ where: { id: client.id } });
  expect(shiftedOnce(client.inactiveSince!, agent.frozenAt!, first.inactiveSince, began, ended)).toBe(true);
  expect((await unfreeze(agent.id)).status).toBe(409);
  expect((await prisma.client.findUniqueOrThrow({ where: { id: client.id } })).inactiveSince).toEqual(first.inactiveSince);
  await flushOwnAudit();
  expect(auditWrites).toHaveLength(1);
  expect(await prisma.auditLog.count({ where: { agentId: actorId, entityId: agent.id, action: "AGENT_UNFREEZE" } })).toBe(1);
  expect(effects.queue).toHaveBeenCalledExactlyOnceWith(agent.id);
});

it("two actual preflight reads permit only one return and one clock shift", async () => {
  const { agent, client } = await fixture();
  let selected = 0, release!: () => void;
  const both = new Promise<void>(resolve => { release = resolve; });
  afterTargetRead = async () => { selected++; if (selected === 2) release(); await both; };
  const began = Date.now(), responses = await Promise.all([unfreeze(agent.id), unfreeze(agent.id)]), ended = Date.now();
  const stored = await prisma.client.findUniqueOrThrow({ where: { id: client.id } });
  await flushOwnAudit();
  expect({ selected, statuses: responses.map(response => response.status).sort(),
    shiftedOnce: shiftedOnce(client.inactiveSince!, agent.frozenAt!, stored.inactiveSince, began, ended),
    ownAudits: auditWrites.length,
    storedAudits: await prisma.auditLog.count({ where: { agentId: actorId, entityId: agent.id, action: "AGENT_UNFREEZE" } }),
    queueSyncs: effects.queue.mock.calls.length,
  }).toEqual({ selected: 2, statuses: [200, 409], shiftedOnce: true, ownAudits: 1, storedAudits: 1, queueSyncs: 1 });
});

it("a committed replacement absence after the read survives the stale manual return", async () => {
  const { agent, client } = await fixture();
  const frozenAt = new Date(Date.now() - DAY), absenceUntil = new Date(Date.now() + 7 * DAY);
  afterTargetRead = async () => {
    afterTargetRead = undefined;
    await prisma.agent.update({ where: { id: agent.id }, data: { frozenAt, absenceUntil, frozenReason: "Synthetic replacement", absenceKind: "SICK" } });
  };
  const response = await unfreeze(agent.id);
  const stored = await prisma.agent.findUniqueOrThrow({ where: { id: agent.id } });
  expect(response.status).toBe(409);
  expect(stored).toMatchObject({ frozenAt, absenceUntil, frozenReason: "Synthetic replacement", absenceKind: "SICK" });
  expect((await prisma.client.findUniqueOrThrow({ where: { id: client.id } })).inactiveSince).toEqual(client.inactiveSince);
  await flushOwnAudit();
  expect(auditWrites).toHaveLength(0);
  expect(await prisma.auditLog.count({ where: { agentId: actorId, entityId: agent.id, action: "AGENT_UNFREEZE" } })).toBe(0);
  expect(effects.queue).not.toHaveBeenCalled();
});
