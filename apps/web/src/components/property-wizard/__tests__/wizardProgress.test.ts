import { describe, expect, it } from "vitest";
import { EMPTY_WIZARD_VALUES } from "../types";
import { wizardProgress } from "../wizardProgress";

const media = { ready: 0, pending: 0, failed: 0 };
describe("wizard rail reflects actual completion", () => {
  it("marks a chosen seller complete while unfinished property fields remain empty", () => {
    const progress = wizardProgress({ ...EMPTY_WIZARD_VALUES, sellerClientId: "test-seller" }, media, {}, false);
    expect(progress.seller).toBe("complete");
    expect(progress.main).toBe("empty");
    expect(progress.review).toBe("empty");
  });
  it("acknowledges media only after every queued file is ready", () => {
    expect(wizardProgress(EMPTY_WIZARD_VALUES, { ready: 1, pending: 1, failed: 0 }, {}, false).media).toBe("empty");
    expect(wizardProgress(EMPTY_WIZARD_VALUES, { ready: 2, pending: 0, failed: 0 }, {}, false).media).toBe("complete");
    expect(wizardProgress(EMPTY_WIZARD_VALUES, { ready: 1, pending: 0, failed: 1 }, {}, false).media).toBe("invalid");
  });
  it("a seller error does not mark the untouched location invalid", () => {
    const progress = wizardProgress(EMPTY_WIZARD_VALUES, media, { sellerName: "Укажите имя продавца" }, false);
    expect(progress.seller).toBe("invalid");
    expect(progress.place).toBe("empty");
  });
});
