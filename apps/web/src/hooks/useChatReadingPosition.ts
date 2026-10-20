import { useCallback, useLayoutEffect, useRef, useState } from "react";

/** Keep the operator's reading position while live messages and media arrive. */
export function useChatReadingPosition(enabled: boolean, messageCount: number, chunk = 60) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const initialized = useRef(false);
  const previousCount = useRef(0);
  const prepend = useRef<{ height: number; top: number } | null>(null);
  const anchor = useRef<{ key: string; offset: number } | null>(null);
  const [visibleCount, setVisibleCount] = useState(chunk);
  const [showLatest, setShowLatest] = useState(false);
  const [newMessageCount, setNewMessageCount] = useState(0);

  const captureAnchor = useCallback(() => {
    const viewport = scrollRef.current;
    if (!viewport) return;
    const bounds = viewport.getBoundingClientRect();
    const messages = Array.from(viewport.querySelectorAll<HTMLElement>("[data-chat-message]"));
    const message = messages.find((node) => {
        const rect = node.getBoundingClientRect();
        return rect.bottom > bounds.top && rect.top < bounds.bottom;
      }) ?? messages.find((node) => node.getBoundingClientRect().bottom > bounds.top);
    // At the very top, the earlier-history button/day label may occupy the
    // viewport. Preserve the nearest upcoming message rather than a height
    // estimate: removing that button changes its own height independently.
    anchor.current = message ? { key: message.dataset.chatMessage!, offset: message.getBoundingClientRect().top - bounds.top } : null;
  }, []);

  const restoreAnchor = useCallback(() => {
    const viewport = scrollRef.current;
    if (!viewport || !anchor.current) return false;
    const message = Array.from(viewport.querySelectorAll<HTMLElement>("[data-chat-message]"))
      .find((node) => node.dataset.chatMessage === anchor.current!.key);
    if (!message) return false;
    const offset = message.getBoundingClientRect().top - viewport.getBoundingClientRect().top;
    const delta = offset - anchor.current.offset;
    if (Math.abs(delta) > 0.5) viewport.scrollTop += delta;
    return true;
  }, []);

  const jumpToLatest = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    pinned.current = true;
    anchor.current = null;
    el.scrollTo({ top: el.scrollHeight });
    setShowLatest(false);
    setNewMessageCount(0);
  }, []);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el || !enabled) return;
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    setShowLatest(!pinned.current);
    if (pinned.current) { setNewMessageCount(0); anchor.current = null; }
    else captureAnchor();
  }, [enabled, captureAnchor]);

  const showMoreMessages = useCallback(() => {
    const el = scrollRef.current;
    if (enabled && el) {
      pinned.current = false;
      captureAnchor();
      prepend.current = { height: el.scrollHeight, top: el.scrollTop };
    }
    setVisibleCount((count) => count + chunk);
  }, [enabled, chunk, captureAnchor]);

  useLayoutEffect(() => {
    if (!enabled) return;
    const el = scrollRef.current;
    if (!el) return;
    const added = messageCount - previousCount.current;
    if (initialized.current && added > 0 && !pinned.current) {
      // Expand the window before paint: the first message being read must not
      // disappear when a new message is appended to a fixed-size tail.
      setVisibleCount((count) => count + added);
      setNewMessageCount((count) => count + added);
      setShowLatest(true);
    }
    previousCount.current = messageCount;
    if (messageCount > 0 && (!initialized.current || pinned.current)) {
      el.scrollTo({ top: el.scrollHeight });
      initialized.current = true;
      setNewMessageCount(0);
    }
  }, [enabled, messageCount]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!enabled || !el) return;
    if (prepend.current) {
      if (!restoreAnchor()) el.scrollTop = prepend.current.top + el.scrollHeight - prepend.current.height;
      prepend.current = null;
    } else if (!pinned.current) {
      // A new-message toolbar or a regrouped first bubble can move the anchor
      // without changing the content's total height. Correct before paint,
      // before the browser's ensuing scroll event captures the shifted offset.
      restoreAnchor();
    }
  }, [enabled, visibleCount, showLatest, messageCount, restoreAnchor]);

  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!enabled || !content || typeof ResizeObserver === "undefined") return;
    // Images, translations, uploads and the phone keyboard can resize the
    // thread without changing the message count. A reader higher up keeps the
    // same visible message offset, even when an image ABOVE it gains height.
    const observer = new ResizeObserver(() => {
      const el = scrollRef.current;
      if (el && pinned.current) el.scrollTo({ top: el.scrollHeight });
      else restoreAnchor();
    });
    observer.observe(content);
    const viewport = scrollRef.current;
    if (viewport) observer.observe(viewport);
    return () => observer.disconnect();
  }, [enabled, restoreAnchor]);

  return { scrollRef, contentRef, visibleCount, setVisibleCount, showMoreMessages, onScroll, showLatest, newMessageCount, jumpToLatest };
}
