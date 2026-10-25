import {
  customerPropertyFocusSchema, customerPublicToolParameters, customerToolCallSchema, customerToolResultSchema,
  type CustomerPropertyFocus, type CustomerToolResult,
} from "@royal-home/shared";
import type { TxClient } from "../db.js";
import { readCustomerPropertyFacts } from "../lib/customerPropertyFacts.js";
import { isCustomerPrincipal, revalidateCustomerPrincipal, type CustomerPrincipal, type CustomerPrincipalSnapshot } from "../lib/customerPrincipal.js";
import { logSystemError } from "../lib/systemError.js";

export interface CustomerToolOptions {
  /** Server foundation/core switch. This is never taken from model arguments. */
  enabled: boolean;
  factsDb?: Pick<TxClient, "property">;
}

/** Public declarations only; no staff tools, private status, or future write success. */
export function customerToolDefinitions(principal: unknown, enabled: boolean) {
  if (!enabled || !isCustomerPrincipal(principal)) return [];
  return [{ name: "get_property_facts", description: "Читать публичные цену, район/город и подтверждённые данные текущего объекта. Не создаёт заявку, показ или звонок.", parameters: customerPublicToolParameters() }];
}

function focusFor(principal: CustomerPrincipal, snapshot: CustomerPrincipalSnapshot): CustomerPropertyFocus | null {
  const parsed = customerPropertyFocusSchema.safeParse(snapshot.focus);
  return parsed.success && parsed.data.scopeKey === principal.scope.scopeKey &&
    BigInt(parsed.data.lastEvidenceOrder) <= BigInt(principal.admission.order) ? parsed.data : null;
}
function sameFocus(expected: CustomerPropertyFocus, revision: number, principal: CustomerPrincipal, snapshot: CustomerPrincipalSnapshot): boolean {
  const current = focusFor(principal, snapshot);
  return !!current && snapshot.focusRevision === revision && current.status === expected.status &&
    current.generation === expected.generation && current.eventKey === expected.eventKey &&
    current.lastEvidenceOrder === expected.lastEvidenceOrder && current.propertyId === expected.propertyId;
}

/** Narrow public dispatcher. All targets come from current server focus.
 * Point-in-time DB checks do not replace P03 OUT freshness or P07 owner fences. */
export async function dispatchCustomerTool(principal: unknown, rawCall: unknown, options: CustomerToolOptions): Promise<CustomerToolResult> {
  if (!options.enabled) return { status: "denied", reason: "disabled" };
  const call = customerToolCallSchema.safeParse(rawCall);
  if (!call.success) return { status: "denied", reason: "invalid_call" };
  if (!isCustomerPrincipal(principal)) return { status: "denied", reason: "invalid_principal" };
  try {
    const before = await revalidateCustomerPrincipal(principal);
    if (before.status === "unavailable") return { status: "unavailable", reason: "storage_unavailable" };
    if (before.status !== "current") return { status: "denied", reason: "scope_changed" };
    const focus = focusFor(principal, before.snapshot);
    if (!focus) return { status: "denied", reason: "scope_changed" };
    if (focus.status === "ambiguous") return { status: "ambiguous", tool: "get_property_facts" };
    if (focus.status !== "resolved" || !focus.propertyId) return { status: "missing", tool: "get_property_facts" };

    const facts = await readCustomerPropertyFacts(focus.propertyId, principal.scope.channel, options.factsDb);
    const after = await revalidateCustomerPrincipal(principal);
    if (after.status === "unavailable") return { status: "unavailable", reason: "storage_unavailable" };
    if (after.status !== "current" || !sameFocus(focus, before.snapshot.focusRevision, principal, after.snapshot)) {
      return { status: "denied", reason: "scope_changed" };
    }
    if (!facts) return { status: "missing", tool: "get_property_facts" };
    const fresh = await readCustomerPropertyFacts(focus.propertyId, principal.scope.channel, options.factsDb);
    if (!fresh || fresh.signature !== facts.signature) return { status: "denied", reason: "stale_facts" };
    const final = await revalidateCustomerPrincipal(principal);
    if (final.status === "unavailable") return { status: "unavailable", reason: "storage_unavailable" };
    if (final.status !== "current" || !sameFocus(focus, before.snapshot.focusRevision, principal, final.snapshot)) {
      return { status: "denied", reason: "scope_changed" };
    }
    return customerToolResultSchema.parse({ status: "observed", tool: "get_property_facts", facts: fresh,
      kinds: call.data.args.kinds, observedAt: new Date().toISOString() });
  } catch (error) {
    void logSystemError("api", `customer property facts read failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 500),
      { dedupKey: "customer-property-facts-read-failed" });
    return { status: "unavailable", reason: "storage_unavailable" };
  }
}
