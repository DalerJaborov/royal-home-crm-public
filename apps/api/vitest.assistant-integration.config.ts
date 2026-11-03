import { fileURLToPath } from "node:url";
// Never load developer .env; only the separately created disposable database is permitted.
const database = new URL(process.env.ASSISTANT_INTEGRATION_DATABASE_URL ?? "http://missing");
if (database.protocol !== "postgresql:" || database.hostname !== "127.0.0.1" || database.port !== "15687"
  || database.username !== "test_assistant" || database.pathname !== "/assistant_integration_migrations_test") {
  throw new Error("Only the isolated assistant integration database on localhost:15687 is allowed");
}
process.env.DATABASE_URL = database.href;
process.env.VITEST_DB_PARALLEL = "0";
process.env.JWT_ACCESS_SECRET = "assistant-integration-test-only-access";
process.env.JWT_REFRESH_SECRET = "assistant-integration-test-only-refresh";
process.env.NODE_ENV = "test";
process.env.TEST_ENV_PIN = "1";
export default {
  envDir: false,
  resolve: { alias: [{ find: /^(?:.*\/)?loadEnv\.(?:js|ts)$/, replacement: fileURLToPath(new URL("./tests/assistant-integration-empty-env.ts", import.meta.url)) }] },
  test: { environment: "node", env: { TZ: "UTC" }, setupFiles: ["./tests/setup.ts"],
    include: ["tests/assistant-telegram.test.ts", "tests/ai-assistant-*.test.ts", "tests/assistant-actions-*.test.ts", "tests/assistant-change-client-agent.test.ts", "tests/assistant-send-back-guard.test.ts"], testTimeout: 30000, hookTimeout: 30000,
    pool: "forks", maxWorkers: 1, fileParallelism: false, isolate: true,
    execArgv: ["--max-old-space-size=4096"] },
};
