import { fetchSomon } from "./sourceClient.js";

/** Reads a number using the same endpoint as the Somon card button. */
export async function fetchSomonPhone(id: string, request: (path: string) => Promise<Response> = fetchSomon): Promise<string | null> {
  if (!/^\d{1,20}$/.test(id)) throw new Error("Invalid Somon advert ID");
  const response = await request(`/api/items/get_phone/${id}/`);
  if (!response.ok) throw new Error(`Somon phone request failed (${response.status})`);
  const data: unknown = await response.json();
  if (typeof data !== "object" || data === null || !("phone" in data)) throw new Error("Invalid Somon phone response");
  const phone = (data as { phone: unknown }).phone;
  if (phone == null || phone === "") return null;
  if (typeof phone !== "string" || !/^\+?[\d\s()\-]{7,24}$/.test(phone)) throw new Error("Invalid Somon phone value");
  return phone;
}

/**
 * Номер по клику агента (кнопка в карточке рынка). Идёт через ту же дверь и тот же бюджет,
 * но в режиме `interactive`: работает и при выключенных лидах, соблюдает остановку источника
 * (403) и общий интервал, а скану и обработке лидов уступает — тогда `SomonSourceUnavailable("not_ready")`,
 * который маршрут превращает в «повторите через минуту» (429).
 * `fetcher` — подмена `fetch` для тестов.
 */
export function fetchSomonPhoneInteractive(id: string, fetcher: typeof fetch = fetch): Promise<string | null> {
  return fetchSomonPhone(id, (path) => fetchSomon(path, new Date(), fetcher, { interactive: true }));
}
