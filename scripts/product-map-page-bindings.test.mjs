import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { collectPageBindings } from "./product-map-page-bindings.mjs";

function fixture(t, files) {
  const root = mkdtempSync(join(tmpdir(), "rh-map-bindings-"));
  for (const [name, source] of Object.entries(files)) {
    const file = join(root, name);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, source);
  }
  t.after(() => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.ok(root.includes("rh-map-bindings-"));
    rmSync(root, { recursive: true, force: true });
  });
  return { root, read: () => collectPageBindings(join(root, "App.tsx"), { webRoot: root }) };
}

test("named common loader never steals the adjacent inline page import", (t) => {
  const { root, read } = fixture(t, {
    "App.tsx": `import { loadClients as warmClients } from "./lib/chunks";
      const Clients = lazyWithReload(warmClients);
      const LostClients = lazyWithReload(() => import("./pages/LostClients").then(m => ({default:m.LostClients})));
      export function App() { return <><Clients/><LostClients/></>; }`,
    "lib/chunks.ts": `export const loadClients = memoizedChunk(() => import("../pages/Clients").then(m => ({default:m.Clients})));`,
    "pages/Clients.tsx": "export function Clients() {}",
    "pages/LostClients.tsx": "export function LostClients() {}",
  });
  const result = read();
  assert.equal(result.get("Clients"), join(root, "pages/Clients.tsx"));
  assert.equal(result.get("LostClients"), join(root, "pages/LostClients.tsx"));
});

test("static aliases, long inline factories and conditional imports retain actual page files", (t) => {
  const { root, read } = fixture(t, {
    "App.tsx": `import { Dashboard as Home } from "./pages/Dashboard";
      const Unknown = notAPage();
      const Calendar = lazyWithReload(() => { /* ${"long ".repeat(50)} */ return import("./pages/Calendar"); });
      const Dev = import.meta.env.DEV ? lazyWithReload(() => import("./pages/dev/Example")) : null;`,
    "pages/Dashboard.tsx": "export function Dashboard() {}",
    "pages/Calendar.tsx": "export function Calendar() {}",
    "pages/dev/Example.tsx": "export default function Example() {}",
  });
  const result = read();
  assert.equal(result.get("Home"), join(root, "pages/Dashboard.tsx"));
  assert.equal(result.get("Calendar"), join(root, "pages/Calendar.tsx"));
  assert.equal(result.get("Dev"), join(root, "pages/dev/Example.tsx"));
  assert.equal(result.has("Unknown"), false);
});

test("follows named reexports and terminates cyclic unresolved loaders", (t) => {
  const { root, read } = fixture(t, {
    "App.tsx": `import { renamed, cycle } from "./lib/index"; const Finance = lazyWithReload(renamed); const Nothing = lazyWithReload(cycle);`,
    "lib/index.ts": `export { loader as renamed } from "./actual"; export { cycle } from "./cycle";`,
    "lib/actual.ts": `export function loader() { return import("../pages/Finance"); }`,
    "lib/cycle.ts": `import { cycle as other } from "./index"; export const cycle = other;`,
    "pages/Finance.tsx": "export function Finance() {}",
  });
  assert.equal(read().get("Finance"), join(root, "pages/Finance.tsx"));
  assert.equal(read().has("Nothing"), false);
});

test("ambiguous multi-page factory fails instead of silently assigning the wrong screen", (t) => {
  const { read } = fixture(t, {
    "App.tsx": `const Mixed = lazyWithReload(() => condition ? import("./pages/A") : import("./pages/B"));`,
    "pages/A.tsx": "export function A() {}",
    "pages/B.tsx": "export function B() {}",
  });
  assert.throws(read, /Ambiguous page binding Mixed/);
});

test("real directory imports resolve through index files instead of reading a directory", (t) => {
  const { root, read } = fixture(t, {
    "App.tsx": `import { loadArchive } from "./lib/loaders"; const Archive = lazyWithReload(loadArchive);`,
    "lib/loaders/index.ts": `export const loadArchive = () => import("../../pages/archive");`,
    "pages/archive/index.tsx": "export function Archive() {}",
  });
  assert.equal(read().get("Archive"), join(root, "pages/archive/index.tsx"));
});
