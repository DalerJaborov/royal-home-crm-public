/** Что показывает палитра поиска. Тип результата у вызывающего свой (Property/Client/Deal). */
export interface PaletteSearchSink<R> {
  /** Строка запроса пуста: списки обнуляются. */
  clear: () => void;
  setLoading: (loading: boolean) => void;
  setResults: (results: R) => void;
}

/**
 * Дебаунс-поиск палитры команд. Возвращает отмену для cleanup эффекта.
 *
 * Отмена обязана гасить не только таймер, но и УЖЕ улетевший запрос: раньше
 * флаг cancelled проверялся после ответа, но cleanup его никогда не взводил, и
 * медленный ответ на «аб» подменял результаты «абдулло», а после очистки строки
 * снова заполнял списки (FORMS08, аудит 04.10.2026). Пустой запрос ещё и
 * снимает индикатор загрузки, иначе спиннер зависал после очистки поля.
 */
export function startPaletteSearch<R>(
  query: string,
  fetchAll: (query: string) => Promise<R>,
  sink: PaletteSearchSink<R>,
  delayMs = 250
): () => void {
  if (!query.trim()) {
    sink.clear();
    sink.setLoading(false);
    return () => undefined;
  }
  let cancelled = false;
  const timer = setTimeout(async () => {
    sink.setLoading(true);
    try {
      const results = await fetchAll(query);
      if (cancelled) return;
      sink.setResults(results);
    } catch {
      // тихо игнорируем — поиск не критичен
    } finally {
      if (!cancelled) sink.setLoading(false);
    }
  }, delayMs);
  return () => {
    cancelled = true;
    clearTimeout(timer);
  };
}
