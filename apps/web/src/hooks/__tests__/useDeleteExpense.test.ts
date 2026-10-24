import { beforeEach, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
const h = vi.hoisted(() => ({ api: vi.fn(), invalidateQueries: vi.fn() }));
vi.mock("../../lib/api", async importOriginal => ({ ...(await importOriginal<typeof import("../../lib/api")>()), api: h.api }));
vi.mock("@tanstack/react-query", async importOriginal => ({
  ...(await importOriginal<typeof import("@tanstack/react-query")>()),
  useQueryClient: () => ({ invalidateQueries: h.invalidateQueries }),
  useMutation: (options: unknown) => options,
}));
import { useDeleteExpense } from "../useFinance";
beforeEach(() => { h.api.mockReset(); h.api.mockResolvedValue(undefined); });
it.each([
  { name: "legacy string", input: "synthetic-expense", path: "/expenses/synthetic-expense" },
  { name: "captured version zero", input: { id: "synthetic-expense", version: 0 }, path: "/expenses/synthetic-expense?version=0" },
  { name: "optional absent version", input: { id: "synthetic-expense" }, path: "/expenses/synthetic-expense" },
])("delete hook preserves $name", async ({ input, path }) => {
  let mutation!: { mutationFn: (value: typeof input) => Promise<unknown> };
  function Probe() { mutation = useDeleteExpense() as unknown as typeof mutation; return null; }
  renderToStaticMarkup(createElement(Probe));
  await mutation.mutationFn(input);
  expect(h.api).toHaveBeenCalledExactlyOnceWith(path, { method: "DELETE" });
});
