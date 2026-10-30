import React from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ error: null as Error | null }));
vi.mock("../../../components/LocationPicker", () => ({ LocationPicker: () => null }));
vi.mock("../../../hooks/useDistricts", () => ({
  useDistricts: () => ({ data: [{ id: "sino", name: "Сино" }] }),
  useCreateDistrict: () => ({ error: state.error, isPending: false, mutate: vi.fn() }),
}));
import { DistrictsSection } from "../AgencyTab";

describe("district form failure feedback", () => {
  it("shows a duplicate rejection without claiming success", () => {
    state.error = new Error("Район «Сино» уже есть в справочнике");
    const html = renderToString(<DistrictsSection />);
    expect(html).toContain('role="alert"');
    expect(html).toContain("Район «Сино» уже есть в справочнике");
    expect(html).not.toContain("Сохранено");
  });
  it("does not show an error before submitting", () => {
    state.error = null;
    expect(renderToString(<DistrictsSection />)).not.toContain('role="alert"');
  });
});
