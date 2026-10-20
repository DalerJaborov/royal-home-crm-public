// PRIVATE neutral server-only routing reference; not a customer permission.
import type { CustomerNormalizedIngressInput } from "./customerIngressPayload.js";
import type { CustomerTransportReference } from "./customerConversationScope.js";
import type { CustomerAgentExecution } from "./customerAgentEnrollment.js";
export interface CustomerDmRoutingWitness { readonly purpose: "routing_only" }
export interface CustomerUnkeyedRoutingInput {
  channel: "INSTAGRAM" | "FACEBOOK" | "WHATSAPP"; peer: string; accountExternalId?: string;
  eventKind: "message" | "postback"; eventId?: undefined;
}
export interface CustomerDmRoutingSnapshot {
  readonly input: CustomerNormalizedIngressInput | CustomerUnkeyedRoutingInput;
  readonly transport: CustomerTransportReference;
  readonly scopeKey: string;
  readonly eventKey: string | null;
  readonly execution: CustomerAgentExecution;
}
const references = new WeakMap<object, Readonly<CustomerDmRoutingSnapshot>>();
function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
/** Internal producer composition only, never HTTP/model/staff action input. */
export function captureCustomerDmRouting(value: CustomerDmRoutingSnapshot): CustomerDmRoutingWitness {
  const witness = Object.freeze({ purpose: "routing_only" as const });
  references.set(witness, freeze(structuredClone(value))); return witness;
}
export function inspectCustomerDmRouting(value: unknown): Readonly<CustomerDmRoutingSnapshot> | null {
  return value && typeof value === "object" ? references.get(value) ?? null : null;
}
