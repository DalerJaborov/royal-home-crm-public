import { isDeepStrictEqual } from "node:util";
import { customerActionIntentsSchema, type CustomerFence } from "@royal-home/shared";
import { prisma } from "../db.js";
import { customerPrincipalAuthenticatedInput, isCustomerPrincipal, loadPublicCustomerPrincipal,
  revalidateCustomerPrincipal, type CustomerPrincipal } from "./customerPrincipal.js";
import { inspectCustomerWriteAuthority, type CustomerWriteAuthority } from "./customerState.js";
import { recoverAuthenticatedCustomerInput } from "./customerIngressAuthority.js";

function sameOriginalController(a: Readonly<CustomerFence>, b: Readonly<CustomerFence>): boolean {
  return a.inquiryId === b.inquiryId && a.nativeId === b.nativeId && isDeepStrictEqual(a.endpoint, b.endpoint) &&
    a.ownerToken === b.ownerToken && a.ownershipEpoch === b.ownershipEpoch && a.bindingRevision === b.bindingRevision &&
    a.scopeRevision === b.scopeRevision && a.policyRevision === b.policyRevision;
}
/** Only a genuine current-IN write/receipt authority permits continuation over
 * its own semantic state change. The original principal remains stale. This
 * neither rebinds an old input to a newer actor/IN nor changes its capture age.
 * HOLD after handover has a separate receipt-ACK purpose, never BOT revival. */
export async function continueCustomerAgentAfterLocalAuthority(original: unknown, authority: CustomerWriteAuthority): Promise<
  { status: "current"; principal: CustomerPrincipal } | { status: "held"; reason: string }
> {
  if (!isCustomerPrincipal(original)) return { status: "held", reason: "original_principal_required" };
  const grant = inspectCustomerWriteAuthority(authority), frame = customerPrincipalAuthenticatedInput(original);
  if (!grant || !frame || (grant.kind === "handover" && grant.purpose === "receipt") || grant.eventKey !== original.admission.eventKey ||
      grant.order !== original.admission.order || !sameOriginalController(original.authority.fence, grant.fence)) {
    return { status: "held", reason: "same_input_local_authority_required" };
  }
  try {
    const [row] = await prisma.$queryRaw<Array<{ actionIntents: unknown; lastAcceptedEventKey: string | null; lastAcceptedOrder: bigint | null;
      stateRevision: bigint; intentRevision: bigint }>>`
      SELECT "actionIntents","lastAcceptedEventKey","lastAcceptedOrder","stateRevision","intentRevision"
      FROM "CustomerInquiry" WHERE "id"=${grant.fence.inquiryId}`;
    const intents = customerActionIntentsSchema.safeParse(row?.actionIntents), slot = intents.success ? intents.data[grant.kind] : null;
    if (!row || row.lastAcceptedEventKey !== grant.eventKey || row.lastAcceptedOrder?.toString() !== grant.order ||
        !slot || slot.generation !== grant.generation || !slot.evidenceRefs.includes(grant.eventKey) ||
        !["open", "committed"].includes(slot.status) ||
        (grant.commandDigest !== undefined && slot.commandDigest !== grant.commandDigest) ||
        (grant.purpose === "receipt" && slot.status !== "committed")) {
      return { status: "held", reason: "original_action_changed" };
    }
    // Principal.admission deliberately omits raw property evidence. Do not
    // fabricate an empty/full admission from that model-free reference: recover
    // the genuine original Ticket/envelope without changing its order or age.
    const recovered = await recoverAuthenticatedCustomerInput(grant.eventKey);
    if (recovered.status !== "recovered" || recovered.ticket.order !== original.admission.order ||
        recovered.ticket.scopeKey !== original.admission.scopeKey || recovered.ticket.conversationId !== original.scope.conversationId) {
      return { status: "held", reason: "original_ticket_unavailable" };
    }
    const loaded = await loadPublicCustomerPrincipal({ admission: recovered.ticket, authenticatedInput: recovered.input,
      visibility: original.visibility });
    if (loaded.status !== "public_only" || loaded.principal.authority.fence.stateRevision !== row.stateRevision.toString() ||
        loaded.principal.authority.fence.intentRevision !== row.intentRevision.toString() ||
        !sameOriginalController(original.authority.fence, loaded.principal.authority.fence) ||
        !isDeepStrictEqual(original.knownContact, loaded.principal.knownContact)) return { status: "held", reason: "original_controller_changed" };
    const current = await revalidateCustomerPrincipal(loaded.principal);
    if (current.status !== "current") return { status: "held", reason: "original_input_changed" };
    return { status: "current", principal: loaded.principal };
  } catch {
    return { status: "held", reason: "continuation_unavailable" };
  }
}
