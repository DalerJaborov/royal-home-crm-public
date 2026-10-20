import { test } from "node:test";
import assert from "node:assert/strict";
import { assertLiveTarget } from "./parity-live-session.mjs";

test("live theme audit cannot mutate production or the owner's preview", () => {
  for (const base of ["https://crm.royalhome.tj", "http://localhost:5284", "http://example.com:5294", "https://localhost:5294"]) {
    assert.throws(() => assertLiveTarget(base), /isolated/);
  }
});
test("live theme audit accepts only the isolated loopback QA endpoints", () => {
  for (const base of ["http://localhost:5294", "http://127.0.0.1:5294"]) assert.doesNotThrow(() => assertLiveTarget(base));
});
test("integration seed is explicit and never grants access to other targets", () => {
  assert.throws(() => assertLiveTarget("http://127.0.0.1:5305", false), /isolated/);
  assert.doesNotThrow(() => assertLiveTarget("http://127.0.0.1:5305", true));
  for (const base of ["http://localhost:5284", "http://localhost:5306", "https://localhost:5305", "http://example.com:5305", "http://user:pass@localhost:5305"]) assert.throws(() => assertLiveTarget(base, true), /isolated/);
});
