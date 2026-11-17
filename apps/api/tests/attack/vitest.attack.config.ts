import { defineConfig } from "vitest/config";

// Config of the attack contour (scripts/attack-customer-core.mjs). Same environment as the normal API suite (owned Postgres,
// tests/setup.ts), but a single file, long timeouts and sequential execution: scenarios share one stand and one singleton policy row.
export default defineConfig({
  test: {
    environment: "node", env: { TZ: "UTC", ATTACK_GEMINI_KEY: process.env.GEMINI_API_KEY ?? "" }, setupFiles: ["./tests/setup.ts"],
    include: ["tests/attack/attack.run.ts"], testTimeout: 120_000, hookTimeout: 120_000, retry: 0,
    reporters: ["default"], fileParallelism: false, pool: "forks", maxWorkers: 1, isolate: true, execArgv: ["--max-old-space-size=2048"],
  },
});
