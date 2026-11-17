import { clientPrimaryState } from "../lib/clientPrimaryState";

/** Отметка у клиента — только если есть важный факт (см. clientPrimaryState); иначе ничего. */
export function ClientStateBadge({ client }: { client: Parameters<typeof clientPrimaryState>[0] }) {
  const state = clientPrimaryState(client);
  if (!state) return null;
  return <span className={`chip ${state.tone}`} title={state.title} aria-label={state.title ? `${state.label}. ${state.title}` : undefined}>
    {state.label}
  </span>;
}
