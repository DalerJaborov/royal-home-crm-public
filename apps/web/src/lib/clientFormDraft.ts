type ClientKind = "BUYER" | "SELLER";

/** Keep the entry route in the key and the selected kind in the snapshot. */
export interface ClientFormDraft<Form> {
  version: 1;
  form: Form;
  step: number;
  newKind: ClientKind;
}

// Historical snapshots lack newKind: retain the entry kind for those drafts.
export function clientDraftKind(draft: { newKind?: unknown }, initialKind: ClientKind): ClientKind {
  return draft.newKind === "BUYER" || draft.newKind === "SELLER" ? draft.newKind : initialKind;
}

export function isClientDraftUnchanged<Form extends object>(
  draft: { form: Form; newKind?: unknown }, initialForm: Form, initialKind: ClientKind, isEdit: boolean,
): boolean {
  return (isEdit || clientDraftKind(draft, initialKind) === initialKind)
    && (Object.keys(initialForm) as (keyof Form)[]).every((key) => draft.form[key] === initialForm[key]);
}
