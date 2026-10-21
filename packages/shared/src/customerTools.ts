import { z } from "zod";
import { customerPropertyAdmissionSchema, customerPropertyFactsSchema, customerPropertyFactKindSchema } from "./customerPropertyContext.js";

/** Server reference only. Its shape does not prove a signature or Client ownership. */
export const customerToolAdmissionReferenceSchema = customerPropertyAdmissionSchema.omit({ evidence: true });
export type CustomerToolAdmissionReference = z.infer<typeof customerToolAdmissionReferenceSchema>;

export const customerPublicToolArgsSchema = z.object({
  kinds: z.array(customerPropertyFactKindSchema).min(1).max(customerPropertyFactKindSchema.options.length),
}).strict();
export const customerToolCallSchema = z.object({
  name: z.literal("get_property_facts"),
  args: customerPublicToolArgsSchema,
}).strict();
export type CustomerToolCall = z.infer<typeof customerToolCallSchema>;

/** A public read observation, never a mutation/action receipt. */
export const customerToolResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("observed"),
    tool: z.literal("get_property_facts"),
    facts: customerPropertyFactsSchema,
    kinds: customerPublicToolArgsSchema.shape.kinds,
    observedAt: z.string().datetime(),
  }).strict(),
  z.object({ status: z.enum(["missing", "ambiguous"]), tool: z.literal("get_property_facts") }).strict(),
  z.object({
    status: z.literal("denied"),
    reason: z.enum(["disabled", "invalid_call", "invalid_principal", "scope_changed", "stale_facts"]),
  }).strict(),
  z.object({ status: z.literal("unavailable"), reason: z.literal("storage_unavailable") }).strict(),
]);
export type CustomerToolResult = z.infer<typeof customerToolResultSchema>;

/** Only implemented, enabled public capabilities. No private or write declarations. */
export function customerPublicToolParameters(
  target: "openapi-3.0" | "draft-2020-12" = "openapi-3.0",
): Record<string, unknown> {
  return z.toJSONSchema(customerPublicToolArgsSchema, { target });
}
