import { describe, expect, it } from "vitest";
import { conversationBotState } from "../conversationBotState";

const now = Date.parse("2026-10-26T00:00:00Z");
const future = "2026-10-27T00:00:00Z";
const paused = { id: "stand-paused", canReply: true, pausedUntil: future };
const live = { id: "stand-live", canReply: true, pausedUntil: null };
const history = { id: "td_stand-history", canReply: false, pausedUntil: null };
const group = { id: "client:stand-client", grouped: true, pausedUntil: null };

describe("conversation bot source state", () => {
  it("does not use the group's empty pause field for a paused source", () => {
    expect(conversationBotState({ ...group, sources: [paused] }, now))
      .toEqual({ paused: true, label: "Бот на паузе", controlId: null });
  });
  it("reports mixed pause state without granting a group action", () => {
    expect(conversationBotState({ ...group, sources: [paused, live, history] }, now))
      .toEqual({ paused: true, label: "Бот на паузе: 1 из 2 каналов", controlId: null });
  });
  it.each([paused, live])("targets only the selected writable source $id", selected => {
    expect(conversationBotState({ ...group, sources: [paused, live], selectedSourceId: selected.id }, now))
      .toEqual({ paused: selected === paused, label: selected === paused ? "Бот на паузе" : "Бот не на паузе", controlId: selected.id });
  });
  it.each(["foreign", history.id, group.id])("does not turn %s into a bot-control target", selectedSourceId => {
    expect(conversationBotState({ ...group, sources: [paused, live, history], selectedSourceId }, now).controlId).toBeNull();
  });
  it("does not call a read-only Direct history an active bot", () => {
    expect(conversationBotState({ ...group, sources: [history] }, now))
      .toEqual({ paused: false, label: "Только история", controlId: null });
  });
  it("preserves single-chat control and expires pauses at the actual deadline", () => {
    expect(conversationBotState({ id: "stand-single", grouped: false, pausedUntil: future }, now).controlId).toBe("stand-single");
    expect(conversationBotState({ ...group, sources: [{ ...paused, pausedUntil: new Date(now).toISOString() }] }, now).paused).toBe(false);
    expect(conversationBotState({ ...group, sources: [{ ...paused, pausedUntil: "invalid" }] }, now).paused).toBe(false);
  });
});
