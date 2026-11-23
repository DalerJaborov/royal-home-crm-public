import { defineConfig } from "@playwright/test";
const baseURL = process.env.E2E_BASE_URL;
if (!baseURL || !["localhost", "127.0.0.1"].includes(new URL(baseURL).hostname) || new URL(baseURL).protocol !== "http:" || !new URL(baseURL).port || new URL(baseURL).port === "5284") {
  throw new Error("Нужен изолированный локальный стенд (E2E_BASE_URL=http://localhost:<порт>).");
}
export default defineConfig({
  testDir: "./tests/e2e", testMatch: "client-card-tidy.spec.ts", workers: 1, fullyParallel: false,
  timeout: 90_000, retries: 0, reporter: "list",
  use: { baseURL, serviceWorkers: "block", screenshot: "only-on-failure" },
});
