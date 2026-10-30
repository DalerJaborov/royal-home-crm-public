import { afterEach, describe, expect, it, vi } from "vitest";
const boundary = vi.hoisted(() => ({ credentials: vi.fn(async () => { throw new Error("External credential boundary reached"); }) }));
vi.mock("../src/messengers/meta.js", async original => ({
  ...(await original<typeof import("../src/messengers/meta.js")>()), loadCredentials: boundary.credentials,
}));
import { prisma } from "../src/db.js";
import { publishPropertyCardStory, publishPropertySoldStory, publishPropertyPriceDropStory, publishPropertyInstagramStories } from "../src/lib/instagramStories.js";

afterEach(() => { vi.restoreAllMocks(); boundary.credentials.mockClear(); });
describe("private properties never reach external story publication", () => {
  for (const state of ["private", "deleted", "missing"] as const) {
    it.each(["card", "sold", "price", "video"])(`${state}: %s stops before loading credentials`, async kind => {
      vi.spyOn(prisma.property, "findUnique").mockResolvedValue(state === "missing" ? null : { id: "qa-private", offSite: state === "private", deletedAt: state === "deleted" ? new Date() : null, clipReviewStatus: "APPROVED" } as never);
      vi.spyOn(prisma.settings, "findUnique").mockResolvedValue({ instagramStoriesEnabled: true, facebookStoriesEnabled: true } as never);
      const result = await (kind === "card" ? publishPropertyCardStory("qa-private", { force: true })
        : kind === "sold" ? publishPropertySoldStory("qa-private", { force: true })
          : kind === "price" ? publishPropertyPriceDropStory("qa-private", "100")
            : publishPropertyInstagramStories("qa-private", "/uploads/handoff/qa.mp4", { force: true }));
      expect(result.attempted).toBe(false);
      expect(result.publishedParts).toBe(0);
      expect(result.error).toBeTruthy();
      expect(boundary.credentials).not.toHaveBeenCalled();
    });
  }
});
