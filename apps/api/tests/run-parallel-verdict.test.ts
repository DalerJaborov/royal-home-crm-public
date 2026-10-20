import { describe, expect, it } from "vitest";
import { mergeShardReports, shardVerdict, type ShardReportLike } from "./runParallelVerdict.js";

function report(name = "tests/one.test.ts", statuses = ["passed"]): ShardReportLike {
  return {
    success: true, startTime: 100,
    numTotalTestSuites: 1, numPassedTestSuites: 1, numFailedTestSuites: 0, numPendingTestSuites: 0,
    numTotalTests: statuses.length,
    numPassedTests: statuses.filter((s) => s === "passed").length,
    numFailedTests: statuses.filter((s) => s === "failed").length,
    numPendingTests: statuses.filter((s) => s === "skipped" || s === "pending").length,
    numTodoTests: statuses.filter((s) => s === "todo").length,
    testResults: [{ name, status: "passed", assertionResults: statuses.map((status) => ({ status })) }],
  };
}

describe("shardVerdict — process success and complete assertions", () => {
  it("accepts completed runs including intentional skipped and todo tests", () => {
    expect(shardVerdict(0, report())).toBe("green");
    expect(shardVerdict(0, report("skip", ["passed", "skipped", "todo"]))).toBe("green");
    expect(shardVerdict(0, report("todo", ["todo"]))).toBe("green");
  });
  it.each([1, 137, -1, Number.NaN])("process exit %s is red even with a complete report", (code) => {
    expect(shardVerdict(code, report())).toBe("red");
  });
  it("rejects the 14.10 mechanism: all file labels passed/success true but unfinished assertions", () => {
    const unfinished = report("tests/ad-opener-neutral-question.test.ts", ["pending", "pending", "pending"]);
    Object.assign(unfinished, {
      numTotalTestSuites: 2077, numPassedTestSuites: 2076, numPendingTestSuites: 1,
      numTotalTests: 5280, numPassedTests: 5274, numPendingTests: 1, numTodoTests: 3,
    });
    expect(shardVerdict(0, unfinished)).toBe("red");
    expect(shardVerdict(1, unfinished)).toBe("red");
  });
  it.each(["pending", "run", "queued", "unknown", "failed"])("does not treat %s as an intentional skip", (status) => {
    expect(shardVerdict(0, report("one", [status]))).toBe("red");
  });
  it.each(["numTotalTests", "numPassedTests", "numFailedTests", "numPendingTests", "numTodoTests",
    "numTotalTestSuites", "numPassedTestSuites", "numFailedTestSuites", "numPendingTestSuites"])("requires counter %s", (key) => {
    const incomplete = report();
    delete incomplete[key];
    expect(shardVerdict(0, incomplete)).toBe("red");
  });
  it.each(["0", -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])("rejects invalid counter %s", (value) => {
    expect(shardVerdict(0, { ...report(), numFailedTests: value })).toBe("red");
  });
  it("detects missing assertions even when all reported assertions passed", () => {
    expect(shardVerdict(0, { ...report(), numTotalTests: 2 })).toBe("red");
    expect(shardVerdict(0, { ...report(), numPassedTests: 2 })).toBe("red");
    expect(shardVerdict(0, { ...report(), numPendingTests: 1 })).toBe("red");
    expect(shardVerdict(0, { ...report(), numTodoTests: 1 })).toBe("red");
    expect(shardVerdict(0, { ...report(), numTotalTestSuites: 2 })).toBe("red");
  });
  it("requires success, files, unique names and assertion arrays", () => {
    expect(shardVerdict(0, null)).toBe("red");
    expect(shardVerdict(0, {})).toBe("red");
    expect(shardVerdict(0, { ...report(), success: false })).toBe("red");
    expect(shardVerdict(0, { ...report(), testResults: [] })).toBe("red");
    expect(shardVerdict(0, { ...report(), testResults: [{ name: "one", status: "passed" }] })).toBe("red");
    expect(shardVerdict(0, report("empty", []))).toBe("red");
    const duplicate = report("same", ["passed", "passed"]);
    duplicate.testResults = [...report("same").testResults as unknown[], ...report("same").testResults as unknown[]];
    expect(shardVerdict(0, duplicate)).toBe("red");
  });
});

describe("mergeShardReports — exported success must agree with the gate", () => {
  it("merges a completed pair with earliest start time and exact counters", () => {
    const first = report("first", ["passed", "skipped"]);
    const second = { ...report("second", ["todo"]), startTime: 50 };
    expect(mergeShardReports([first, second], [0, 0])).toMatchObject({
      success: true, startTime: 50, numTotalTests: 3, numPassedTests: 1, numPendingTests: 1, numTodoTests: 1,
      testResults: [...first.testResults as unknown[], ...second.testResults as unknown[]],
    });
  });
  it("cannot wash away nonzero exit, unfinished assertions or a missing shard", () => {
    expect(mergeShardReports([report()], [1]).success).toBe(false);
    expect(mergeShardReports([report("first"), report("unfinished", ["pending"])], [0, 0]).success).toBe(false);
    expect(mergeShardReports([report(), null], [0, 0]).success).toBe(false);
    expect(mergeShardReports([report()], []).success).toBe(false);
    expect(mergeShardReports([], []).success).toBe(false);
    expect(mergeShardReports([report("same"), report("same")], [0, 0]).success).toBe(false);
  });
  it("retains failed file diagnostics rather than returning an empty success", () => {
    const incomplete = report("incomplete", ["pending"]);
    const merged = mergeShardReports([incomplete], [1]);
    expect(merged.success).toBe(false);
    expect(merged.testResults).toEqual(incomplete.testResults);
    expect(merged.numPendingTests).toBe(1);
  });
});
