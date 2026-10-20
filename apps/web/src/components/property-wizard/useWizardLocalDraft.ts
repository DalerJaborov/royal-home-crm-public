import { useFormDraft } from "../../hooks/useFormDraft";
import { isWizardEmpty, type WizardValues } from "./types";

/**
 * Запасная копия мастера в localStorage.
 *
 * Пишется только после армирования (`armed`, то же условие, что у серверного
 * автосохранения): пока GET /properties/drafts/current в пути, значения формы
 * ещё стартовые (пустые или только с интейкером), и через 400 мс хук стёр бы
 * или затёр копию прошлого захода, ради которой она и существует, раньше, чем
 * onLoaded/onFailed успели её прочитать и предложить «продолжить». Без ключа
 * хук не пишет и не стирает ничего.
 */
export function useWizardLocalDraft(draftKey: string | null, armed: boolean, values: WizardValues): void {
  useFormDraft(armed ? draftKey : null, values, isWizardEmpty);
}
