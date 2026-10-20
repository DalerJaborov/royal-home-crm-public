import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertProductionEnv } from "../src/env-check.js";

/**
 * ПРОВЕРКА ОКРУЖЕНИЯ ПЕРЕД СТАРТОМ — последняя преграда перед тем, как прод
 * поднимется с секретами из `.env.example`.
 *
 * До 25.09.2026 до `env-check.ts` не дотягивался ни один тест (список в
 * CLAUDE.md). Цена поломки здесь несимметрична: перестанет останавливать —
 * прод однажды поднимется с `change-me` в подписи токенов, и любой сможет
 * подделать JWT и войти админом; начнёт останавливать лишнего — контейнер не
 * поднимется, что заметят сразу же.
 *
 * Поэтому проверяется именно ГРАНИЦА: что останавливает, что только
 * предупреждает и чем production отличается от разработки.
 */

const KEYS = [
  "NODE_ENV",
  "DATABASE_URL",
  "JWT_ACCESS_SECRET",
  "JWT_REFRESH_SECRET",
  "SETTINGS_ENCRYPTION_KEY",
  "CRM_PUBLIC_URL",
] as const;

const GOOD = {
  DATABASE_URL: "postgresql://u:p@localhost:5432/db",
  JWT_ACCESS_SECRET: "a".repeat(40),
  JWT_REFRESH_SECRET: "b".repeat(40),
  SETTINGS_ENCRYPTION_KEY: "0".repeat(64),
  CRM_PUBLIC_URL: "https://crm.example.tj",
};

const saved: Record<string, string | undefined> = {};
let exitSpy: ReturnType<typeof vi.spyOn>;

/** Остановка запуска — это `process.exit(1)`; в тесте он не должен убить прогон. */
class StartupStopped extends Error {}

function env(overrides: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries({ ...GOOD, ...overrides })) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

/** true — запуск остановлен. */
function stopped(): boolean {
  try {
    assertProductionEnv();
    return false;
  } catch (err) {
    if (err instanceof StartupStopped) return true;
    throw err;
  }
}

beforeEach(() => {
  for (const k of KEYS) saved[k] = process.env[k];
  exitSpy = vi.spyOn(process, "exit").mockImplementation(((): never => {
    throw new StartupStopped();
  }) as never);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.restoreAllMocks();
});

describe("Проверка окружения в production", () => {
  it("останавливает запуск на секрете из .env.example", () => {
    env({ NODE_ENV: "production", JWT_ACCESS_SECRET: "change-me-please-generate-your-own" });
    expect(stopped()).toBe(true);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("останавливает запуск на коротком секрете", () => {
    // Длина считается только в production: 31 символ — уже мало.
    env({ NODE_ENV: "production", JWT_REFRESH_SECRET: "c".repeat(31) });
    expect(stopped()).toBe(true);
  });

  it("останавливает запуск без адреса базы", () => {
    env({ NODE_ENV: "production", DATABASE_URL: undefined });
    expect(stopped()).toBe(true);
  });

  it("останавливает запуск на ключе шифрования не той длины и не того алфавита", () => {
    env({ NODE_ENV: "production", SETTINGS_ENCRYPTION_KEY: "0".repeat(63) });
    expect(stopped()).toBe(true);

    env({ NODE_ENV: "production", SETTINGS_ENCRYPTION_KEY: "z".repeat(64) });
    expect(stopped()).toBe(true);
  });

  it("на исправном окружении не останавливает ничего", () => {
    env({ NODE_ENV: "production" });
    expect(stopped()).toBe(false);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("без CRM_PUBLIC_URL только предупреждает: бот теряет фотографии, но система работает", () => {
    env({ NODE_ENV: "production", CRM_PUBLIC_URL: undefined });
    expect(stopped()).toBe(false);
    expect(console.warn).toHaveBeenCalled();
  });
});

describe("Проверка окружения в разработке", () => {
  it("те же проблемы не останавливают, а предупреждают", () => {
    env({ NODE_ENV: "development", JWT_ACCESS_SECRET: "change-me", DATABASE_URL: undefined });
    expect(stopped()).toBe(false);
    expect(exitSpy).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalled();
  });

  it("короткий секрет в разработке — не проблема вовсе", () => {
    env({ NODE_ENV: "development", JWT_ACCESS_SECRET: "коротко" });
    expect(stopped()).toBe(false);
    // Ни одного предупреждения о длине: правило длины действует только в production.
    const warned = (console.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .map((c) => String(c[0]))
      .join("\n");
    expect(warned).not.toContain("слишком короткий");
  });
});
