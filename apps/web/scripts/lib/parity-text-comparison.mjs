const ratio = (mobile, desktop) => desktop > 0 ? Math.round(mobile / desktop * 100) / 100 : null;

/** A mounted (but hidden) empty pane is not a loaded mobile conversation. */
export function needsMatchingConversationCapture(label, cell) {
  if (typeof label !== "string" || !/^Диалог:\s*\S/.test(label)) return false;
  const conversation = cell?.conversationText;
  return !(conversation?.label === label && conversation.visible && conversation.bodyPresent && conversation.bodyTextLen > 0 && conversation.backVisible);
}

/** A mobile messenger intentionally shows one pane. Compare only the same loaded
 * conversation body, with evidence of an available return to its dialog list. */
export function compareResponsiveText(route, desktop, mobile) {
  const rawRatio = desktop?.ok && mobile?.ok ? ratio(mobile.textLen, desktop.textLen) : null;
  const wholePage = { scope: "whole-page", ratio: rawRatio, rawRatio };
  if (route.split(/[?#]/)[0] !== "/messages" || !desktop?.ok || !mobile?.ok) return wholePage;
  const d = desktop.comparedConversationText ?? desktop.conversationText;
  const m = mobile.comparedConversationText ?? mobile.conversationText;
  if (!d?.visible || !m?.visible || !d.bodyPresent || !m.bodyPresent || !m.backVisible) return wholePage;
  if (typeof d.label !== "string" || !/^Диалог:\s*\S/.test(d.label) || d.label !== m.label) return wholePage;
  if (!(d.bodyTextLen > 0) || !(m.bodyTextLen > 0)) return wholePage;
  return { scope: "same-conversation-body", ratio: ratio(m.bodyTextLen, d.bodyTextLen), rawRatio,
    conversationLabel: d.label, desktopTextLen: d.bodyTextLen, mobileTextLen: m.bodyTextLen };
}

export function hasResponsiveTextLoss(row) {
  const value = row.textComparison?.ratio ?? row.ratioMobileToDesktop;
  return value !== null && value !== undefined && value < 0.5 && row.desktop?.textLen > 0;
}
