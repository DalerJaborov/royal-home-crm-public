import { AsyncLocalStorage } from "node:async_hooks";

interface ManagedTransportContext {
  beforePost(): Promise<void>;
  accepted(mid: string | null): void;
}
const context = new AsyncLocalStorage<ManagedTransportContext>();
export function withCustomerPropertyTransport<T>(hooks: ManagedTransportContext, run: () => Promise<T>): Promise<T> {
  return context.run(hooks, run);
}
/** Invoked immediately before each real POST, including safe transport retries. */
export async function beforeCustomerPropertyPost(method: string | undefined): Promise<void> {
  if (method?.toUpperCase() === "POST") await context.getStore()?.beforePost();
}
/** Does not wait for a DB MID stamp and survives errors after acceptance. */
export function customerPropertyProviderAccepted(mid: string | null): void {
  context.getStore()?.accepted(mid);
}
export class CustomerPropertyHeldError extends Error {
  constructor() { super("Managed property reply held before send"); }
}
