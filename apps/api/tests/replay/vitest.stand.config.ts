import { defineConfig } from "vitest/config";
if (process.env.TEST_ENV_PIN === "0") throw new Error("Replay forbids pin opt-out before overrides");
export default defineConfig({ test: { environment: "node", include: ["tests/replay/*.stand.replay.ts"], setupFiles: ["tests/replay/setupStand.ts"], pool: "forks", maxWorkers: 1, fileParallelism: false, isolate: true, retry: 0,
  env: { TZ: "UTC", TEST_ENV_PIN: "1", JWT_ACCESS_SECRET: "replay-stand-access-secret-0123456789", JWT_REFRESH_SECRET: "replay-stand-refresh-secret-0123456789", SETTINGS_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" }, execArgv: ["--max-old-space-size=768"], testTimeout: 30000, hookTimeout: 30000 } }); // gitleaks:allow -- reviewed synthetic test value or non-secret identifier
