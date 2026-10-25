import { describe, expect, it } from "vitest";
import { investigationCaseConfigSchema, investigationCaseConfigUpdateSchema, investigationDecisionSchema } from "@royal-home/shared";
import { evaluateInvestigationRecurrence } from "../src/lib/investigationRecurrence.js";
import { randomUUID } from "node:crypto";

describe("investigation preview configuration", () => {
  it("requires explicit thresholds, rejects negative/fractional/excessive input and defaults only the period", () => {
    expect(investigationCaseConfigSchema.safeParse({}).success).toBe(false);
    expect(investigationCaseConfigSchema.parse({ minSample: 5, repeatThreshold: 2 })).toEqual({ minSample: 5, repeatThreshold: 2, windowDays: 30 });
    for (const bad of [0, -1, 1.5, 1000001]) {
      expect(investigationCaseConfigSchema.safeParse({ minSample: bad, repeatThreshold: 2 }).success).toBe(false);
      expect(investigationCaseConfigSchema.safeParse({ minSample: 5, repeatThreshold: bad }).success).toBe(false);
    }
    expect(investigationCaseConfigSchema.safeParse({ minSample: 5, repeatThreshold: 2, windowDays: -1 }).success).toBe(false);
    expect(investigationCaseConfigUpdateSchema.safeParse({ config: {} }).success).toBe(true);
    expect(investigationCaseConfigUpdateSchema.safeParse({ config: null }).success).toBe(true);
  });
  it("counts distinct cases, groups correlated evidence, preserves cleared cases without treating them as repeated suspicion", () => {
    const cases = [
      { id: "a", subjectAgentId: "agent", status: "OPEN", evidence: Array.from({ length: 3 }, () => ({ independenceKey: "same-call" })) },
      { id: "b", subjectAgentId: "agent", status: "CLEARED", evidence: [{ independenceKey: "another-call" }] },
    ];
    expect(evaluateInvestigationRecurrence(null, cases)[0].evaluation).toBe("NOT_CONFIGURED");
    expect(evaluateInvestigationRecurrence({ minSample: 3, repeatThreshold: 1, windowDays: 30 }, cases)[0].evaluation).toBe("INSUFFICIENT_SAMPLE");
    const evaluated = evaluateInvestigationRecurrence({ minSample: 2, repeatThreshold: 2, windowDays: 30 }, [...cases, cases[0]])[0];
    expect(evaluated).toMatchObject({ cases: 2, sourceGroups: 2, cleared: 1, confirmed: 0, evaluation: "BELOW_REPEAT_THRESHOLD" });
    expect(evaluateInvestigationRecurrence({ minSample: 2, repeatThreshold: 1, windowDays: 30 }, cases)[0].evaluation).toBe("REPEATED_CASES_FOR_REVIEW");
    expect(cases.map(row => row.status)).toEqual(["OPEN", "CLEARED"]);
    expect(evaluated).not.toHaveProperty("level");
  });
  it("allows human C1-C3 only for review, never a client supplied C4 level", () => {
    const decision = { requestKey: randomUUID(), revision: 1, note: "Human explanation", status: "REVIEWING" };
    expect(investigationDecisionSchema.safeParse({ ...decision, level: "C3" }).success).toBe(true);
    expect(investigationDecisionSchema.safeParse({ ...decision, level: "C4" }).success).toBe(false);
    expect(investigationDecisionSchema.safeParse({ ...decision, status: "OPEN", level: "C3" }).success).toBe(false);
  });
});
