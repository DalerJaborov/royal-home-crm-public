import { useEffect, useLayoutEffect, useState } from "react";
import { BellRing, ChevronDown, Clock3 } from "lucide-react";
import type { McFirstLineItem } from "../../hooks/useMissionControl";
import { CButton, CLink } from "./ui";

type NoticeDecisions = Record<string, number>;
const ACKNOWLEDGED = -1;
const HOUR_MS = 60 * 60 * 1000;
const storageKey = (agentId: string) => `rh-clean-critical:v1:${agentId}`;

/** A changed aggregate message is a new event, even when its server ID is reused. */
export const criticalNoticeKey = (item: McFirstLineItem) => JSON.stringify([item.id, item.text, item.href]);

export function safeCriticalHref(href: string): boolean {
  return href.startsWith("/") && !href.startsWith("//") && !/[\\\s\u0000-\u001f\u007f]/.test(href);
}

export function readCriticalDecisions(storage: Pick<Storage, "getItem"> | undefined, agentId: string): NoticeDecisions {
  try {
    const value: unknown = JSON.parse(storage?.getItem(storageKey(agentId)) ?? "null");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter(([, expiry]) =>
      typeof expiry === "number" && Number.isFinite(expiry) && (expiry === ACKNOWLEDGED || expiry >= 0),
    ));
  } catch (cause) { console.warn("Не удалось прочитать решения по критическим событиям", cause); return {}; }
}

export function criticalNoticeQueue(items: readonly McFirstLineItem[], decisions: NoticeDecisions, now: number): McFirstLineItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (item.severity !== "critical" || !safeCriticalHref(item.href)) return false;
    const key = criticalNoticeKey(item);
    if (seen.has(key)) return false;
    seen.add(key);
    const expiry = decisions[key];
    return expiry !== ACKNOWLEDGED && (expiry === undefined || expiry <= now);
  });
}

export function updateCriticalDecision(
  decisions: NoticeDecisions, item: McFirstLineItem, action: "acknowledge" | "snooze", now: number,
): NoticeDecisions {
  const key = criticalNoticeKey(item);
  // Bound browser metadata; moving this key to the end preserves the newest decisions.
  const entries = Object.entries(decisions).filter(([stored]) => stored !== key);
  return Object.fromEntries([...entries, [key, action === "acknowledge" ? ACKNOWLEDGED : now + HOUR_MS]].slice(-128));
}

function browserStorage(): Storage | undefined {
  try { return typeof window === "undefined" ? undefined : window.sessionStorage; } catch (cause) { console.warn("Хранилище критических событий недоступно", cause); return undefined; }
}

/** Do not appear over a dialog or while the person is entering data. Never move focus. */
function interactionInProgress(): boolean {
  if (typeof document === "undefined") return false;
  if ([...document.querySelectorAll<HTMLElement>('dialog[open], [role="dialog"], [aria-modal="true"]')]
    .some((element) => !element.hidden && element.getClientRects().length > 0)) return true;
  const focused = document.activeElement;
  return focused instanceof HTMLElement && (focused.matches("input, textarea, select") || focused.isContentEditable || !!focused.closest("form,fieldset,[data-editing='true']"));
}

export function CleanCriticalNotice({ agentId, items, compact = false }: { agentId: string; items: readonly McFirstLineItem[]; compact?: boolean }) {
  return <CriticalNoticeForAgent key={agentId} agentId={agentId} items={items} compact={compact} />;
}

function CriticalNoticeForAgent({ agentId, items, compact }: { agentId: string; items: readonly McFirstLineItem[]; compact: boolean }) {
  const [decisions, setDecisions] = useState(() => readCriticalDecisions(browserStorage(), agentId));
  const [now, setNow] = useState(() => Date.now());
  const [blocked, setBlocked] = useState(interactionInProgress);
  const [expanded, setExpanded] = useState(false);
  const queue = criticalNoticeQueue(items, decisions, now);
  const current = queue[0];
  const [announcement, setAnnouncement] = useState("");
  useEffect(() => { setAnnouncement(current?.text ?? ""); }, [current?.text]);
  const hasCandidate = !!current;
  useEffect(() => {
    // The timer also wakes snoozed events while there is no visible candidate.
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  useLayoutEffect(() => {
    if (!hasCandidate) return;
    const check = () => setBlocked(interactionInProgress());
    let frame: number | undefined;
    const scheduleCheck = () => {
      if (frame !== undefined) return;
      frame = window.requestAnimationFrame(() => {
        frame = undefined;
        check();
      });
    };
    // Recheck before painting a newly arriving/reawakened card, even if a dialog
    // opened while observation was inactive. Burst mutations cost one check/frame.
    check();
    const onFocusOut = () => queueMicrotask(check);
    const observer = new MutationObserver(scheduleCheck);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["open", "hidden", "aria-hidden", "aria-modal", "style", "class"] });
    document.addEventListener("focusin", check);
    document.addEventListener("focusout", onFocusOut);
    return () => {
      observer.disconnect();
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      document.removeEventListener("focusin", check);
      document.removeEventListener("focusout", onFocusOut);
    };
  }, [hasCandidate]);
  const liveRegion = <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">{blocked ? "" : announcement}</span>;
  if (!current) return liveRegion;
  const decide = (action: "acknowledge" | "snooze") => {
    const next = updateCriticalDecision(decisions, current, action, Date.now());
    setDecisions(next);
    setNow(Date.now());
    try { browserStorage()?.setItem(storageKey(agentId), JSON.stringify(next)); } catch (cause) { console.warn("Не удалось сохранить решение по критическому событию", cause); }
  };
  return (
    <>{liveRegion}<aside className="clean-critical-notice" aria-hidden={blocked || undefined} data-interaction-blocked={blocked || undefined} data-compact={compact || undefined} data-expanded={expanded || undefined} aria-label="Критическое событие">
      <div className="clean-critical-notice-heading">
        <BellRing size={22} aria-hidden="true" />
        <span>Нужно внимание</span>
        <span className="clean-critical-notice-count">В очереди: {queue.length}</span>
        <CButton variant="soft" size="icon-md" className="clean-critical-toggle" aria-label={expanded ? "Свернуть критическое событие" : "Подробнее о критическом событии"} aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}><ChevronDown size={20} aria-hidden="true" /></CButton>
      </div>
      <p className="clean-critical-notice-message">{current.text}</p>
      <div className="clean-critical-notice-actions">
        <CLink to={current.href}>Разобрать</CLink>
        <CButton variant="soft" onClick={() => decide("acknowledge")}>Понял</CButton>
        <CButton variant="soft" onClick={() => decide("snooze")}><Clock3 size={18} aria-hidden="true" />Напомнить через час</CButton>
      </div>
      <p className="clean-critical-notice-hint">«Понял» скрывает карточку только для вас. Само событие остаётся в пульте.</p>
    </aside></>
  );
}
