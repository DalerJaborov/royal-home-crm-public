/** Describes observable follow-up only; never an inference about guilt or all external channels. */
export function classifyPostShowingFollowup(input: {
  excluded: boolean; publicResponse: boolean; robotResponse: boolean; status: string;
  outcome: string | null; attempts: number; lastAttemptAt: Date | null;
  showingAt: Date; asOf: Date; skipReason: string | null;
}) {
  if (input.excluded) return { eligible: false, signal: false, state: "UNKNOWN" as const };
  if (input.publicResponse) return { eligible: true, signal: false, state: "RESPONDED" as const };
  if (input.robotResponse) return { eligible: true, signal: false,
    state: input.status === "DONE" && ["REFUSED", "UNCLEAR"].includes(input.outcome ?? "") ? "UNRESOLVED_SURVEY" as const : "RESPONDED" as const };
  if (input.status === "GIVEN_UP" && input.attempts >= 2 && input.lastAttemptAt && input.lastAttemptAt > input.showingAt && input.lastAttemptAt <= input.asOf && !input.skipReason)
    return { eligible: true, signal: true, state: "NO_RESPONSE_TO_COMPLETED_SURVEY_ATTEMPTS" as const };
  return { eligible: false, signal: false, state: "UNKNOWN" as const };
}
