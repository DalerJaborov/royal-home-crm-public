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
