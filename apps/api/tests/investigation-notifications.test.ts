import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ findMany: vi.fn() }));
vi.mock("../src/db.js", () => ({ prisma: { $disconnect: vi.fn(), agent: { findMany: mocks.findMany } } }));
import {
  filterInvestigationRecipients, isInvestigationNotification,
  visibleNotificationsWhere, investigationNotificationWhere,
} from "../src/lib/investigationNotifications.js";

describe("investigation notifications role boundary", () => {
  beforeEach(() => mocks.findMany.mockReset());

  it("keeps ordinary operational notices even when their free text mentions security", async () => {
    const notice = { tag: "task-client-1", body: "СБ, проверка, увод — текст задачи клиента" };
    expect(isInvestigationNotification(notice)).toBe(false);
    expect(await filterInvestigationRecipients(["agent"], notice)).toEqual(["agent"]);
    expect(mocks.findMany).not.toHaveBeenCalled();
  });

  it.each(["security-review-client", "security-review-digest-week", "post-showing-call-review-id", "seller-property-missing-id", "alarm-refused-high-score-id", "voice-compliance"])("restricts historical producer %s", (tag) => {
    expect(isInvestigationNotification({ tag })).toBe(true);
  });

  it("classifies the historical duplicate only by its producer and generated reason", () => {
    expect(isInvestigationNotification({ tag: "deal-failed-id", body: "23.10, агент А: Купил самостоятельно — слова клиента" })).toBe(true);
    expect(isInvestigationNotification({ tag: "deal-failed-id", body: "23.10, агент А: Дорого — не сошлись по цене" })).toBe(false);
    expect(isInvestigationNotification({ tag: "task-id", body: "23.10, агент А: Купил самостоятельно" })).toBe(false);
  });

  it("rechecks current roles before every delivery, ignoring historical permission recipients", async () => {
    mocks.findMany.mockResolvedValueOnce([{ id: "director" }]).mockResolvedValueOnce([]);
    const candidates = ["agent-with-overrides", "rop", "security", "director"];
    expect(await filterInvestigationRecipients(candidates, { tag: "post-showing-call-id" })).toEqual(["director"]);
    expect(await filterInvestigationRecipients(candidates, { tag: "post-showing-call-id" })).toEqual([]);
    expect(mocks.findMany).toHaveBeenCalledWith({ where: { isActive: true, role: { in: ["ADMIN", "DIRECTOR"] } }, select: { id: true } });
  });

  it.each(["AGENT", "HEAD_OF_SALES", "MANAGER", "SECURITY", "MARKETING"])("filters history and counters for %s, retaining untagged ordinary rows", (role) => {
    expect(visibleNotificationsWhere("staff", role)).toEqual({ agentId: "staff", OR: [{ tag: null }, { NOT: investigationNotificationWhere() }] });
  });

  it.each(["ADMIN", "DIRECTOR"])("keeps private history for %s", (role) => {
    expect(visibleNotificationsWhere("owner", role)).toEqual({ agentId: "owner" });
  });
});
