import type { PublicReadContext, PublicSourceRef } from "@royal-home/shared";
export {
  publicCommentChannelSchema, publicSourceRefSchema, publicCommentTargetSchema, publicInstallationSchema,
  publicSourceProofSchema, publicSettingsSnapshotSchema, serverPublicCommentSnapshotSchema,
} from "@royal-home/shared";
export type {
  PublicCommentChannel, PublicSourceRef, PublicCommentTarget, PublicInstallation, PublicSourceProof,
  PublicSettingsSnapshot, ServerPublicCommentSnapshot, PublicReadContext, PublicHeldReason, PublicResult,
} from "@royal-home/shared";
/** Root P12 namespace port; server composition only, no permissive default or private-data callback. */
export interface PublicCommentSourcePort {
  loadFromServer(ref: PublicSourceRef): Promise<unknown | null>;
  /** Resolve only verified publication mapping and return readCustomerPropertyFacts public projection. */
  readPublicPropertyFacts(context: PublicReadContext): Promise<unknown>;
}
