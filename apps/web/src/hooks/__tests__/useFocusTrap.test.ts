import { afterEach, describe, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({ effects: [] as (() => (() => void) | undefined)[] }));
vi.mock("react", () => ({
  useRef: <T,>(current: T) => ({ current }),
  useEffect: (effect: () => (() => void) | undefined) => { hooks.effects.push(effect); },
}));
import { useFocusTrap } from "../useFocusTrap";

type Item = ReturnType<typeof item>;
const listeners = new Set<(event: KeyboardEvent) => void>();
const connected = new Set<object>();
const doc = {
  activeElement: null as Item | null,
  contains: (node: object) => connected.has(node),
  addEventListener: (_: string, listener: (event: KeyboardEvent) => void) => listeners.add(listener),
  removeEventListener: (_: string, listener: (event: KeyboardEvent) => void) => listeners.delete(listener),
};
const cleanups: (() => void)[] = [];
function item() {
  const value = { offsetParent: {}, hasAttribute: () => false, focus: () => { doc.activeElement = value; } };
  connected.add(value);
  return value;
}
function TrapHarness(buttons: Item[]) {
  const node = { ...item(), querySelectorAll: () => buttons, contains: (active: unknown) => active === node || buttons.includes(active as Item) };
  const ref = useFocusTrap<HTMLElement>();
  ref.current = node as unknown as HTMLElement;
  const effect = hooks.effects.pop()!;
  return { node, effect, mount: () => { const cleanup = effect()!; cleanups.push(cleanup); return cleanup; } };
}
function tab(shiftKey = false) {
  const event = { key: "Tab", shiftKey, preventDefault: vi.fn() };
  for (const listener of listeners) listener(event as unknown as KeyboardEvent);
  return event;
}
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  listeners.clear(); connected.clear(); hooks.effects.length = 0; vi.unstubAllGlobals();
});
describe("nested focus traps", () => {
  it("lets native Tab traverse the upper dialog and wraps only its boundaries", () => {
    vi.stubGlobal("document", doc);
    const opener = item(); opener.focus();
    const lower = [item(), item()]; TrapHarness(lower).mount(); lower[1].focus();
    const upper = [item(), item(), item()]; TrapHarness(upper).mount();
    upper[1].focus(); expect(tab().preventDefault).not.toHaveBeenCalled();
    expect(doc.activeElement).toBe(upper[1]);
    upper[2].focus(); expect(tab().preventDefault).toHaveBeenCalledOnce();
    expect(doc.activeElement).toBe(upper[0]);
    tab(true); expect(doc.activeElement).toBe(upper[2]);
  });
  it("returns to the parent opener and resumes its boundary guard", () => {
    vi.stubGlobal("document", doc);
    const lower = [item(), item()]; TrapHarness(lower).mount(); lower[1].focus();
    const upper = [item()]; const unmount = TrapHarness(upper).mount(); upper[0].focus();
    unmount(); expect(doc.activeElement).toBe(lower[1]);
    tab(); expect(doc.activeElement).toBe(lower[0]);
  });
  it("does not steal child focus when a lower trap unmounts", () => {
    vi.stubGlobal("document", doc);
    const lower = TrapHarness([item()]); const unmount = lower.mount();
    const upper = [item()]; TrapHarness(upper).mount(); upper[0].focus();
    unmount(); expect(doc.activeElement).toBe(upper[0]);
  });
  it("returns to the outer trigger when the whole nested tree unmounts parent first", () => {
    vi.stubGlobal("document", doc);
    const opener = item(); opener.focus();
    const lowerItems = [item()]; const closeParent = TrapHarness(lowerItems).mount(); lowerItems[0].focus();
    const upperItems = [item()]; const closeChild = TrapHarness(upperItems).mount(); upperItems[0].focus();
    closeParent(); connected.delete(lowerItems[0]); closeChild();
    expect(doc.activeElement).toBe(opener);
  });
  it("returns to the outer trigger when the whole nested tree unmounts child first", () => {
    vi.stubGlobal("document", doc);
    const opener = item(); opener.focus();
    const lowerItems = [item()]; const closeParent = TrapHarness(lowerItems).mount(); lowerItems[0].focus();
    const upperItems = [item()]; const closeChild = TrapHarness(upperItems).mount(); upperItems[0].focus();
    connected.delete(lowerItems[0]); closeChild(); closeParent();
    expect(doc.activeElement).toBe(opener);
  });
  it("skips a disabled final confirm button while retaining the upper guard", () => {
    vi.stubGlobal("document", doc);
    TrapHarness([item()]).mount();
    const upper = [item(), item(), item()]; upper[2].hasAttribute = (name?: string) => name === "disabled";
    TrapHarness(upper).mount(); upper[1].focus(); tab(); expect(doc.activeElement).toBe(upper[0]);
    tab(true); expect(doc.activeElement).toBe(upper[1]);
  });
  it("uses activation order rather than child-before-parent effect order", () => {
    vi.stubGlobal("document", doc);
    const lowerItems = [item()]; const lower = TrapHarness(lowerItems);
    const upperItems = [item(), item()]; const upper = TrapHarness(upperItems);
    upper.mount(); lower.mount(); upperItems[0].focus();
    expect(tab().preventDefault).not.toHaveBeenCalled();
  });
  it("keeps one active listener after a StrictMode effect cleanup/replay", () => {
    vi.stubGlobal("document", doc);
    const buttons = [item(), item()]; const value = TrapHarness(buttons);
    value.mount()(); value.mount(); expect(listeners.size).toBe(1);
    buttons[1].focus(); tab(); expect(doc.activeElement).toBe(buttons[0]);
  });
});
