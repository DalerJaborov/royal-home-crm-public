import { useEffect } from "react";
import type { SetURLSearchParams } from "react-router-dom";

/**
 * Фильтры списка живут в адресе страницы.
 *
 * ЗАЧЕМ. Отфильтрованный список — это результат работы: «три двушки в Сино до
 * 900 тысяч». Пока фильтры жили только в памяти компонента, этот результат
 * нельзя было ни переслать коллеге, ни положить в закладки, ни — главное —
 * вернуть кнопкой «назад» из карточки: возврат отдавал чистый список с начала,
 * и агент, дошедший до двадцатой строки, перебирал фильтры заново после каждого
 * открытого объекта.
 *
 * Здесь только запись. Чтение остаётся у страницы: у каждого списка свой разбор
 * (районы приходят и одиночным ключом ради старых ссылок, площадь — числами,
 * порядок — значением из словаря), и прятать его за общей схемой значило бы
 * усложнить ровно то место, где ошибки заметнее всего.
 *
 * `replace`, а не push: иначе каждый щелчок по фильтру оставлял бы запись в
 * истории, и «назад» пришлось бы жать десять раз, чтобы уйти со страницы.
 */
export function useSyncFiltersToUrl(
  searchParams: URLSearchParams,
  setSearchParams: SetURLSearchParams,
  /** Ключ адреса → значение; `undefined` и пустая строка убирают ключ из адреса. */
  values: Record<string, string | undefined>,
  /** Ключи, которые надо вычистить из адреса (устаревшие синонимы). */
  drop: string[] = []
) {
  // Сериализуем в строку: объект пересоздаётся на каждый рендер, и сравнение по
  // ссылке гоняло бы эффект вхолостую при каждом нажатии клавиши.
  // Object serialization drops undefined keys, leaving cleared filters in the URL.
  // Entry arrays retain them as null so the effect can delete each owned key.
  const encoded = JSON.stringify(Object.entries(values));

  useEffect(() => {
    const next = new URLSearchParams(searchParams);
    for (const [key, value] of JSON.parse(encoded) as [string, string | null][]) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    for (const key of drop) next.delete(key);
    // Запись только при реальном отличии — иначе эффект будит сам себя по кругу.
    if (next.toString() !== searchParams.toString()) setSearchParams(next, { replace: true });
    // drop — константный список ключей у каждой страницы; в зависимости не берём,
    // иначе новый массив на каждый рендер снова гонял бы эффект вхолостую.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [encoded, searchParams, setSearchParams]);
}
