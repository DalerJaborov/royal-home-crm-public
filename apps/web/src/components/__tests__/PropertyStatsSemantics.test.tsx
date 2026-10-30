import React from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PropertyStats } from "../PropertyStats";
import type { Property } from "../../types";

describe("property statistic evidence", () => {
  it("does not relabel legacy booking totals as card views", () => {
    expect(renderToString(<PropertyStats property={{ viewsCount: 99 } as Property} />)).toBe("");
  });
  it("uses only the conducted-showing aggregate when supplied", () => {
    const html = renderToString(<PropertyStats property={{ viewsCount: 99, conductedShowingsCount: 1 } as Property} />);
    expect(html).toContain("Проведено показов: 1");
    expect(html).not.toContain("99");
    expect(html).not.toContain("Просмотров карточки");
  });
});
