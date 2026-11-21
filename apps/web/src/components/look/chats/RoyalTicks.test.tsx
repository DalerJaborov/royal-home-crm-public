import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { RoyalTicks } from "./RoyalMessageInfo";

describe("RoyalTicks: отказ доставки", () => {
  it("вместо голого «!» — подпись «Не доставлено»", () => {
    const html = renderToStaticMarkup(<RoyalTicks status="failed" />);
    expect(html).toContain("Не доставлено</span>");
    expect(html).toContain('data-status="failed"');
  });
});
