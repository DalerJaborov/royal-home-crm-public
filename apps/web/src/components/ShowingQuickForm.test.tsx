import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ShowingQuickForm } from "./ShowingQuickForm";

// Render the selected-client branch without a DOM; manual QA exercises selection.
const selected = vi.hoisted(() => ({ id: "test-client", kind: "BUYER", fullName: "Synthetic buyer" }));
vi.mock("react", async (importOriginal) => {
  const original = await importOriginal<typeof import("react")>();
  return { ...original, useState: (initial: unknown) => original.useState(initial === null ? selected : initial) };
});
vi.mock("../hooks/useClients", () => ({ useClients: () => ({ data: { items: [] } }) }));
vi.mock("../hooks/useDebouncedValue", () => ({ useDebouncedValue: (value: string) => value }));
vi.mock("./AddInteractionModal", () => ({
  AddInteractionModal: (props: { mode?: string; initialType?: string; initialPropertyId?: string; clientId: string }) =>
    <div data-mode={props.mode} data-type={props.initialType} data-property={props.initialPropertyId} data-client={props.clientId} />,
}));

describe("quick showing plans a future appointment", () => {
  for (const clean of [false, true]) {
    it.each([undefined, "test-property"])(`clean=${clean}, property=%s explicitly opens scheduling`, initialPropertyId => {
      const html = renderToStaticMarkup(<ShowingQuickForm clean={clean} initialPropertyId={initialPropertyId} onClose={() => undefined} />);
      expect(html).toContain('data-mode="schedule"');
      expect(html).toContain('data-type="SHOWING"');
      expect(html).toContain('data-client="test-client"');
      if (initialPropertyId) expect(html).toContain('data-property="test-property"');
    });
  }
});
