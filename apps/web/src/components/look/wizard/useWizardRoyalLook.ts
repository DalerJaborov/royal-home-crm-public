import { useEffect, useSyncExternalStore } from "react";
import { useAuthStore } from "../../../store/auth";
import { useCleanShellSelection } from "../../../hooks/useCleanShell";
import { useRoyalLookChoice } from "../../../hooks/useRoyalLook";

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
const KEY = "rh-look-granted";

function remembered(agentId: string | undefined): boolean {
  if (!agentId) return false;
  try { return window.localStorage.getItem(`${KEY}:${agentId}`) === "1"; } catch { return false; }
}

function subscribe(notify: () => void) {
  window.addEventListener("storage", notify);
  return () => window.removeEventListener("storage", notify);
}

/** Чистое правило: пока ответа нет — запомненное, после ответа — только ответ сервера. */
export function wizardLookGrant(serverGranted: boolean, pending: boolean, rememberedGrant: boolean): boolean {
  return serverGranted || (pending && rememberedGrant);
}

export function useWizardRoyalLook(): boolean {
  const { clean, look, pending } = useCleanShellSelection();
  const agentId = useAuthStore((s) => s.agent?.id);
  const serverGranted = clean && look === "royal";
  const saved = useSyncExternalStore(subscribe, () => remembered(agentId), () => false);
  useEffect(() => {
    if (pending || !agentId) return;
    try {
      if (serverGranted) window.localStorage.setItem(`${KEY}:${agentId}`, "1");
      else window.localStorage.removeItem(`${KEY}:${agentId}`);
    } catch { /* Без хранилища просто нет запоминания: холодный заход нарисуется после ответа. */ }
  }, [pending, serverGranted, agentId]);
  return useRoyalLookChoice(wizardLookGrant(serverGranted, pending, saved));
}
