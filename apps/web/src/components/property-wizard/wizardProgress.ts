import { validateAll, validateStep, WIZARD_STEPS, type WizardStepKey, type WizardValues } from "./types";

export type WizardStepState = "complete" | "invalid" | "empty";

/** Derive the rail from actual field validation and upload acknowledgements.
 * Errors on one section must not mark every unfinished section as invalid. */
export function wizardProgress(values: WizardValues, media: { ready: number; pending: number; failed: number }, errors: Record<string, string>, requireIntakeAgent: boolean): Record<WizardStepKey, WizardStepState> {
  const result = {} as Record<WizardStepKey, WizardStepState>;
  for (const { key } of WIZARD_STEPS) {
    if (key === "media") {
      result[key] = media.failed > 0 ? "invalid" : media.ready > 0 && media.pending === 0 ? "complete" : "empty";
      continue;
    }
    const invalid = key === "review" ? validateAll(values, { requireIntakeAgent }) : validateStep(key, values, { requireIntakeAgent });
    result[key] = Object.keys(invalid).some((field) => !!errors[field]) ? "invalid"
      : Object.keys(invalid).length === 0 && (key !== "review" || media.pending + media.failed === 0) ? "complete" : "empty";
  }
  return result;
}
