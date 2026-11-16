// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const dropped = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../../lib/swApiCache", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/swApiCache")>();
  return { ...actual, dropSwApiCache: dropped };
});

import { useAuthStore } from "../auth";

const agent = { id: "a1", fullName: "Тест", phone: "test", role: "AGENT" } as never;

describe("store/auth чистит кэш воркера общей функцией", () => {
  beforeEach(() => dropped.mockClear());
  it("при входе и при выходе", () => {
    useAuthStore.getState().setSession(agent, "token");
    expect(dropped).toHaveBeenCalledTimes(1);
    useAuthStore.getState().logout();
    expect(dropped).toHaveBeenCalledTimes(2);
  });
});
