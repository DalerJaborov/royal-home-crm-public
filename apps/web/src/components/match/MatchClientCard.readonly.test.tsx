import { Children, isValidElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MatchingClient } from "@royal-home/shared";
const h = vi.hoisted(() => ({ readOnly: false, index: 0, refs: [] as { current: unknown }[], send: vi.fn(), navigate: vi.fn(), confirm: null as (() => unknown) | null }));
vi.mock("react", async importOriginal => ({ ...(await importOriginal<typeof import("react")>()), useRef: (value: unknown) => { const index = h.index++; return h.refs[index] ??= { current: value }; }, useState: (value: unknown) => [value, vi.fn()] }));
vi.mock("../../lib/permissions", () => ({ useIsReadOnly: () => h.readOnly }));
vi.mock("react-router-dom", () => ({ useNavigate: () => h.navigate }));
vi.mock("../../hooks/useClients", () => ({ useSendProperties: () => ({ mutateAsync: h.send, isPending: false }), useSendTarget: () => ({ data: null }) }));
vi.mock("../../hooks/useSendPropertyConfirm", () => ({ useSendPropertyConfirm: () => ({ open: false, request: (fn: () => unknown) => { h.confirm = fn; } }) }));
import { MatchClientCard } from "./MatchClientCard";
function buttons(node: ReactNode): { children?: ReactNode; onClick?: () => void; disabled?: boolean }[] {
  return Children.toArray(node).flatMap(child => isValidElement<{ children?: ReactNode; onClick?: () => void; disabled?: boolean }>(child) ? [...(child.type === "button" ? [child.props] : []), ...buttons(child.props.children)] : []);
}
const client = { id: "seed-client", shortId: 1, fullName: "Seed client", reasons: [], score: 80, status: "IN_PROGRESS" } as unknown as MatchingClient;
beforeEach(() => { h.readOnly = false; h.index = 0; h.refs = []; h.confirm = null; h.send.mockReset(); h.navigate.mockReset(); });
describe("matching row access changes", () => {
  it("prevents a captured send confirmation after readonly access appears", async () => {
    const tree = MatchClientCard({ client, propertyId: "seed-property" });
    buttons(tree).find(button => button.children === "Отправить")?.onClick?.();
    expect(h.confirm).toBeTypeOf("function");
    const confirm = h.confirm!;
    h.readOnly = true; h.index = 0;
    const readonlyTree = MatchClientCard({ client, propertyId: "seed-property" });
    expect(buttons(readonlyTree).find(button => button.children === "Отправить")?.disabled).toBe(true);
    await confirm(); expect(h.send).not.toHaveBeenCalled();
  });
});
