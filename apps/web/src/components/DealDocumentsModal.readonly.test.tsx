import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
const state = vi.hoisted(() => ({ readOnly: false }));
vi.mock("../lib/permissions", () => ({ useIsReadOnly: () => state.readOnly }));
vi.mock("./rh2/Rh2Sheet", () => ({ Rh2Sheet: ({ children }: { children: ReactNode }) => <section>{children}</section> }));
vi.mock("../hooks/useDealDocuments", () => ({
  useDealDocuments: () => ({ data: [{ id: "doc", kind: "OWNERSHIP", originalName: "Проверка.pdf", uploadedByName: "Сотрудник", uploadedAt: "2026-10-01T00:00:00Z" }], isLoading: false }),
  useUploadDealDocument: () => ({ isPending: false }),
  useDeleteDealDocument: () => ({ isPending: false, isError: false }),
  useDealPayoutStatus: () => ({ data: null }),
  useDealPayout: () => ({ isPending: false }),
}));
import { DealDocumentsModal } from "./DealDocumentsModal";
beforeEach(() => { state.readOnly = false; });
const render = () => renderToStaticMarkup(<DealDocumentsModal dealId="deal" dealStage="COMPLETED" canPayout onClose={() => {}} />);
describe("read-only deal document view", () => {
  it("retains document downloads and payout state without upload, delete or payout mutation controls", () => {
    state.readOnly = true;
    const html = render();
    expect(html).toContain("Проверка.pdf");
    expect(html).toContain("Ждёт выплаты");
    for (const text of ["Удалить", "Добавить документ", 'type="file"', "Отметить выплаченной"]) expect(html).not.toContain(text);
  });
  it("retains existing permitted document and payout actions for editable profiles", () => {
    const html = render();
    for (const text of ["Удалить", "Добавить документ", 'type="file"', "Отметить выплаченной"]) expect(html).toContain(text);
  });
});
