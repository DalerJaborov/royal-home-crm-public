/**
 * ОЖИДАНИЕ ФОНОВОЙ ЗАПИСИ.
 *
 * Часть кода отвечает пользователю и только ПОТОМ дописывает журнал, ленту или
 * уведомление: `void logSystemError(...)`, `void sendPushToAgents(...)`. Это
 * сознательное решение — горячий путь не должен ждать запись, которая никому не
 * нужна в ответе. Но тест, проверяющий такую запись сразу после запроса, гоняется
 * с ней наперегонки: успеет транзакция до `expect` — зелено, не успеет — красно,
 * и оба исхода честные. Именно так «мигали» whisper-file-route и часть проверок
 * ленты 10.09.2026.
 *
 * Здесь короткий опрос вместо голой проверки: условие перечитывается, пока не
 * станет истинным или не выйдет срок. Успешный случай не замедляется — первая же
 * проверка происходит немедленно, до всякой паузы.
 *
 * Это НЕ повод заменять ожиданием отсутствующий `await` там, где ответ
 * пользователю от него не страдает (редкие ветки ошибок, кроны): там правильнее
 * дождаться записи в самом коде. Помощник — для горячих путей, где `void`
 * оправдан.
 */

export interface WaitForOptions {
  /** Предельное время ожидания, мс. По умолчанию 2000 — заведомо больше любой
   *  локальной записи в БД и заведомо меньше таймаута теста (20 с). */
  timeoutMs?: number;
  /** Пауза между попытками, мс. */
  intervalMs?: number;
  /** Что написать в тексте ошибки, если условие так и не выполнилось. */
  label?: string;
}

/**
 * Ждёт, пока `check()` не вернёт истинное значение, и возвращает это значение.
 * По истечении срока бросает ошибку с последним увиденным значением — чтобы в
 * отчёте было видно «ждали 1, дождались 0», а не просто «таймаут».
 */
export async function waitFor<T>(check: () => Promise<T> | T, options: WaitForOptions = {}): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 2000;
  const intervalMs = options.intervalMs ?? 25;
  const deadline = Date.now() + timeoutMs;

  let last: T = await check();
  if (last) return last;

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    last = await check();
    if (last) return last;
  }

  const label = options.label ?? "условие фоновой записи";
  throw new Error(`waitFor: ${label} не выполнилось за ${timeoutMs} мс (последнее значение: ${JSON.stringify(last)})`);
}

/**
 * Дождаться, пока значение перестанет меняться, и вернуть его.
 *
 * Нужно там, где тест снимает «сколько было ДО» перед своим действием: фоновые
 * записи ПРЕДЫДУЩИХ тестов того же файла могут приземлиться уже после того, как
 * снимок сделан, и разница «до/после» покажет чужую строку как свою. Ждём двух
 * одинаковых замеров подряд — значит хвост предыдущих записей осел.
 */
export async function waitForSettled<T>(read: () => Promise<T>, options: WaitForOptions = {}): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 2000;
  const intervalMs = options.intervalMs ?? 50;
  const deadline = Date.now() + timeoutMs;

  let previous = await read();
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    const current = await read();
    if (current === previous) return current;
    previous = current;
  }
  return previous;
}

/**
 * Частный случай, ради которого помощник и заводился: дождаться, пока счётчик
 * строк не достигнет ожидаемого. Возвращает фактическое число.
 */
export async function waitForCount(
  count: () => Promise<number>,
  atLeast: number,
  options: WaitForOptions = {}
): Promise<number> {
  let seen = 0;
  await waitFor(
    async () => {
      seen = await count();
      return seen >= atLeast;
    },
    { ...options, label: options.label ?? `строк ≥ ${atLeast}` }
  );
  return seen;
}
