import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

/**
 * Threads OAuth (23.09.2026) — routes/threads.ts.
 *
 * State — общий с TikTok (lib/oauthState.ts, вынесено 23.09.2026 из
 * routes/tiktok.ts ровно ради второго канала с той же схемой). Здесь не
 * повторяем те же тесты подписи (они уже есть в tests/tiktok-oauth.test.ts и
 * проверяют саму функцию, а не канал) — проверяем только колбэк Threads:
 * тот же протокол `cancelled`/`state`/`not-configured`, что у TikTok.
 *
 * БЕЗ БД: db.js замокан пустым объектом ключей.
 */

vi.mock("../src/db.js", () => ({
  prisma: {
    settings: {
      findUnique: vi.fn().mockResolvedValue({ threadsAppId: null, threadsAppSecret: null }),
    },
    $disconnect: async () => {},
  },
}));
vi.mock("../src/lib/systemError.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/systemError.js")>()),
  logSystemError: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../src/lib/audit.js", () => ({
  logAudit: vi.fn(),
}));

const { signState } = await import("../src/lib/oauthState.js");
const { threadsCallbackRouter } = await import("../src/routes/threads.js");

describe("GET /threads/oauth/callback", () => {
  let app: express.Express;

  beforeEach(() => {
    app = express();
    app.use("/api/v1/threads/oauth/callback", threadsCallbackRouter);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("без code/state — редирект с reason=cancelled, Threads API не дёргается", async () => {
    const res = await request(app).get("/api/v1/threads/oauth/callback");
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("threads=error");
    expect(res.headers.location).toContain("reason=cancelled");
  });

  it("ключи Threads не настроены — редирект с reason=not-configured", async () => {
    const res = await request(app)
      .get("/api/v1/threads/oauth/callback")
      .query({ code: "some-code", state: signState() });
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("threads=error");
    expect(res.headers.location).toContain("reason=not-configured");
  });

  it("state подделан — редирект с reason=state, до обмена кода дело не доходит", async () => {
    const res = await request(app)
      .get("/api/v1/threads/oauth/callback")
      .query({ code: "some-code", state: "фальшивка.а.б" });
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("reason=state");
  });
});
