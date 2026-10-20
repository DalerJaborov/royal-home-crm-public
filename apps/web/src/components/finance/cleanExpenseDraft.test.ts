import { describe, expect, it, vi } from "vitest";
import { createCleanExpenseSubmitLock, prepareCleanExpense, type CleanExpenseDraft } from "./cleanExpenseDraft";

const draft: CleanExpenseDraft = {
  amount: "500,25", category: "OFFICE", note: "Аренда офиса", source: "", agentId: "",
  month: "2026-10", repeat: false, day: "1",
};
describe("supported Clean expense requests", () => {
  it("accepts an unambiguous two-decimal amount through the shared schema", () => {
    const request = prepareCleanExpense({ ...draft, amount: "500.25" });
    expect(request).toEqual({ ok: true, kind: "expense", body: { amount: 500.25, category: "OFFICE", note: "Аренда офиса", month: "2026-10", source: undefined, agentId: undefined } });
  });
  it.each(["", "0", "-2", "Infinity", "1,2,3", "0x10", "1e3", "1.000", "1,000", "500.257", "100000000", "99999999999999999999"])("does not send invalid amount %s", (amount) => {
    expect(prepareCleanExpense({ ...draft, amount })).toMatchObject({ ok: false, field: "amount" });
  });
  it("keeps attribution mandatory for advertising and salary", () => {
    expect(prepareCleanExpense({ ...draft, category: "ADVERTISING" })).toMatchObject({ ok: false, field: "source" });
    expect(prepareCleanExpense({ ...draft, category: "SALARY" })).toMatchObject({ ok: false, field: "agentId" });
  });
  it("removes stale attribution when the category changes", () => {
    const request = prepareCleanExpense({ ...draft, source: "INSTAGRAM", agentId: "a156e483-c40d-42b8-bd8a-df82856ff817" });
    expect(request.ok && request.body.source).toBeUndefined();
    expect(request.ok && request.body.agentId).toBeUndefined();
  });
  it("keeps the chosen accounting month and rejects an invalid one", () => {
    expect(prepareCleanExpense({ ...draft, month: "2026-09" })).toMatchObject({ ok: true, body: { month: "2026-09" } });
    expect(prepareCleanExpense({ ...draft, month: "2026-13" })).toMatchObject({ ok: false, field: "month" });
  });
  it("sends only the actual recurring template fields and retains its channel", () => {
    expect(prepareCleanExpense({ ...draft, repeat: true, category: "ADVERTISING", source: "INSTAGRAM", day: "28" })).toEqual({
      ok: true, kind: "recurring", body: { title: "Аренда офиса", amount: 500.25, currency: "TJS", category: "ADVERTISING", dayOfMonth: 28, source: "INSTAGRAM", agentId: undefined },
    });
  });
  it.each(["0", "29", "1.5", "oops"])("rejects unsupported recurring day %s instead of changing it", (day) => {
    expect(prepareCleanExpense({ ...draft, repeat: true, day })).toMatchObject({ ok: false, field: "day" });
  });
  it("requires a title even for a recurring advertising template", () => {
    expect(prepareCleanExpense({ ...draft, repeat: true, category: "ADVERTISING", source: "INSTAGRAM", note: "" })).toMatchObject({ ok: false, field: "note" });
    expect(prepareCleanExpense({ ...draft, repeat: true, note: "x".repeat(201) })).toMatchObject({ ok: false, field: "note" });
  });
  it("retains the salary employee in the recurring request", () => {
    expect(prepareCleanExpense({ ...draft, repeat: true, category: "SALARY", agentId: "a156e483-c40d-42b8-bd8a-df82856ff817" })).toMatchObject({ ok: true, body: { agentId: "a156e483-c40d-42b8-bd8a-df82856ff817" } });
  });
});

describe("expense submit lock", () => {
  it("blocks a same-tick second save and releases after completion", async () => {
    const lock = createCleanExpenseSubmitLock();
    let finish!: () => void;
    const save = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const first = lock.run(save);
    expect(lock.isBusy()).toBe(true);
    expect(await lock.run(save)).toBe(false);
    expect(save).toHaveBeenCalledOnce();
    finish(); await first;
    expect(lock.isBusy()).toBe(false);
  });
  it("allows retry after the server rejects a save", async () => {
    const lock = createCleanExpenseSubmitLock();
    await expect(lock.run(async () => { throw new Error("offline"); })).rejects.toThrow("offline");
    expect(lock.isBusy()).toBe(false);
    expect(await lock.run(async () => {})).toBe(true);
  });
});
