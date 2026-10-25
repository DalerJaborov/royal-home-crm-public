import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { postShowingCohortConfigSchema, type PostShowingCohortView } from "@royal-home/shared";
import { PostShowingCohortFacts } from "./PostShowingCohort";
const data: PostShowingCohortView = { version: 2, from: "2026-10-01T00:00:00Z", to: "2026-10-25T00:00:00Z", asOf: "2026-10-25T00:00:00Z", source: "RECORDED_SHOWINGS_WITH_POST_SHOWING_AGENT_SNAPSHOT", evaluation: "DEFINITION_PENDING", config: postShowingCohortConfigSchema.parse({}), coverage: { recordedShowings: 20, unobserved: 12, preview: 3, pending: 1, stationOutage: 2, occurrenceUnconfirmed: 4 }, limitations: ["Не все каналы наблюдаемы"], agents: [{ agentId: "a", agentName: "Синтетический агент", recorded: 8, publicResponses: 2, robotResponses: 1, unresolvedSurvey: 1, unknown: 5, eligible: null, silent: null, ratePercent: null, peerEligible: null, peerRatePercent: null }] };
describe("cohort snapshot truthfulness", () => {
  it("shows coverage and does not present unknown numerator as a zero percent", () => {
    const html = renderToStaticMarkup(<PostShowingCohortFacts data={data} />);
    expect(html).toContain("Сохранён ранний срез без классификации"); expect(html).toContain("Не все каналы наблюдаемы"); expect(html).toContain("Без снимка агента опроса: 12"); expect(html).not.toContain("0%");
  });
});
