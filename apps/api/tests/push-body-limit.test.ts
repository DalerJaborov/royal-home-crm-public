import { describe, expect, it } from "vitest";
import { fitWireBody } from "../src/push.js";

/**
 * Web Push режет тело на ~4096 байт: сверх лимита — 413 у web.push.apple.com и
 * 400 «binary data must be less than 4096 bytes» у FCM, уведомление молча не
 * доезжает (прод-случаи 25.08.2026). Источник тогдашнего раздувания (data:-аватар)
 * починен отдельно, здесь проверяется сам транспортный предохранитель.
 */
describe("предохранитель размера тела push", () => {
  it("короткое тело не трогает", () => {
    const body = fitWireBody({ title: "Звонок", body: "Клиент ждёт", url: "/clients/1" });
    expect(JSON.parse(body)).toEqual({ title: "Звонок", body: "Клиент ждёт", url: "/clients/1" });
  });

  it("data:-аватар выбрасывается всегда — даже если тело влезает", () => {
    const body = fitWireBody({ title: "х", body: "т", avatarUrl: `data:image/png;base64,${"A".repeat(100)}` });
    expect(JSON.parse(body).avatarUrl).toBeUndefined();
  });

  it("обычный короткий аватар-путь сохраняется", () => {
    const body = fitWireBody({ title: "х", body: "т", avatarUrl: "/uploads/avatars/a.png" });
    expect(JSON.parse(body).avatarUrl).toBe("/uploads/avatars/a.png");
  });

  it("раздутое тело усекается ниже лимита 4096, а не уходит как есть", () => {
    // Кириллица — худший случай: JSON-экранирования нет, но UTF-8 даёт 2 байта на букву.
    const body = fitWireBody({ title: "Заголовок", body: "ж".repeat(6000), url: "/x" });
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(3800);
    const parsed = JSON.parse(body) as { title: string; body: string; url: string };
    expect(parsed.title).toBe("Заголовок");
    expect(parsed.url).toBe("/x");
    expect(parsed.body.length).toBeGreaterThan(0);
  });
});
