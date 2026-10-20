import { ReplayLedger } from "./ledger.js";

/** Explicit synthetic read fixtures, never an ORM/business emulator. */
export function offlineDatabase(ledger: ReplayLedger, reads: Record<string, () => unknown> = {}) {
  return new Proxy({}, { get(_target, table: string) {
    if (table === "then") return undefined;
    if (table.startsWith("$")) return async () => ledger.deny("db", table);
    return new Proxy({}, { get(_model, method: string) {
      return async () => {
        const operation = `${table}.${method}`; const fixture = reads[operation];
        if (!fixture) return ledger.deny("db", operation);
        ledger.record("db", `synthetic-read:${operation}`, true); return structuredClone(fixture());
      };
    } });
  } });
}
