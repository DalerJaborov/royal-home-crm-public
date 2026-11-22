import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import {
  ClientBuildWatch,
  clientBuildWatchMiddleware,
  formatStaleSummary,
  REPORT_EVERY_MS,
  STALE_AFTER_MS,
} from "../src/lib/clientBuildWatch.js";
import { app } from "../src/app.js";

/**
 * Сторож вкладок, застрявших на старой сборке (21.11.2026). Поводом стал iPhone
 * владельца: сутки на старой сборке фронта, и узнали об этом только от него.
 * Вкладка шлёт X-Client-Build / X-Client-Build-Time, сервер раз в час тихо
 * пишет сводку «кто на старой сборке дольше 30 минут после выхода новой».
 */
const T0 = 1_700_000_000_000;

describe("ClientBuildWatch — кто застрял", () => {
  it("текущая — самая свежая по времени сборки; застрявшие — старые, кто ходит к серверу после 30 минут", () => {
    const watch = new ClientBuildWatch(T0);
    watch.note("old", T0 - 86_400_000, "a:1", T0);
    watch.note("new", T0 - 60_000, "a:2", T0);
    // через 31 минуту первый всё ещё на старой — застрял
    watch.note("old", T0 - 86_400_000, "a:1", T0 + STALE_AFTER_MS + 60_000);
    watch.note("new", T0 - 60_000, "a:2", T0 + STALE_AFTER_MS + 60_000);
    const summary = watch.staleSummary(T0 + STALE_AFTER_MS + 60_000);
    expect(summary).toEqual({ current: "new", stale: [{ build: "old", clients: 1 }], total: 1 });
    expect(formatStaleSummary(summary!)).toContain("old (1)");
  });

  it("первые полчаса после выхода сборки — не застрявшие, а обычное обновление", () => {
    const watch = new ClientBuildWatch(T0);
    watch.note("old", T0 - 86_400_000, "a:1", T0);
    watch.note("new", T0, "a:2", T0);
    watch.note("old", T0 - 86_400_000, "a:1", T0 + STALE_AFTER_MS - 1);
    expect(watch.staleSummary(T0 + STALE_AFTER_MS - 1)).toBeNull();
  });

  it("вкладка, обновившаяся вовремя, не считается", () => {
    const watch = new ClientBuildWatch(T0);
    watch.note("old", T0 - 86_400_000, "a:1", T0);
    watch.note("new", T0, "a:2", T0);
    watch.note("new", T0, "a:1", T0 + 60_000);
    expect(watch.staleSummary(T0 + 2 * STALE_AFTER_MS)).toBeNull();
  });

  it("время сборки из будущего не делает её текущей", () => {
    const watch = new ClientBuildWatch(T0);
    watch.note("real", T0 - 60_000, "a:1", T0);
    watch.note("liar", T0 + 365 * 86_400_000, "d:x", T0 + 1);
    // у «liar» время отброшено — ранг по первому появлению (T0+1) всё равно
    // свежее, но врать на год вперёд он больше не может
    expect(watch.currentBuild()?.info.builtAt).not.toBe(T0 + 365 * 86_400_000);
  });

  it("сводка — раз в час и только если есть застрявшие", () => {
    const watch = new ClientBuildWatch(T0);
    watch.note("old", T0 - 86_400_000, "a:1", T0);
    watch.note("new", T0, "a:2", T0);
    expect(watch.takeReport(T0 + 10 * 60_000)).toBeNull(); // час не прошёл
    watch.note("old", T0 - 86_400_000, "a:1", T0 + REPORT_EVERY_MS);
    expect(watch.takeReport(T0 + REPORT_EVERY_MS)?.total).toBe(1);
    expect(watch.takeReport(T0 + REPORT_EVERY_MS + 60_000)).toBeNull(); // снова ждём час
  });
});

describe("clientBuildWatchMiddleware — граница запроса", () => {
  function mini(watch: ClientBuildWatch, report = vi.fn()) {
    const a = express();
    a.use(clientBuildWatchMiddleware(watch, report));
    a.get("/x", (_req, res) => res.json({ ok: true }));
    return { a, report };
  }

  it("учитывает вкладку по устройству, если вход ещё не выполнен", async () => {
    const watch = new ClientBuildWatch();
    const { a } = mini(watch);
    await request(a).get("/x").set("X-Client-Build", "abc1234").set("X-Client-Build-Time", "1700000000000").set("X-Device-Id", "dev-1").expect(200);
    expect(watch.currentBuild()?.build).toBe("abc1234");
  });

  it("мусорные заголовки не принимаются и запросу не мешают", async () => {
    const watch = new ClientBuildWatch();
    const { a } = mini(watch);
    await request(a).get("/x").set("X-Client-Build", "<script>").set("X-Device-Id", "dev-1").expect(200);
    await request(a).get("/x").set("X-Client-Build", "ok").set("X-Client-Build-Time", "yesterday").set("X-Device-Id", "dev-1").expect(200);
    await request(a).get("/x").set("X-Client-Build", "x".repeat(65)).set("X-Device-Id", "dev-1").expect(200);
    expect(watch.currentBuild()).toBeNull();
  });

  it("застрявшая вкладка попадает в тихую сводку журнала раз в час", async () => {
    const now = Date.now();
    const watch = new ClientBuildWatch(now - REPORT_EVERY_MS);
    watch.note("new", now - 2 * REPORT_EVERY_MS, "d:fresh", now - 2 * REPORT_EVERY_MS);
    const { a, report } = mini(watch);
    await request(a).get("/x").set("X-Client-Build", "old").set("X-Client-Build-Time", String(now - 86_400_000)).set("X-Device-Id", "iphone").expect(200);
    await vi.waitFor(() => expect(report).toHaveBeenCalledTimes(1));
    expect(report.mock.calls[0][0]).toContain("old (1)");
    // второй запрос в тот же час — без повторной записи
    await request(a).get("/x").set("X-Client-Build", "old").set("X-Device-Id", "iphone").expect(200);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(report).toHaveBeenCalledTimes(1);
  });

  it("без заголовков сборки ничего не учитывает", async () => {
    const watch = new ClientBuildWatch();
    const { a } = mini(watch);
    await request(a).get("/x").set("X-Device-Id", "dev-1").expect(200);
    expect(watch.currentBuild()).toBeNull();
  });
});

describe("приложение", () => {
  it("X-App-Build по-прежнему уходит в ответе и виден фронту (подсказка для /version.json)", async () => {
    const res = await request(app).get("/api/v1/health");
    expect(res.headers["x-app-build"]).toMatch(/^\d+$/);
  });
});
