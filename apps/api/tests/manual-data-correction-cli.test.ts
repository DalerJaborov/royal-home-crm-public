import { createServer, type Server } from "node:http";
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("../scripts/clientDataCorrection.mjs", import.meta.url));
const ownedRoot = mkdtempSync(join(tmpdir(), "crm-manual-cli-"));
const input = join(ownedRoot, "input.json"), canary = "PRIVATE_INPUT_CANARY";
let server: Server, base = "", hits = 0, lastPath = "";
function run(args: string[]) {
  return new Promise<{ code: number; stdout: string; stderr: string }>(resolve => {
    execFile(process.execPath, [script, ...args], { timeout: 8000, env: {
      PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP,
      CRM_MAINTENANCE_API_BASE: base, CRM_MAINTENANCE_ACCESS_TOKEN: "test-local-api-only",
    } }, (error, stdout, stderr) => resolve({ code: error ? Number(error.code) || 1 : 0, stdout, stderr }));
  });
}
beforeAll(async () => {
  server = createServer((req, res) => {
    hits++; lastPath = req.url ?? ""; req.resume();
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ mode: "DRY_RUN", planHash: "a".repeat(64), reason: canary,
      targets: [{ clientId: "00000000-0000-4000-8000-000000000001", before: { fullName: canary }, patch: { fullName: "Synthetic corrected" } }],
      impact: { writesWorkflow: false } }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("No local test listener");
  base = `http://127.0.0.1:${address.port}`;
});
beforeEach(() => { hits = 0; lastPath = ""; writeFileSync(input, JSON.stringify({ reason: canary })); });
afterAll(async () => {
  if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  const target = realpathSync(ownedRoot);
  if (dirname(target) !== realpathSync(tmpdir()) || !basename(target).startsWith("crm-manual-cli-")) throw new Error("Unexpected cleanup target");
  rmSync(target, { recursive: true, force: true });
});
describe("maintenance CLI privacy and default read-only behavior", () => {
  it("defaults to preview and hides private values from console", async () => {
    const result = await run([`--input=${input}`]);
    expect(result.code).toBe(0); expect(lastPath).toBe("/api/v1/maintenance/data-corrections/preview");
    expect(result.stdout).not.toContain(canary); expect(result.stderr).not.toContain(canary);
  });
  it("writes a concrete review to a new private file, never overwriting it", async () => {
    const output = join(ownedRoot, "review.json");
    const result = await run([`--input=${input}`, `--output-preview=${output}`]);
    expect(result.code).toBe(0); expect(readFileSync(output, "utf8")).toContain(canary); expect(result.stdout).not.toContain(canary);
    hits = 0;
    expect((await run([`--input=${input}`, `--output-preview=${output}`, "--persist-plan"])).code).toBe(1);
    expect(hits).toBe(0);
  });
  it.each(["file", "directory"])("rejects another Git checkout (.git as %s) before any API call", async kind => {
    const repo = join(ownedRoot, `other-repository-${kind}`); mkdirSync(repo);
    if (kind === "file") writeFileSync(join(repo, ".git"), "gitdir: synthetic-worktree");
    else mkdirSync(join(repo, ".git"));
    const result = await run([`--input=${input}`, `--output-preview=${join(repo, "review.json")}`, "--persist-plan"]);
    expect(result.code).toBe(1); expect(hits).toBe(0); expect(result.stderr).not.toContain(canary);
  });
  it("does not print malformed JSON snippets or send them to the API", async () => {
    writeFileSync(input, `{\"client\":\"${canary}`);
    const result = await run([`--input=${input}`]);
    expect(result.code).toBe(1); expect(hits).toBe(0); expect(result.stderr).not.toContain(canary);
  });
  it("does not apply without both independent execution acknowledgements", async () => {
    const result = await run(["--apply", "--review-impact", "--plan-id=00000000-0000-4000-8000-000000000001", `--plan-hash=${"a".repeat(64)}`]);
    expect(result.code).toBe(1); expect(hits).toBe(0);
  });
});
