import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { signAccessToken } from "../src/auth/jwt.js";
import { clearDirectorDashboardCache } from "../src/lib/directorDashboard.js";

/**
 * «Свой клиент» (28.11.2026): новый источник сохраняется, виден в блоке «Откуда
 * приходят» и в фильтре; старые источники (в т.ч. «Пришёл в офис») считаются как раньше.
 * Свой давний день 20.03.2012 — другие тесты на него ничего не заводят.
 */
const runId = Date.now();
const sfx = String(runId).slice(-6);
const DAY = "2012-03-20";
const at = new Date(`${DAY}T07:00:00.000Z`);
const ids = { agents: [] as string[], clients: [] as string[] };
let director = "";
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const q = (extra = "") => `preset=custom&from=${DAY}&to=${DAY}${extra}`;

beforeAll(async () => {
  const d = await prisma.agent.create({ data: { fullName: `Директор свой ${runId}`, phone: `+99293${sfx}1`, role: "DIRECTOR", passwordHash: "x" } });
  ids.agents.push(d.id);
  director = signAccessToken({ sub: d.id, role: "DIRECTOR" });
  const mk = async (n: number, source: string) => {
    const c = await prisma.client.create({ data: { fullName: `Источник ${n} ${runId}`, phone: `+99291${n}${sfx}`, source, createdAt: at } as never });
    ids.clients.push(c.id);
  };
  await mk(1, "OWN_CLIENT");
  await mk(2, "OWN_CLIENT");
  await mk(3, "WALK_IN");
  await mk(4, "WHATSAPP");
  clearDirectorDashboardCache();
});

afterAll(async () => {
  await prisma.client.deleteMany({ where: { id: { in: ids.clients } } });
  await prisma.agent.deleteMany({ where: { id: { in: ids.agents } } });
  await prisma.$disconnect();
});

describe("источник «Свой клиент»", () => {
  it("сохраняется в базе и виден в строках «по источнику»", async () => {
    const res = await request(app).get(`/api/v1/reports/director?${q()}`).set(auth(director));
    expect(res.status).toBe(200);
    const by = (s: string) => res.body.sources.find((r: { source: string }) => r.source === s);
    expect(by("OWN_CLIENT")).toMatchObject({ leads: 2, label: "Свой клиент" });
    // старые значения считаются как раньше, «Пришёл в офис» не перезаписан
    expect(by("WALK_IN")).toMatchObject({ leads: 1, label: "Пришёл в офис" });
    expect(by("WHATSAPP")).toMatchObject({ leads: 1 });
  });

  it("фильтр по источнику принимает OWN_CLIENT и отсекает остальные", async () => {
    const res = await request(app).get(`/api/v1/reports/director?${q("&source=OWN_CLIENT")}`).set(auth(director));
    expect(res.status).toBe(200);
    expect(res.body.kpis.find((k: { key: string }) => k.key === "newLeads").value).toBe(2);
  });

  it("клиент создаётся с источником OWN_CLIENT через API", async () => {
    const res = await request(app).post("/api/v1/clients").set(auth(director)).send({ fullName: `Свой через API ${runId}`, phone: `+99292${sfx}7`, source: "OWN_CLIENT", kind: "BUYER" });
    expect(res.status).toBeLessThan(300);
    const id = res.body.id ?? res.body.client?.id;
    expect(id).toBeTruthy();
    ids.clients.push(id);
    const saved = await prisma.client.findUnique({ where: { id }, select: { source: true } });
    expect(saved?.source).toBe("OWN_CLIENT");
  });
});
