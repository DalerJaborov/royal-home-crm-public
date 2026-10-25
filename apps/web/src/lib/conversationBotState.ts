type BotSource = { id: string; canReply: boolean; pausedUntil: string | null };

/** A group is not a bot controller. Only an explicitly selected writable source
 * can receive a pause/resume; an aggregate label never grants that action. */
export function conversationBotState(input: {
  id: string; grouped: boolean; pausedUntil?: string | null;
  sources?: readonly BotSource[]; selectedSourceId?: string | null;
}, now = Date.now()): { paused: boolean; label: string; controlId: string | null } {
  const active = (until?: string | null) => !!until && Date.parse(until) > now;
  const label = (paused: boolean) => paused ? "Бот на паузе" : "Бот не на паузе";
  if (!input.grouped) {
    const paused = active(input.pausedUntil);
    return { paused, label: label(paused), controlId: input.id };
  }
  const sources = (input.sources ?? []).filter(source => source.canReply);
  const selected = sources.find(source => source.id === input.selectedSourceId);
  if (selected) {
    const paused = active(selected.pausedUntil);
    return { paused, label: label(paused), controlId: selected.id };
  }
  if (!sources.length) return { paused: false, label: "Только история", controlId: null };
  const count = sources.filter(source => active(source.pausedUntil)).length;
  return { paused: count > 0, controlId: null,
    label: sources.length === 1 || count === 0 ? label(count > 0)
      : count === sources.length ? "Бот на паузе во всех каналах"
        : `Бот на паузе: ${count} из ${sources.length} каналов` };
}
