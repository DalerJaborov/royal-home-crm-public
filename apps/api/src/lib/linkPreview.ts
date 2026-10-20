import { safeFetch, UnsafeUrlError } from "./safeFetch.js";
import { logSystemError } from "./systemError.js";
import { describeError } from "./describeError.js";

/**
 * Что находится по ссылке, которую прислал клиент.
 *
 * Зачем: человек кидает боту объявление с другого сайта или у другого риелтора, и
 * до сих пор для бота это была просто строка — он вежливо просил «расскажите, что
 * там понравилось». То есть переспрашивал ровно то, что человек уже показал.
 * Теперь мы открываем страницу и достаём заголовок, описание и цену — этого хватает,
 * чтобы ответить по существу: «вижу, двушка в Сино за 60 тысяч — у нас есть похожее».
 *
 * Читаем ТОЛЬКО разметку для соцсетей (og:*) и заголовок. Не «парсим сайт»: у
 * каждого сайта своя вёрстка, и попытка вытащить цену из тела страницы превратилась
 * бы в бесконечную починку под чужие переделки. Теги og заполняют почти все, потому
 * что именно из них собирается карточка ссылки в мессенджерах — то есть мы читаем
 * ровно то, что владелец сайта сам подготовил для показа.
 *
 * Безопасность целиком на lib/safeFetch.ts: адрес приходит от постороннего человека,
 * и без проверки это прямая дорога внутрь нашей сети.
 */

export interface LinkPreview {
  url: string;
  title?: string;
  description?: string;
  siteName?: string;
}

/** Страница на чтение — 5 секунд и 512 КБ. Ход бота не может ждать чужой сайт
 *  дольше, а разметка соцсетей всегда лежит в самом начале документа. */
const TIMEOUT_MS = 5000;
const MAX_BYTES = 512 * 1024;

/** Успех держим долго (объявления меняются редко), неудачу — считанные минуты:
 *  чужой сайт мог лежать одну минуту, и наказывать за это следующего клиента
 *  получасовым молчанием нельзя. Та же ошибка уже стоила нам волны комментариев. */
const OK_TTL_MS = 6 * 60 * 60 * 1000;
const FAIL_TTL_MS = 3 * 60 * 1000;
const CACHE_MAX = 300;

const cache = new Map<string, { value: LinkPreview | null; at: number }>();

/** Наши собственные адреса читать незачем: объект по ним находится в базе точнее
 *  и без единого внешнего запроса (messengers/sharedMedia.ts). */
const OWN_HOSTS = [/(^|\.)royalhome\.tj$/i, /(^|\.)instagram\.com$/i];

/** Первая внешняя ссылка в сообщении. Именно ПЕРВАЯ и единственная: сообщение с
 *  десятью ссылками не должно превращаться в десять запросов наружу с нашего
 *  сервера — это и медленно, и ровно тот механизм, которым чужой сервер заставляют
 *  работать за себя. */
export function firstForeignLink(text: string): string | null {
  const matches = text.match(/https?:\/\/[^\s<>"')]+/gi);
  if (!matches) return null;
  for (const raw of matches) {
    // Хвостовая пунктуация («…смотри тут https://site.tj/x.») в адрес не входит.
    const url = raw.replace(/[.,;:!?)»]+$/u, "");
    try {
      const host = new URL(url).hostname;
      if (OWN_HOSTS.some((re) => re.test(host))) continue;
      return url;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * ПЕРВАЯ ССЫЛКА НА НАШ СОБСТВЕННЫЙ САЙТ (21.09.2026).
 *
 * `firstForeignLink` наши адреса пропускает нарочно: объект по ним находится в
 * базе точнее и без запроса наружу. Но когда объект НЕ нашёлся (ссылка на поиск,
 * на страницу-статью, на объявление, снятое с продажи, или адрес со слагом,
 * которого разборщик не знает), подсказки модели не оставалось вообще никакой —
 * и человек, приславший ссылку на нашу же страницу, получал «видео у меня не
 * открылось». Для этого случая страницу можно просто прочитать, как чужую.
 */
export function firstOwnSiteLink(text: string): string | null {
  const matches = text.match(/https?:\/\/[^\s<>"')]+/gi);
  if (!matches) return null;
  for (const raw of matches) {
    const url = raw.replace(/[.,;:!?)»]+$/u, "");
    try {
      const host = new URL(url).hostname;
      // Только наш сайт: страницу Instagram таким способом не прочитать (Meta
      // отдаёт её без og-тегов неавторизованному читателю).
      if (/(^|\.)royalhome\.tj$/i.test(host)) return url;
    } catch {
      continue;
    }
  }
  return null;
}

export async function linkPreview(url: string): Promise<LinkPreview | null> {
  const cached = cache.get(url);
  if (cached && Date.now() - cached.at < (cached.value ? OK_TTL_MS : FAIL_TTL_MS)) {
    return cached.value;
  }

  let value: LinkPreview | null = null;
  try {
    const res = await safeFetch(url, {
      timeoutMs: TIMEOUT_MS,
      maxBytes: MAX_BYTES,
      // Представляемся честно: сайты вправе знать, кто их читает, а маскировка под
      // браузер — первый шаг к тому, чтобы нас заблокировали целиком.
      headers: { "User-Agent": "RoyalHomeCRM/1.0 (+https://royalhome.tj)", Accept: "text/html,*/*" },
    });
    if (res && res.contentType.includes("text/html")) {
      value = parseHtml(res.url, res.body.toString("utf8"));
    }
  } catch (err) {
    // Запрещённый адрес — это не поломка, а сработавшая защита: пишем в журнал и
    // молча продолжаем разговор. Клиенту про наши внутренние правила знать незачем.
    if (err instanceof UnsafeUrlError) {
      void logSystemError("meta", `Ссылка клиента не открыта (${err.message}): ${url.slice(0, 120)}`);
    } else {
      void logSystemError("meta", `Ссылка клиента не прочиталась: ${describeError(err)}`);
    }
  }

  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
  cache.set(url, { value, at: Date.now() });
  return value;
}

/** Разметка соцсетей и заголовок. Экспортируется ради теста: разбор чужой вёрстки —
 *  то, что ломается молча при любой правке регулярного выражения. */
export function parseHtml(url: string, html: string): LinkPreview | null {
  const head = html.slice(0, 200_000);
  const tags = metaTags(head);
  const preview: LinkPreview = {
    url,
    title: tags.get("og:title") ?? titleTag(head),
    description: tags.get("og:description") ?? tags.get("description"),
    siteName: tags.get("og:site_name"),
  };
  // Пустая карточка бесполезна: пусть вызывающий честно скажет «не открылось»,
  // а не подсовывает модели строку из одного адреса.
  if (!preview.title && !preview.description) return null;
  return preview;
}

/**
 * Все мета-теги страницы: имя (`property` или `name`) → `content`, первый
 * встреченный выигрывает. Порядок атрибутов у всех разный (`property` до
 * `content` и наоборот), поэтому атрибуты разбираем внутри тега, а не одним
 * выражением на весь документ.
 *
 * БЕЗ РЕГУЛЯРКИ ПО ВСЕМУ ДОКУМЕНТУ (аудит 23.09.2026, круг 3, №72). Прежние
 * выражения вида `<meta[^>]+…` на странице из тысяч `<meta` без закрывающей
 * `>` откатывались квадратично: 80 000 символов — 0,85 с на одно выражение,
 * а их было восемь на 200 000 символов. Ссылку на такую страницу может
 * прислать любой клиент в Instagram или WhatsApp, разбор идёт в процессе API
 * — и вся CRM, звонки и живые обновления стояли десятки секунд на каждом
 * таком сообщении. Теперь тег ищется `indexOf`, а выражение работает только
 * внутри одного тега длиной не больше 2000 символов: время линейно.
 */
const MAX_TAG = 2000;
/** Нижний регистр только для латиницы: длина строки не меняется, и позиции
 *  `indexOf` в копии совпадают с позициями в оригинале (у `toLowerCase` для
 *  некоторых букв Юникода результат длиннее исходника). */
const asciiLower = (s: string) => s.replace(/[A-Z]+/g, (m) => m.toLowerCase());
const ATTR = /([a-z:-]+)\s*=\s*(["'])([\s\S]*?)\2/gi;

function metaTags(html: string): Map<string, string> {
  const lower = asciiLower(html);
  const found = new Map<string, string>();
  let pos = 0;
  for (;;) {
    const open = lower.indexOf("<meta", pos);
    if (open < 0) break;
    const close = lower.indexOf(">", open);
    // Нет «>» после этого тега — нет и после любого следующего: разбор окончен.
    if (close < 0) break;
    pos = close + 1;
    if (close - open > MAX_TAG) continue;
    let name: string | undefined;
    let content: string | undefined;
    for (const attr of html.slice(open + 5, close).matchAll(ATTR)) {
      const key = attr[1]!.toLowerCase();
      if ((key === "property" || key === "name") && name === undefined) name = attr[3]!.trim().toLowerCase();
      else if (key === "content" && content === undefined) content = attr[3]!;
    }
    if (!name || content === undefined || found.has(name)) continue;
    const value = clean(content);
    if (value) found.set(name, value);
  }
  return found;
}

/** Заголовок `<title>…</title>` — тем же приёмом, `indexOf` вместо `<title[^>]*>`,
 *  которое на тысячах незакрытых `<title` откатывалось так же квадратично. */
function titleTag(html: string): string | undefined {
  const lower = asciiLower(html);
  const open = lower.indexOf("<title");
  if (open < 0) return undefined;
  const bodyStart = lower.indexOf(">", open);
  if (bodyStart < 0 || bodyStart - open > MAX_TAG) return undefined;
  const end = lower.indexOf("</title>", bodyStart);
  if (end < 0) return undefined;
  const text = clean(html.slice(bodyStart + 1, Math.min(end, bodyStart + 1 + 300)));
  return text || undefined;
}

/** Мягкая чистка: сущности, переносы и лишние пробелы. Модель получит текст, а не
 *  кусок разметки. */
function clean(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}
