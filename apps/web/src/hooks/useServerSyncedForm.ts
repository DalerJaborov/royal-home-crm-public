import { useEffect, useRef } from "react";
import { serverRefillPatch, type FormFields } from "../lib/serverFormSync";

/**
 * Форма, которая заливается с сервера, но НЕ стирает набранное (глубокая
 * проверка 02.10.2026, F3; правило — lib/serverFormSync.ts).
 *
 * Вместо `useEffect(() => { setX(settings.x) … }, [settings])`, который на
 * каждый новый объект настроек (соседний тумблер, соседнее «Сохранить», опрос
 * раз в минуту) перезаписывал ВСЕ поля, — перезаливаются только поля, которые
 * сервер реально поменял и которые человек не трогал.
 *
 * `server` — значения формы, посчитанные из ответа сервера (undefined, пока
 * ответа нет); `local` — текущие значения формы; `apply` — положить в форму
 * поля из `patch`.
 */
export function useServerSyncedForm<T extends FormFields>(
  server: T | undefined,
  local: T,
  apply: (patch: Partial<T>) => void
): void {
  const lastServer = useRef<T | undefined>(undefined);
  const latest = useRef({ server, local, apply });
  latest.current = { server, local, apply };
  // Эффект срабатывает по СОДЕРЖИМОМУ серверных значений, а не по ссылке на
  // объект: новый объект с теми же числами — не повод трогать форму.
  const serverKey = server === undefined ? undefined : JSON.stringify(server);
  useEffect(() => {
    const { server: next, local: now, apply: put } = latest.current;
    if (next === undefined) return;
    const patch = serverRefillPatch(next, lastServer.current, now);
    lastServer.current = next;
    if (Object.keys(patch).length > 0) put(patch);
  }, [serverKey]);
}

type FieldPairs<T extends FormFields> = { [K in keyof T]: readonly [T[K], (value: T[K]) => void] };

/**
 * То же для формы из отдельных `useState`: `{ имя: [значение, сеттер] }`.
 *
 *   useServerSyncedFields(settings && { name: settings.companyName }, { name: [name, setName] });
 */
export function useServerSyncedFields<T extends FormFields>(server: T | undefined, fields: FieldPairs<T>): void {
  const local = {} as T;
  for (const key of Object.keys(fields) as (keyof T)[]) local[key] = fields[key][0];
  useServerSyncedForm(server, local, (patch) => {
    for (const key of Object.keys(patch) as (keyof T)[]) fields[key][1](patch[key] as T[keyof T]);
  });
}
