import { isDeepStrictEqual } from "node:util";
import type { ReplayAssertion } from "./report.js";

export function assertion(key: string, obligation: string, actual: unknown, expected: unknown): ReplayAssertion {
  return { key, obligation, provenance: "synthetic-companion", status: isDeepStrictEqual(actual, expected) ? "passed" : "failed", ...(isDeepStrictEqual(actual, expected) ? {} : { reason: "Independent structural oracle mismatch" }) };
}
export function unavailable(key: string, obligation: string, reason: string): ReplayAssertion { return { key, obligation, provenance: "observed-precondition", status: "unavailable", reason }; }
