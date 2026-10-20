import { createHash } from "node:crypto";
import { customerMutationCommandSchema, type CustomerActionKind, type CustomerMutationCommand } from "@royal-home/shared";

export function customerMutationKind(command: CustomerMutationCommand): CustomerActionKind {
  switch (command.name) {
    case "save_contact": return "contact";
    case "request_callback": return "callback";
    case "request_handover": return "handover";
    case "book_showing": return "book_showing";
    case "reschedule_showing": return "reschedule_showing";
    case "cancel_showing": return "cancel_showing";
    case "ask_owner": return "owner_question";
  }
}
/** Parse before hashing: key order/defaults/extraneous model fields cannot
 * turn one approved intent into a different resource effect. */
export function customerMutationDigest(command: CustomerMutationCommand): string {
  return createHash("sha256").update(JSON.stringify(customerMutationCommandSchema.parse(command))).digest("hex");
}
export function isShowingMutation(command: CustomerMutationCommand): command is Extract<CustomerMutationCommand,
  { name: "book_showing" | "reschedule_showing" | "cancel_showing" }> {
  return command.name === "book_showing" || command.name === "reschedule_showing" || command.name === "cancel_showing";
}
