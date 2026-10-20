import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";

type EffectSlot = { deps?: unknown[]; cleanup?: void | (() => void); current?: unknown; value?: unknown; callback?: unknown };
const rt = vi.hoisted(() => ({ slots: [] as EffectSlot[], index: 0, effects: [] as (() => void)[], api: vi.fn(), flush: vi.fn(), ensure: vi.fn(), localDraft: vi.fn(), adopted: vi.fn(), hydrated: vi.fn(), close: vi.fn(), token: "session-1", initialIntake: "" }));
vi.mock("react", async (original) => {
  const same = (a?: unknown[], b?: unknown[]) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  return { ...await original<typeof import("react")>(),
    useRef: (initial: unknown) => { const i = rt.index++; return rt.slots[i] ??= { current: initial }; },
    useState: (initial: unknown) => { const i = rt.index++; const slot = rt.slots[i] ??= { value: typeof initial === "function" ? initial() : initial }; return [slot.value, (value: unknown) => { slot.value = typeof value === "function" ? value(slot.value) : value; }]; },
    useCallback: (callback: unknown, deps: unknown[]) => { const i = rt.index++; const old = rt.slots[i]; if (old && same(old.deps, deps)) return old.callback; rt.slots[i] = { deps, callback }; return callback; },
    useMemo: (callback: () => unknown) => callback(),
    useEffect: (effect: () => void | (() => void), deps: unknown[]) => { const i = rt.index++; const old = rt.slots[i]; if (old && same(old.deps, deps)) return; rt.effects.push(() => { old?.cleanup?.(); rt.slots[i] = { deps, cleanup: effect() }; }); },
  };
});
vi.mock("react-router-dom", async (original) => ({ ...await original<typeof import("react-router-dom")>(), useNavigate: () => vi.fn() }));
vi.mock("@tanstack/react-query", async (original) => ({ ...await original<typeof import("@tanstack/react-query")>(), useQueryClient: () => ({ invalidateQueries: vi.fn() }) }));
vi.mock("../../../hooks/useRetryKey", async (original) => ({ ...await original<typeof import("../../../hooks/useRetryKey")>(), useRetryKey: () => "create-test" }));
vi.mock("../../../hooks/useDistricts", async (original) => ({ ...await original<typeof import("../../../hooks/useDistricts")>(), useDistricts: () => ({ data: [], isLoading: false }) }));
vi.mock("../../../hooks/useProperties", async (original) => ({ ...await original<typeof import("../../../hooks/useProperties")>(), useCreateProperty: () => ({ mutateAsync: vi.fn() }) }));
vi.mock("../../../store/auth", async (original) => ({ ...await original<typeof import("../../../store/auth")>(), useAuthStore: Object.assign((select: (state: unknown) => unknown) => select({ agent: { id: "agent-1" } }), { getState: () => ({ agent: { id: "agent-1" } }), subscribe: () => () => {} }) }));
vi.mock("../../../lib/permissions", async (original) => ({ ...await original<typeof import("../../../lib/permissions")>(), useCan: () => () => false }));
vi.mock("../../../lib/api", async (original) => ({ ...await original<typeof import("../../../lib/api")>(), api: (...args: unknown[]) => rt.api(...args) }));
vi.mock("../../../lib/pendingMapPin", async (original) => ({ ...await original<typeof import("../../../lib/pendingMapPin")>(), takePendingMapPin: () => null }));
vi.mock("../../../lib/workGuard", async (original) => ({ ...await original<typeof import("../../../lib/workGuard")>(), registerWork: () => vi.fn() }));
vi.mock("../../../lib/draftReminder", async (original) => ({ ...await original<typeof import("../../../lib/draftReminder")>(), setDraftReminder: vi.fn() }));
vi.mock("../../../lib/houseSnap", async (original) => ({ ...await original<typeof import("../../../lib/houseSnap")>(), snapNote: () => null, fetchHouseSnap: vi.fn() }));
vi.mock("../../../store/toast", async (original) => ({ ...await original<typeof import("../../../store/toast")>(), toast: { error: vi.fn() } }));
vi.mock("../../../hooks/useDraftMedia", async (original) => ({ ...await original<typeof import("../../../hooks/useDraftMedia")>(), useDraftMedia: () => [], useDraftPhotoLocation: () => null, summarizeDraftMedia: () => ({ ready: 0, pending: 0, failed: 0, photos: [], videos: [], percent: 0 }) }));
vi.mock("../../../lib/draftUploads", async (original) => ({ ...await original<typeof import("../../../lib/draftUploads")>(), canRetryDraftItem: () => false, clearDraftMedia: vi.fn(), detachDraftMediaView: vi.fn(), getDraftMediaSnapshot: () => [], hasLiveDraftMedia: () => false, hydrateDraftMedia: (...args: unknown[]) => rt.hydrated(...args), removeDraftMedia: vi.fn(), retryDraftMedia: vi.fn(), waitForDraftUploads: vi.fn() }));
const server = { id: "draft-1", revision: 2, values: {}, media: [], step: 0, updatedAt: "2026-10-20T12:00:00Z", expiresAt: "2026-10-27T12:00:00Z" };
vi.mock("../../../lib/propertyDraftSession", async (original) => ({ ...await original<typeof import("../../../lib/propertyDraftSession")>(), loadPropertyDraftSession: async () => ({ draft: null, revision: 0 }), getPropertyDraftSession: () => null, ensurePropertyDraftSession: () => rt.ensure(), adoptPropertyDraftSession: (...args: unknown[]) => rt.adopted(...args), invalidatePropertyDraftSession: vi.fn(), propertyDraftSessionToken: () => rt.token, isPropertyDraftSessionCurrent: (token: string) => token === rt.token }));
vi.mock("../useServerAutosave", async (original) => ({ ...await original<typeof import("../useServerAutosave")>(), useServerAutosave: () => ({ status: { state: "local" }, flush: () => rt.flush(), retry: vi.fn(), cancel: vi.fn() }) }));
vi.mock("../useWizardLocalDraft", async (original) => ({ ...await original<typeof import("../useWizardLocalDraft")>(), useWizardLocalDraft: (...args: unknown[]) => rt.localDraft(...args), WIZARD_LOCAL_DRAFT_TTL_MS: 604800000 }));
vi.mock("../WizardShell", async (original) => ({ ...await original<typeof import("../WizardShell")>(), WizardShell: "wizard-shell" }));
vi.mock("../StepSeller", async (original) => ({ ...await original<typeof import("../StepSeller")>(), StepSeller: "seller-step" }));
vi.mock("../StepMedia", async (original) => ({ ...await original<typeof import("../StepMedia")>(), StepMedia: "media-step" }));
vi.mock("../StepMain", async (original) => ({ ...await original<typeof import("../StepMain")>(), StepMain: "main-step" }));
vi.mock("../StepPlace", async (original) => ({ ...await original<typeof import("../StepPlace")>(), StepPlace: "place-step" }));
vi.mock("../StepReview", async (original) => ({ ...await original<typeof import("../StepReview")>(), StepReview: "review-step" }));
vi.mock("../DraftGate", async (original) => ({ ...await original<typeof import("../DraftGate")>(), DraftGate: "draft-gate" }));
vi.mock("../SaveProgressOverlay", async (original) => ({ ...await original<typeof import("../SaveProgressOverlay")>(), SaveProgressOverlay: "save-progress" }));
vi.mock("../UploadProblemSheet", async (original) => ({ ...await original<typeof import("../UploadProblemSheet")>(), UploadProblemSheet: "upload-problem" }));
vi.mock("../../ConfirmDialog", async (original) => ({ ...await original<typeof import("../../ConfirmDialog")>(), ConfirmDialog: "confirm-dialog" }));
import { PropertyWizard } from "../PropertyWizard";
type Node = ReactElement<Record<string, unknown>>;
function find(node: unknown, type: string): Node | undefined {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) { for (const child of node) { const found = find(child, type); if (found) return found; } return; }
  const element = node as Node;
  return element.type === type ? element : find(element.props?.children, type);
}
function render() {
  rt.index = 0;
  const tree = PropertyWizard({ onClose: rt.close, initialIntakeAgentId: rt.initialIntake || undefined });
  while (rt.effects.length) rt.effects.shift()!();
  return tree as Node;
}
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
beforeEach(() => {
  rt.slots = []; rt.effects = []; rt.index = 0; rt.api.mockReset(); rt.adopted.mockReset(); rt.hydrated.mockReset(); rt.close.mockReset(); rt.token = "session-1";
  rt.initialIntake = ""; rt.flush.mockReset().mockResolvedValue(undefined); rt.ensure.mockReset().mockResolvedValue({ id: "draft-1", revision: 1 }); rt.localDraft.mockReset().mockReturnValue(true);
  vi.stubGlobal("window", { scrollTo: vi.fn() });
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() });
});
afterEach(() => { for (const slot of rt.slots) slot.cleanup?.(); vi.unstubAllGlobals(); });

describe("seller import in the actual wizard controller", () => {
  it("locks selection and shell actions from invocation through the deferred import response", async () => {
    let resolve!: (value: unknown) => void;
    rt.api.mockReturnValue(new Promise((yes) => { resolve = yes; }));
    render(); await settle();
    let tree = render(); const seller = find(tree, "seller-step")!;
    const change = seller.props.onChange as (patch: unknown) => void;
    const pick = seller.props.onSellerPicked as (id: string) => void;
    change({ sellerClientId: "seller-A", sellerName: "", sellerPhone: "" }); pick("seller-A");
    (tree.props.onClose as () => void)();
    // Old handlers can still exist before React commits disabled controls.
    change({ sellerClientId: "" }); change({ sellerClientId: "seller-B", sellerName: "B" }); pick("seller-B");
    tree = render();
    expect(find(tree, "seller-step")?.props.values).toMatchObject({ sellerClientId: "seller-A", sellerName: "" });
    expect(find(tree, "fieldset")?.props.disabled).toBe(true);
    expect(tree.props.busy).toBe(true);
    (tree.props.onNext as () => void)(); (tree.props.onClose as () => void)(); (tree.props.onDeleteDraft as () => void)();
    (tree.props.onSaveAndExit as () => void)(); (tree.props.onGoToStep as (i: number) => void)(2);
    expect(rt.close).not.toHaveBeenCalled();
    await settle();
    expect(rt.api).toHaveBeenCalledTimes(1);
    expect(rt.api.mock.calls[0][0]).toContain("seller-A");
    resolve({ draft: { ...server, values: { address: "Адрес А" } } }); await settle();
    tree = render();
    expect(tree.props.busy).toBe(false);
    expect(find(tree, "fieldset")?.props.disabled).toBe(false);
    expect(find(tree, "seller-step")?.props.values).toMatchObject({ sellerClientId: "seller-A", address: "Адрес А" });
    expect(rt.adopted).toHaveBeenCalledWith({ draft: expect.objectContaining({ revision: 2 }), revision: 2 });
    expect(rt.hydrated).toHaveBeenCalledTimes(1);
  });
  it("keeps the import lock while autosave and session creation are still pending", async () => {
    let flushDone!: () => void; let sessionDone!: (value: unknown) => void; let importDone!: (value: unknown) => void;
    rt.flush.mockReturnValue(new Promise<void>((yes) => { flushDone = yes; }));
    rt.ensure.mockReturnValue(new Promise((yes) => { sessionDone = yes; }));
    rt.api.mockReturnValue(new Promise((yes) => { importDone = yes; }));
    render(); await settle();
    const seller = find(render(), "seller-step")!;
    (seller.props.onChange as (p: unknown) => void)({ sellerClientId: "seller-A" });
    (seller.props.onSellerPicked as (id: string) => void)("seller-A");
    expect(render().props.busy).toBe(true);
    expect(rt.ensure).not.toHaveBeenCalled(); expect(rt.api).not.toHaveBeenCalled();
    flushDone(); await settle();
    expect(render().props.busy).toBe(true); expect(rt.api).not.toHaveBeenCalled();
    sessionDone({ id: "draft-1", revision: 1 }); await settle();
    expect(render().props.busy).toBe(true); expect(rt.api).toHaveBeenCalledTimes(1);
    importDone({ draft: server }); await settle();
    expect(render().props.busy).toBe(false);
  });
  it("discard exit disables local writes even when the reset form includes an intake agent", async () => {
    rt.initialIntake = "agent-1";
    render(); await settle();
    let tree = render();
    (tree.props.onDeleteDraft as () => void)(); tree = render();
    const dialog = tree.props.overlay as Node;
    (dialog.props.onConfirm as () => void)(); await settle(); render();
    expect(rt.close).toHaveBeenCalledTimes(1);
    expect(rt.localDraft.mock.calls.at(-1)?.[1]).toBe(false);
    expect(rt.localDraft.mock.calls.at(-1)?.[2]).toMatchObject({ intakeAgentId: "agent-1" });
  });
});
