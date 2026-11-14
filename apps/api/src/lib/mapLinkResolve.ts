/**
 * КОРОТКАЯ ССЫЛКА КАРТЫ → ТОЧКА (10.11.2026, мастер объекта в Telegram).
 *
 * «maps.app.goo.gl/…» и «yandex.ru/maps/-/…» координат не содержат — они
 * перенаправляют на полную ссылку. Идём по перенаправлениям сами (не дальше трёх
 * шагов), и только на хосты Google/Yandex (`isMapHost`): ссылку присылает
 * человек, и без этого ограничения сервер можно было бы заставить сходить куда
 * угодно, в том числе во внутреннюю сеть. Тело ответа не читаем.
 */
import { isMapHost, isShortMapLink, mapPointFromUrl, parseMapPoint, shortMapLinkIn, type MapPoint } from "@royal-home/shared";
import { logSystemError } from "./systemError.js";

const MAX_HOPS = 3;
const HOP_TIMEOUT_MS = 5_000;

export async function resolveShortMapLink(link: string, fetcher: typeof fetch = fetch): Promise<MapPoint | null> {
  if (!isShortMapLink(link)) return null;
  let current = link;
  try {
    for (let hop = 0; hop < MAX_HOPS; hop += 1) {
      const response = await fetcher(current, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(HOP_TIMEOUT_MS) });
      await response.body?.cancel().catch(() => undefined);
      const location = response.headers.get("location");
      if (response.status < 300 || response.status >= 400 || !location) return null;
      const next = new URL(location, current).toString();
      if (!isMapHost(next)) return null;
      const found = mapPointFromUrl(next);
      if (found) return found;
      current = next;
    }
  } catch (error) {
    void logSystemError("telegram", `Короткая ссылка карты не раскрылась: ${error instanceof Error ? error.message : String(error)}`);
  }
  return null;
}

/** Точка из текста сообщения: координаты, полная ссылка карты или короткая ссылка. */
export async function mapPointFromText(text: string, fetcher: typeof fetch = fetch): Promise<MapPoint | null> {
  const direct = parseMapPoint(text);
  if (direct) return direct;
  const short = shortMapLinkIn(text);
  return short ? resolveShortMapLink(short, fetcher) : null;
}
