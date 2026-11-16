import { defineConfig } from "vitest/config";
if (process.env.TEST_ENV_PIN === "0") throw new Error("Replay forbids explicit TEST_ENV_PIN=0 before overrides");
const probe = process.env.REPLAY_NEGATIVE_PROBE;
if (probe && !["late-caught-network", "unfinished-drain", "extra-model", "wrong-oracle"].includes(probe)) throw new Error("Unknown negative replay control");
// The offline golden200 replay drove the old customer bot (ai/leadQualifier.ts), deleted in one brain step 3b (16.11.2026):
// offline mode now runs only the negative controls; the core is replayed on the stand (vitest.stand.config.ts).
export default defineConfig({ test: { environment: "node", include: ["tests/replay/negative.replay.ts"], setupFiles: ["tests/replay/setupOffline.ts"], pool: "forks", maxWorkers: 1, fileParallelism: false, isolate: true, retry: 0,
  env: { TZ: "UTC", TEST_ENV_PIN: "1" }, execArgv: ["--max-old-space-size=512"], testTimeout: 20000 } });
