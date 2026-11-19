import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Building2, Ruler } from "lucide-react";
import { RoyalSection } from "../clients/RoyalSection";
import { WizIcon, wizIconPairs } from "./WizIcon";

/**
 * Значки мастера объекта в «Новом виде» (пачка wizard). Без метки раздела —
 * прежний lucide; с меткой — значок набора макета. Каждая пара обязана рисоваться:
 * пара на значок, которого нет в наборе, роняла шаг «Параметры» целиком (найдено
 * кадром 20.11: «wallet» был в исходном JSON макета, но не в RoyalIcon).
 */
const html = (section: string | undefined, icon = Building2) =>
  renderToStaticMarkup(<RoyalSection name={section}><WizIcon icon={icon} size={24} className="wizard-type-icon" /></RoyalSection>);

describe("WizIcon", () => {
  it("без признака вида рисует прежний lucide", () => {
    expect(html(undefined)).toContain("lucide-building");
    expect(html("objects")).toContain("lucide-building");
  });
  it("в разделе wizard рисует значок макета и сохраняет класс места", () => {
    const out = html("wizard");
    expect(out).not.toContain("lucide");
    expect(out).toContain("wizard-type-icon");
    expect(out).toContain("ry-wiz-ic");
    expect(out).toContain('aria-hidden="true"');
  });
  it("значок без пары остаётся lucide и в новом виде", () => {
    expect(html("wizard", Ruler)).toContain("lucide-ruler");
  });
  it.each(wizIconPairs().map(([icon, name]) => [name, icon] as const))("пара «%s» рисуется (значок есть в наборе)", (_name, icon) => {
    const out = html("wizard", icon);
    expect(out).toMatch(/<svg[^>]*><path/);
  });
});
