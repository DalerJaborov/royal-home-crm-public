import { describe, expect, it } from "vitest";
import { assignmentWriteDenied, COMPLETED_ASSIGNMENT_MESSAGE } from "../src/lib/assignmentCompletion.js";
import { clientWriteDenied } from "../src/lib/clientWriteAccess.js";

const done = { assignmentCompletedAt: new Date() };

describe("завершённое закрепление: кто может писать и звонить", () => {
  it.each(["ADMIN", "DIRECTOR", "HEAD_OF_SALES"])("%s проходит", (role) => {
    expect(assignmentWriteDenied(done, role)).toBeNull();
  });

  it.each(["AGENT", "MANAGER", "OPERATOR", "SECURITY", "MARKETING", "SHAREHOLDER", undefined, null])("%s получает отказ", (role) => {
    expect(assignmentWriteDenied(done, role)).toBe(COMPLETED_ASSIGNMENT_MESSAGE);
  });

  it("без завершения отказа нет ни у кого", () => {
    expect(assignmentWriteDenied({ assignmentCompletedAt: null }, "AGENT")).toBeNull();
  });

  it("clientWriteDenied: РОП с правом назначать проходит, агент нет", () => {
    const client = { assignedAgentId: "other", assignmentCompletedAt: new Date() };
    expect(clientWriteDenied({ id: "r", role: "HEAD_OF_SALES", canAssignClients: true }, client, undefined)).toBeNull();
    expect(clientWriteDenied({ id: "a", role: "AGENT", canAssignClients: false }, client, undefined)).toBe(COMPLETED_ASSIGNMENT_MESSAGE);
  });
});
