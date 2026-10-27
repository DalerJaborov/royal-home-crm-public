import { spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

// Only reads may wait for a short outage. No caller-supplied write command.
export const READ_NETWORK_DELAYS_MS = Object.freeze([5000, 10000, 20000, 30000]);
export const READ_NETWORK_WINDOW_MS = 120000;

export function gitFetchConnectionFailure(result) {
  if (result.error?.code === "ETIMEDOUT") return true;
  if (result.signal || result.error) return false;
  return /Failed to connect to github\.com(?::443| port 443)|Could not resolve host: github\.com|Connection (?:timed out|reset)|Recv failure|curl (?:7|28|56)\b/i
    .test(result.stderr || "");
}

/** Exactly git fetch origin main: remote reads/local tracking refs, never a push
 * or merge. The original result is returned on exhaustion; callers must stop. */
export async function fetchOriginMain({
  run = (command, args, options) => spawnSync(command, args, {
    ...options, encoding: "utf8", windowsHide: true,
  }), wait = sleep, now = Date.now, log = console.log,
} = {}) {
  const started = now();
  let result;
  for (let attempt = 0; ; attempt++) {
    const remaining = READ_NETWORK_WINDOW_MS - (now() - started);
    if (remaining <= 0 && result) return result;
    result = run("git", ["fetch", "origin", "main"], { timeout: Math.max(1, remaining) });
    for (const output of [result.stdout, result.stderr]) if (output?.trim()) log(output.trim());
    if (result.status === 0 || !gitFetchConnectionFailure(result)) return result;
    const delay = READ_NETWORK_DELAYS_MS[attempt];
    if (delay === undefined || now() - started + delay >= READ_NETWORK_WINDOW_MS) return result;
    log(`  git fetch: обрыв соединения; повтор чтения ${attempt + 1}/${READ_NETWORK_DELAYS_MS.length} через ${delay / 1000} с`);
    await wait(delay);
  }
}
