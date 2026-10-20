import { useAuthStore } from "../store/auth";

/**
 * Эпоха сессии на момент вызова (см. sessionEpoch в store/auth). Запрос, который
 * потом пишет в общий кэш или стор, запоминает её до отправки.
 */
export function currentSessionEpoch(): number {
  return useAuthStore.getState().sessionEpoch;
}

/**
 * Откат оптимистичного апдейта действует только в той сессии, где апдейт сделан
 * (аудит 04.10.2026, WEB-01). Выход/вход чистит кэш, но уже летящая мутация не
 * отменяется: её onError приходит позже и без этой сверки возвращал бы в
 * очищенный кэш (и в снимок на диске) карточку прежнего сотрудника.
 * `epoch` undefined: onMutate не успел отработать, откатывать нечего.
 */
export function rollbackInSameSession(epoch: number | undefined, rollback: () => void): void {
  if (epoch === undefined || epoch !== currentSessionEpoch()) return;
  rollback();
}
