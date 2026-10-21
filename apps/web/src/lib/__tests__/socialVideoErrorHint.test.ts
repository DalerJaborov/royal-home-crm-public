import { describe, expect, it } from "vitest";
import { socialVideoErrorHint } from "../socialVideoErrorHint";

describe("publication error guidance", () => {
  it("explains a connect timeout as a connection failure", () => {
    const hint = socialVideoErrorHint(false, "fetch failed (UND_ERR_CONNECT_TIMEOUT Connect Timeout Error)");
    expect(hint).toContain("не смог соединиться");
    expect(hint).not.toContain("Настройки");
  });
  it("preserves provider backoff guidance", () => {
    expect(socialVideoErrorHint(true, "rate limit")).toContain("Площадка просит подождать");
  });
  it("keeps account guidance for an actual provider refusal", () => {
    expect(socialVideoErrorHint(false, "Invalid OAuth access token")).toContain("Настройки");
  });
});
