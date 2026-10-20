import { describe, expect, it, vi } from "vitest";

vi.mock("../src/db.js", () => ({ prisma: { $disconnect: vi.fn().mockResolvedValue(undefined) } }));

import { crmPropertyIdFromUrl, siteListingIdFromUrl } from "../src/lib/propertyMentionFromText.js";

describe("property mention URL boundaries", () => {
  it.each([
    "https://evilroyalhome.tj/listing/45",
    "https://foreign.example/royalhome.tj/listing/45",
    "https://royalhome.tj.foreign.example/listing/45",
    "https://foreign.example/@royalhome.tj/listing/45",
  ])("does not treat a foreign address as our property: %s", (url) => {
    expect(siteListingIdFromUrl(url)).toBeNull();
    expect(crmPropertyIdFromUrl(url.replace("/listing/45", "/listing/by-crm/abc-123"))).toBeNull();
  });

  it.each(["45abc", "45-foo", "0", "2147483648", "999999999999999999999999999999999999999999999"])(
    "does not query a partial or out-of-range site id: %s", (id) => {
      expect(siteListingIdFromUrl(`https://royalhome.tj/listing/${id}`)).toBeNull();
    },
  );

  it("accepts our complete link in prose, with query parameters or no protocol", () => {
    expect(siteListingIdFromUrl("Вот https://royalhome.tj/listing/45?from=chat.")).toBe(45);
    expect(siteListingIdFromUrl("(royalhome.tj/listing/45)")).toBe(45);
    expect(crmPropertyIdFromUrl("https://royalhome.tj/listing/by-crm/abc-123?from=chat")).toBe("abc-123");
  });
});
