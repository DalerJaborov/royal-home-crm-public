/**
 * ПОИСК ОБЪЕКТА ПО НОМЕРУ в окне «Привязать объекты» (03.10.2026).
 *
 * Поле подписано «Номер объекта или адрес», но сервер (`GET /properties?q=`) ищет
 * только по названию, адресу и описанию. Запрос «103» находил объект, у которого
 * «103» написано в описании (№90), а сам объект №103 не находил; «140» и «142»
 * отвечали «ничего не нашлось», хотя объекты есть (прод, 03.10).
 *
 * Серверный поиск не трогаем (его читают каталог, бот и подбор): если строка —
 * номер, окно дополнительно открывает карточку `GET /properties/:shortId` (маршрут
 * принимает короткий номер) и ставит найденный объект ПЕРВЫМ, а текстовые
 * совпадения идут следом.
 */

export interface ParsedPropertySearch {
  /** Короткий номер объекта, если строка — только номер; иначе null. */
  shortId: number | null;
  /** Строка для текстового поиска по адресу/названию (для номера — он же цифрами). */
  text: string;
}

/** До 9 цифр: номер — Int в базе, а «123456789012» номером быть не может. */
const NUMBER_RE = /^(?:№|#|n|об|ob)?[\s-]*(\d{1,9})$/i;

/**
 * «103», «№103», «№ 103», «ОБ-000103», «ob 103» → номер 103.
 * «Фирдавси», «103 Фирдавси», «Рудаки 45» → адресный поиск, номера нет.
 */
export function parsePropertySearch(raw: string): ParsedPropertySearch {
  const trimmed = raw.trim();
  const match = NUMBER_RE.exec(trimmed);
  if (!match) return { shortId: null, text: trimmed };
  const shortId = Number(match[1]);
  // Номера начинаются с единицы: «0» — это не объект, а просто цифра в адресе.
  if (!Number.isSafeInteger(shortId) || shortId < 1) return { shortId: null, text: trimmed };
  return { shortId, text: String(shortId) };
}

/** То, что окно показывает в строке результата. */
export interface PropertySearchHit {
  id: string;
  shortId: number;
  title: string;
  address: string;
  status: string;
  coverUrl: string | null;
}

/** Нужные окну поля карточки `GET /properties/:id`. */
export interface PropertyCardLike {
  id: string;
  shortId: number;
  title: string;
  address: string;
  status: string;
  deletedAt?: string | null;
  photos?: { thumbUrl?: string | null }[] | null;
}

/** Карточка → строка результата; объект в корзине — null (его привязать нельзя). */
export function cardToSearchHit(card: PropertyCardLike): PropertySearchHit | null {
  if (card.deletedAt) return null;
  return {
    id: card.id,
    shortId: card.shortId,
    title: card.title,
    address: card.address,
    status: card.status,
    coverUrl: card.photos?.[0]?.thumbUrl ?? null,
  };
}

/**
 * Точное совпадение по номеру — первым, затем текстовые, без повторов и без уже
 * выбранных. `limit` режет итог: окно показывает короткий список.
 */
export function mergeSearchResults<E extends { id: string }, T extends { id: string }>(
  exact: E | null | undefined,
  found: readonly T[] | null | undefined,
  excludeIds: ReadonlySet<string>,
  limit: number
): (E | T)[] {
  const seen = new Set(excludeIds);
  const out: (E | T)[] = [];
  for (const item of [...(exact ? [exact] : []), ...(found ?? [])]) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out.slice(0, limit);
}
