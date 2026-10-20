import { describe, expect, it } from "vitest";
import { publishedSourceCutoff, rawVideoPublicationMarks, type PublishedSourceFacts } from "../src/lib/publishedRawVideoRetention.js";

const now = new Date("2026-10-18T12:00:00Z");
const receipt = "2026-10-11T12:00:00Z";
const finalPath = "/uploads/handoff/current.mp4";
const ready: PublishedSourceFacts = { status: "AVAILABLE", deletedAt: null, videoHandoffStatus: "RECEIVED",
  clipReviewStatus: "APPROVED", videoHandoffFinalPath: finalPath, publishedChannels: ["INSTAGRAM"],
  publishedPostIds: { INSTAGRAM: "123", RAW_VIDEO_PUBLISHED_AT: receipt, RAW_VIDEO_PUBLISHED_PATH: finalPath } };

describe("publication receipt and seven-day source retention", () => {
  it("expires exactly after seven full days, not a second earlier", () => {
    expect(publishedSourceCutoff(ready, now)?.toISOString()).toBe(new Date(receipt).toISOString());
    expect(publishedSourceCutoff(ready, new Date(now.getTime() - 1))).toBeNull();
  });
  it.each(["PENDING_REVIEW", "AWAITING_VIDEO", "AWAITING_PHOTOS", "EDITING"])("preserves %s regardless of publication age", status => {
    expect(publishedSourceCutoff({ ...ready, status }, now)).toBeNull();
  });
  it.each(["QUEUED", "SENT_TO_EDITOR"])("preserves returned-to-editor %s", videoHandoffStatus => {
    expect(publishedSourceCutoff({ ...ready, videoHandoffStatus }, now)).toBeNull();
  });
  it.each(["PENDING", "REJECTED"])("preserves review %s", clipReviewStatus => {
    expect(publishedSourceCutoff({ ...ready, clipReviewStatus }, now)).toBeNull();
  });
  it("preserves trash, unpublished, missing and invalid receipts", () => {
    for (const change of [{deletedAt: now}, {publishedChannels: []}, {publishedPostIds: null},
      {publishedPostIds: {INSTAGRAM: "123"}}, {publishedPostIds: {...ready.publishedPostIds as object, RAW_VIDEO_PUBLISHED_AT: "invalid"}},
      {publishedPostIds: {...ready.publishedPostIds as object, RAW_VIDEO_PUBLISHED_AT: "2027-01-01"}}]) {
      expect(publishedSourceCutoff({...ready, ...change}, now)).toBeNull();
    }
  });
  it("does not use the previous video's publication receipt for a replacement", () => {
    expect(publishedSourceCutoff({...ready, videoHandoffFinalPath: "/uploads/handoff/replacement.mp4"}, now)).toBeNull();
  });
  it("preserves unfinished platform publications", () => {
    expect(publishedSourceCutoff({...ready, publishedPostIds: {...ready.publishedPostIds as object, TIKTOK_PENDING: "upload"}}, now)).toBeNull();
  });
  it("records real new post IDs and keeps the receipt on duplicate callbacks", () => {
    const marks = rawVideoPublicationMarks({}, [{channel: "INSTAGRAM", postId: "123"}], finalPath, now);
    expect(marks).toEqual({RAW_VIDEO_PUBLISHED_AT: now.toISOString(), RAW_VIDEO_PUBLISHED_PATH: finalPath});
    expect(rawVideoPublicationMarks({INSTAGRAM: "123", ...marks}, [{channel:"INSTAGRAM",postId:"123"}], finalPath)).toEqual({});
    expect(rawVideoPublicationMarks({}, [{channel:"INSTAGRAM"}], finalPath)).toEqual({});
    expect(rawVideoPublicationMarks({}, [{channel:"INSTAGRAM",postId:"123"}], null)).toEqual({});
  });
});
