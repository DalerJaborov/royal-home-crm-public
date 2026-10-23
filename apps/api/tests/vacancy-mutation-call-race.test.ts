import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { signAccessToken } from "../src/auth/jwt.js";
import { waitFor } from "./helpers/waitFor.js";

const marker = `synthetic-vacancy-race-${randomUUID()}`;
const positionKey = `race-${randomUUID()}`;
const applicationIds: string[] = [];
let actorId: string;
let token: string;

beforeAll(async () => {
  const actor = await prisma.agent.create({ data: {
    fullName: marker, phone: marker, passwordHash: "synthetic-unused", role: "ADMIN",
  } });
  actorId = actor.id;
  token = signAccessToken({ sub: actor.id, role: actor.role });
  await prisma.recruitmentPosition.create({ data: {
    key: positionKey, titleRu: "Тестовая вакансия", titleTg: "Вазифаи санҷишӣ", isOpen: true,
  } });
});

afterAll(async () => {
  await prisma.recruitmentCommunication.deleteMany({ where: { jobApplicationId: { in: applicationIds } } });
  await prisma.jobApplication.deleteMany({ where: { id: { in: applicationIds } } });
  await prisma.recruitmentPosition.deleteMany({ where: { key: positionKey } });
  await prisma.agent.deleteMany({ where: { id: actorId } });
});

/** A real transaction models a dispatch claim, without calling any provider.
 * The HTTP mutation must wait for its application lock before checking calls.
 * pg_stat_activity proves the request reached the contested database lock;
 * there is no timing sleep or assumption about how fast Express responds. */
it.each(["setStatus", "assignPosition", "bulkDelete", "singleDelete"] as const)(
  "%s rechecks the call after a concurrent dispatch claim commits", async (action) => {
    const application = await prisma.jobApplication.create({ data: {
      channel: "MANUAL", name: marker, status: "NEW",
    } });
    applicationIds.push(application.id);
    const communication = await prisma.recruitmentCommunication.create({ data: {
      id: randomUUID(), previewId: randomUUID(), jobApplicationId: application.id,
      actorId, purpose: "INVITE", channel: "ASSISTANT_CALL", status: "QUEUED",
      previewHash: "synthetic", snapshotJson: {}, expiresAt: new Date(Date.now() + 60_000),
    } });

    let locked!: () => void;
    let release!: () => void;
    const hasLock = new Promise<void>((resolve) => { locked = resolve; });
    const canCommit = new Promise<void>((resolve) => { release = resolve; });
    let holderPid = 0;
    const claim = prisma.$transaction(async (tx) => {
      const [session] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
      holderPid = session.pid;
      await tx.$queryRaw`SELECT "id" FROM "JobApplication" WHERE "id"=${application.id} FOR UPDATE`;
      await tx.recruitmentCommunication.update({ where: { id: communication.id }, data: { status: "IN_FLIGHT" } });
      locked();
      await canCommit;
    }, { timeout: 15_000 });

    await hasLock;
    const mutation = action === "singleDelete"
      ? request(app).delete(`/api/v1/vacancies/${application.id}`)
      : request(app).post("/api/v1/vacancies/bulk").send({
        ids: [application.id],
        action: action === "bulkDelete" ? "delete" : action,
        ...(action === "setStatus" ? { status: "REJECTED" } : {}),
        ...(action === "assignPosition" ? { positionKey } : {}),
      });
    const response = mutation.set("Authorization", `Bearer ${token}`).then((result) => result);
    try {
      await waitFor(async () => {
        const rows = await prisma.$queryRaw<Array<{ waiting: boolean }>>`
          SELECT EXISTS (
            SELECT 1 FROM pg_stat_activity
            WHERE datname=current_database() AND pid<>pg_backend_pid()
              AND ${holderPid} = ANY(pg_blocking_pids(pid))
          ) AS waiting`;
        return rows[0].waiting;
      }, { timeoutMs: 5000, label: "HTTP mutation waiting for the dispatch transaction" });
    } finally {
      release();
      await claim;
    }
    const result = await response;
    if (action === "singleDelete") expect(result.status).toBe(409);
    else {
      expect(result.status).toBe(200);
      expect(result.body).toMatchObject({ updated: 0, skipped: [{ id: application.id, reason: "calling" }] });
    }
    expect(await prisma.jobApplication.findUnique({ where: { id: application.id } })).toMatchObject({
      status: "NEW", hrPositionKey: null,
    });
    expect(await prisma.recruitmentCommunication.findUnique({ where: { id: communication.id } })).toMatchObject({ status: "IN_FLIGHT" });
  }
);
