import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import express from "express";
import request from "supertest";

/**
 * TikTok OAuth (17.09.2026) — routes/tiktok.ts.
 *
 * STATE — подписанная строка `<ts>.<nonce>.<hmac>` на HMAC-SHA256 от
 * JWT_ACCESS_SECRET (тот же секрет, что подписывает access-токены, см.
 * auth/jwt.ts), а не запись в памяти процесса (в отличие от routes/ads.ts) —
 * переживает перезапуск сервера между нажатием кнопки и возвратом из TikTok.
 *
 * БЕЗ БД: db.js замокан пустым объектом ключей — этого достаточно для веток,
 * которые тест проверяет (state, "ключи не настроены"), реальный обмен кода на
 * токен здесь не тестируется (тот путь дёргает TikTok API, ему место в
 * social-publish, не в этом файле — тот же принцип, что у tests/ads-oauth, если
 * такой есть: HTTP-обмен и state-проверка тестируются раздельно).
 */

vi.mock("../src/db.js", () => ({
  prisma: {
    settings: {
      findUnique: vi.fn().mockResolvedValue({ tiktokClientKey: null, tiktokClientSecret: null }),
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

const { signState, verifyState } = await import("../src/lib/oauthState.js");
const { tiktokCallbackRouter } = await import("../src/routes/tiktok.js");

function hmacState(ts: number, nonce: string): string {
  const payload = `${ts}.${nonce}`;
  const hmac = createHmac("sha256", process.env.JWT_ACCESS_SECRET ?? "").update(payload).digest("hex");
  return `${payload}.${hmac}`;
}

describe("state (OAuth TikTok)", () => {
  it("верный, только что подписанный — проходит", () => {
    expect(verifyState(signState())).toBe(true);
  });

  it("подделанный (изменён hmac) — отказ", () => {
    const state = signState();
    const parts = state.split(".");
    parts[2] = parts[2].startsWith("a") ? "b" + parts[2].slice(1) : "a" + parts[2].slice(1);
    expect(verifyState(parts.join("."))).toBe(false);
  });

  it("просроченный (старше 10 минут) — отказ", () => {
    const oldTs = Date.now() - 11 * 60 * 1000;
    const state = hmacState(oldTs, "nonce123");
    expect(verifyState(state)).toBe(false);
  });

  it("из будущего (часы разошлись) — тоже отказ, а не тихое принятие", () => {
    const futureTs = Date.now() + 60 * 1000;
    const state = hmacState(futureTs, "nonce456");
    expect(verifyState(state)).toBe(false);
  });

  it("неверный формат (не три части через точку) — отказ, а не исключение", () => {
    expect(verifyState("не-похоже-на-state")).toBe(false);
    expect(verifyState("")).toBe(false);
  });
});

describe("GET /oauth/callback", () => {
  let app: express.Express;

  beforeEach(() => {
    app = express();
    app.use("/api/v1/tiktok/oauth/callback", tiktokCallbackRouter);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("без code/state — редирект с reason=cancelled, TikTok API не дёргается", async () => {
    const res = await request(app).get("/api/v1/tiktok/oauth/callback");
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("tiktok=error");
    expect(res.headers.location).toContain("reason=cancelled");
  });

  it("ключи TikTok не настроены — редирект с reason=not-configured", async () => {
    const res = await request(app)
      .get("/api/v1/tiktok/oauth/callback")
      .query({ code: "some-code", state: signState() });
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("tiktok=error");
    expect(res.headers.location).toContain("reason=not-configured");
  });

  it("state подделан — редирект с reason=state, до обмена кода дело не доходит", async () => {
    const res = await request(app).get("/api/v1/tiktok/oauth/callback").query({ code: "some-code", state: "фальшивка.а.б" });
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("reason=state");
  });
});
