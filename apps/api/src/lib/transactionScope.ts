import { AsyncLocalStorage } from "node:async_hooks";

/** Internal DB infrastructure singleton. No transport/model registration API. */
export type StageEventRow = {
  entityType: "CLIENT" | "DEAL";
  entityId: string;
  field: string;
  from: string | null;
  to: string;
  agentId: string | null;
};

/**
 * Идущая интерактивная транзакция: её клиент, открыта ли она ещё, и события,
 * которые запишутся только после фиксации. `open` снимается, как только колбэк
 * транзакции завершился: дело, запущенное из колбэка и пережившее его, читает и
 * пишет уже обычным путём, а не через закрытую транзакцию.
 */
export type TxScope = { tx: unknown; open: boolean; pending: StageEventRow[] };
export const txScope = new AsyncLocalStorage<TxScope>();

export function openScope(): TxScope | undefined {
  const scope = txScope.getStore();
  return scope?.open ? scope : undefined;
}

/** Read-only evidence of the actual active interactive callback in this async
 * context. Extended tx clients may inherit $transaction; object shape cannot
 * distinguish them from the root. No registration/permission API is exposed. */
export function isActiveTransactionClient(value: unknown): boolean {
  const scope = openScope();
  return !!scope && scope.tx === value;
}
