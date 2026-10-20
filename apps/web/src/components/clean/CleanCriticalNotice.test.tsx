import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import type { McFirstLineItem } from "../../hooks/useMissionControl";
import {
  CleanCriticalNotice, criticalNoticeQueue, readCriticalDecisions,
  safeCriticalHref, updateCriticalDecision,
} from "./CleanCriticalNotice";

const critical: McFirstLineItem = { id: "missed-calls", severity: "critical", text: "Есть пропущенные звонки", href: "/calls?filter=missed" };
const other: McFirstLineItem = { id: "unassigned", severity: "critical", text: "Новые обращения без ответственного", href: "/clients" };

describe("critical event notice", () => {
  it("queues only actual critical events with safe internal destinations", () => {
    expect(criticalNoticeQueue([
      critical, critical, { ...other, severity: "warn" }, { ...other, href: "https://example.com" }, other,
    ], {}, 0)).toEqual([critical, other]);
    for (const href of ["//example.com", "/\\example.com", "javascript:alert(1)", "/calls\n", "data:text/html,example"])
      expect(safeCriticalHref(href)).toBe(false);
  });

  it("acknowledging hides only this event; changed server content reappears", () => {
    const decisions = updateCriticalDecision({}, critical, "acknowledge", 100);
    expect(criticalNoticeQueue([critical, other], decisions, 100)).toEqual([other]);
    expect(criticalNoticeQueue([{ ...critical, text: "Уже 10 пропущенных звонков" }], decisions, 100)).toHaveLength(1);
  });

  it("snoozes for exactly one hour and lets the next event through", () => {
    const decisions = updateCriticalDecision({}, critical, "snooze", 100);
    expect(criticalNoticeQueue([critical, other], decisions, 100 + 3_600_000 - 1)).toEqual([other]);
    expect(criticalNoticeQueue([critical, other], decisions, 100 + 3_600_000)).toEqual([critical, other]);
  });

  it("reload restores personal decisions without hiding another person's events", () => {
    const decisions = updateCriticalDecision({}, critical, "acknowledge", 100);
    const storage = { getItem: (key: string) => key === "rh-clean-critical:v1:owner" ? JSON.stringify(decisions) : null };
    expect(criticalNoticeQueue([critical], readCriticalDecisions(storage, "owner"), 200)).toEqual([]);
    expect(criticalNoticeQueue([critical], readCriticalDecisions(storage, "admin"), 200)).toEqual([critical]);
    expect(readCriticalDecisions({ getItem: () => { throw new Error("blocked"); } }, "owner")).toEqual({});
    expect(readCriticalDecisions({ getItem: () => "invalid JSON" }, "owner")).toEqual({});
  });

  it("renders one nonmodal card, keeps the queue visible and uses the real route", () => {
    const html = renderToStaticMarkup(<MemoryRouter><CleanCriticalNotice agentId="owner" items={[critical, other]} /></MemoryRouter>);
    expect(html).toContain(critical.text);
    expect(html).not.toContain(other.text);
    expect(html).toContain("В очереди: 2");
    expect(html).toContain('href="/calls?filter=missed"');
    expect(html).toContain("Само событие остаётся в пульте");
    expect(html).not.toMatch(/autofocus|aria-modal|role="dialog"/);
  });
});
