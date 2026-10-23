import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { signAccessToken } from "../src/auth/jwt.js";
import { reportDateQuerySchema } from "../src/lib/reportPeriod.js";

const run = randomUUID();
const externalFetch = vi.fn(async () => { throw new Error("Unexpected external HTTP in report period validation"); });
let agentId: string;
let token: string;
const get = (path: string) => request(app).get(`/api/v1${path}`).set("Authorization", `Bearer ${token}`);

beforeAll(async () => {
  vi.stubGlobal("fetch", externalFetch);
  const settings = await prisma.settings.findUniqueOrThrow({ where: { id: "singleton" }, select: { metaAdsEnabled: true } });
  expect(settings.metaAdsEnabled).toBe(false);
  agentId = (await prisma.agent.create({ data: { fullName: "Synthetic report calendar", phone: `report-period-${run}`, role: "ADMIN" } })).id;
  token = signAccessToken({ sub: agentId, role: "ADMIN" });
});
afterAll(async () => {
  expect(externalFetch).not.toHaveBeenCalled();
  if (agentId) await prisma.agent.delete({ where: { id: agentId } });
  vi.unstubAllGlobals();
});

describe("report calendar boundaries through real authenticated HTTP and PostgreSQL", () => {
  it.each([
    "month=2026-00", "month=2026-13", "from=2026-02-30&to=2026-03-02",
    "from=2026-02-29&to=2026-03-01", "from=2026-10-20&to=2026-10-01",
  ])("ads report rejects invalid calendar/effective range %s", async (query) => {
    const result = await get(`/ads/report?${query}`);
    expect(result.status).toBe(400); expect(result.body.error).toEqual(expect.any(String));
  });
  it.each(["board", "trend", "leaderboard", "creatives", "reconcile"])("ads %s uses the same invalid-month boundary", async (path) => {
    const result = await get(`/ads/${path}?month=2026-13`);
    expect(result.status).toBe(400); expect(result.body.error).toEqual(expect.any(String));
  });
  for (const path of ["funnel", "agents", "sources"]) {
    it.each([
      "from=2026-02-30&to=2026-03-02", "from=2026-02-29&to=2026-03-01", "from=2026-10-20&to=2026-10-01",
      "from=2026-02-30T10:00:00Z&to=2026-03-02T10:00:00Z",
    ])(`${path} rejects invalid calendar/effective range %s`, async (query) => {
      const result = await get(`/reports/${path}?${query}`);
      expect(result.status).toBe(400); expect(result.body.error).toEqual(expect.any(String));
    });
  }
  it.each([
    ["month=2026-12", "2026-12-01", "2026-12-31"],
    ["month=2024-02", "2024-02-01", "2024-02-29"],
    ["from=2024-02-29&to=2024-02-29", "2024-02-29", "2024-02-29"],
    ["from=2026-12-31&to=2027-01-01", "2026-12-31", "2027-01-01"],
  ])("ads preserves valid selected dates %s", async (query, from, to) => {
    const result = await get(`/ads/report?${query}`);
    expect(result.status).toBe(200); expect(result.body).toMatchObject({ from, to });
  });
  it.each([
    "from=2024-02-29&to=2024-02-29",
    "from=2024-02-29T10:00:00Z&to=2024-02-29T15:00:00Z",
    "from=2024-02-29T15:00:00Z&to=2024-02-29T10:00:00Z",
  ])("ordinary reports preserve same-day Dushanbe expansion and ISO input %s", async (query) => {
    const result = await get(`/reports/funnel?${query}`);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ from: "2024-02-28T19:00:00.000Z", to: "2024-02-29T18:59:59.999Z" });
  });
  it("ordinary reports preserve December-to-January local dates", async () => {
    const result = await get("/reports/funnel?from=2026-12-31&to=2027-01-01");
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ from: "2026-12-30T19:00:00.000Z", to: "2027-01-01T18:59:59.999Z" });
  });
  it("the local input schema preserves Date objects without a year ceiling", () => {
    const at = new Date("1800-01-01T10:00:00.000Z");
    expect(reportDateQuerySchema.parse(at)).toEqual(at);
    expect(reportDateQuerySchema.parse(at.toISOString())).toEqual(at);
  });
  it("preserves the existing maximum range cap", async () => {
    const result = await get("/reports/funnel?from=2000-01-01&to=2026-10-01");
    expect(result.status).toBe(200);
    expect(new Date(result.body.to).getTime() - new Date(result.body.from).getTime()).toBe(60 * 31 * 86_400_000);
  });
  it("default reports and advertising periods remain valid", async () => {
    expect((await get("/reports/funnel")).status).toBe(200);
    expect((await get("/ads/report")).status).toBe(200);
  });
});
