import { AsyncLocalStorage } from "node:async_hooks";

/**
 * КТО СЕЙЧАС ДЕЙСТВУЕТ — id сотрудника текущего HTTP-запроса, доступный из любой
 * глубины кода без протаскивания через параметры (26.08.2026, ревью, пункт 4).
 *
 * Появился ради журнала переходов (lib/stageEvents.ts + перехват в db.ts):
 * статус меняют десятки мест, и передавать agentId в каждое — значит переписать
 * половину сигнатур. AsyncLocalStorage переживает await: контекст, запущенный в
 * requireAuth, виден во всех обработчиках этого же запроса.
 *
 * Вне HTTP-запроса (cron, вебхук без входа, бот) контекста нет — getState()
 * отдаёт undefined, и журнал честно пишет agentId=null: «перевела сама CRM».
 */
const actorStorage = new AsyncLocalStorage<{ agentId: string }>();

/** Выполнить продолжение запроса от имени сотрудника (зовётся из requireAuth). */
export function runAsActor<T>(agentId: string, fn: () => T): T {
  return actorStorage.run({ agentId }, fn);
}

/** Выполнить от имени самой CRM — даже внутри чужого запроса (автоодобрение при
 *  загрузке видео агентом, 25.09.2026: журнал переходов не должен записать
 *  перевод в монтаж на агента, который просто загрузил ролик). */
export function runAsSystem<T>(fn: () => T): T {
  return actorStorage.exit(fn);
}

/** id сотрудника текущего запроса; null — действие системы (cron, вебхук, бот). */
export function currentActorId(): string | null {
  return actorStorage.getStore()?.agentId ?? null;
}
