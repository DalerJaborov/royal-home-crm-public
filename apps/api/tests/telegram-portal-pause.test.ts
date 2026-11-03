import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { portalAlertsPausedIn } from "../src/lib/telegramPortalPause.js";
import { devCronsMuted } from "../src/worker.js";

/** Пауза Telegram-уведомлений площадок Somon/Paydo (03.11.2026) и предохранитель локальных кронов. */
const reader = (value: boolean | null) => ({
  settings: { findUnique: (async () => (value === null ? null : { telegramPortalAlertsPaused: value })) as never },
});

describe("пауза уведомлений площадок", () => {
  it("по умолчанию пауза: нет строки Settings — пауза; флаг false снимает её", async () => {
    expect(await portalAlertsPausedIn(reader(null))).toBe(true);
    expect(await portalAlertsPausedIn(reader(true))).toBe(true);
    expect(await portalAlertsPausedIn(reader(false))).toBe(false);
  });

  it("сторож: каждый файл, что шлёт в Telegram по площадкам (somonLeads/*), проходит через дверь паузы", () => {
    const dir = path.resolve(__dirname, "../src/lib/somonLeads");
    const senders = readdirSync(dir)
      .filter((f) => f.endsWith(".ts") && statSync(path.join(dir, f)).isFile())
      .filter((f) => /telegram\/api\.js/.test(readFileSync(path.join(dir, f), "utf8")));
    expect(senders).toEqual(["sendReserved.ts"]);
    expect(readFileSync(path.join(dir, "sendReserved.ts"), "utf8")).toContain("portalAlertsPausedIn");
    expect(readFileSync(path.join(dir, "monitor.ts"), "utf8")).toContain("isTelegramPortalAlertsPaused");
  });
});

describe("предохранитель локального запуска", () => {
  const withEnv = (env: Record<string, string | undefined>, fn: () => void) => {
    const saved = { NODE_ENV: process.env.NODE_ENV, DEV_CRONS: process.env.DEV_CRONS };
    for (const [k, v] of Object.entries(env)) v === undefined ? delete process.env[k] : (process.env[k] = v);
    try { fn(); } finally { for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v); }
  };
  it("dev без DEV_CRONS — кроны молчат; с DEV_CRONS=1, в проде и в тестах — работают", () => {
    withEnv({ NODE_ENV: "development", DEV_CRONS: undefined }, () => expect(devCronsMuted()).toBe(true));
    withEnv({ NODE_ENV: "development", DEV_CRONS: "1" }, () => expect(devCronsMuted()).toBe(false));
    withEnv({ NODE_ENV: "production", DEV_CRONS: undefined }, () => expect(devCronsMuted()).toBe(false));
    withEnv({ NODE_ENV: "test", DEV_CRONS: undefined }, () => expect(devCronsMuted()).toBe(false));
  });
});
