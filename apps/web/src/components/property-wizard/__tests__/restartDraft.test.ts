import { describe, expect, it, vi } from "vitest";
import { runRestartDraft } from "../restartDraft";

/**
 * WEB-05: «Начать заново» сначала удаляет серверный черновик и только потом
 * включает автосохранение (04.10.2026). Иначе PUT автосохранения при задержанном
 * или упавшем DELETE возвращал старый черновик вместе с его фото, и новый объект
 * получал невидимые снимки прежнего.
 */
function deferred() {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("runRestartDraft", () => {
  it("пока DELETE висит, автосохранение не включено; после успеха включается", async () => {
    const del = deferred();
    const commit = vi.fn();
    const fail = vi.fn();
    const run = runRestartDraft("server", { deleteServerDraft: () => del.promise, commit, fail });
    await Promise.resolve();
    expect(commit).not.toHaveBeenCalled();
    del.resolve();
    expect(await run).toBe(true);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(fail).not.toHaveBeenCalled();
  });

  it("DELETE упал: ошибка показана, гейт остаётся, автосохранение не включено", async () => {
    const commit = vi.fn();
    const fail = vi.fn();
    const ok = await runRestartDraft("server", {
      deleteServerDraft: async () => {
        throw new Error("сеть пропала");
      },
      commit,
      fail,
    });
    expect(ok).toBe(false);
    expect(commit).not.toHaveBeenCalled();
    expect(fail).toHaveBeenCalledWith(expect.stringContaining("Не удалось удалить прежний черновик"));
  });

  it("локальный черновик после ошибки GET: сначала проверяем и удаляем серверный", async () => {
    const del = vi.fn();
    const commit = vi.fn();
    expect(await runRestartDraft("local", { deleteServerDraft: del, commit, fail: vi.fn() })).toBe(true);
    expect(del).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledTimes(1);
  });
});
