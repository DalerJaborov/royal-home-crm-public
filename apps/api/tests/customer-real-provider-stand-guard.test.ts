import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const runner = fileURLToPath(new URL("../scripts/manual/customerCoreRealProvider.mjs", import.meta.url));
describe("manual paid-provider stand rejects missing authorization before imports or I/O", () => {
  it.each([
    { args: [] },
    { args: ["--config", "missing-do-not-create.json", "--max-usd", "0.000000000", "--execute-two-real-operations"] },
    { args: ["--config", "missing-do-not-create.json", "--max-usd", "0.258048000"] },
  ])("requires the explicit bounded invocation: %j", ({ args }) => {
    // No credentials/DB URL are passed to this child. A broken early guard
    // must fail the oracle rather than reach a configured provider or database.
    const result = spawnSync(process.execPath, [runner, ...args], {
      env: { PATH: process.env.PATH, TEST_ENV_PIN: "1", NODE_OPTIONS: "" },
      encoding: "utf8", timeout: 5000, windowsHide: true,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout.trim())).toMatchObject({ status: "failed", casesReady: 0,
      counts: { count: 0, generate: 0, syntheticProfile: 0 }, liveSocialPosts: 0 });
  });
});
