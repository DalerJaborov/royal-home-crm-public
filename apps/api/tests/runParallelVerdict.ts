/** Vitest 4 can label an unfinished file passed and set success:true.
 * Only a successful process and fully accounted terminal assertions are green. */
export type ShardReportLike = Record<string, unknown>;
export type ShardVerdict = "green" | "red";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const COUNTERS = [
  "numTotalTests", "numPassedTests", "numFailedTests", "numPendingTests", "numTodoTests",
  "numTotalTestSuites", "numPassedTestSuites", "numFailedTestSuites", "numPendingTestSuites",
] as const;

export function shardVerdict(code: number, report: ShardReportLike | null): ShardVerdict {
  if (code !== 0 || !isRecord(report) || report.success !== true) return "red";
  for (const key of COUNTERS) {
    const value = report[key];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return "red";
  }
  if (report.numFailedTests !== 0 || report.numFailedTestSuites !== 0) return "red";
  const files = report.testResults;
  if (!Array.isArray(files) || files.length === 0) return "red";
  const names = new Set<string>();
  const observed = { passed: 0, skipped: 0, todo: 0 };
  for (const file of files) {
    if (!isRecord(file) || file.status !== "passed" || typeof file.name !== "string" || !file.name.trim()) return "red";
    if (names.has(file.name)) return "red";
    names.add(file.name);
    if (!Array.isArray(file.assertionResults) || file.assertionResults.length === 0) return "red";
    for (const assertion of file.assertionResults) {
      if (!isRecord(assertion)) return "red";
      switch (assertion.status) {
        case "passed": observed.passed++; break;
        case "skipped": observed.skipped++; break;
        case "todo": observed.todo++; break;
        default: return "red"; // pending/run/queued/unknown are not intentional skips.
      }
    }
  }
  // Vitest's numPendingTests includes skipped tests AND running tests; distinguish
  // them using assertion statuses rather than rejecting legitimate skips.
  if (report.numPassedTests !== observed.passed || report.numPendingTests !== observed.skipped ||
      report.numTodoTests !== observed.todo || report.numTotalTests !== observed.passed + observed.skipped + observed.todo) return "red";
  if (report.numTotalTestSuites !== (report.numPassedTestSuites as number) + (report.numPendingTestSuites as number)) return "red";
  return "green";
}

export type MergedShardReport = Record<string, unknown> & { success: boolean; testResults: unknown[] };

/** The merged success flag is a verdict, never a reinterpretation of file labels. */
export function mergeShardReports(reports: readonly (ShardReportLike | null)[], codes: readonly number[]): MergedShardReport {
  const merged: MergedShardReport = { testResults: [], success: false };
  for (const part of reports) {
    if (!isRecord(part)) continue;
    for (const [key, value] of Object.entries(part)) {
      if (key === "success") continue;
      if (key === "testResults") {
        if (Array.isArray(value)) merged.testResults.push(...value);
      } else if (key === "startTime" && typeof value === "number") {
        merged.startTime = typeof merged.startTime === "number" ? Math.min(merged.startTime, value) : value;
      } else if (typeof value === "number") {
        merged[key] = (typeof merged[key] === "number" ? merged[key] as number : 0) + value;
      } else if (merged[key] === undefined) {
        merged[key] = value;
      }
    }
  }
  const names = merged.testResults.map((file) => isRecord(file) ? file.name : undefined);
  merged.success = reports.length > 0 && reports.length === codes.length &&
    reports.every((part, index) => shardVerdict(codes[index], part) === "green") &&
    new Set(names).size === names.length;
  return merged;
}
