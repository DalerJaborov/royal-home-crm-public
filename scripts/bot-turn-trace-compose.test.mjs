import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, unlinkSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const compose = path.join(ROOT, "docker-compose.prod.yml");
const source = readFileSync(compose, "utf8");

function render(overrides = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), "rh-trace-compose-"));
  assert.ok(path.resolve(directory).startsWith(`${path.resolve(tmpdir())}${path.sep}`));
  const envFile = path.join(directory, "fixture.env");
  const required = [...new Set([...source.matchAll(/\$\{([A-Z][A-Z0-9_]*):\?/g)].map((match) => match[1]))];
  const referenced = [...new Set([...source.matchAll(/\$\{([A-Z][A-Z0-9_]*)/g)].map((match) => match[1]))];
  const fake = Object.fromEntries(referenced.map((key) => [key, required.includes(key) ? "fake-required-compose-fixture-0000" : ""]));
  const env = { ...process.env };
  // Compose sees ONLY fixture values, never ambient CRM/provider secrets or a
  // real .env.production. Rendered JSON stays in memory and isn't logged.
  for (const key of referenced) delete env[key];
  writeFileSync(envFile, Object.entries({ ...fake, ...overrides }).map(([key, value]) => `${key}=${value}`).join("\n"));
  try {
    const result = spawnSync("docker", ["compose", "--env-file", envFile, "-f", compose, "config", "--format", "json"], { cwd: directory, env, encoding: "utf8", timeout: 30000, windowsHide: true });
    assert.equal(result.error, undefined, "Docker Compose must be installed for this configuration gate");
    assert.equal(result.status, 0, "Fixture-only Compose config must validate");
    try { return JSON.parse(result.stdout).services; } catch { throw Error("Compose returned malformed configuration JSON"); }
  } finally { unlinkSync(envFile); rmdirSync(directory); }
}
test("trace flags default OFF with no HMAC key in both API and worker", () => {
  const services = render();
  for (const name of ["api", "worker"]) {
    assert.equal(services[name].environment.BOT_TURN_TRACE_ENABLED, "0");
    assert.equal(services[name].environment.BOT_TURN_TRACE_HMAC_KEY, "");
    assert.equal(services[name].environment.BOT_TURN_TRACE_TEXT_ENABLED, "0");
    assert.equal(services[name].environment.BOT_PROPERTY_CONTEXT_ENABLED, "0");
  }
});
test("metadata-only activation and one separate fake key reach API and worker", () => {
  const key = "fictional-compose-trace-key-test-only-0000";
  const services = render({ BOT_TURN_TRACE_ENABLED: "1", BOT_TURN_TRACE_HMAC_KEY: key });
  for (const name of ["api", "worker"]) {
    assert.equal(services[name].environment.BOT_TURN_TRACE_ENABLED, "1");
    assert.equal(services[name].environment.BOT_TURN_TRACE_HMAC_KEY, key);
    assert.equal(services[name].environment.BOT_TURN_TRACE_TEXT_ENABLED, "0");
  }
});

test("fact-only property flag is an independent opt-in for API and worker", () => {
  const services = render({ BOT_PROPERTY_CONTEXT_ENABLED: "1" });
  for (const name of ["api", "worker"]) {
    assert.equal(services[name].environment.BOT_PROPERTY_CONTEXT_ENABLED, "1");
    assert.equal(services[name].environment.BOT_TURN_TRACE_ENABLED, "0");
  }
});
