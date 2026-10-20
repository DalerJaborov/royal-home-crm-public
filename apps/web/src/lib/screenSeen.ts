import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import { api } from "./api";
import { useAuthStore } from "../store/auth";

/**
 * КАРТА ОБСЛЕДОВАННОГО, половина про экраны (08.09.2026).
 *
 * Владелец: «есть места, куда мы ещё не доходили в коде и на экране». Маршруты
 * сервера считают себя сами (apps/api/src/lib/routeHits.ts), но экраны так не
 * посчитать: половина из них либо ничего не запрашивает, либо берёт ровно те же
 * данные, что и соседний, — по трафику их не различить. Поэтому о смене экрана
 * фронт сообщает сам.
 *
 * Через неделю обычной работы список экранов минус то, что сюда попало, и есть
 * ответ на вопрос владельца: вот эти разделы не открывал никто и никогда, там и
 * живут баги, на которые ещё некому было пожаловаться.
 */

/** Публичные экраны: на них нет сессии, а ручка отметки требует входа. */
const PUBLIC_PREFIXES = ["/login", "/l/", "/o/"];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Путь → ШАБЛОН маршрута: "/clients/8f3a…-…" превращается в "/clients/:id".
 *
 * Считать надо именно шаблоны: иначе карта вместо полутора десятков разделов
 * покажет тысячи строк и будет считать клиентов, а не экраны.
 *
 * Почему не спрашиваем сам роутер: в этом проекте маршруты объявлены
 * декларативно (<Routes> в App.tsx), а не через data-router, поэтому штатного
 * способа получить шаблон текущего совпадения нет — `useMatches` работает
 * только со вторым. Нормализация по виду сегмента не зависит от внутренностей
 * роутера и переживёт его обновление.
 */
export function normalizeScreenPath(pathname: string): string {
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length === 0) return "/";
  const normalized = segments.map((seg) => {
    if (UUID_RE.test(seg)) return ":id";
    if (/^\d+$/.test(seg)) return ":id";
    // Токены публичных ссылок и прочие длинные непроизносимые хвосты.
    if (seg.length > 24) return ":id";
    return seg;
  });
  return `/${normalized.join("/")}`;
}

/**
 * Один экран — одна отметка за жизнь вкладки.
 *
 * Без этого переход «список → карточка → назад» слал бы отметку на каждый шаг,
 * и на активном дне это тысячи лишних запросов. Для карты важен ФАКТ посещения,
 * а не частота: вопрос стоит «сюда вообще заходили?», а не «как часто».
 */
const reported = new Set<string>();

/**
 * Чистая часть решения «слать ли отметку» (ночная проверка 24.09.2026,
 * находка №12). `useScreenSeen` стоит в App.tsx ВЫШЕ `ProtectedRoute`, который
 * на холодной загрузке восстанавливает `accessToken` по refresh-cookie
 * асинхронно, — эффект успевал сработать раньше и слал `/_seen` без токена,
 * получая гарантированный 401 на каждой холодной загрузке. Без токена ручка
 * всё равно ответит 401 (она требует входа) — просто не отправляем запрос,
 * пока токена нет; как только он появится, `useScreenSeen` перезапустит
 * эффект (accessToken — тоже в зависимостях) и тот же экран отметится уже
 * успешно.
 */
export function shouldReportScreen(pathname: string, hasAccessToken: boolean): boolean {
  if (!hasAccessToken) return false;
  return !PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

export function useScreenSeen(): void {
  const { pathname } = useLocation();
  const accessToken = useAuthStore((s) => s.accessToken);
  const readOnly = useAuthStore((s) => s.agent?.role === "SHAREHOLDER" || s.agent?.readOnly === true);

  useEffect(() => {
    if (readOnly || !shouldReportScreen(pathname, !!accessToken)) return;

    const screen = normalizeScreenPath(pathname);
    if (reported.has(screen)) return;
    reported.add(screen);

    // Отметка не имеет права влиять на экран: отказ гасим молча и не повторяем.
    void api("/_seen", { method: "POST", body: { screen } }).catch(() => {});
  }, [pathname, accessToken, readOnly]);
}
