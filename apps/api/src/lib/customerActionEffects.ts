import { type CustomerMutationCommand, type CustomerMutationReceipt } from "@royal-home/shared";
import { type TxClient } from "../db.js";
import { createManagedCustomerCallbackTx } from "./customerCallbackLifecycle.js";
import { prelockCustomerShowingTx, executeCustomerShowingTx } from "./customerShowing.js";
import { createOwnerQuestionTx } from "./ownerQuestionMutation.js";
import { assertCustomerActionProperty } from "./customerActionProperty.js";
import { inspectCustomerWriteAuthority } from "./customerState.js";
import { isShowingMutation } from "./customerActionCommand.js";
import { validateExactShowingSlot } from "./showingBooking.js";

type Grant = NonNullable<ReturnType<typeof inspectCustomerWriteAuthority>>;
export interface CustomerActionPrelock { clientId?: string; originBookingActionId?: string }
/** Preliminary reads choose a lock, not a resource authorization. The exact
 * origin is checked again in the resource kernel after canonical locks. */
export async function prelockCustomerActionResource(tx: TxClient, grant: Grant,
  command: CustomerMutationCommand): Promise<CustomerActionPrelock | null> {
  if (!isShowingMutation(command)) return {};
  let originBookingActionId: string | undefined;
  if (command.name !== "book_showing") {
    const origin = await tx.customerAction.findUnique({ where: { publicRef: command.args.bookingRef }, select: {
      id: true, inquiryId: true, kind: true, status: true,
    } });
    if (!origin || origin.inquiryId !== grant.fence.inquiryId || origin.kind !== "book_showing" || origin.status !== "COMMITTED") return null;
    originBookingActionId = origin.id;
  }
  const prelock = await prelockCustomerShowingTx(tx, { inquiryId: grant.fence.inquiryId, kind: command.name, originBookingActionId });
  return prelock ? { ...prelock, originBookingActionId } : null;
}

export interface CustomerActionEffect {
  resourceId: string; resourceType: CustomerMutationReceipt["resourceType"]; resourceRevision?: string;
}
/** A single local effect inside the parent journal transaction. No authority
 * is minted here and no provider/model/network call is allowed under locks. */
export async function applyCustomerActionResource(tx: TxClient, grant: Grant, command: Exclude<CustomerMutationCommand, { name: "save_contact" }>,
  actionId: string, now: Date, prelock: CustomerActionPrelock, callbackPhone: string | null): Promise<CustomerActionEffect> {
  if (command.name === "request_callback" || command.name === "request_handover") {
    const result = await createManagedCustomerCallbackTx(tx, { actionId, fence: grant.fence,
      requestKind: command.name === "request_callback" ? "CALLBACK" : "HUMAN", phone: callbackPhone, topic: command.args.topic });
    return { resourceId: result.resourceId, resourceType: "CallbackRequest", resourceRevision: result.lifecycleRevision };
  }
  if (command.name === "ask_owner") {
    const property = grant.property, fence = grant.fence, channel = fence.endpoint.channel;
    if (!property || !fence.nativeId || (channel !== "WHATSAPP" && channel !== "INSTAGRAM" && channel !== "FACEBOOK")) {
      throw new Error("Owner question requires an exact original Meta target and property");
    }
    await tx.$queryRaw`SELECT "id" FROM "Property" WHERE "id"=${property.propertyId} FOR UPDATE`;
    await assertCustomerActionProperty(tx, fence, property);
    const scope = await tx.customerEndpointScope.findUnique({ where: { id: fence.endpoint.endpointScopeId }, select: { transportKey: true } });
    if (!scope) throw new Error("Owner question original endpoint disappeared");
    const result = await createOwnerQuestionTx(tx, { actionId, question: command.args.question, propertyId: property.propertyId,
      replyTarget: { version: 1, nativeKind: "bot", inquiryId: fence.inquiryId, nativeId: fence.nativeId, channel,
        peer: fence.endpoint.peerId, accountId: fence.endpoint.accountId, endpointScopeId: fence.endpoint.endpointScopeId,
        transportKey: scope.transportKey, scopeRevision: fence.scopeRevision, bindingRevision: fence.bindingRevision, generation: grant.generation } });
    return { resourceId: result.resourceId, resourceType: "OwnerQuestion", resourceRevision: result.resourceRevision };
  }
  if (!prelock.clientId) throw new Error("Showing resource was not prelocked");
  const property = grant.property;
  if (command.name === "book_showing" && (!property || command.args.propertyShortId !== property.shortId)) throw new Error("Showing property changed");
  const origin = prelock.originBookingActionId ? await tx.interaction.findUnique({
    where: { customerBookingActionId: prelock.originBookingActionId }, select: { propertyId: true, nextActionDate: true },
  }) : null;
  const at = command.name === "cancel_showing" ? origin?.nextActionDate : new Date(command.args.at);
  if (!at || !Number.isFinite(at.getTime()) || (command.name !== "cancel_showing" &&
      !validateExactShowingSlot(at, now).ok)) throw new Error("Showing date requires clarification");
  if (command.name === "reschedule_showing" && (!property || property.propertyId !== origin?.propertyId)) throw new Error("Showing focus changed");
  const settings = await tx.settings.findUnique({ where: { id: "singleton" }, select: { meetingSummaryAfterShowingMinutes: true } });
  const result = await executeCustomerShowingTx(tx, { inquiryId: grant.fence.inquiryId, kind: command.name,
    clientId: prelock.clientId, actionId, originBookingActionId: prelock.originBookingActionId,
    propertyId: command.name === "cancel_showing" ? origin?.propertyId ?? null : property!.propertyId,
    at, now, channel: grant.fence.endpoint.channel, notes: "Действие клиента через CustomerAgentCore",
    expectedRevision: command.name === "book_showing" ? undefined : command.args.expectedRevision,
    meetingSummaryAfterShowingMinutes: settings?.meetingSummaryAfterShowingMinutes ?? 30,
    ...(command.name !== "cancel_showing" ? { validateLockedTarget: async (locked: TxClient) => {
      await assertCustomerActionProperty(locked, grant.fence, property!);
    } } : {}),
  });
  await tx.backgroundJob.create({ data: { type: "customer-showing-notify", payload: { version: 1, actionId },
    maxAttempts: 5, dedupeKey: `customer-showing-notify:${actionId}` } });
  return { resourceId: result.resourceId, resourceType: "Interaction", resourceRevision: result.revision };
}

/** Server-only effect observation, never permission to send an acknowledgement. */
export async function observeManagedCustomerResource(tx: TxClient, receipt: CustomerMutationReceipt): Promise<"active" | "inactive" | "missing"> {
  if (receipt.kind === "callback" || receipt.kind === "handover") {
    const resource = await tx.callbackRequest.findUnique({ where: { id: receipt.resourceId }, select: { customerActionId: true, doneAt: true } });
    return resource?.customerActionId !== receipt.actionId ? "missing" : resource.doneAt === null ? "active" : "inactive";
  }
  if (receipt.kind === "owner_question") {
    const resource = await tx.ownerQuestion.findUnique({ where: { id: receipt.resourceId }, select: { customerActionId: true } });
    return resource?.customerActionId === receipt.actionId ? "active" : "missing";
  }
  if (receipt.version !== 2) return "missing";
  const resource = await tx.interaction.findUnique({ where: { id: receipt.resourceId }, select: {
    customerBookingActionId: true, managedShowingRevision: true, completedAt: true, nextAction: true, declinedAt: true,
  } });
  if (!resource?.customerBookingActionId) return "missing";
  const original = await tx.customerAction.findUnique({ where: { id: resource.customerBookingActionId }, select: { inquiryId: true } });
  if (original?.inquiryId !== receipt.inquiryId) return "missing";
  const revisionCurrent = resource.managedShowingRevision?.toString() === receipt.resourceRevision;
  return revisionCurrent && (receipt.kind === "cancel_showing" ? resource.completedAt === null && resource.nextAction === null && resource.declinedAt !== null :
    resource.completedAt === null && resource.nextAction !== null) ? "active" : "inactive";
}
