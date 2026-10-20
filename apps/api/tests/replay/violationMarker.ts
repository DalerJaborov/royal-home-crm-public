import { writeFileSync } from "node:fs";
import type { ReplayAttempt } from "./ledger.js";

/** CLI-owned private path. Even a denial after case write/afterAll cannot leave
 * the parent with a green artifact. No request, URL, body or credentials. */
export function persistViolation(attempt: ReplayAttempt): void {
  const path = process.env.REPLAY_VIOLATION_MARKER;
  if (path) writeFileSync(path, `${JSON.stringify({ kind: attempt.kind, operation: attempt.operation, denied: true })}\n`, { mode: 0o600 });
}
