import type { ChannelTurnResult } from "../../src/ai/channelTurnResult.js";

/**
 * One brain, step 3b (16.11.2026): the old customer bot is deleted. Tests of the channel BODIES (debounce, pause, budget,
 * photos, toggles, …) used to fake the model under the old bot; now they fake the one door
 * (ai/customerChannelTurn.ts::runCustomerChannelTurn) with the same scripted answers: the door receives the turn history and
 * returns what the test's model mock returns (the channels' result shape). Prompt contents are no longer asserted anywhere —
 * the old prompt is gone; the core's prompt is covered by its own tests.
 */
export function channelBrainFromModel(model: (input: { endpoint: "channel-turn"; messages: unknown[] }) => unknown) {
  return async (history: unknown[]): Promise<ChannelTurnResult | null> => {
    const result = await model({ endpoint: "channel-turn", messages: history });
    return (result ?? null) as ChannelTurnResult | null;
  };
}
