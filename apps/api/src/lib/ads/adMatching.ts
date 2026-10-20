import type { AdMatchSource } from "../../generated/prisma/client.js";
import { prisma } from "../../db.js";
import { getAllOwnMedia } from "../../messengers/instagramFeed.js";
import { captionShortId, healInstagramUrl, instagramShortcode } from "../../messengers/sharedMedia.js";
import type { AdCreativeAsset } from "./adAssets.js";
import { CRM_PUBLISHED_POST_KEYS as PUBLISHED_POST_KEYS, crmMediaKeys as mediaKeys } from "./crmMediaRegistryKeys.js";

/**
 * ЗА КАКОЙ ОБЪЕКТ ПЛАТИТ ОБЪЯВЛЕНИЕ.
 *
 * Meta про наши карточки ничего не знает: у неё есть только продвигаемая публикация
 * и название кампании. Связь приходится доказывать, и доказательства бывают разной
 * силы — поэтому источник привязки хранится рядом с ней (Ad.matchSource).
 *
 * ПОРЯДОК ДОВЕРИЯ:
 *   1. POST_URL — код публикации совпал с полем «Ссылка на публикацию Instagram»
 *      в карточке. Прямее некуда.
 *   1б. CRM_MEDIA — id публикации (или хвост storyId) есть в наших записях о
 *      публикациях: Property.publishedPostIds, PropertyPhotoPost.mediaId,
 *      PropertyStoryPost.mediaId. Доказано нашей же базой, проверяется раньше ленты.
 *   2. FEED_CAPTION — публикации нет ни в одной карточке, но она есть В НАШЕЙ ЛЕНТЕ
 *      Instagram, и в её подписи стоит «№1042». Это тот же приём, которым бот
 *      узнаёт пересланный клиентом рилс (messengers/ownMedia.ts). Ради него всё и
 *      затевалось: на 20.08.2026 у 17 карточек в поле ссылки лежит не адрес
 *      Instagram вовсе, и без ленты их реклама навсегда осталась бы «ничьей».
 *   3. ENTITY_NAME — номер объекта написан прямо в названии кампании/группы/
 *      объявления. Единственный путь, который работает и для Google, и для TikTok,
 *      и для рекламы у блогера, — там никакого «поста Instagram» нет.
 *
 * ОДНО ОБЪЯВЛЕНИЕ — НЕСКОЛЬКО ОБЪЕКТОВ (03.10.2026). «Гибкое» объявление несёт
 * несколько роликов про разные квартиры, поэтому те же пути прогоняются по КАЖДОМУ
 * материалу объявления и по ВСЕМ номерам из названий (matchAll), а не останавливаются
 * на первом найденном.
 *
 * ЧЕГО ЗДЕСЬ СОЗНАТЕЛЬНО НЕТ — догадок. Ни по адресу, ни по цене, ни по похожести
 * текста: ошибка привязки означает, что владелец увидит расход на чужой квартире и
 * примет по нему решение. Не нашли — оставляем без объекта, такие строки собираются
 * в отчёте отдельной кучкой «Не привязано».
 */

/** Номер объекта в НАЗВАНИИ рекламной сущности: и «№1042», и «#1042».
 *
 *  Отдельно от captionShortId (там строго «№», как в подписи под постом): название
 *  кампании пишет маркетолог в Ads Manager, где решётка привычнее и лежит на
 *  клавиатуре, а спутать её не с чем — других чисел с решёткой в названиях не
 *  бывает. Голое число («1042 июль») не берём: это чаще бюджет или дата. */
const NAME_SHORTID_RE = /[#№]\s*(\d+)/g;

/** ВСЕ номера объектов из названия: «№12 и №13» → [12, 13]. Без повторов, в порядке записи.
 *  До 03.10.2026 брался только первый номер, и «гибкое» объявление про две квартиры
 *  целиком уходило на одну. */
export function nameShortIds(name: string | null | undefined): number[] {
  if (!name) return [];
  const out: number[] = [];
  for (const match of name.matchAll(NAME_SHORTID_RE)) {
    const shortId = Number(match[1]);
    if (Number.isFinite(shortId) && !out.includes(shortId)) out.push(shortId);
  }
  return out;
}

/** Первый номер из названия — для вызывающих, которым нужен ровно один. */
export function nameShortId(name: string | null | undefined): number | null {
  return nameShortIds(name)[0] ?? null;
}

/** Всё, что матчер знает об объявлении. Ровно поля модели Ad — чтобы вызывать его
 *  можно было и на свежих данных Meta, и на уже сохранённой записи (перепривязка). */
export interface AdMatchInput {
  postUrl?: string | null;
  mediaId?: string | null;
  /** «<id Страницы>_<id поста>» — по нему узнаётся наша Страница Facebook. */
  storyId?: string | null;
  name?: string | null;
  campaignName?: string | null;
  adsetName?: string | null;
  /**
   * Текст объявления от самой Meta. Появился 21.08.2026, когда выяснилось, что
   * ленте Instagram доверять нельзя: ни одна из 25 рекламируемых публикаций
   * агентства в ней не нашлась (реклама идёт со Страницы Facebook и с аккаунта,
   * не подключённого к CRM). Meta отдаёт этот текст вместе с объявлением, то есть
   * он есть всегда, когда есть само объявление.
   */
  caption?: string | null;
  /** Материалы объявления (ролики, картинки, карточки). Нет у старых вызывающих. */
  assets?: AdCreativeAsset[] | null;
}

export interface AdMatchResult {
  propertyId: string;
  source: AdMatchSource;
}

/** Результат привязки ВСЕХ объектов объявления. */
export interface AdMatchAllResult {
  /** Доказанные объекты; первый — самый уверенный (он же «основной»). Пусто — не нашли. */
  matches: AdMatchResult[];
  /** Материалы объявления; у привязанных заполнен propertyId. */
  assets: AdCreativeAsset[];
  /**
   * Сколько РАЗНЫХ материалов в объявлении: материалы, доказанно про один и тот же
   * объект, считаются одним (пять фото одной квартиры — не «пять неизвестных»).
   * assetCount больше числа найденных объектов — объявление неполное.
   */
  assetCount: number;
}

export interface AdMatcherOptions {
  /**
   * Чинить ли поле «Ссылка на публикацию Instagram» у карточки, когда связь
   * доказана лентой. По умолчанию да — это тот же самоисцеляющийся приём, что и в
   * диалоге бота: один раз доказали связь дорогим путём, записали, дальше находится
   * дешёвым. В тестах и в предпросмотре выключается.
   */
  heal?: boolean;
}

export interface AdMatcher {
  /** Первый (самый уверенный) объект — тонкая обёртка над matchAll для старых вызывающих. */
  match(ad: AdMatchInput): Promise<AdMatchResult | null>;
  /**
   * ВСЕ доказанные объекты объявления. Те же пути, что и у match, но по КАЖДОМУ
   * материалу и по ВСЕМ номерам из названий; догадок по-прежнему нет.
   */
  matchAll(ad: AdMatchInput): Promise<AdMatchAllResult>;
  /**
   * НАША ЛИ ЭТО РЕКЛАМА ВООБЩЕ.
   *
   * Кабинет подрядчика ведёт не только нас: рядом с нашими квартирами там реклама
   * других его клиентов, и её бюджет не имеет к нам никакого отношения. Своим
   * считаем объявление, которое продвигает нашу публикацию Instagram (нашлась в
   * ленте наших аккаунтов) или нашу Страницу Facebook.
   *
   * Осторожно в обе стороны: чужое, посчитанное нашим, врёт про стоимость объекта;
   * наше, посчитанное чужим, прячет реальные расходы. Поэтому «не наше» — не
   * приговор: такие объявления сохраняются отдельным списком, и человек может
   * сказать «нет, это наше» (routes/ads.ts).
   */
  isOurs(ad: AdMatchInput): boolean;
  /** Сколько карточек матчер починил по дороге — уходит в отчёт синхронизации. */
  healedCount(): number;
}

type FeedPost = { caption?: string; permalink: string };

/** Ключи Property.publishedPostIds, в которых лежит id публикации (те же, что у messengers/sharedMedia.ts). */

/** Id публикации Facebook бывает «{страница}_{пост}» — в карту кладём и целиком, и хвост. */

/**
 * КАРТА «id публикации → объект» из записей CRM о том, что и куда мы опубликовали.
 * Грузится ОДИН раз на прогон (три запроса, а не по запросу на объявление). Источники
 * те же, что у messengers/sharedMedia.ts::propertyByMediaId: ролик
 * (Property.publishedPostIds), фото-пост (PUBLISHED) и история.
 *
 * Если один и тот же id оказался у РАЗНЫХ объектов, он выбрасывается из карты: гадать,
 * какой из них продвигает объявление, нельзя — ошибка привязки это расход на чужой квартире.
 * В карту попадают только объекты из переданного списка (живые; удалённые — нет).
 */
export async function loadCrmMediaMap(
  properties: { id: string; publishedPostIds: unknown }[]
): Promise<Map<string, string>> {
  const known = new Set(properties.map((p) => p.id));
  const map = new Map<string, string>();
  const ambiguous = new Set<string>();
  const put = (raw: string | null | undefined, propertyId: string) => {
    if (!known.has(propertyId)) return;
    for (const key of mediaKeys(raw)) {
      const prev = map.get(key);
      if (prev && prev !== propertyId) ambiguous.add(key);
      else map.set(key, propertyId);
    }
  };

  for (const p of properties) {
    const ids = p.publishedPostIds;
    if (!ids || typeof ids !== "object" || Array.isArray(ids)) continue;
    for (const key of PUBLISHED_POST_KEYS) {
      const value = (ids as Record<string, unknown>)[key];
      if (typeof value === "string") put(value, p.id);
    }
  }

  const [photoPosts, storyPosts] = await Promise.all([
    prisma.propertyPhotoPost.findMany({
      where: { status: "PUBLISHED", mediaId: { not: null } },
      select: { propertyId: true, mediaId: true },
    }),
    prisma.propertyStoryPost.findMany({ select: { propertyId: true, mediaId: true } }),
  ]);
  for (const post of photoPosts) put(post.mediaId, post.propertyId);
  for (const post of storyPosts) put(post.mediaId, post.propertyId);

  for (const key of ambiguous) map.delete(key);
  return map;
}

/**
 * Готовит матчер ОДИН раз на прогон: карточки и лента читаются разом, дальше
 * привязка каждого объявления — работа в памяти. Иначе на каждое объявление
 * приходился бы поход в базу и в Graph API, а объявлений в кабинете сотни.
 */
export async function buildAdMatcher(options: AdMatcherOptions = {}): Promise<AdMatcher> {
  const heal = options.heal !== false;

  const properties = await prisma.property.findMany({
    where: { deletedAt: null },
    select: {
      id: true,
      shortId: true,
      instagramUrl: true,
      address: true,
      price: true,
      rooms: true,
      publishedPostIds: true,
      district: { select: { name: true } },
    },
  });
  /** Для разбора подписи — в плоском виде, чтобы не таскать вложенность. */
  const forCaption = properties.map((p) => ({
    id: p.id,
    shortId: p.shortId,
    address: p.address,
    price: p.price,
    rooms: p.rooms,
    districtName: p.district?.name ?? null,
  }));

  const byShortId = new Map<number, { id: string; instagramUrl: string | null }>();
  const byPostCode = new Map<string, { id: string; instagramUrl: string | null }>();
  for (const p of properties) {
    byShortId.set(p.shortId, { id: p.id, instagramUrl: p.instagramUrl });
    const code = instagramShortcode(p.instagramUrl);
    // Первая карточка выигрывает: если один пост зачем-то указан у двух объектов,
    // гадать нельзя — вторая просто не участвует в быстром пути и будет искаться
    // через ленту, где номер в подписи однозначен.
    if (code && !byPostCode.has(code)) byPostCode.set(code, { id: p.id, instagramUrl: p.instagramUrl });
  }

  // Публикации, о которых CRM знает сама (ролики, фото-посты, истории): быстрый и самый
  // надёжный путь — раньше ленты Instagram, которой нельзя доверять (см. шапку файла).
  const crmMedia = await loadCrmMediaMap(properties);
  const crmPropertyOf = (...rawIds: (string | null | undefined)[]): string | null => {
    for (const raw of rawIds) {
      for (const key of mediaKeys(raw)) {
        const hit = crmMedia.get(key);
        if (hit) return hit;
      }
    }
    return null;
  };

  // Лента может быть недоступна (нет маркера, Meta отказала) — тогда работают
  // только пути 1 и 3. Это деградация, а не отказ: молчаливо роняет качество
  // привязки, но не срывает учёт денег.
  const feed = (await getAllOwnMedia()) ?? [];
  const feedByCode = new Map<string, FeedPost>();
  const feedByMediaId = new Map<string, FeedPost>();
  for (const item of feed) {
    const code = instagramShortcode(item.permalink);
    if (code && !feedByCode.has(code)) feedByCode.set(code, { caption: item.caption, permalink: item.permalink });
    if (item.id && !feedByMediaId.has(item.id)) {
      feedByMediaId.set(item.id, { caption: item.caption, permalink: item.permalink });
    }
  }

  // Наша Страница Facebook: первая половина storyId у своих объявлений — это её id.
  const settings = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { metaPageId: true },
  });
  const ourPageId = settings?.metaPageId?.trim() || process.env.META_PAGE_ID || null;

  let healed = 0;

  const isOurs = (ad: AdMatchInput): boolean => {
    const code = instagramShortcode(ad.postUrl);
    if (code && feedByCode.has(code)) return true;
    if (ad.mediaId && feedByMediaId.has(ad.mediaId)) return true;
    // Публикация, которую мы сами выпустили через CRM, — наша по определению.
    if (crmPropertyOf(ad.mediaId, ad.storyId)) return true;
    // Материал объявления тоже может быть нашей публикацией (карточка карусели).
    for (const asset of ad.assets ?? []) {
      const assetCode = instagramShortcode(asset.permalink);
      if (assetCode && feedByCode.has(assetCode)) return true;
    }
    if (ourPageId && ad.storyId?.startsWith(`${ourPageId}_`)) return true;
    // Лента недоступна и Страница не настроена — отличить своё от чужого нечем.
    // В этом случае считаем своим ВСЁ: спрятать реальные расходы хуже, чем
    // показать лишнее, — лишнее видно и снимается вручную, спрятанное не видно никак.
    if (feed.length === 0 && !ourPageId) return true;
    return false;
  };

  /**
   * Пути 1 и 2 для ОДНОЙ публикации (на уровне объявления или материала):
   *   1. код публикации совпал с полем в карточке;
   *   2. публикация нашлась в нашей ленте — номер объекта берём из её подписи.
   * Возвращает и найденную публикацию: её подпись нужна пути «по тексту».
   */
  const resolvePost = async (
    code: string | null,
    mediaId: string | null | undefined,
    storyId?: string | null
  ): Promise<{ hit: AdMatchResult | null; post: FeedPost | null }> => {
    if (code) {
      const direct = byPostCode.get(code);
      if (direct) return { hit: { propertyId: direct.id, source: "POST_URL" }, post: null };
    }
    // Публикация записана в самой CRM — ленту дёргать не нужно.
    const crmHit = crmPropertyOf(mediaId, storyId);
    if (crmHit) return { hit: { propertyId: crmHit, source: "CRM_MEDIA" }, post: null };
    const post = (code ? feedByCode.get(code) : null) ?? (mediaId ? feedByMediaId.get(mediaId) : null) ?? null;
    if (post) {
      const shortId = captionShortId(post.caption);
      const target = shortId != null ? byShortId.get(shortId) : undefined;
      if (target) {
        if (heal && (await healInstagramUrl(target.id, target.instagramUrl, post.permalink))) {
          healed++;
          // Чтобы следующая публикация того же объекта не «чинила» его повторно.
          target.instagramUrl = post.permalink;
        }
        return { hit: { propertyId: target.id, source: "FEED_CAPTION" }, post };
      }
    }
    return { hit: null, post };
  };

  /**
   * Путь «по тексту публикации» — добавлен 21.08.2026 после первой сверки живого
   * кабинета: из 25 объявлений не привязалось НИ ОДНО. Оказалось, агентство не
   * пишет «№объекта» в подписях, а ссылки в карточках ведут на другие публикации
   * (видео-обзоры), поэтому остальные пути молчат.
   *
   * Здесь связь доказывается содержимым: адрес и цена объекта, найденные в тексте.
   * Требуем СОВПАДЕНИЯ ДВУХ признаков сразу и уникального победителя — одна улица
   * на два объекта или одна цена у пяти квартир ничего не доказывают, и привязать
   * по ним значит показать владельцу расход на чужой квартире.
   */
  const byCaptionText = (text: string | null | undefined): AdMatchResult | null => {
    if (!text) return null;
    const strong = matchByCaption(text, forCaption);
    return strong ? { propertyId: strong, source: "FEED_CAPTION" } : null;
  };

  /** Номера из названий: сначала объявление, нет — группа, нет — кампания (как и раньше, но ВСЕ номера уровня). */
  const namedShortIds = (ad: AdMatchInput): number[] => {
    for (const name of [ad.name, ad.adsetName, ad.campaignName]) {
      const ids = nameShortIds(name);
      if (ids.length > 0) return ids;
    }
    return [];
  };

  const matchAll = async (ad: AdMatchInput): Promise<AdMatchAllResult> => {
    const hits = new Map<string, AdMatchResult>();
    const add = (hit: AdMatchResult | null) => {
      if (hit && !hits.has(hit.propertyId)) hits.set(hit.propertyId, hit);
    };

    // 1–2. Публикация объявления.
    const adPost = await resolvePost(instagramShortcode(ad.postUrl), ad.mediaId, ad.storyId);
    add(adPost.hit);

    // 1–2 и «по тексту» — по КАЖДОМУ материалу: ролик в «гибком» объявлении может
    // быть про свой объект, и его подпись — единственное, что это доказывает.
    const assets: AdCreativeAsset[] = [];
    for (const asset of ad.assets ?? []) {
      const own = await resolvePost(instagramShortcode(asset.permalink), asset.kind === "post" ? ad.mediaId : null);
      const hit = own.hit ?? byCaptionText(own.post?.caption ?? asset.text);
      add(hit);
      assets.push(hit ? { ...asset, propertyId: hit.propertyId } : asset);
    }

    // 3. Номера объектов, написанные в названии, — единственный путь для систем
    //    без публикаций Instagram (Google, TikTok, ручные расходы).
    for (const shortId of namedShortIds(ad)) {
      const byName = byShortId.get(shortId);
      if (byName) add({ propertyId: byName.id, source: "ENTITY_NAME" });
    }

    // 4. Текст объявления целиком — последний путь и только когда больше ничего не
    //    нашлось: подпись от Meta у «гибкого» объявления — это одна из нескольких
    //    подписей, и не должна добавлять объект рядом с уже доказанными.
    if (hits.size === 0) add(byCaptionText(adPost.post?.caption ?? ad.caption));

    const resolved = new Set(assets.filter((a) => a.propertyId).map((a) => a.propertyId));
    const unresolved = assets.filter((a) => !a.propertyId).length;
    return {
      matches: Array.from(hits.values()),
      assets,
      assetCount: Math.max(1, resolved.size + unresolved),
    };
  };

  return {
    healedCount: () => healed,
    isOurs,
    matchAll,
    async match(ad: AdMatchInput): Promise<AdMatchResult | null> {
      return (await matchAll(ad)).matches[0] ?? null;
    },
  };
}

/**
 * Объект по тексту публикации: улица + цена, или район + цена, или улица + комнаты.
 * Возвращает id только при единственном кандидате с двумя совпадениями — иначе null.
 */
/**
 * Цена объекта В ТЕКСТЕ, с границами чисел (ревью 03.10.2026, п. 16). Прежний поиск шёл
 * по склейке ВСЕХ цифр подписи, и цена «находилась» внутри телефона или чужого числа.
 * Здесь число ищется как отдельное: слитно («105000») и с разделителями тысяч («105 000»,
 * «105.000», «105,000», неразрывный пробел), и не может быть куском более длинного числа
 * ни справа (`105 0001`), ни слева («1 105 000» — это миллион, а не 105 тысяч).
 */
const SEP = "[\\s.,\\u00a0\\u202f]";
export function textHasPrice(text: string, price: number): boolean {
  const digits = String(Math.round(price));
  if (digits.length <= 3) return false;
  const groups: string[] = [];
  for (let end = digits.length; end > 0; end -= 3) groups.unshift(digits.slice(Math.max(0, end - 3), end));
  return new RegExp(`(?<!\\d|\\d${SEP})${groups.join(`${SEP}?`)}(?!\\d|[.,]\\d)`).test(text);
}

/**
 * «3 комнатная», «3-комнатная», «3-х комнатная», «3 хона», «3 room». Число комнат — отдельное
 * число: «13 комнат» признака «3 комнаты» не даёт. (Раньше выражение собиралось в обычной
 * строке шаблона, где `\s` превращается в `s`, и признак «комнаты» не срабатывал вообще.)
 */
export function textHasRooms(text: string, rooms: number): boolean {
  return new RegExp(`(?<!\\d)${rooms}[\\s-]*(х\\s*)?(комнат|хона|room)`).test(text);
}

export function matchByCaption(
  caption: string,
  properties: {
    id: string;
    shortId: number;
    // Закрытый объект (offSite) может остаться без адреса вовсе — рекламу на
    // него не крутят, но выборка выше его не исключает; такой объект просто
    // не наберёт совпадений по адресу ниже (см. фильтр по !p.address).
    address: string | null;
    price: unknown;
    rooms: number | null;
    districtName: string | null;
  }[]
): string | null {
  const text = caption.toLowerCase();

  const scored = properties
    .filter((p) => p.address)
    .map((p) => {
      let hits = 0;
      const address = p.address!.toLowerCase();
      // Улица — самое длинное слово адреса: «рудаки», «сомони», «фирдавси».
      const street = address
        .split(/[,\s]+/)
        .filter((w) => w.length > 4)
        .sort((a, b) => b.length - a.length)[0];
      if (street && text.includes(street)) hits++;
      if (p.districtName && text.includes(p.districtName.toLowerCase())) hits++;
      const price = Math.round(Number(p.price));
      // Цену ищем как отдельное число — слитно и с разделителями тысяч (textHasPrice).
      if (price > 1000 && textHasPrice(text, price)) hits++;
      if (p.rooms && textHasRooms(text, p.rooms)) hits++;
      return { id: p.id, hits };
    })
    .filter((x) => x.hits >= 2)
    .sort((a, b) => b.hits - a.hits);

  if (scored.length === 0) return null;
  // Ничья между двумя объектами — доказательства нет, молчим.
  if (scored.length > 1 && scored[1].hits === scored[0].hits) return null;
  return scored[0].id;
}
