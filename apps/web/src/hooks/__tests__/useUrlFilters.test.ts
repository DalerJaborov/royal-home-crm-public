import { describe, expect, it, vi } from "vitest";
vi.mock("react", () => ({ useEffect: (effect: () => void) => effect() }));
import { useSyncFiltersToUrl } from "../useUrlFilters";

describe("list filter URL ownership", () => {
  it("removes cleared filters and view without deleting unrelated parameters", () => {
    const write = vi.fn();
    useSyncFiltersToUrl(new URLSearchParams("status=WITHDRAWN&agentId=old&view=cards&noVideo=1&shell=clean&page=4"), write, {
      status: undefined, agentId: undefined, view: undefined, noVideo: undefined,
    }, ["page"]);
    expect(write).toHaveBeenCalledOnce();
    expect(write.mock.calls[0][0].toString()).toBe("shell=clean");
    expect(write.mock.calls[0][1]).toEqual({ replace: true });
  });
  it("does not navigate again when the canonical link already matches", () => {
    const write = vi.fn();
    useSyncFiltersToUrl(new URLSearchParams("status=AVAILABLE&q=центр"), write, { status: "AVAILABLE", q: "центр", agentId: undefined });
    expect(write).not.toHaveBeenCalled();
  });
});
