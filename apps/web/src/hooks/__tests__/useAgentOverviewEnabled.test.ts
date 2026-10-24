import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Карточка сотрудника не должна слать `GET /agents/undefined/overview|live`
 * (перепись экранов 24.10.2026): маршрут `/team/undefined` отдаёт id строкой
 * «undefined», и прежний `enabled: !!agentId` её пропускал.
 */
const captured = vi.hoisted(() => ({ options: [] as { enabled: boolean }[] }));
vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: { enabled: boolean }) => {
    captured.options.push(options);
    return {};
  },
}));
vi.mock("../../lib/api", () => ({ api: vi.fn() }));

import { useAgentLive, useAgentOverview } from "../useAgentOverview";

describe("useAgentOverview / useAgentLive: enabled", () => {
  beforeEach(() => {
    captured.options = [];
  });

  it.each([undefined, "", "undefined", "null"])("запрос выключен при id=%j", (id) => {
    useAgentOverview(id);
    useAgentLive(id);
    expect(captured.options.map((o) => o.enabled)).toEqual([false, false]);
  });

  it("запрос включён при настоящем id", () => {
    useAgentOverview("abc");
    useAgentLive("abc");
    expect(captured.options.map((o) => o.enabled)).toEqual([true, true]);
  });
});
