import { describe, expect, it, vi } from "vitest";
import { CI_UNSET_VARS, pinTestEnv } from "./testEnvPin.js";

/**
 * Эталон окружения тестов (tests/testEnvPin.ts): переменные, которых нет в CI,
 * снимаются после загрузки .env, чем бы ни был заполнен локальный файл.
 * Проверяется на отдельном объекте — настоящий process.env к этому моменту уже
 * прошёл через pinTestEnv в setup.ts, и ниже это тоже проверяется.
 */
describe("эталон окружения тестов", () => {
  it("снимает переменные сайта и публичного адреса, остальное не трогает", () => {
    const env = {
      DATABASE_URL: "postgresql://x",
      JWT_ACCESS_SECRET: "s",
      SITE_SYNC_URL: "https://site.example",
      SITE_SYNC_API_KEY: "k",
      SITE_PUBLIC_URL: "https://royalhome.tj",
      CRM_PUBLIC_URL: "http://localhost:4000",
    };
    const removed = pinTestEnv(env);
    expect(removed.sort()).toEqual(["CRM_PUBLIC_URL", "SITE_PUBLIC_URL", "SITE_SYNC_API_KEY", "SITE_SYNC_URL"]);
    expect(env.DATABASE_URL).toBe("postgresql://x");
    expect(env.JWT_ACCESS_SECRET).toBe("s");
    expect("SITE_SYNC_URL" in env).toBe(false);
    expect("CRM_PUBLIC_URL" in env).toBe(false);
  });

  it("пустая строка тоже снимается: для кода «пусто» и «не задано» — разные вещи", () => {
    const env = { SITE_SYNC_URL: "" };
    expect(pinTestEnv(env)).toEqual(["SITE_SYNC_URL"]);
    expect("SITE_SYNC_URL" in env).toBe(false);
  });

  it("TEST_ENV_PIN=0 выключает эталон целиком", () => {
    const env = { TEST_ENV_PIN: "0", SITE_SYNC_URL: "https://site.example", GEMINI_API_KEY: "fake-explicit-optout" };
    expect(pinTestEnv(env)).toEqual([]);
    expect(env.SITE_SYNC_URL).toBe("https://site.example");
    expect(env.GEMINI_API_KEY).toBe("fake-explicit-optout");
  });

  it("removes external credentials without touching DB/JWT/encryption or inbound authentication", () => {
    const keep = {
      DATABASE_URL: "postgresql://fake-local/test", JWT_ACCESS_SECRET: "fake-access",
      JWT_REFRESH_SECRET: "fake-refresh", SETTINGS_ENCRYPTION_KEY: "fake-settings",
      PHONE_ENCRYPTION_KEY: "fake-phone", PORT: "4000",
      WEBSITE_LEAD_API_KEY: "fake-inbound", TELEGRAM_WEBHOOK_SECRET: "fake-webhook",
    };
    const env = { ...Object.fromEntries(CI_UNSET_VARS.map((name) => [name, "fake-external-sentinel"])), ...keep };
    expect(pinTestEnv(env).sort()).toEqual([...CI_UNSET_VARS].sort());
    expect(env).toEqual(keep);
  });

  it("does not prevent a test from supplying its own fake key after setup", () => {
    const env: Record<string, string | undefined> = { GEMINI_API_KEY: "fake-inherited" };
    pinTestEnv(env);
    env.GEMINI_API_KEY = "fake-test-key";
    expect(env.GEMINI_API_KEY).toBe("fake-test-key");
  });
  it.skipIf(process.env.TEST_ENV_PIN === "0")("module reset cannot reload dotenv credentials through prismaAdapter", async () => {
    const config = vi.fn(() => {
      process.env.GEMINI_API_KEY = "fake-dotenv-reload";
      return { parsed: { GEMINI_API_KEY: "fake-dotenv-reload" } };
    });
    vi.doMock("dotenv", () => ({ config }));
    try {
      vi.resetModules();
      await import("../src/lib/prismaAdapter.js"); // Imports loadEnv but never constructs a DB client.
      expect(config).not.toHaveBeenCalled();
      expect(process.env.GEMINI_API_KEY).toBeUndefined();
      vi.stubEnv("GEMINI_API_KEY", "fake-test-key-after-setup");
      vi.resetModules();
      await import("../src/loadEnv.js");
      expect(config).not.toHaveBeenCalled();
      expect(process.env.GEMINI_API_KEY).toBe("fake-test-key-after-setup");
    } finally {
      vi.unstubAllEnvs();
      vi.doUnmock("dotenv");
    }
  });

  it("в самом прогоне переменных эталона нет — setup.ts их снял", () => {
    if (process.env.TEST_ENV_PIN === "0") return;
    for (const name of CI_UNSET_VARS) expect(process.env[name], name).toBeUndefined();
  });
});
