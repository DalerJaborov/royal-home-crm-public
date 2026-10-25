import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { InteractionTimeline } from "../../components/InteractionTimeline";
import { bookedShowingsByProperty, isLiveShowing, showingConfirmationBadge } from "../clientFormat";
import type { Interaction } from "../../types";
import { conductedShowings } from "../clientSignals";

const showing: Interaction = {
  id: "cancelled", clientId: "client", agentId: "agent", type: "SHOWING", propertyId: "property",
  notes: "Встреча у объекта", outcome: null, nextAction: "Провести показ", nextActionDate: "2099-01-01T10:00:00Z",
  createdAt: "2026-10-23T10:00:00Z", taskCancelledAt: "2026-10-23T11:00:00Z", completedAt: null,
};

describe("cancelled task history", () => {
  it("does not reserve a showing or imply completion", () => {
    expect(isLiveShowing(showing)).toBe(false);
    expect(conductedShowings([{ ...showing, nextActionDate: "2020-01-01T10:00:00Z" }])).toBe(0);
    expect(bookedShowingsByProperty([showing]).size).toBe(0);
    expect(showingConfirmationBadge(showing)?.label).toBe("Отменено");
    expect(isLiveShowing({ ...showing, taskCancelledAt: null })).toBe(true);
  });
  it.each(["SHOWING", "MEETING"] as const)("labels %s history plainly without actionable controls", type => {
    const html = renderToStaticMarkup(<InteractionTimeline interactions={[{ ...showing, type }]} />);
    expect(html).toContain("Отменено");
    expect(html).not.toMatch(/СБ|Просрочено|Выполнено|Перенести|Завершить/);
  });
});
