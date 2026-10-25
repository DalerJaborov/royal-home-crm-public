import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SearchableSelect } from "./SearchableSelect";

describe("SearchableSelect — поле и список темы (перепись 24.10)", () => {
  const html = renderToStaticMarkup(
    <SearchableSelect
      value="a"
      onChange={() => {}}
      options={[
        { value: "a", label: "Рустам" },
        { value: "b", label: "Сомон" },
      ]}
    />,
  );

  it("поле-триггер несёт класс темы, а не Tailwind-утилиты без рамки", () => {
    expect(html).toContain('class="rh-select"');
    expect(html).toContain('class="rh-select-trigger"');
    expect(html).toContain('role="combobox"');
    expect(html).not.toMatch(/border-line|rounded-lg|bg-card/);
    expect(html).toContain("Рустам");
  });

  it("роли доступности остаются: триггер combobox, подпись выбранного значения", () => {
    expect(html).toContain('aria-haspopup="listbox"');
    expect(html).toContain('aria-expanded="false"');
  });
});
