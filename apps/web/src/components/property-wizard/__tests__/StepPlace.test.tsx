import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import type { District } from "../../../types";
import type { GeoResolveCandidate } from "../../../hooks/usePropertiesMap";
import { EMPTY_WIZARD_VALUES } from "../types";

type Slot = { value?: unknown; current?: unknown; deps?: unknown[]; cleanup?: void | (() => void) };
const rt = vi.hoisted(() => ({
  scopes: new Map<string, Slot[]>(), scope: "root", index: 0, effects: [] as (() => void)[],
  resolve: vi.fn(), api: vi.fn(), landmarks: [] as { id: string; name: string }[],
}));
vi.mock("react", async (original) => {
  const slot = (initial: Slot) => {
    const slots = rt.scopes.get(rt.scope) ?? [];
    rt.scopes.set(rt.scope, slots);
    const index = rt.index++;
    return slots[index] ??= initial;
  };
  return { ...await original<typeof import("react")>(),
    useState: (initial: unknown) => { const state = slot({ value: initial }); return [state.value, (value: unknown) => { state.value = typeof value === "function" ? value(state.value) : value; }]; },
    useRef: (initial: unknown) => slot({ current: initial }),
    useId: () => slot({ value: `${rt.scope}-${rt.index}` }).value,
    useEffect: (effect: () => void | (() => void), deps: unknown[]) => {
      const state = slot({});
      if (state.deps && deps.length === state.deps.length && deps.every((item, i) => Object.is(item, state.deps![i]))) return;
      rt.effects.push(() => { state.cleanup?.(); state.deps = deps; state.cleanup = effect(); });
    },
  };
});
vi.mock("../../../hooks/usePropertiesMap", async (original) => ({ ...await original<typeof import("../../../hooks/usePropertiesMap")>(), resolveGeoPlace: (...args: unknown[]) => rt.resolve(...args) }));
vi.mock("../../../lib/api", async (original) => ({ ...await original<typeof import("../../../lib/api")>(), api: (...args: unknown[]) => rt.api(...args) }));
vi.mock("../../../hooks/useLandmarks", async (original) => ({ ...await original<typeof import("../../../hooks/useLandmarks")>(), useLandmarks: () => ({ data: { items: rt.landmarks } }) }));
vi.mock("../../../hooks/useDebouncedValue", async (original) => ({ ...await original<typeof import("../../../hooks/useDebouncedValue")>(), useDebouncedValue: (value: unknown) => value }));
vi.mock("../useReverseGeocode", async (original) => ({ ...await original<typeof import("../useReverseGeocode")>(), useReverseGeocode: () => ({ result: null, status: "idle" }) }));
vi.mock("../useMapDistrict", async (original) => ({ ...await original<typeof import("../useMapDistrict")>(), useMapDistrict: () => null }));
vi.mock("../usePointLandmarks", async (original) => ({ ...await original<typeof import("../usePointLandmarks")>(), usePointLandmarks: () => null }));
vi.mock("../useDuplicateAddress", async (original) => ({ ...await original<typeof import("../useDuplicateAddress")>(), useDuplicateAddress: () => [] }));
import { StepPlace } from "../StepPlace";

type Node = ReactElement<Record<string, unknown>>;
const candidates: GeoResolveCandidate[] = [
  { targetId: "one", targetType: "building", name: "Тестовая 1", lat: 38.5, lng: 68.7, radiusM: 20, precision: "prefix" },
  { targetId: "two", targetType: "building", name: "Тестовая 2", lat: 38.6, lng: 68.8, radiusM: 20, precision: "prefix" },
];
let values = { ...EMPTY_WIZARD_VALUES, address: "Тестовая", landmark: "Парк" };
let errors: Record<string, string> = {};
const changed = vi.fn();
const districts = [{ id: "district-one", name: "Сино" }] as District[];
function render(): Node[] {
  rt.scope = "root"; rt.index = 0;
  const tree = StepPlace({ values, errors, districts, districtsLoading: false, onChange: (patch) => { changed(patch); values = { ...values, ...patch }; } });
  const nodes: Node[] = [];
  function expand(child: unknown) {
    if (Array.isArray(child)) { child.forEach(expand); return; }
    if (!child || typeof child !== "object") return;
    const element = child as Node;
    if (typeof element.type === "function") {
      rt.scope = element.type.name; rt.index = 0;
      expand((element.type as (props: unknown) => unknown)(element.props));
    } else { nodes.push(element); expand(element.props?.children); }
  }
  expand(tree);
  while (rt.effects.length) rt.effects.shift()!();
  return nodes;
}
const input = (nodes: Node[], name = "address") => nodes.find((node) => node.props["data-testid"] === `wizard-${name}-input`)!;
const options = (nodes: Node[]) => nodes.filter((node) => node.props.role === "option");
function invoke(node: Node, handler: string, event?: unknown) { (node.props[handler] as (event?: unknown) => void)(event); }
function key(node: Node, value: string, composing = false) {
  const event = { key: value, nativeEvent: { isComposing: composing }, preventDefault: vi.fn(), stopPropagation: vi.fn() };
  invoke(node, "onKeyDown", event); return event;
}
async function openAddress() {
  invoke(input(render()), "onFocus"); render();
  await vi.advanceTimersByTimeAsync(350);
  return render();
}
beforeEach(() => {
  vi.useFakeTimers(); rt.scopes.clear(); rt.effects = []; rt.index = 0;
  values = { ...EMPTY_WIZARD_VALUES, address: "Тестовая", landmark: "Парк" }; errors = {}; changed.mockReset();
  rt.resolve.mockReset().mockResolvedValue({ ...candidates[0], confidence: "prefix", alternatives: [candidates[1]] });
  rt.api.mockReset().mockResolvedValue({ district: null });
  rt.landmarks = [{ id: "park-one", name: "Первый парк" }, { id: "park-two", name: "Второй парк" }];
});
afterEach(() => {
  for (const scope of rt.scopes.values()) for (const state of scope) state.cleanup?.();
  vi.clearAllTimers(); vi.useRealTimers();
});

describe("place suggestions interaction", () => {
  it("keeps focus on the combobox and selects the arrow-highlighted address with Enter", async () => {
    let nodes = await openAddress();
    expect(input(nodes).props["aria-expanded"]).toBe(true);
    expect(key(input(nodes), "Enter").preventDefault).not.toHaveBeenCalled();
    expect(changed).not.toHaveBeenCalled();
    key(input(nodes), "ArrowDown"); nodes = render();
    expect(input(nodes).props["aria-activedescendant"]).toBe(options(nodes)[0].props.id);
    key(input(nodes), "ArrowDown"); nodes = render();
    expect(options(nodes).map((node) => node.props["aria-selected"])).toEqual([false, true]);
    expect(options(nodes).every((node) => node.props.tabIndex === -1)).toBe(true);
    expect(key(input(nodes), "Enter").preventDefault).toHaveBeenCalled();
    expect(changed).toHaveBeenCalledWith({ address: "Тестовая 2", lat: 38.6, lng: 68.8 });
    expect(input(render()).props["aria-expanded"]).toBe(false);
    expect(rt.api).toHaveBeenCalledWith("/geo/lookup?lat=38.6&lng=68.8");
  });

  it("closes without selecting on Escape and Tab, and never lets a previous blur close a reopened list", async () => {
    let nodes = await openAddress(); key(input(nodes), "ArrowUp"); nodes = render();
    expect(input(nodes).props["aria-activedescendant"]).toBe(options(nodes)[1].props.id);
    expect(key(input(nodes), "Escape").stopPropagation).toHaveBeenCalled();
    expect(input(render()).props["aria-expanded"]).toBe(false);
    invoke(input(render()), "onFocus"); nodes = render();
    key(input(nodes), "ArrowDown"); nodes = render();
    expect(key(input(nodes), "Tab").preventDefault).not.toHaveBeenCalled();
    expect(input(render()).props["aria-expanded"]).toBe(false);
    invoke(input(render()), "onFocus"); invoke(input(render()), "onBlur"); invoke(input(render()), "onFocus");
    await vi.advanceTimersByTimeAsync(200);
    expect(input(render()).props["aria-expanded"]).toBe(true);
    expect(changed).not.toHaveBeenCalled();
  });

  it("retains input focus for pointer activation and selects through click, including touch/assistive clicks", async () => {
    const nodes = await openAddress(); const selected = options(nodes)[1];
    const pointer = { preventDefault: vi.fn() };
    invoke(selected, "onPointerDown", pointer);
    expect(pointer.preventDefault).toHaveBeenCalled(); expect(changed).not.toHaveBeenCalled();
    invoke(selected, "onClick");
    expect(changed).toHaveBeenCalledTimes(1);
    expect(values.address).toBe("Тестовая 2");
    expect(input(render()).props["aria-expanded"]).toBe(false);
  });

  it("supports landmark arrows/Home/End and rejects stale highlights after text or results change", () => {
    invoke(input(render(), "landmark"), "onFocus"); let nodes = render();
    key(input(nodes, "landmark"), "ArrowDown"); nodes = render();
    key(input(nodes, "landmark"), "End"); nodes = render();
    expect(input(nodes, "landmark").props["aria-activedescendant"]).toBe(options(nodes)[1].props.id);
    key(input(nodes, "landmark"), "Home"); nodes = render();
    expect(options(nodes)[0].props["aria-selected"]).toBe(true);
    invoke(input(nodes, "landmark"), "onChange", { target: { value: "Ручной ориентир" } }); nodes = render();
    key(input(nodes, "landmark"), "Enter");
    expect(values.landmark).toBe("Ручной ориентир");
    key(input(nodes, "landmark"), "ArrowDown"); nodes = render();
    rt.landmarks = [{ id: "new", name: "Другой парк" }]; nodes = render();
    expect(input(nodes, "landmark").props["aria-activedescendant"]).toBeUndefined();
    expect(key(input(nodes, "landmark"), "Enter").preventDefault).not.toHaveBeenCalled();
    key(input(nodes, "landmark"), "ArrowUp"); nodes = render();
    expect(key(input(nodes, "landmark"), "Enter", true).preventDefault).not.toHaveBeenCalled();
    key(input(nodes, "landmark"), "Enter");
    expect(values.landmark).toBe("Другой парк");
    // Cached suggestions must reopen with arrows after selection/Escape.
    nodes = render(); key(input(nodes, "landmark"), "ArrowDown"); nodes = render();
    expect(input(nodes, "landmark").props["aria-expanded"]).toBe(true);
    key(input(nodes, "landmark"), "Escape"); nodes = render();
    key(input(nodes, "landmark"), "ArrowDown"); nodes = render();
    expect(input(nodes, "landmark").props["aria-expanded"]).toBe(true);
  });

  it("associates each actual field error with its control, including the off-site address", () => {
    errors = { address: "Укажите адрес", landmark: "Ориентир слишком длинный", districtId: "Укажите район" };
    for (const offSite of [false, true]) {
      values.offSite = offSite; const nodes = render();
      for (const field of [input(nodes), input(nodes, "landmark"), nodes.find((node) => node.props.role === "tab")!]) {
        expect(field.props["aria-invalid"]).toBe(true);
        const id = field.props["aria-describedby"];
        expect(nodes.some((node) => node.props.id === id && node.props.role === "status")).toBe(true);
      }
    }
    errors = {};
    expect(input(render()).props["aria-invalid"]).toBe(false);
    expect(input(render()).props["aria-describedby"]).toBeUndefined();
  });
});
