import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const RUNTIME_PATHS = [
  "apps/api/src", "packages/shared/src", "apps/api/prisma/schema.prisma", "apps/api/prisma/migrations", "apps/api/prisma.config.ts",
  "package.json", "package-lock.json", "apps/api/package.json", "packages/shared/package.json", "apps/api/tsconfig.json", "packages/shared/tsconfig.json",
];

/** Harness/docs WIP is allowed; ignored generated Prisma files stay ignored.
 * @param {string} root */
export function assertRuntimeSourceClean(root) {
  const options = { cwd: root, encoding: /** @type {const} */ ("utf8"), stdio: /** @type {["ignore", "pipe", "ignore"]} */ (["ignore", "pipe", "ignore"]) };
  const status = execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all", "--", ...RUNTIME_PATHS], options);
  if (status.trim()) throw new Error("Replay runtime source is dirty or has untracked runtime files");
  try { execFileSync("git", ["diff", "HEAD", "--exit-code", "--", ...RUNTIME_PATHS], { cwd: root, stdio: "ignore" }); }
  catch { throw new Error("Replay runtime source differs from HEAD"); }
}

/** @param {string} root */
export function readReplaySourceFingerprint(root) {
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error("Verified source HEAD required");
  const directory = resolve(root, "apps/api/tests/replay");
  const hash = createHash("sha256");
  for (const name of readdirSync(directory).filter((value) => /\.(ts|json)$/.test(value)).sort()) hash.update(name).update(readFileSync(resolve(directory, name)));
  for (const name of ["replay-customer-agent.mjs", "replayArtifactPaths.mjs", "replaySourceIntegrity.mjs"]) hash.update(name).update(readFileSync(resolve(root, "scripts", name)));
  for (const name of ["runParallelVerdict.ts", "testEnvPin.ts"]) hash.update(name).update(readFileSync(resolve(root, "apps/api/tests", name)));
  return { sha, graderHash: hash.digest("hex") };
}

/** Recheck immediately before child execution and before final publication.
 * @param {string} root @param {{sha: string, graderHash: string}} expected */
export function assertReplaySourceFingerprint(root, expected) {
  assertRuntimeSourceClean(root);
  const actual = readReplaySourceFingerprint(root);
  if (actual.sha !== expected.sha) throw new Error("Replay HEAD changed during the run");
  if (actual.graderHash !== expected.graderHash) throw new Error("Replay grader changed during the run");
}
