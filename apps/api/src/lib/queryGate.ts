/**
 * ОГРАНИЧИТЕЛЬ ОДНОВРЕМЕННЫХ ЗАПРОСОВ (дашборд директора, ревью #362): сводка — это десятки
 * группировок и подсчётов, и все разом они занимают пул соединений, пока остальная CRM ждёт.
 * Ограничитель пускает не больше `limit` запросов одновременно, остальные ждут очереди.
 * Оборачивать надо только «листья» (сам запрос к базе), а не функции, которые ждут другие
 * запросы: иначе вложенное ожидание может заблокироваться.
 */
export function createLimiter(limit: number): <T>(task: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async <T>(task: () => Promise<T>): Promise<T> => {
    while (active >= limit) await new Promise<void>((resolve) => waiting.push(resolve));
    active += 1;
    try {
      return await task();
    } finally {
      active -= 1;
      waiting.shift()?.();
    }
  };
}
