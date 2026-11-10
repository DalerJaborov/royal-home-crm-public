/**
 * БЫВШИЕ СОТРУДНИКИ НЕ ВИДНЫ КАК ЖИВЫЕ ЛЮДИ (владелец 11.11.2026:
 * «Мы бы не хотели видеть бывших сотрудников вообще… Да давай всех скрой»).
 *
 * Правило — packages/shared/src/formerStaff.ts: любой СПИСОК сотрудников по
 * умолчанию без isActive=false; директор (agents.manage) просит бывших
 * параметром includeFormer=1, у остальных флаг игнорируется. Данные не стираются.
 *
 * Второй блок — сторож исходников: новый «рейтинговый» список
 * (`role: { in: [...RATED_ROLES] }`) без `isActive` не проходит.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { grantElevation } from "../src/lib/stepUp.js";
import { loadWeeklyLeaderboard } from "../src/lib/leaderboard.js";
import { dushanbeStartOfToday } from "../src/lib/dushanbeTime.js";
import { deleteAgentsWithTraces } from "./helpers/cleanupAgents.js";

const tag = String(Date.now()).slice(-7);
const password = "testpass123";
const ids: string[] = [];
let adminToken = "";
let managerToken = "";
let currentId = "";
let formerId = "";

async function login(phone: string) {
  const res = await request(app).post("/api/v1/auth/login").send({ phone, password });
  expect(res.status).toBe(200);
  const agent = await prisma.agent.findUnique({ where: { phone }, select: { id: true } });
  if (agent) grantElevation(agent.id);
  return res.body.accessToken as string;
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  const make = (fullName: string, phone: string, role: "ADMIN" | "MANAGER" | "AGENT", isActive = true) =>
    prisma.agent.create({ data: { fullName, phone, role, passwordHash, isActive } });
  const admin = await make(`Бывшие Директор ${tag}`, `+99293${tag}1`, "ADMIN");
  const manager = await make(`Бывшие Менеджер ${tag}`, `+99293${tag}2`, "MANAGER");
  const current = await make(`Бывшие Работает ${tag}`, `+99293${tag}3`, "AGENT");
  // Как после «удаления» на проде: отключён, телефон переименован.
  const former = await make(`Бывшие Уволен ${tag}`, `x-deleted:+99293${tag}4`, "AGENT", false);
  ids.push(admin.id, manager.id, current.id, former.id);
  currentId = current.id;
  formerId = former.id;
  adminToken = await login(admin.phone);
  managerToken = await login(manager.phone);
});

afterAll(async () => {
  await deleteAgentsWithTraces(ids);
});

const listIds = (body: unknown) => (body as Array<{ id: string }>).map((a) => a.id);

describe("справочник сотрудников GET /agents", () => {
  it("по умолчанию бывшего нет, работающий есть", async () => {
    for (const token of [adminToken, managerToken]) {
      const res = await request(app).get("/api/v1/agents").set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(listIds(res.body)).toContain(currentId);
      expect(listIds(res.body)).not.toContain(formerId);
    }
  });

  it("директор видит бывших по просьбе includeFormer=1", async () => {
    const res = await request(app).get("/api/v1/agents?includeFormer=1").set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(listIds(res.body)).toContain(formerId);
  });

  it("без права agents.manage флаг игнорируется", async () => {
    const res = await request(app).get("/api/v1/agents?includeFormer=1").set("Authorization", `Bearer ${managerToken}`);
    expect(res.status).toBe(200);
    expect(listIds(res.body)).not.toContain(formerId);
  });
});

describe("«Команда» GET /team и /team/stages", () => {
  it("по умолчанию бывшего нет", async () => {
    const res = await request(app).get("/api/v1/team").set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(listIds(res.body)).toContain(currentId);
    expect(listIds(res.body)).not.toContain(formerId);
  });

  it("директору — по просьбе, менеджеру — нет", async () => {
    const admin = await request(app).get("/api/v1/team?includeFormer=1").set("Authorization", `Bearer ${adminToken}`);
    expect(listIds(admin.body)).toContain(formerId);
    const manager = await request(app).get("/api/v1/team?includeFormer=1").set("Authorization", `Bearer ${managerToken}`);
    expect(manager.status).toBe(200);
    expect(listIds(manager.body)).not.toContain(formerId);
  });

  it("этапы команды без бывших", async () => {
    const res = await request(app).get("/api/v1/team/stages").set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain(formerId);
  });
});

describe("рейтинг недели", () => {
  it("бывший с баллами в рейтинг не попадает", async () => {
    const date = dushanbeStartOfToday();
    await prisma.kpiDailyScore.createMany({
      data: [
        { agentId: currentId, date, score: 5 },
        { agentId: formerId, date, score: 99 },
      ],
    });
    const board = await loadWeeklyLeaderboard();
    expect(board.map((r) => r.id)).toContain(currentId);
    expect(board.map((r) => r.id)).not.toContain(formerId);
  });
});

describe("сторож исходников: рейтинговые списки только с isActive", () => {
  it("каждый agent.findMany по RATED_ROLES фильтрует isActive", () => {
    const root = path.resolve(__dirname, "../src");
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (name === "generated" || name === "node_modules") continue;
        if (statSync(full).isDirectory()) walk(full);
        else if (full.endsWith(".ts")) files.push(full);
      }
    };
    walk(root);
    // Исключения — с причиной. royalScore: «место в компании» — только число в
    // кабинете агента (без имён), тест royal-score-cabinet держит его смысл.
    const allowed = new Set(["lib/royalScore.ts"]);
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
      for (const m of text.matchAll(/\.agent\.findMany\(\{([\s\S]{0,500}?)\bselect\s*:/g)) {
        const head = m[1];
        const rel = path.relative(root, file).split(path.sep).join("/");
        if (/RATED_ROLES/.test(head) && !/isActive/.test(head) && !allowed.has(rel)) {
          offenders.push(`${path.relative(root, file)}:${text.slice(0, m.index).split("\n").length}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
