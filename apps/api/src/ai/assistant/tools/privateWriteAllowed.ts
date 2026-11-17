import { isReadOnlyRole } from "@royal-home/shared";
import type { AssistantActor } from "../actor.js";

export function privateWriteAllowed(actor: AssistantActor): boolean {
  return (actor.surface === "crm-private" || actor.surface === "telegram-private") && !isReadOnlyRole(actor.role);
}
