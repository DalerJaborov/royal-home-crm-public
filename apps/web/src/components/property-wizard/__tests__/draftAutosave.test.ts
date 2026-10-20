import { describe, expect, it, vi } from "vitest";
import { DraftAutosave } from "../draftAutosave";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const result = { id: "draft-1", revision: 2, updatedAt: "2026-10-20T10:00:00Z" };
const micro = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

describe("DraftAutosave ordered acknowledgement and lifecycle", () => {
  it("serializes PUTs and never marks newer unsent edits saved", async () => {
    const first = deferred<typeof result>();
    const second = deferred<typeof result>();
    const save = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const status = vi.fn();
    const controller = new DraftAutosave(save, status);
    controller.stage({ values: { price: "10" }, step: 0 });
    const flushing = controller.flush();
    controller.stage({ values: { price: "20" }, step: 1 });
    void controller.flush();
    expect(save).toHaveBeenCalledTimes(1);
    first.resolve(result);
    await micro();
    expect(save).toHaveBeenCalledTimes(2);
    expect(status.mock.calls.some(([s]) => s.state === "server")).toBe(false);
    second.resolve({ ...result, revision: 3 });
    await flushing;
    expect(status).toHaveBeenLastCalledWith({ state: "server", savedAt: result.updatedAt });
    expect(save.mock.calls[1][0].values.price).toBe("20");
  });

  it("keeps a failed snapshot dirty and allows retry without new edits", async () => {
    const save = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(result);
    const status = vi.fn();
    const controller = new DraftAutosave(save, status);
    controller.stage({ values: { address: "saved locally" }, step: 1 });
    await expect(controller.flush()).rejects.toThrow("offline");
    expect(controller.dirty).toBe(true);
    expect(status).toHaveBeenLastCalledWith({ state: "local", message: "offline" });
    await controller.flush();
    expect(save).toHaveBeenCalledTimes(2);
    expect(controller.dirty).toBe(false);
  });

  it("invalidates pending acknowledgements and queued writes after create/delete/logout", async () => {
    const pending = deferred<typeof result>();
    const save = vi.fn().mockReturnValue(pending.promise);
    const status = vi.fn();
    const controller = new DraftAutosave(save, status);
    controller.stage({ values: { address: "A" }, step: 0 });
    const flushing = controller.flush();
    controller.stage({ values: { address: "B" }, step: 1 });
    controller.cancel();
    status.mockClear();
    pending.resolve(result);
    await flushing;
    expect(save).toHaveBeenCalledTimes(1);
    expect(status).not.toHaveBeenCalled();
    expect(controller.dirty).toBe(false);
  });
  it("a new generation can flush without waiting for an obsolete request", async () => {
    const pending = deferred<typeof result>();
    const save = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValueOnce({ ...result, revision: 4 });
    const status = vi.fn();
    const controller = new DraftAutosave(save, status);
    controller.stage({ values: { address: "old" }, step: 0 });
    const old = controller.flush();
    controller.cancel();
    controller.stage({ values: { address: "new" }, step: 1 });
    await controller.flush();
    expect(save).toHaveBeenCalledTimes(2);
    expect(controller.dirty).toBe(false);
    pending.resolve(result); await old;
    expect(controller.dirty).toBe(false);
  });
});
