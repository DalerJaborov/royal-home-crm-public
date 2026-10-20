import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * FORMS05: когда родитель меняет value у уже смонтированной карты (удалили
 * первое из «мест» клиента, второе заняло индекс 0), метка обязана переехать
 * на новые координаты. React подменён минимальным рантаймом хуков, как в
 * property-wizard/__tests__/useWizardLocalDraft.test.ts: jsdom в проекте нет.
 */
type Effect = { deps: unknown[] | undefined; cleanup?: void | (() => void) };
const rt = vi.hoisted(() => ({ slots: [] as unknown[], idx: 0, pending: [] as Array<() => void> }));
const leaf = vi.hoisted(() => ({
  marker: { pos: [0, 0] as [number, number] },
  view: [] as unknown[],
}));

vi.mock("react", () => ({
  useRef: (init: unknown) => {
    const i = rt.idx++;
    if (!(i in rt.slots)) rt.slots[i] = { current: init };
    return rt.slots[i];
  },
  useEffect: (fn: () => void | (() => void), deps?: unknown[]) => {
    const i = rt.idx++;
    const prev = rt.slots[i] as Effect | undefined;
    const changed = !prev || !deps || !prev.deps || deps.some((d, k) => !Object.is(d, prev.deps![k]));
    if (!changed) return;
    rt.pending.push(() => {
      if (prev && typeof prev.cleanup === "function") prev.cleanup();
      const slot: Effect = { deps, cleanup: undefined };
      rt.slots[i] = slot;
      slot.cleanup = fn();
    });
  },
}));
vi.mock("leaflet/dist/leaflet.css", () => ({}));
vi.mock("../../lib/leafletYandexTiles", () => ({
  attachYandexFallback: () => undefined,
  primaryTileConfig: () => ({ url: "", attribution: "" }),
}));
vi.mock("leaflet", () => {
  const latlng = (lat: number, lng: number) => ({ lat, lng });
  const map = {
    setView: (c: [number, number]) => {
      leaf.view.push(c);
      return map;
    },
    on: () => map,
    remove: () => undefined,
    invalidateSize: () => undefined,
    panTo: (c: [number, number]) => void leaf.view.push(c),
  };
  const marker = {
    addTo: () => marker,
    on: () => marker,
    getLatLng: () => latlng(leaf.marker.pos[0], leaf.marker.pos[1]),
    setLatLng: (c: [number, number] | { lat: number; lng: number }) => {
      leaf.marker.pos = Array.isArray(c) ? c : [c.lat, c.lng];
      return marker;
    },
  };
  const L = {
    map: () => map,
    tileLayer: () => ({ addTo: () => undefined }),
    marker: (c: [number, number]) => {
      leaf.marker.pos = c;
      return marker;
    },
    divIcon: () => ({}),
    circle: () => ({ addTo: () => ({}), setLatLng: () => undefined, setRadius: () => undefined, remove: () => undefined }),
  };
  return { default: L };
});

import { LocationPicker } from "../LocationPicker";

function render(value: { lat: number; lng: number } | null) {
  rt.idx = 0;
  rt.pending = [];
  LocationPicker({ value, onChange: () => undefined });
  for (const run of rt.pending) run();
}

beforeEach(() => {
  rt.slots = [];
  leaf.view = [];
  leaf.marker.pos = [0, 0];
  // containerRef.current у useRef-заглушки пуст: подставляем элемент вручную.
  vi.stubGlobal("setTimeout", () => 0);
});

describe("LocationPicker: смена value у смонтированной карты", () => {
  it("метка переезжает на новые координаты", () => {
    // Первый рендер: подсовываем контейнер, иначе инициализация карты пропускается.
    rt.idx = 0;
    rt.slots[0] = { current: {} };
    render({ lat: 38.51, lng: 68.71 });
    expect(leaf.marker.pos).toEqual([38.51, 68.71]);
    render({ lat: 38.59, lng: 68.79 });
    expect(leaf.marker.pos).toEqual([38.59, 68.79]);
  });
});
