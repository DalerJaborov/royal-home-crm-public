import type { PublicCommentChannel, PublicSettingsSnapshot } from "./publicCommentTypes.js";

/** A settings/display projection, NOT permission to POST or a proof of API rights.
 * No arbitrary prompt field may add an effect/tool. */
const SUPPORTED = {
  INSTAGRAM: ["hide", "delete", "unhide"],
  FACEBOOK: ["hide", "delete", "unhide"],
  TELEGRAM: ["delete"],
  YOUTUBE: ["reject"],
} as const;
export function projectPublicCommentCapabilities(channel: PublicCommentChannel, settings: PublicSettingsSnapshot,
  sourceReadiness: "current" | "held") {
  const channelEnabled = channel === "INSTAGRAM" ? settings.botInstagramEnabled && settings.metaEnabled
    : channel === "FACEBOOK" ? settings.botFacebookEnabled && settings.metaEnabled
    : channel === "TELEGRAM" ? settings.botTelegramEnabled : true;
  const readReady = settings.contractVersion === "scoped" && settings.rolloutMode !== "OFF" && settings.publicRead &&
    settings.botEnabled && settings.botCanAnswerComments && channelEnabled && sourceReadiness === "current";
  return Object.freeze({
    channel,
    legacyReplyTransportImplemented: true,
    legacyModerationEffects: Object.freeze([...SUPPORTED[channel]]),
    publicAgentReadReady: readReady,
    answerPlan: readReady ? "available" as const : "held" as const,
    // Root P12's public-target POST port has not been supplied/wired in this draft.
    publicDelivery: "requires_p12_public_target" as const,
    moderation: Object.freeze({ mode: "proposal_only" as const, staffApprovalRequired: true as const }),
    privateHistory: false as const,
    directMessage: false as const,
    contactWrite: false as const,
    callbackWrite: false as const,
    showingWrite: false as const,
    providerPermissions: "not_verified" as const,
  });
}

/** Model classification is only a proposal; it is never authorization. */
export function publicModerationProposal(input: { classification: "spam" | "abuse" | "promotion" | "owner" | "criticism" | "uncertain";
  effect: "hide" | "delete" | "reject" }, channel: PublicCommentChannel) {
  if (input.classification === "owner" || input.classification === "criticism" || input.classification === "uncertain") return { kind: "review" as const };
  if (!SUPPORTED[channel].some(effect => effect === input.effect)) return { kind: "review" as const };
  return { kind: "moderation_proposal" as const, effect: input.effect, staffApprovalRequired: true as const };
}
