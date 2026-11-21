import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { RoyalSection } from "../clients/RoyalSection";
import { MarketingBrandMark } from "./MarketingSection";

/**
 * Знак площадки нового вида (пачка marketing): в прежнем виде разметка не меняется
 * вовсе, в новом — круг с родным знаком площадки и без второй подписи для чтеца.
 */
describe("MarketingBrandMark", () => {
  it("без метки раздела ничего не рисует (прежний вид цел)", () => {
    expect(renderToStaticMarkup(<MarketingBrandMark channel="YOUTUBE" />)).toBe("");
    expect(renderToStaticMarkup(<RoyalSection name={undefined}><MarketingBrandMark channel="YOUTUBE" /></RoyalSection>)).toBe("");
    // чужой раздел — тоже нет: знак принадлежит только «Маркетингу»
    expect(renderToStaticMarkup(<RoyalSection name="money"><MarketingBrandMark channel="YOUTUBE" /></RoyalSection>)).toBe("");
  });
  it("в разделе «Маркетинг» — круг площадки, скрытый от чтеца (название стоит рядом текстом)", () => {
    for (const channel of ["INSTAGRAM", "FACEBOOK", "YOUTUBE", "TIKTOK", "TELEGRAM", "THREADS", "instagram"]) {
      const html = renderToStaticMarkup(<RoyalSection name="marketing"><MarketingBrandMark channel={channel} /></RoyalSection>);
      expect(html, channel).toContain(`data-channel="${channel.toUpperCase()}"`);
      expect(html, channel).toContain('aria-hidden="true"');
      expect(html, channel).toContain("<svg");
    }
  });
  it("незнакомая площадка или «нет площадки» — пусто, а не выдуманный знак", () => {
    for (const channel of ["—", "", null, undefined, "MYSPACE"]) {
      expect(renderToStaticMarkup(<RoyalSection name="marketing"><MarketingBrandMark channel={channel} /></RoyalSection>)).toBe("");
    }
  });
});
