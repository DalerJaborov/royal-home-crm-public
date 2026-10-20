import { beforeEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ readOnly: false, index: 0, refs: [] as { current: unknown }[], options: [] as { mutationFn: () => unknown }[], api: vi.fn() }));
vi.mock("react", async importOriginal => ({ ...(await importOriginal<typeof import("react")>()), useRef: (value: unknown) => { const index = h.index++; return h.refs[index] ??= { current: value }; }, useState: (value: unknown) => [value, vi.fn()] }));
vi.mock("../lib/permissions", () => ({ useIsReadOnly: () => h.readOnly }));
vi.mock("../lib/api", () => ({ api: h.api }));
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({ setQueryData: vi.fn() }), useQuery: () => ({ data: { link: null }, isLoading: false, isError: false }), useMutation: (options: { mutationFn: () => unknown }) => { h.options.push(options); return { mutate: vi.fn(), isPending: false }; } }));
import { OwnerReportCard } from "./OwnerReportCard";
beforeEach(() => { h.readOnly = false; h.index = 0; h.refs = []; h.options = []; h.api.mockReset(); });
describe("owner report access changes", () => {
  it("blocks old create and revoke callbacks after access changes to view-only", () => {
    OwnerReportCard({ propertyId: "seed-property" });
    const [create, revoke] = h.options;
    h.readOnly = true; h.index = 0;
    OwnerReportCard({ propertyId: "seed-property" });
    expect(create.mutationFn).toThrow("Доступ только для просмотра");
    expect(revoke.mutationFn).toThrow("Доступ только для просмотра");
    expect(h.api).not.toHaveBeenCalled();
  });
  it("blocks initial readonly mutation without creating an external report link", () => {
    h.readOnly = true; OwnerReportCard({ propertyId: "seed-property" });
    for (const option of h.options) expect(option.mutationFn).toThrow("Доступ только для просмотра");
    expect(h.api).not.toHaveBeenCalled();
  });
});
