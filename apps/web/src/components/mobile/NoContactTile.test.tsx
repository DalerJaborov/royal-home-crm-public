import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { NoContactTile } from "./NoContactTile";

/**
 * Плитка «не связывались» (17.11.2026, жалоба РОП Нозы на красные «50 без контакта»):
 * красная только когда есть кого показать, ноль — спокойный, с подписью
 * «со всеми связывались».
 */
describe("NoContactTile", () => {
  it("ноль — спокойный цвет и подпись «со всеми связывались»", () => {
    const html = renderToStaticMarkup(<NoContactTile count={0} onClick={() => {}} />);
    expect(html).toContain("со всеми связывались");
    expect(html).not.toContain("crit");
    expect(html).toContain('data-tone="calm"');
    expect(html).toContain(">0<");
  });

  it("больше нуля — красным и подпись «не связывались»", () => {
    const html = renderToStaticMarkup(<NoContactTile count={5} onClick={() => {}} />);
    expect(html).toContain("не связывались");
    expect(html).not.toContain("со всеми связывались");
    expect(html).toContain('class="v crit"');
    expect(html).toContain('class="l crit"');
    expect(html).toContain(">5<");
  });

  it("старой подписи «без контакта» больше нет", () => {
    expect(renderToStaticMarkup(<NoContactTile count={3} onClick={() => {}} />)).not.toContain("без контакта");
  });
});
