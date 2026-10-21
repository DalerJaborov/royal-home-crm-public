import { afterEach, expect, it, vi } from "vitest";
import { parseIncoming } from "../src/messengers/meta.js";

afterEach(() => vi.unstubAllEnvs());
const envelope = (event: Record<string, unknown>) => ({ object: "instagram", entry: [{ id: "synthetic-account", messaging: [{
  sender: { id: "synthetic-peer" }, recipient: { id: "synthetic-account" }, ...event,
}] }] });

it("captures original postback advertising references for CORE without enabling legacy property behavior", () => {
  vi.stubEnv("BOT_PROPERTY_CONTEXT_ENABLED", "0");
  const body = envelope({ postback: { mid: "synthetic-button-mid", title: "Подробнее", payload: "synthetic-button",
    referral: { ad_id: "123456789012345", ads_context_data: { post_id: "12345_67890" } } } });
  expect(parseIncoming(body, undefined, false)[0].adId).toBeUndefined();
  const core = parseIncoming(body, undefined, false, { captureCustomerReferences: true })[0];
  expect(core).toMatchObject({ messageId: "synthetic-button-mid", adId: "123456789012345", adPostId: "12345_67890",
    propertyReferralOrigin: "postback_referral" });
  expect(process.env.BOT_PROPERTY_CONTEXT_ENABLED).toBe("0");
});

it("keeps the shared publication ID on later attachments when legacy context is off", () => {
  vi.stubEnv("BOT_PROPERTY_CONTEXT_ENABLED", "0");
  const body = envelope({ message: { mid: "synthetic-media-mid", text: "Сколько стоит?", attachments: [
    { type: "image", payload: { url: "https://synthetic.invalid/image" } },
    { type: "share", payload: { url: "https://www.instagram.com/reel/Synthetic_1/", reel_video_id: "123456789012345" } },
  ] } });
  expect(parseIncoming(body, undefined, false)[0].extraAttachments?.[0].attachmentMediaId).toBeUndefined();
  expect(parseIncoming(body, undefined, false, { captureCustomerReferences: true })[0].extraAttachments?.[0])
    .toMatchObject({ attachmentMediaId: "123456789012345", url: "https://www.instagram.com/reel/Synthetic_1/" });
});
