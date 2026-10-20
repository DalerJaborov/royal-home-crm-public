import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";

describe("smoke: /api/v1/morning-report", () => {
  let app: any;
  beforeAll(async () => {
    process.env.MORNING_REPORT_TOKEN = "smoke-token-1234567890";
    app = (await import("../src/app.js")).app;
  });

  it("без токена — 401", async () => {
    const res = await request(app).get("/api/v1/morning-report");
    expect(res.status).toBe(401);
  });

  it("со служебным токеном отдаёт числа и ошибки", async () => {
    const res = await request(app)
      .get("/api/v1/morning-report")
      .set("Authorization", "Bearer smoke-token-1234567890");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("tasksToday");
    expect(res.body).toHaveProperty("errorsUnresolvedTotal");
    expect(Array.isArray(res.body.errors)).toBe(true);
    // Две категории (03.09.2026, аудит «377 неразобранных, 17 типов»):
    // errorGroups — уникальные ТИПЫ (actionable-only) с count, errorsOperationalTotal —
    // технический счётчик шума ИИ-конвейера, не показанный директору как тревога.
    expect(Array.isArray(res.body.errorGroups)).toBe(true);
    expect(typeof res.body.errorsOperationalTotal).toBe("number");
    expect(typeof res.body.propertiesWithdrawnSellerRecovered).toBe("number");
    // 21.09.2026: «Что не доехало» — см. doc-comment у
    // MorningNumbers.stuckWorkGivenUpYesterday в lib/morningNumbers.ts.
    expect(typeof res.body.stuckWorkGivenUpYesterday).toBe("number");
    expect(typeof res.body.stuckWorkHangingNow).toBe("number");
  });

  it("старый путь team-requests больше не существует", async () => {
    const res = await request(app).get("/api/v1/team-requests");
    expect(res.status).toBe(404);
  });
});
