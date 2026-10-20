import { logSystemError } from "../lib/systemError.js";
import { describeError } from "../lib/describeError.js";

/**
 * РАЗБОР ПРИСЛАННЫХ ССЫЛОК НА ПУБЛИКАЦИИ (10.10.2026, аудит
 * docs/audit-bots-2026-10-10-object-routing.md, P0-2 / P1-4).
 *
 * Узнавание пересланного поста (messengers/sharedMedia.ts::findSharedProperty)
 * понимало только «прямые» адреса: instagram.com/reel/<код>, /p/<код> и
 * facebook.com/<стр>/videos/<номер>. Живые ссылки приходят иначе:
 *  - «Поделиться» в Instagram с 2024 года копирует instagram.com/share/reel/<токен>
 *    (или /share/<токен>) — кода поста в ней нет, он есть только в адресе, куда
 *    Instagram перенаправляет;
 *  - Facebook: /reel/<номер>, /share/r/<токен>, fb.watch/<токен>, permalink.php?story_fbid=,
 *    watch/?v=, video.php?v=;
 *  - обёртки переходов l.facebook.com/l.php?u=<адрес> и l.instagram.com/?u=<адрес>.
 * Всё это раньше заканчивалось «не опознана» и ответом «видео не открылось».
 *
 * Здесь одно место разбора: развернуть обёртки (без сети), найти короткие ссылки
 * «поделиться» и пройти их переадресацию на сервере (сеть, с таймаутом и кэшем),
 * достать номера публикаций Facebook. Результат — дополнительный текст, в котором
 * прежние разборщики находят код и номер как обычно.
 */

/** Обёртки переходов Meta: настоящий адрес лежит в параметре `u`. */
const REDIRECT_WRAPPER_RE = /https?:\/\/l\.(?:facebook|instagram)\.com\/(?:l\.php)?\/?\?[^\s]*?\bu=([^&\s]+)/gi;

/** Развернуть обёртки переходов в тексте: к тексту дописываются настоящие адреса. */
export function unwrapRedirectLinks(text: string): string {
  const found: string[] = [];
  for (const m of text.matchAll(REDIRECT_WRAPPER_RE)) {
    try {
      found.push(decodeURIComponent(m[1]!));
    } catch {
      // Битая кодировка — адрес не разворачивается, остаётся как был.
    }
  }
  return found.length ? `${text} ${found.join(" ")}` : text;
}

/** Ссылки «поделиться», в которых самого номера/кода публикации нет. */
const SHARE_LINK_RE =
  /(?:https?:\/\/)?(?:www\.|m\.)?(?:instagram\.com\/share\/(?:reel\/|p\/|video\/)?[A-Za-z0-9_-]+|facebook\.com\/share\/(?:r|v|p)\/[A-Za-z0-9_-]+|fb\.watch\/[A-Za-z0-9_-]+)\/?/gi;

export function shareShortLinks(text: string): string[] {
  const links = new Set<string>();
  for (const m of text.matchAll(SHARE_LINK_RE)) {
    const raw = m[0]!;
    links.add(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  }
  return [...links].slice(0, 3);
}

/**
 * Номера публикаций Facebook из адреса: ролик, пост, видео. Тот же номер
 * автопубликация пишет в Property.publishedPostIds.FACEBOOK / FACEBOOK_POST.
 * pfbid… (зашифрованный номер поста) без Graph API в число не переводится — его нет.
 */
export function facebookMediaIds(text: string): string[] {
  const ids = new Set<string>();
  const patterns = [
    /facebook\.com\/[^\s]*?\/(?:videos|posts|reel|reels|photos)\/(?:[^/\s]*\/)?(\d{5,})/gi,
    /facebook\.com\/(?:reel|reels|watch\/?\?v=|video\.php\?v=)\/?(\d{5,})/gi,
    /facebook\.com\/[^\s]*?[?&](?:story_fbid|fbid|v)=(\d{5,})/gi,
  ];
  for (const re of patterns) for (const m of text.matchAll(re)) ids.add(m[1]!);
  return [...ids];
}

/** Сколько переадресаций проходим и сколько ждём сеть: это живой ход разговора. */
const MAX_HOPS = 5;
const EXPAND_TIMEOUT_MS = 3_000;
const CACHE_TTL_MS = 60 * 60 * 1000;
const CACHE_MAX = 500;
const expandCache = new Map<string, { urls: string[]; at: number }>();

type FetchLike = (url: string, init: { redirect: "manual"; signal: AbortSignal; headers: Record<string, string> }) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
}>;

/**
 * Пройти переадресацию короткой ссылки «поделиться» и вернуть все адреса пути
 * (включая параметр `next=` страницы входа — Instagram прячет туда адрес поста,
 * когда отправляет неавторизованного на вход). Отказ сети — пустой список: узнавание
 * просто не получит подсказки, ответ клиенту не ждёт и не ломается.
 */
export async function expandShareLink(url: string, fetchImpl: FetchLike = fetch as unknown as FetchLike): Promise<string[]> {
  const cached = expandCache.get(url);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.urls;
  const visited: string[] = [];
  let current = url;
  try {
    for (let hop = 0; hop < MAX_HOPS; hop++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), EXPAND_TIMEOUT_MS);
      let res;
      try {
        res = await fetchImpl(current, {
          redirect: "manual",
          signal: controller.signal,
          headers: { "User-Agent": "Mozilla/5.0 (compatible; RoyalHomeCRM/1.0)" },
        });
      } finally {
        clearTimeout(timer);
      }
      const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
      if (!location) break;
      current = new URL(location, current).toString();
      visited.push(current);
      try {
        const next = new URL(current).searchParams.get("next");
        if (next) visited.push(new URL(next, current).toString());
      } catch {
        // Разобрать next не вышло — сам адрес уже в списке.
      }
    }
  } catch (err) {
    void logSystemError("meta", `Ссылку «поделиться» не удалось развернуть: ${describeError(err)}`, {
      dedupKey: "share-link-expand",
    });
  }
  if (expandCache.size >= CACHE_MAX) expandCache.delete(expandCache.keys().next().value!);
  expandCache.set(url, { urls: visited, at: Date.now() });
  return visited;
}

/** Только для тестов. */
export function resetShareLinkCache(): void {
  expandCache.clear();
}

/**
 * Текст для узнавания: исходный + развёрнутые обёртки + адреса, куда ведут ссылки
 * «поделиться». Дальше его читают прежние разборщики (instagramShortcode и др.).
 */
export async function expandLinkFields(text: string, fetchImpl?: FetchLike): Promise<string> {
  const unwrapped = unwrapRedirectLinks(text);
  const shortLinks = shareShortLinks(unwrapped);
  if (shortLinks.length === 0) return unwrapped;
  const expanded = (await Promise.all(shortLinks.map((l) => expandShareLink(l, fetchImpl)))).flat();
  return expanded.length ? `${unwrapped} ${expanded.join(" ")}` : unwrapped;
}
