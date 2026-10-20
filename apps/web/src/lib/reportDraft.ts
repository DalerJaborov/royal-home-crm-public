type ReportNotes = Record<string, string | null>;

export interface ReportDraft<T extends ReportNotes> {
  id: string;
  value: T;
  baseline: T;
  editing: boolean;
}

export function reportNotesEqual<T extends ReportNotes>(left: T, right: T): boolean {
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) => left[key] === right[key]);
}

export function createReportDraft<T extends ReportNotes>(id: string, value: T): ReportDraft<T> {
  return { id, value, baseline: value, editing: false };
}

/** Background refreshes may update a pristine editor, never replace a dirty draft. */
export function reconcileReportDraft<T extends ReportNotes>(draft: ReportDraft<T>, id: string, remote: T): ReportDraft<T> {
  if (draft.id !== id) return createReportDraft(id, remote);
  if (draft.editing && !reportNotesEqual(draft.value, draft.baseline)) return draft;
  if (reportNotesEqual(draft.value, remote) && reportNotesEqual(draft.baseline, remote)) return draft;
  return { ...draft, value: remote, baseline: remote };
}

export function reportDraftConflict<T extends ReportNotes>(draft: ReportDraft<T>, remote: T): boolean {
  return draft.editing && !reportNotesEqual(draft.baseline, remote) && !reportNotesEqual(draft.value, remote);
}
