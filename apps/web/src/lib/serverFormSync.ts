/**
 * КАКИЕ ПОЛЯ ФОРМЫ ПЕРЕЗАЛИТЬ С СЕРВЕРА (глубокая проверка 02.10.2026, F3).
 *
 * Формы настроек держат поля в своём состоянии, а сервер присылает новые
 * значения по любому поводу: соседний тумблер кладёт в кэш новый объект
 * настроек, соседнее «Сохранить» — тоже, опрос раз в 60 секунд — тоже. Раньше
 * форма перезаливала ВСЕ поля на каждый такой приход, и набранное, но не
 * сохранённое молча пропадало.
 *
 * Правило: поле обновляется с сервера, только если
 *   • это первая загрузка (`lastServer` ещё нет), или
 *   • сервер поменял ИМЕННО это поле, а человек его не трогал (в форме
 *     по-прежнему прежнее серверное значение).
 * Поле, которое человек уже правит, не трогается никогда — даже если его же
 * поменял кто-то другой: сохранит — запишет своё, как и раньше.
 *
 * Значения сравниваются по содержимому (списки, записи), а не по ссылке:
 * каждый ответ сервера — новые объекты.
 */
export type FormFields = Record<string, unknown>;

type SourceTransition = { kind: "optimistic" } | { kind: "rollback"; from: object };
// Cache identities only: no markers can leak into settings JSON or persistence.
const sourceTransitions = new WeakMap<object, SourceTransition>();

export function markOptimisticFormSource(source: object, previous: object): object | undefined {
  if (source === previous) return undefined;
  sourceTransitions.set(source, { kind: "optimistic" });
  return source;
}

export function markRolledBackFormSource(source: object, optimistic: object): void {
  if (source === optimistic) sourceTransitions.delete(source);
  else sourceTransitions.set(source, { kind: "rollback", from: optimistic });
}

export function markConfirmedFormSource(source: object): void {
  sourceTransitions.delete(source);
}

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  // Число и та же строка — одно значение: поле формы держит "15", а
  // мгновенный отклик правки кладёт в кэш 15 до ответа сервера.
  const primitive = (v: unknown) => v === null || (typeof v !== "object" && typeof v !== "function");
  if (primitive(a) && primitive(b)) return String(a) === String(b);
  return JSON.stringify(a) === JSON.stringify(b);
}

export function serverRefillPatch<T extends FormFields>(server: T, lastServer: T | undefined, local: T): Partial<T> {
  const patch: Partial<T> = {};
  for (const key of Object.keys(server) as (keyof T)[]) {
    const next = server[key];
    if (lastServer === undefined) {
      patch[key] = next;
      continue;
    }
    const prev = lastServer[key];
    if (same(next, prev)) continue; // сервер это поле не менял
    if (!same(local[key], prev)) continue; // человек его уже правит
    patch[key] = next;
  }
  return patch;
}

/** Per mounted form: remember which inputs were drafts before an optimistic write. */
export class ServerFormSyncState<T extends FormFields> {
  private lastServer: T | undefined;
  private readonly draftsBeforeOptimism = new WeakMap<object, Set<keyof T>>();

  refill(server: T, local: T, source?: object): Partial<T> {
    const transition = source && sourceTransitions.get(source);
    const previous = this.lastServer;
    if (source && transition?.kind === "optimistic" && previous) {
      this.draftsBeforeOptimism.set(source, new Set(
        (Object.keys(server) as (keyof T)[]).filter(key => !same(local[key], previous[key]))
      ));
    }
    const patch = serverRefillPatch(server, this.lastServer, local);
    if (transition?.kind === "rollback") {
      for (const key of this.draftsBeforeOptimism.get(transition.from) ?? []) delete patch[key];
    }
    this.lastServer = server;
    return patch;
  }
}
