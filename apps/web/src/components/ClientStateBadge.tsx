import { clientPrimaryState } from "../lib/clientPrimaryState";

export function ClientStateBadge({ client }: { client: Parameters<typeof clientPrimaryState>[0] }) {
  const state = clientPrimaryState(client);
  return <span className={`chip ${state.tone}`} title={state.title} aria-label={state.title ? `${state.label}. ${state.title}` : undefined}>
    {state.dot !== undefined && <span className={`dot ${state.dot}`} aria-hidden="true" />}
    {state.label}
  </span>;
}
