import { useSyncExternalStore } from "react";
import { FilePenLine } from "lucide-react";
import { Link } from "react-router-dom";
import { getDraftReminder, subscribeDraftReminder } from "../lib/draftReminder";

/** Saved work belongs beside the catalogue's create action. The global indicator
 * is reserved for uploads and failures, so a saved draft never covers a page. */
export function PropertyDraftShortcut() {
  const hasDraft = useSyncExternalStore(subscribeDraftReminder, getDraftReminder, () => false);
  if (!hasDraft) return null;
  return (
    <Link to="/properties/new?draft=continue" className="inline-flex min-h-11 items-center gap-2 rounded-xl px-3 text-[14px] font-medium text-blue hover:bg-blue/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue" data-testid="property-draft-shortcut">
      <FilePenLine size={18} aria-hidden />
      Продолжить черновик
    </Link>
  );
}
