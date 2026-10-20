import { getAllOwnMedia, type InstagramMediaItem } from "./instagramFeed.js";
import { instagramShortcode } from "./sharedMedia.js";
import { expandLinkFields } from "./sharedLinks.js";
import { logSystemError } from "../lib/systemError.js";

/**
 * Наша собственная публикация по короткому коду из ссылки.
 *
 * Зачем: клиент пересылает боту наш рилс, и в вебхуке от Meta приходит НЕ файл, а
 * адрес публикации (проверено замером за 7–13.08.2026: код извлекался во всех
 * десяти случаях). Скачать по такому адресу нечего — там страница, а не видео.
 * Зато у нас есть собственная лента (`/me/media`), и в ней Graph отдаёт прямую
 * ссылку на файл СВОИХ публикаций. То есть посмотреть пересланное видео мы можем —
 * просто идти за ним надо не по присланному адресу, а в свою ленту.
 *
 * Это же закрывает вторую беду. Раньше узнавание держалось на поле «Ссылка на
 * публикацию Instagram», которое агенты заполняют руками: на проде в 20 карточках
 * из 41 там лежит `t.me`, и для них узнавание не срабатывало никогда. Теперь даже
 * без карточки бот видит само видео и его подпись — то есть отвечает по существу,
 * а не переспрашивает.
 */

export interface OwnMedia {
  /** Номер публикации в Instagram — тот же, что автопубликация пишет в
   *  Property.publishedPostIds.INSTAGRAM (см. findSharedProperty). */
  id?: string;
  permalink: string;
  caption?: string;
  /** Прямая ссылка на файл. У видео Graph отдаёт её только владельцу аккаунта. */
  mediaUrl?: string;
  thumbnailUrl?: string;
  mediaType: string;
}

/**
 * Свежесть ленты для узнавания. Двадцать минут (столько живёт кэш для сайта) — это
 * ровно тот срок, за который свежая публикация успевает разойтись по подписчикам, а
 * бот ещё «не знает» о ней. Поэтому здесь срок короче.
 */
const FEED_MAX_AGE_MS = 3 * 60 * 1000;

/**
 * Найти нашу публикацию по её адресу.
 *
 * Адресов-кандидатов НЕСКОЛЬКО, и это не удобство, а исправление (20.09.2026).
 * Meta кладёт в `attachment.payload.url` то сам адрес публикации, то ссылку на
 * свой CDN (`lookaside.fbsbx.com/...`) — из второй короткий код не достать вовсе.
 * А ссылка при этом часто лежит рядом: в тексте сообщения или во втором вложении
 * той же пачки. Прежняя подпись брала РОВНО ОДИН адрес, и вызывающий передавал
 * `attachmentUrl ?? text` — то есть при непустом CDN-адресе текст не смотрели
 * никогда, хотя двумя десятками строк ниже тот же вебхук ищет код именно так:
 * `instagramShortcode(attachmentUrl) ?? instagramShortcode(base)`.
 *
 * Чем это обходилось: своя же публикация не находилась, модель её не видела, и
 * разговор уходил в ветку «видео у меня не открылось» — человеку, который только
 * что показал пальцем на нашу квартиру. В выгрузке 775 живых переписок за 21.08–20.09
 * так отвечено на 80 пересылок наших постов и роликов из 149.
 *
 * Берём первый адрес, из которого код вообще достаётся: лишний адрес ничего не
 * стоит, а ленту читаем всё равно один раз.
 */
export async function findOwnMedia(...urls: (string | undefined | null)[]): Promise<OwnMedia | null> {
  let code = urls.map((u) => instagramShortcode(u)).find((c): c is string => Boolean(c));
  // Ссылка «поделиться» (instagram.com/share/…) и обёртка перехода кода не несут —
  // он в адресе, куда они ведут (10.10.2026, P0-2/P1-4, messengers/sharedLinks.ts).
  if (!code) code = instagramShortcode(await expandLinkFields(urls.filter(Boolean).join(" "))) ?? undefined;
  if (!code) return null;

  /**
   * ИЩЕМ ПО ЛЕНТАМ ВСЕХ НАШИХ АККАУНТОВ, А НЕ ОДНОГО (владелец 17.08.2026:
   * «главное — бот узнаёт все наши рилсы?»).
   *
   * До этого дня ответ был «нет»: лента бралась одним маркером из Настроек, то
   * есть только у основного аккаунта, и публикации Royal Home Info бот не узнавал
   * вовсе. А клиент, приславший наш же ролик из второго аккаунта, получал
   * «не понял, о какой квартире речь» — самый обидный промах из возможных.
   */
  const items = await getAllOwnMedia(FEED_MAX_AGE_MS);
  if (!items) {
    void logSystemError(
      "meta",
      "Пересланную публикацию не с чем сверить: лента наших аккаунтов Instagram не прочитана вовсе. " +
        "Пока это так, бот не узнаёт НИ ОДНОГО своего ролика и отвечает «видео не открылось». " +
        "Причину ищите в записях выше — протухший маркер аккаунта (HTTP 401) или предел Graph (429).",
      { url: `https://www.instagram.com/reel/${code}/` }
    );
    return null;
  }

  let found = items.find((m) => instagramShortcode(m.permalink) === code);
  let read = items.length;
  // Нет в свежих 300 — дочитываем глубже (P0-2, 10.10.2026): старый наш ролик
  // по-прежнему наш. Глубокий список живёт часами (instagramFeed.ts, DEEP_CACHE_MS).
  if (!found && items.length >= 300) {
    const deep = await getAllOwnMedia(FEED_MAX_AGE_MS, "deep");
    if (deep) {
      found = deep.find((m) => instagramShortcode(m.permalink) === code);
      read = Math.max(read, deep.length);
    }
  }
  /**
   * КОД ДОСТАЛИ, А В НАШЕЙ ЛЕНТЕ ЕГО НЕТ — ЗАПИСЫВАЕМ (20.09.2026).
   *
   * Различить два случая иначе нельзя, а чинятся они по-разному: либо публикация
   * действительно чужая (и «видео не открылось» — правильный ответ), либо наша, но
   * лента до неё не дочитана — маркер второго аккаунта умер, Graph отдал часть
   * страниц, публикация старше предела в 300 записей. Второй случай виден только по
   * длине ленты, поэтому она здесь и названа.
   *
   * Текст постоянный, код уходит в поле адреса — иначе дедупликация в
   * lib/systemError.ts не срабатывает и утренняя сводка будит владельца одинаковыми
   * записями (та же причина, что у reportUnmatchedShare в messengers/sharedMedia.ts).
   */
  if (!found) {
    void logSystemError(
      "meta",
      `Пересланной публикации нет в нашей ленте Instagram (прочитано ${read} записей). ` +
        "Если публикация всё-таки наша — лента дочитана не полностью: проверьте маркеры всех аккаунтов " +
        "Instagram и записи «Лента аккаунта Instagram» рядом. Пока её нет в ленте, бот отвечает клиенту, " +
        "что видео не открылось.",
      { url: `https://www.instagram.com/reel/${code}/` }
    );
  }
  return found ? toOwnMedia(found) : null;
}

/**
 * Наша публикация по её НОМЕРУ, а не по адресу (02.10.2026).
 *
 * Meta всё чаще присылает пересланный пост ссылкой на свой CDN, где кода нет, но
 * рядом кладёт номер публикации (`reel_video_id` / `ig_post_media_id`, см.
 * MetaIncoming.attachmentMediaId). В нашей ленте у каждой записи тот же номер.
 * Промах здесь не пишем в журнал: номер приходит и у чужих публикаций, и «чужое»
 * — обычный исход, а не поломка.
 */
export async function findOwnMediaById(mediaId: string | undefined | null): Promise<OwnMedia | null> {
  if (!mediaId) return null;
  const items = await getAllOwnMedia(FEED_MAX_AGE_MS);
  const found = items?.find((m) => m.id === mediaId);
  return found ? toOwnMedia(found) : null;
}

function toOwnMedia(m: InstagramMediaItem): OwnMedia {
  return {
    id: m.id,
    permalink: m.permalink,
    caption: m.caption,
    mediaUrl: m.mediaUrl,
    thumbnailUrl: m.thumbnailUrl,
    mediaType: m.mediaType,
  };
}

/**
 * Что из публикации можно ОТДАТЬ МОДЕЛИ ГЛАЗАМИ.
 *
 * У видео берём обложку, а не сам файл, и это осознанно: ролик агентства весит
 * десятки мегабайт, разбирается моделью в несколько секунд и стоит денег, а
 * обложка отвечает на главный вопрос «что это за квартира» почти так же полно.
 * Подпись под публикацией при этом уходит текстом — вместе они дают боту больше,
 * чем дал бы сам ролик без подписи.
 */
export function viewableUrl(media: OwnMedia): string | undefined {
  if (media.mediaType === "VIDEO") return media.thumbnailUrl ?? media.mediaUrl;
  return media.mediaUrl ?? media.thumbnailUrl;
}
