import { test } from "node:test";
import assert from "node:assert/strict";
import { compareResponsiveText, hasResponsiveTextLoss, needsMatchingConversationCapture } from "./parity-text-comparison.mjs";

const cell = (textLen, overrides = {}) => ({ ok: true, textLen, conversationText: {
  label: "Диалог: Демо клиент", visible: true, bodyPresent: true, bodyTextLen: 150,
  backVisible: true, ...overrides,
} });
const row = (route, desktop = cell(1000), mobile = cell(270)) => ({
  desktop, mobile, ratioMobileToDesktop: mobile.textLen / desktop.textLen,
  textComparison: compareResponsiveText(route, desktop, mobile),
});

test("one-pane messenger compares the same loaded conversation and preserves raw page evidence", () => {
  const result = row("/messages?channel=WHATSAPP");
  assert.equal(result.textComparison.scope, "same-conversation-body");
  assert.equal(result.textComparison.ratio, 1);
  assert.equal(result.textComparison.rawRatio, .27);
  assert.equal(result.ratioMobileToDesktop, .27);
  assert.equal(hasResponsiveTextLoss(result), false);
});

for (const [name, overrides] of [
  ["different conversation", { label: "Диалог: Другой клиент" }],
  ["generic unselected placeholder", { label: "Диалог" }],
  ["missing label", { label: "" }],
  ["hidden pane", { visible: false }],
  ["missing body", { bodyPresent: false }],
  ["empty loaded body", { bodyTextLen: 0 }],
  ["no visible return to dialogs", { backVisible: false }],
]) {
  test(`${name} cannot waive whole-page loss`, () => {
    const result = row("/messages", cell(1000), cell(270, overrides));
    assert.equal(result.textComparison.scope, "whole-page");
    assert.equal(hasResponsiveTextLoss(result), true);
  });
}

test("lost text inside the same conversation still fails", () => {
  const result = row("/messages", cell(1000, { bodyTextLen: 400 }), cell(270, { bodyTextLen: 100 }));
  assert.equal(result.textComparison.scope, "same-conversation-body");
  assert.equal(result.textComparison.ratio, .25);
  assert.equal(hasResponsiveTextLoss(result), true);
});

for (const route of ["/clients", "/reports", "/messages/archive", "/settings"]) {
  test(`${route} always uses whole-page comparison`, () => {
    const result = row(route);
    assert.equal(result.textComparison.scope, "whole-page");
    assert.equal(hasResponsiveTextLoss(result), true);
  });
}
test("missing desktop body and legacy messenger cannot waive loss", () => {
  for (const desktop of [cell(1000, { bodyPresent: false }), { ok: true, textLen: 1000 }]) {
    assert.equal(hasResponsiveTextLoss(row("/messages", desktop)), true);
  }
});
test("failed cells do not create a semantic success", () => {
  const result = compareResponsiveText("/messages", { ...cell(1000), ok: false }, cell(270));
  assert.deepEqual(result, { scope: "whole-page", ratio: null, rawRatio: null });
});
test("a separately opened matching mobile conversation keeps initial list-only raw metrics", () => {
  const desktop = cell(1994, { bodyTextLen: 1310 });
  const mobile = { ok: true, textLen: 546, conversationText: null,
    comparedConversationText: { ...cell(0).conversationText, bodyTextLen: 1262 } };
  const comparison = compareResponsiveText("/messages", desktop, mobile);
  assert.equal(comparison.scope, "same-conversation-body");
  assert.equal(comparison.rawRatio, .27);
  assert.equal(comparison.ratio, .96);
});

test("hidden operator placeholder still requires opening the matching mobile dialog", () => {
  assert.equal(needsMatchingConversationCapture("Диалог: Демо клиент", { conversationText: {
    label: "Переписка", visible: false, bodyPresent: false, bodyTextLen: 0,
  } }), true);
  assert.equal(needsMatchingConversationCapture("Диалог: Демо клиент", cell(270)), false);
  assert.equal(needsMatchingConversationCapture("Диалог: Демо клиент", cell(270, { label: "Диалог: Другой клиент" })), true);
  assert.equal(needsMatchingConversationCapture("Диалог", cell(270)), false);
});
