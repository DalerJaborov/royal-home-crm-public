import { describe, expect, it } from "vitest";
import { groupNotifications, notificationGroupDescriptors, PINNED_NOTIFICATION_LEVELS } from "../notificationGroups";

const items = [{ id: "approval", level: "APPROVAL" }, { id: "critical", level: "CRITICAL" },
  { id: "insight", level: "INSIGHT" }, { id: "other", level: "OTHER" }, { id: "legacy" }, { id: "future", level: "UNKNOWN_NEW_LEVEL" }];
describe("notification presentation groups", () => {
  it.each(["ADMIN", "DIRECTOR"])("shows three complete queues for %s", role => {
    const groups = groupNotifications(role, items, [{ id: "older-approval", level: "APPROVAL" }, items[0]]);
    expect(groups.map(group => group.title)).toEqual(["Согласования", "Контроль", "Мои задачи и подсказки"]);
    const ids = groups.flatMap(group => group.section.map(item => item.id));
    expect(ids).toHaveLength(7); expect(new Set(ids).size).toBe(7);
    expect(groups[0].section.map(item => item.id)).toEqual(["older-approval", "approval"]);
    expect(groups[2].section.map(item => item.id)).toEqual(["insight", "other", "legacy", "future"]);
  });
  it.each(["AGENT", "MANAGER", "SECURITY", undefined])("keeps four groups for %s without dropping legacy levels", role => {
    expect(notificationGroupDescriptors(role)).toHaveLength(4);
    const groups = groupNotifications(role, items, []);
    expect(groups.flatMap(group => group.section)).toHaveLength(items.length);
    expect(groups[3].section.map(item => item.id)).toEqual(["other", "legacy", "future"]);
  });
  it("retains full-queue approval/critical membership and never mutates read receipts", () => {
    const pinned = [{ id: "old", level: "APPROVAL", read: true }, { id: "urgent", level: "CRITICAL", read: false }];
    const result = groupNotifications("ADMIN", [], pinned);
    expect(PINNED_NOTIFICATION_LEVELS).toEqual(["APPROVAL", "CRITICAL"]);
    expect(result[0].section[0]).toBe(pinned[0]);
    expect(result[1].section[0]).toBe(pinned[1]);
    expect(pinned.map(item => item.read)).toEqual([true, false]);
  });
});
