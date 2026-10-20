import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";

/**
 * «ПОТЕРЯННЫЕ»: ДАТА И ПОРЯДОК ПО МОМЕНТУ ПОТЕРИ (аудит 23.09.2026, №51).
 *
 * Раздел брал дату и порядок из escalatedAt (эскалация по кругу передач), а у
 * клиентов, потерянных после отказа агента или «светофора», его нет: дата была
 * пустой, и такие карточки стояли не на своём месте.
 */

const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");
const { signAccessToken } = await import("../src/auth/jwt.js");

const runId = Date.now();
const tail = String(runId).slice(-7);
const clientIds: string[] = [];
let directorId = "";
let token = "";
const DAY = 86_400_000;

async function lost(suffix: string, data: Record<string, unknown>) {
  const phone = `+9929${suffix}${tail}`;
  await prisma.client.deleteMany({ where: { phone } });
  const c = await prisma.client.create({
    data: { fullName: `Потерянный ${suffix} ${runId}`, phone, source: "PHONE_CALL", kind: "BUYER", status: "LOST", ...data } as never,
  });
  clientIds.push(c.id);
  return c.id;
}

beforeAll(async () => {
  directorId = (
    await prisma.agent.create({ data: { fullName: `Директор потерь ${runId}`, phone: `+99290${tail}`, role: "DIRECTOR", passwordHash: "x" } })
  ).id;
  token = signAccessToken({ sub: directorId, role: "DIRECTOR" });
});

afterAll(async () => {
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: directorId } });
});

describe("Раздел «Потерянные»", () => {
  it("дата — момент потери, свежая потеря выше старой эскалации", async () => {
    const lostAt = new Date(Date.now() - 1000);
    const fresh = await lost("1", { lostAt, escalatedAt: null });
    const old = await lost("2", { lostAt: new Date(Date.now() - 30 * DAY), escalatedAt: new Date(Date.now() - 30 * DAY) });

    const res = await request(app).get("/api/v1/clients/lost?kind=BUYER").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    const items = res.body.items as { id: string; lostAt: string | null }[];
    const iFresh = items.findIndex((i) => i.id === fresh);
    const iOld = items.findIndex((i) => i.id === old);
    expect(iFresh).toBeGreaterThanOrEqual(0);
    expect(new Date(items[iFresh].lostAt!).getTime()).toBe(lostAt.getTime());
    if (iOld >= 0) expect(iFresh).toBeLessThan(iOld);
  });
});
