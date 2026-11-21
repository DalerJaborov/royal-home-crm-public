import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { ROLES as ALL_ROLES, UI_SHELL_FOR_EVERYONE, uiShellEffectiveSchema } from "@royal-home/shared";

/**
 * НОВЫЙ ИНТЕРФЕЙС И «НОВЫЙ ВИД» — ВСЕМ (владелец 21.11.2026: «включи просто новый
 * интерфейс для всех и всё»). Рубильника по сотрудникам и ролям больше нет:
 * GET /ui-shell отвечает одинаково любой роли, а настройки (`/ui-shell/config`)
 * убраны вместе с блоком в Настройках. Сохранённый когда-то в базе рубильник
 * (даже выключенный) ответ не меняет — поле больше не читается.
 */
const mocks = vi.hoisted(() => ({ findUnique: vi.fn(), agent: vi.fn() }));
vi.mock("../src/db.js", () => ({ prisma: {
  $disconnect: vi.fn().mockResolvedValue(undefined),
  settings: { findUnique: mocks.findUnique },
  agent: { findUnique: mocks.agent, update: vi.fn().mockResolvedValue({}) },
} }));
vi.mock("../src/auth/jwt.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/auth/jwt.js")>(),
  verifyAccessToken: (token: string) => ({ sub: token, role: token }),
}));

import { uiShellRouter } from "../src/routes/uiShell.js";
import { invalidateAgentAccess } from "../src/auth/middleware.js";

const app = express();
app.use(express.json());
app.use("/api/v1/ui-shell", uiShellRouter);

const ROLES = [...ALL_ROLES];

beforeEach(() => {
  vi.clearAllMocks();
  invalidateAgentAccess();
  // Старый выключенный рубильник в базе: ответ от него больше не зависит.
  mocks.findUnique.mockResolvedValue({ uiShellRollout: { enabled: false, agentIds: [], roles: [] } });
  mocks.agent.mockImplementation(async ({ where }: { where: { id: string } }) => ({
    role: where.id, fullName: where.id, isActive: true, permissions: null, sipExtension: null, mustChangePassword: false,
  }));
});

describe("новый интерфейс для всех", () => {
  it("одна точка решения: включено и «Новый вид»", () => {
    expect(UI_SHELL_FOR_EVERYONE).toEqual({ enabled: true, look: "royal" });
    expect(uiShellEffectiveSchema.parse(UI_SHELL_FOR_EVERYONE)).toEqual(UI_SHELL_FOR_EVERYONE);
  });

  it.each(ROLES)("GET /ui-shell — %s получает новый интерфейс и новый вид, без чтения базы", async (role) => {
    const res = await request(app).get("/api/v1/ui-shell").set("Authorization", `Bearer ${role}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ enabled: true, look: "royal" });
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(mocks.findUnique).not.toHaveBeenCalled();
  });

  it("без входа — 401", async () => {
    expect((await request(app).get("/api/v1/ui-shell")).status).toBe(401);
  });

  it("настроек рубильника больше нет: /config не отвечает ни на чтение, ни на запись", async () => {
    const auth = { Authorization: "Bearer DIRECTOR" };
    expect((await request(app).get("/api/v1/ui-shell/config").set(auth)).status).toBe(404);
    expect((await request(app).put("/api/v1/ui-shell/config").set(auth).send({ enabled: false, agentIds: [], roles: [] })).status).toBe(404);
  });
});
