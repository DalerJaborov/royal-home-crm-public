import type { VacancyFilters } from "../types/vacancies";

/** Keep page identity in the query key and send filters to the server. */
export function vacancyFiltersQuery(filters: VacancyFilters): string {
  const params = new URLSearchParams();
  if (filters.limit) params.set("limit", String(filters.limit));
  if (filters.offset) params.set("offset", String(filters.offset));
  if (filters.status) params.set("status", filters.status);
  if (filters.bucket) params.set("bucket", filters.bucket);
  if (filters.includeNoPhone) params.set("includeNoPhone", "true");
  if (filters.includeFiltered) params.set("includeFiltered", "true");
  if (filters.activeOnly) params.set("activeOnly", "true");
  if (filters.positionKey) params.set("positionKey", filters.positionKey);
  if (filters.q?.trim()) params.set("q", filters.q.trim());
  if (filters.priority) params.set("priority", filters.priority);
  return params.toString();
}
