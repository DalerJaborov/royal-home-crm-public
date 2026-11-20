import { useAuthStore } from "../../../store/auth";
import { useCleanShellSelection } from "../../../hooks/useCleanShell";
import { rememberedLookGrant, useRoyalLookChoice } from "../../../hooks/royalLookChoice";

/**
 * «НОВЫЙ ВИД» ДЛЯ МАСТЕРА «НОВЫЙ ОБЪЕКТ» БЕЗ МИГАНИЯ (пачка wizard, ревью #321).
 *
 * Мастер живёт снаружи AppLayout, и признак вида он получает сам. Переход из
 * приложения мигания не даёт: ответ /ui-shell уже лежит в кэше запросов (тот же
 * ключ, что у AppLayout), и первый же кадр мастера — новый. Мигал холодный заход
 * (обновление страницы, ссылка из уведомления): пока ответ в пути, мастер рисовался
 * старым и перекрашивался.
 *
 * Поэтому, ПОКА ответ в пути, берётся запомненный на этом устройстве последний ответ
 * сервера для этого сотрудника. Как только сервер ответил, решает только он: признак
 * запоминается или стирается (выключили, отказался, ответ без вида). Ошибка запроса —
 * не «в пути»: вид выключен (закрыто по умолчанию). Личный отказ `?look=legacy`
 * действует и на запомненный признак (useRoyalLookChoice).
 */
/** Чистое правило: пока ответа нет — запомненное, после ответа — только ответ сервера. */
export function wizardLookGrant(serverGranted: boolean, pending: boolean, rememberedGrant: boolean): boolean {
  return serverGranted || (pending && rememberedGrant);
}

export function useWizardRoyalLook(): boolean {
  const { clean, look, pending } = useCleanShellSelection();
  const agentId = useAuthStore((s) => s.agent?.id);
  const serverGranted = clean && look === "royal";
  // Память «вид выдан» — одна на устройство (hooks/royalLookChoice.ts, ревью #329):
  // её пишет выбор оболочки по каждому удачному ответу, мастер только читает.
  // Прежде мастер писал её сам по «вид у меня сейчас», и на телефоне агента, где
  // вид включается со следующего запуска, стирал выданный сервером вид.
  return useRoyalLookChoice(wizardLookGrant(serverGranted, pending, rememberedLookGrant(agentId)));
}
