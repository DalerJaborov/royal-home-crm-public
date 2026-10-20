import { defineConfig } from "vitest/config";
if (process.env.TEST_ENV_PIN === "0") throw new Error("Replay forbids explicit TEST_ENV_PIN=0 before overrides");
const probe = process.env.REPLAY_NEGATIVE_PROBE;
if (probe && !["late-caught-network", "unfinished-drain", "extra-model", "wrong-oracle"].includes(probe)) throw new Error("Unknown negative replay control");
export default defineConfig({ test: { environment: "node", include: [probe ? "tests/replay/negative.replay.ts" : "tests/replay/golden200.replay.ts"], setupFiles: ["tests/replay/setupOffline.ts"], pool: "forks", maxWorkers: 1, fileParallelism: false, isolate: true, retry: 0,
  env: { TZ: "UTC", TEST_ENV_PIN: "1" }, execArgv: ["--max-old-space-size=512"], testTimeout: 20000 } });
