import { useEffect, useState, useSyncExternalStore } from "react";
import { FilePenLine } from "lucide-react";
import { Link } from "react-router-dom";
import { getDraftReminder, subscribeDraftReminder } from "../lib/draftReminder";
import { getPropertyDraftSession } from "../lib/propertyDraftSession";
import { formatDraftShortcutHint } from "../hooks/usePropertyDraft";

/** Saved work belongs beside the catalogue's create action. The global indicator
 * is reserved for uploads and failures, so a saved draft never covers a page.
 * Черновик живёт 4 часа с последнего сохранения — подпись показывает, когда он
 * сохранён и сколько осталось (22.11.2026). */
export function PropertyDraftShortcut() {
  const hasDraft = useSyncExternalStore(subscribeDraftReminder, getDraftReminder, () => false);
  const [, tick] = useState(0);
  useEffect(() => {
    if (!hasDraft) return;
    const id = window.setInterval(() => tick((n) => n + 1), 30_000);
    return () => window.clearInterval(id);
  }, [hasDraft]);
  if (!hasDraft) return null;
  const draft = getPropertyDraftSession()?.draft ?? null;
  const hint = draft ? formatDraftShortcutHint(draft) : "";
  return (
    <Link to="/properties/new?draft=continue" className="inline-flex min-h-11 items-center gap-2 rounded-xl px-3 text-[14px] font-medium text-blue hover:bg-blue/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue" data-testid="property-draft-shortcut">
      <FilePenLine size={18} aria-hidden />
      <span className="flex flex-col leading-tight">
        <span>Продолжить черновик</span>
        {hint && <span className="text-[13px] font-normal text-gray-500" data-testid="property-draft-shortcut-hint">{hint}</span>}
      </span>
    </Link>
  );
}
