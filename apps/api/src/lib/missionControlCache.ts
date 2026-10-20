import { publishPultSnapshot } from "./livePublish.js";
/**
 * Кэш секций пульта в памяти процесса (аудит 02.09.2026 §2 п.2).
 *
 * Секции пульта тянут тысячи строк каждые 15 с на КАЖДОГО открытого директора:
 * портфель объектов, воронка маркетинга, переписки. Кэш общий для всех вкладок и
 * пользователей с одинаковым правом на деньги (ключ включает seesMoney): живые
 * секции живут 15 с (совпадает с опросом фронта), зоны — 60 с.
 *
 * { error: true } не кэшируется — отказ секции должен уйти на следующий же запрос,
 * а не висеть минуту. Переключение модуля пульта сбрасывает всё
 * (routes/pultModules.ts): тумблер обязан отражаться на экране сразу.
 */
const store = new Map<string, { at: number; value: unknown }>();
/**
 * Расчёт, который уже идёт, — один на ключ (аудит 23.09.2026, №92). Раньше в
 * момент истечения секции КАЖДЫЙ открытый пульт видел промах и запускал свой
 * расчёт тех же тысяч строк: десять директоров — десять одинаковых тяжёлых
 * выборок разом. Хуже всего сразу после сброса: он же рассылает «пульт
 * устарел», и все вкладки приходят одновременно. Теперь опоздавшие ждут тот
 * же расчёт.
 */
const inflight = new Map<string, Promise<unknown>>();
/** Номер поколения: сброс кэша поднимает его, и расчёт, начатый ДО сброса, не
 *  кладёт в кэш данные, которые сброс как раз объявил устаревшими. */
let generation = 0;

function isSectionError(value: unknown): boolean {
  return !!value && typeof value === "object" && (value as { error?: unknown }).error === true;
}

export async function cachedSection<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const hit = store.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value as T;
  const running = inflight.get(key);
  if (running) return running as Promise<T>;
  const gen = generation;
  // Цепочка из then, а не async-функция: колбэк finally выполняется всегда
  // позже присваивания `job`, даже если fn бросит синхронно.
  const job: Promise<T> = Promise.resolve()
    .then(fn)
    .then((value) => {
      if (!isSectionError(value) && gen === generation) store.set(key, { at: Date.now(), value });
      return value;
    })
    .finally(() => {
      if (inflight.get(key) === job) inflight.delete(key);
    });
  inflight.set(key, job);
  return job;
}

export function invalidateMissionControlCache(): void {
  store.clear();
  inflight.clear();
  generation++;
  // Единственная точка, где снимок пульта объявляется устаревшим, — значит и
  // единственная честная точка события «пересчитан». Широковещательное: пульт
  // открыт у всех, а сами секции каждый получает своим запросом со своими
  // правами (см. lib/livePublish.ts).
  publishPultSnapshot();
}
