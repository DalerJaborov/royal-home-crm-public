import { AsyncLocalStorage } from "node:async_hooks";

/** One physical provider request. This context is installed only by the durable
 * dispatcher, never by an HTTP/model argument. Legacy transports stay unchanged. */
export interface CustomerDeliveryTransportHooks {
  beforePost(): Promise<void>;
  accepted(mid: string | null): Promise<void>;
  rejected(status: number): Promise<void>;
  networkFailure(error: unknown): Promise<void>;
}
const deliveries = new AsyncLocalStorage<CustomerDeliveryTransportHooks>();
export function withCustomerDeliveryTransport<T>(hooks: CustomerDeliveryTransportHooks, run: () => Promise<T>): Promise<T> {
  return deliveries.run(hooks, run);
}
export function currentCustomerDeliveryTransport(): CustomerDeliveryTransportHooks | undefined {
  return deliveries.getStore();
}
export class CustomerDeliveryHeldError extends Error {
  constructor(readonly reason: string) { super(`Customer delivery held: ${reason}`); }
}
