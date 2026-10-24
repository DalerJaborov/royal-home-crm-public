/**
 * Идентификатор из пути маршрута, пригодный для запроса. React Router отдаёт
 * `useParams().id` строкой, и ссылка вида `/team/${x}` с неопределённым `x`
 * превращается в литерал «undefined» — `!!id` его пропускает, и хук шлёт
 * `GET /agents/undefined/overview`. Пустое значение и литералы «undefined» /
 * «null» считаем отсутствием идентификатора.
 */
export function usableRouteId(id: string | null | undefined): string | undefined {
  if (typeof id !== "string") return undefined;
  const trimmed = id.trim();
  if (trimmed === "" || trimmed === "undefined" || trimmed === "null") return undefined;
  return trimmed;
}
