import { describe, expect, it } from "vitest";
import {
  CommentModerationError, graphModerationOutcome, telegramDeleteOutcome, youtubeRejectOutcome,
  moderationErrorOutcome, requireModerationAccepted, moderationAcceptedNote, moderationFailureNote,
} from "../src/messengers/commentModerationOutcome.js";
import { commentModerationView } from "../../../packages/shared/src/commentModeration.js";
import { instagramCommentQuerySchema } from "../../../packages/shared/src/querySchemas.js";
import { instagramCommentNoteLabel } from "../../../packages/shared/src/enums.js";

describe("endpoint-specific moderation confirmation", () => {
  it.each(["INSTAGRAM", "FACEBOOK"] as const)("%s accepts documented success:true, not a reply id", (provider) => {
    expect(graphModerationOutcome(provider, "delete", { success: true }).outcome).toBe("accepted");
    expect(graphModerationOutcome(provider, "hide", { success: false }).outcome).toBe("refused");
    expect(graphModerationOutcome(provider, "delete", { id: "reply-mid" }).outcome).toBe("unknown");
  });
  it.each([null, undefined, {}, [], false, true, "true", { success: "true" }, { success: 1 },
    { success: true, error: { code: 200 } }, { success: true, error_code: 403 }])("does not authorize Graph moderation from %j", (body) => {
    const result = graphModerationOutcome("INSTAGRAM", "delete", body);
    expect(result.outcome).toBe("unknown");
    expect(() => requireModerationAccepted(result)).toThrow(CommentModerationError);
    expect(() => moderationAcceptedNote(result, "competitor_ad")).toThrow(CommentModerationError);
    expect(moderationFailureNote(result)).toBe("moderation_unknown");
  });
  it("an explicit refusal cannot receive an accepted marker", () => {
    const refused = graphModerationOutcome("INSTAGRAM", "delete", { success: false });
    expect(refused.outcome).toBe("refused");
    expect(() => requireModerationAccepted(refused)).toThrow(CommentModerationError);
    expect(() => moderationAcceptedNote(refused, "competitor_ad")).toThrow(CommentModerationError);
    expect(moderationFailureNote(refused)).toBe("cant_delete");
  });
  it("Telegram requires the documented result literal true", () => {
    expect(telegramDeleteOutcome({ ok: true, result: true }).outcome).toBe("accepted");
    expect(telegramDeleteOutcome({ ok: true, result: true }, 403).outcome).toBe("unknown");
    for (const body of [undefined, { ok: true }, { ok: true, result: false }, { ok: "true", result: true },
      { ok: false, result: true }, { ok: true, result: "true" }, { ok: true, result: true, error_code: 403 }]) {
      expect(telegramDeleteOutcome(body).outcome).toBe("unknown");
    }
  });
  it("YouTube accepts empty204 as rejection, not physical deletion", () => {
    const accepted = youtubeRejectOutcome(204, "");
    expect(accepted).toMatchObject({ outcome: "accepted", effect: "reject" });
    expect(moderationAcceptedNote(accepted, "spam")).toBe("youtube_rejected; spam");
    for (const [status, body] of [[200, "{}"], [201, ""], [204, "{}"], [204, " "], [403, ""], [500, ""]] as const) {
      expect(youtubeRejectOutcome(status, body).outcome).toBe("unknown");
    }
  });
  it("timeout and ambiguous missing-permissions are not a deletion or a confirmed absence", () => {
    for (const error of [new Error("fetch failed"), new Error("Graph API HTTP 500: upstream"),
      new Error("Graph API HTTP 400: does not exist, cannot be loaded due to missing permissions")]) {
      expect(moderationErrorOutcome("INSTAGRAM", "delete", error).outcome).toBe("unknown");
    }
    expect(moderationErrorOutcome("INSTAGRAM", "delete", new Error("Graph API HTTP 403: permissions")).outcome).toBe("refused");
    expect(moderationErrorOutcome("FACEBOOK", "delete", new Error('Graph API HTTP 400: {"error":{"code":200}}')).outcome).toBe("refused");
    expect(moderationErrorOutcome("FACEBOOK", "delete", new Error('Graph API HTTP 400: {"error":{"code":"200"}}')).outcome).toBe("unknown");
    expect(moderationErrorOutcome("FACEBOOK", "delete", new Error('Graph API HTTP 400: {"error":{"code":100}}')).outcome).toBe("unknown");
    expect(moderationErrorOutcome("YOUTUBE", "reject", Object.assign(new Error("processing failed"),
      { status: 400, reason: "processingFailure" })).outcome).toBe("unknown");
    expect(moderationErrorOutcome("TELEGRAM", "delete", new Error("Telegram API deleteMessage: Bad Request: message to delete not found")).outcome).toBe("gone");
  });
});

describe("truthful display and restore capabilities", () => {
  it("YT HIDDEN means rejected, with no reply/unhide; legacy DELETED is not upgraded to a fresh receipt", () => {
    const fresh = commentModerationView({ channel: "YOUTUBE", status: "HIDDEN", note: "youtube_rejected; spam" });
    expect(fresh).toMatchObject({ label: "Отклонён YouTube", canUnhide: false, canReply: false, youtubeRejection: true });
    const legacy = commentModerationView({ channel: "YOUTUBE", status: "DELETED", note: "competitor_ad" });
    expect(legacy).toMatchObject({ label: "Ранее отмечен удалённым в CRM", hidden: false,
      canHide: false, canUnhide: false, canReply: false });
    expect(commentModerationView({ channel: "YOUTUBE", status: "HIDDEN", note: "spam" }))
      .toMatchObject({ label: "Ранее отмечен скрытым в CRM", canUnhide: false, canReply: false });
  });
  it("Meta retains reversible hiding and physically deleted rows deny public actions", () => {
    expect(commentModerationView({ channel: "FACEBOOK", status: "HIDDEN" })).toMatchObject({
      label: "Ранее отмечен скрытым в CRM", hiddenConfirmed: false, canUnhide: true, canReply: false });
    expect(commentModerationView({ channel: "FACEBOOK", status: "HIDDEN", note: "moderation_hidden; manual_hide" }))
      .toMatchObject({ label: "Скрыт от подписчиков", hiddenConfirmed: true, canUnhide: true });
    expect(commentModerationView({ channel: "INSTAGRAM", status: "DELETED", note: "moderation_deleted; spam" }))
      .toMatchObject({ label: "Удалён", canHide: false, canUnhide: false, canReply: false });
    expect(commentModerationView({ channel: "INSTAGRAM", status: "DELETED", note: "competitor_ad" }).label).toBe("Ранее отмечен удалённым в CRM");
    expect(instagramCommentQuerySchema.safeParse({ status: "DELETED" }).success).toBe(true);
  });
  it.each(["INSTAGRAM", "FACEBOOK"])("%s legacy deletion has no fresh receipt from status or a suffix", (channel) => {
    for (const note of [null, "", "competitor_ad", "spam; moderation_deleted"]) {
      expect(commentModerationView({ channel, status: "DELETED", note }))
        .toMatchObject({ label: "Ранее отмечен удалённым в CRM", canReply: false, canUnhide: false });
    }
    expect(commentModerationView({ channel, status: "DELETED", note: "moderation_deleted; spam" }).label).toBe("Удалён");
  });
  it("an unsupported channel cannot confirm hiding or deletion with a marker", () => {
    expect(commentModerationView({ channel: "WEBSITE", status: "HIDDEN", note: "moderation_hidden; spam" }))
      .toMatchObject({ hiddenConfirmed: false, label: "Ранее отмечен скрытым в CRM" });
    expect(commentModerationView({ channel: "WEBSITE", status: "DELETED", note: "moderation_deleted; spam" }).label)
      .toBe("Ранее отмечен удалённым в CRM");
    expect(commentModerationView({ channel: "YOUTUBE", status: "DELETED", note: "moderation_deleted; spam" }).label)
      .toBe("Ранее отмечен удалённым в CRM");
  });
  it("unknown channels/statuses and claimed WORKING rows do not gain capabilities", () => {
    for (const row of [{ channel: "UNKNOWN", status: "HIDDEN" }, { channel: "INSTAGRAM", status: "UNKNOWN" },
      { channel: "INSTAGRAM", status: "WORKING" }]) {
      expect(commentModerationView(row)).toMatchObject({ canHide: false, canUnhide: false, canReply: false });
    }
  });
  it.each([
    { channel: "FACEBOOK", suffix: "moderation_hidden", prefix: "moderation_hidden; spam" },
    { channel: "YOUTUBE", suffix: "youtube_rejected", prefix: "youtube_rejected; spam" },
  ])("a freeform suffix is not a server receipt in $channel", ({ channel, suffix, prefix }) => {
    expect(commentModerationView({ channel, status: "HIDDEN", note: `spam; ${suffix}` }))
      .toMatchObject({ hiddenConfirmed: false, label: "Ранее отмечен скрытым в CRM" });
    expect(commentModerationView({ channel, status: "HIDDEN", note: prefix }).hiddenConfirmed).toBe(true);
  });
  it("refusal note does not claim competitor removal", () => {
    const note = instagramCommentNoteLabel("competitor_ad; cant_delete")!;
    expect(note).toContain("отказала");
    expect(note).not.toContain("Удалена");
    expect(instagramCommentNoteLabel("moderation_unknown; spam")).toContain("не подтвердила");
  });
});
