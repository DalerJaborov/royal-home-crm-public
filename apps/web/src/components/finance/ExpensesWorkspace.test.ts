import { describe, expect, it, vi } from "vitest";
import { createExpenseActionLock, parseExpenseEditAmount } from "./ExpensesWorkspace";

describe("редактирование суммы расхода", () => {
  it("принимает дробную сумму в исходной валюте, включая десятичную запятую", () => {
    expect(parseExpenseEditAmount(" 300,25 ")).toBe(300.25);
    expect(parseExpenseEditAmount("300.25")).toBe(300.25);
  });

  it.each(["", "0", "-1", "abc", "Infinity", "1,2,3"])("отклоняет %j, не отправляя нулевую/некорректную сумму", (value) => {
    expect(parseExpenseEditAmount(value)).toBeNull();
  });
});

describe("единственный запрос расхода до завершения операции", () => {
  it("быстрые Enter и повторный клик выполняют одну мутацию", async () => {
    const run = createExpenseActionLock();
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    const mutate = vi.fn(() => pending);
    const first = run(mutate);
    expect(await run(mutate)).toBe(false);
    expect(mutate).toHaveBeenCalledTimes(1);
    finish();
    expect(await first).toBe(true);
    expect(await run(async () => {})).toBe(true);
  });

  it("после сетевой ошибки разрешает явный повтор", async () => {
    const run = createExpenseActionLock();
    await expect(run(async () => { throw new Error("offline"); })).rejects.toThrow("offline");
    const retry = vi.fn(async () => {});
    expect(await run(retry)).toBe(true);
    expect(retry).toHaveBeenCalledOnce();
  });

  it("общая блокировка не допускает удаления одновременно с сохранением", async () => {
    const run = createExpenseActionLock();
    let finish!: () => void;
    const first = run(() => new Promise<void>((resolve) => { finish = resolve; }));
    const remove = vi.fn(async () => {});
    expect(await run(remove)).toBe(false);
    expect(remove).not.toHaveBeenCalled();
    finish();
    await first;
  });
});
