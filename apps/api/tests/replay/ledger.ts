export interface ReplayAttempt { kind: "model" | "diagnostic" | "effect" | "network" | "db" | "subprocess"; operation: string; allowed: boolean }
/** Independent of business catches. Never clear violations after an attempt. */
export class ReplayLedger {
  readonly attempts: ReplayAttempt[] = [];
  constructor(private readonly onDenied?: (attempt: ReplayAttempt) => void) {}
  record(kind: ReplayAttempt["kind"], operation: string, allowed = false): void { const attempt = { kind, operation, allowed }; this.attempts.push(attempt); if (!allowed) this.onDenied?.(attempt); }
  deny(kind: ReplayAttempt["kind"], operation: string): never { this.record(kind, operation); throw new Error(`Offline replay denied ${kind}:${operation}`); }
  assertClean(): void { const denied = this.attempts.filter((attempt) => !attempt.allowed); if (denied.length) throw new Error(`Offline replay has sticky forbidden attempts: ${denied.slice(0, 8).map((attempt) => `${attempt.kind}:${attempt.operation}`).join(",")}`); }
  snapshot(): ReplayAttempt[] { return this.attempts.map((attempt) => ({ ...attempt })); }
}
