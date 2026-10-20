// Git-хук .githooks/pre-push: push в main — только со строкой Ship-Verified своего
// дерева (ту же строку требует сервер выката), push своих веток не трогает.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { shipVerified } from "../.githooks/pre-push.mjs";

const HOOKS = resolve(import.meta.dirname, "../.githooks");

function sh(cwd, ...args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  return { ok: r.status === 0, out: `${r.stdout}${r.stderr}` };
}

test("shipVerified: строка со своим деревом — да, с чужим или в цитате — нет", () => {
  const tree = "a".repeat(40);
  assert.equal(shipVerified(`правка\n\nShip-Verified: tree=${tree} main=x api-tests=5 failed=0`, tree), true);
  assert.equal(shipVerified(`правка\n\nShip-Verified: tree=${"b".repeat(40)} main=x`, tree), false);
  assert.equal(shipVerified(`см. Ship-Verified: tree=${tree}`, tree), false);
  assert.equal(shipVerified("", tree), false);
});

test("pre-push не пускает в main вершину без строки, пускает со строкой и свои ветки", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "rh-prepush-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const remote = join(dir, "remote.git");
  const work = join(dir, "work");
  sh(dir, "init", "-q", "--bare", "-b", "main", remote);
  sh(dir, "init", "-q", "-b", "main", work);
  for (const [k, v] of [
    ["user.email", "t@t"],
    ["user.name", "t"],
    ["core.hooksPath", HOOKS],
    ["commit.gpgsign", "false"],
  ])
    sh(work, "config", k, v);
  sh(work, "remote", "add", "origin", remote);

  writeFileSync(join(work, "a.txt"), "1\n");
  sh(work, "add", ".");
  sh(work, "commit", "-q", "-m", "мимо ship");
  const bare = sh(work, "push", "origin", "HEAD:main");
  assert.equal(bare.ok, false, bare.out);
  assert.match(bare.out, /ОСТАНОВЛЕНО: push в main мимо `npm run ship`/);

  assert.equal(sh(work, "push", "origin", "HEAD:refs/heads/feat/x").ok, true, "своя ветка проходит");

  const tree = spawnSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: work, encoding: "utf8" }).stdout.trim();
  sh(work, "commit", "-q", "--amend", "-m", `проверено\n\nShip-Verified: tree=${tree} main=x api-tests=5 failed=0`);
  const verified = sh(work, "push", "origin", "HEAD:main");
  assert.equal(verified.ok, true, verified.out);

  assert.equal(sh(work, "push", "origin", ":main").ok, false, "удалять main нельзя");
});
