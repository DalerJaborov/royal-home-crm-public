import { useFormDraft } from "../../hooks/useFormDraft";
import { PROPERTY_DRAFT_TTL_DAYS, type PropertyDraftView } from "@royal-home/shared";
import { EMPTY_WIZARD_VALUES, isWizardEmpty, type WizardValues } from "./types";

/**
 * Запасная копия мастера в localStorage.
 *
 * Пишется после проверки сервера и принятия черновика. До этого стартовые поля
 * не должны затереть копию прошлого захода. Локальная копия хранится столько же,
 * сколько серверная; однодневный срок остальных форм здесь не подходит.
 */
export const WIZARD_LOCAL_DRAFT_TTL_MS = PROPERTY_DRAFT_TTL_DAYS * 86400000;
export function useWizardLocalDraft(draftKey: string | null, armed: boolean, values: WizardValues, server?: PropertyDraftView | null): boolean | null {
  // The wizard is small enough for an immediate snapshot. Closing during the
  // former debounce must not lose the only copy of an offline edit.
  const serverValues = { ...EMPTY_WIZARD_VALUES, ...server?.values };
  const dirty = !server || Object.keys(values).some((key) =>
    JSON.stringify(values[key as keyof WizardValues]) !== JSON.stringify(serverValues[key as keyof WizardValues]));
  return useFormDraft(armed ? draftKey : null, values, isWizardEmpty, 0, {
    draftId: server?.id ?? null, baseRevision: server?.revision ?? null, dirty,
  });
}
