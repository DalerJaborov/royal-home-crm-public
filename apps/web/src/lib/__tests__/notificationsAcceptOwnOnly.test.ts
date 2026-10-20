import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * «Принять» в уведомлениях — только по своему лиду (аудит 23.09.2026, №55):
 * руководитель видел кнопку у чужих лидов, сервер отвечал отказом.
 */
describe("уведомления: кнопка «Принять»", () => {
  it("строится только по лидам, отданным самому сотруднику", () => {
    const src = readFileSync(fileURLToPath(new URL("../../pages/Notifications.tsx", import.meta.url)), "utf8");
    const block = src.slice(src.indexOf("pendingAcceptance: true"), src.indexOf("pendingIdByShortId.set") + 60);
    expect(block).toMatch(/assignedAgentId === myAgentId/);
  });
});
