import { describe, expect, it, vi } from "vitest";
import type { Settings } from "../src/generated/prisma/client.js";

vi.mock("../src/db.js", () => ({ prisma: {
  $disconnect: vi.fn().mockResolvedValue(undefined),
  _runtimeDataModel: { models: { Settings: { fields: [
    { name: "id", type: "String" },
    { name: "companyName", type: "String" },
    { name: "uiShellRollout", type: "Json" },
  ] } } },
} }));

import { diffSnapshot, planRestore } from "../src/lib/settingsSnapshots.js";

describe("rollout is isolated from general settings restoration", () => {
  const active = { enabled: true, agentIds: ["owner"], roles: ["DIRECTOR"] };
  const off = { enabled: false, agentIds: [], roles: [] };

  it.each([active, null, { enabled: true, roles: ["AGENT"] }])("old snapshots cannot re-enable a killed shell: %j", (stored) => {
    const current = { id: "singleton", companyName: "Current", uiShellRollout: off } as unknown as Settings;
    const payload = { id: "singleton", companyName: "Previous", uiShellRollout: stored };
    expect(planRestore(payload, current, null).data).toEqual({ companyName: "Previous" });
    expect(diffSnapshot(payload, current).map((change) => change.field)).toEqual(["companyName"]);
  });

  it("general restoration also cannot disable an intentionally enabled rollout", () => {
    const current = { id: "singleton", companyName: "Current", uiShellRollout: active } as unknown as Settings;
    expect(planRestore({ uiShellRollout: off }, current, null).data).toEqual({});
  });
});
