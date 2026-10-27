/** An explicit list controlled by the manager, not every linked employee. */
export type QueueAgent = { id: string; active: boolean; linked: boolean; enabled: boolean };

export function nextSomonAgent(agents: QueueAgent[], lastAssignedId: string | null): string | null {
  if (agents.length === 0) return null;
  const lastIndex = agents.findIndex(a => a.id === lastAssignedId);
  for (let offset = 1; offset <= agents.length; offset++) {
    const agent = agents[(lastIndex + offset) % agents.length];
    if (agent.active && agent.linked && agent.enabled) return agent.id;
  }
  return null;
}
