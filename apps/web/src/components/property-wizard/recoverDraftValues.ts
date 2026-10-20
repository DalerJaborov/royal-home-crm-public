import type { PropertyDraftView } from "@royal-home/shared";
import type { StoredDraft } from "../../hooks/useFormDraft";
import { isWizardEmpty, type WizardValues } from "./types";

/** Recovery is decided before arming either writer, so an older server reply
 * cannot overwrite the latest device backup on the next render. */
export function recoverDraftValues(draft: PropertyDraftView, local: StoredDraft<WizardValues> | null): PropertyDraftView {
  if (!local || isWizardEmpty(local.value)) return draft;
  if (local.context?.draftId && local.context.draftId !== draft.id) return draft;
  const dirtySameDraft = local.context?.dirty && (!local.context.draftId || local.context.draftId === draft.id);
  // updatedAt also moves when media finishes uploading. Only field revision
  // establishes whether a known dirty local snapshot has been acknowledged.
  if (!dirtySameDraft && local.at <= new Date(draft.updatedAt).getTime()) return draft;
  if (local.context && !local.context.dirty) return draft;
  return { ...draft, values: { ...local.value } };
}
