import { AsyncLocalStorage } from "node:async_hooks";
import type { MessageSender } from "@royal-home/shared";
import { currentActorId } from "./requestActor.js";

/** Only the server delivery entrypoints install this intent. Neither an
 * outbound origin string nor merely running an automated retry from an
 * authenticated HTTP request is sufficient. Existing route ACL/ownership
 * validation remains responsible for the selected conversation. */
const intents = new AsyncLocalStorage<{ actorId: string }>();
export function withManualCustomerDeliveryIntent<T>(sender: MessageSender | undefined, run: () => Promise<T>): Promise<T> {
  return sender?.kind === "agent" ? withAuthenticatedManualCustomerReply(sender.agentId, run) : intents.exit(run);
}
/** Used only at genuine manual public-reply routes after their existing ACL,
 * source/ownership claim. req.agent.id comes from requireAuth, not request JSON. */
export function withAuthenticatedManualCustomerReply<T>(actorId: string, run: () => Promise<T>): Promise<T> {
  return actorId && currentActorId() === actorId ? intents.run({ actorId }, run) : intents.exit(run);
}
export function currentManualCustomerDeliveryActor(): string | null {
  const intent = intents.getStore();
  return intent && intent.actorId === currentActorId() ? intent.actorId : null;
}
