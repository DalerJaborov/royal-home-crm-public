import { z } from "zod";

const appId = z.string().trim().regex(/^\d{1,64}$/);
const secretSource = z.enum(["settings_instagram", "settings_meta"]);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
/** Explicit owner configuration, never a provider app-secret ownership proof. */
export const instagramAppBindingInputSchema = z.object({
  mode: z.literal("owner_selected_observed_signer"), appId, secretSource,
  observationId: digest, observationVersion: digest, configurationVersion: digest,
  confirmFutureInputs: z.literal(true),
}).strict();
export type InstagramAppBindingInput = z.infer<typeof instagramAppBindingInputSchema>;
export const instagramAppBindingStatusSchema = z.object({
  accountId: z.string(), hasAppSecret: z.boolean(),
  configurationVersion: digest,
  candidates: z.array(z.object({ secretSource, observationId: digest, observationVersion: digest,
    observedAt: z.string().datetime() }).strict()).max(2),
  configuredAppId: appId.nullable(), configuredAt: z.string().datetime().nullable(),
  authority: z.literal("owner_selected_observed_signer").nullable(),
  freshSignatureObservedAt: z.string().datetime().nullable(),
}).strict();
export type InstagramAppBindingStatus = z.infer<typeof instagramAppBindingStatusSchema>;
export const instagramAppBindingResultSchema = instagramAppBindingStatusSchema.extend({ configurationChanged: z.boolean() });
