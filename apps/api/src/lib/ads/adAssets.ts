/**
 * МАТЕРИАЛЫ ОБЪЯВЛЕНИЯ — из чего на самом деле собрано объявление Meta.
 *
 * Поводом стало «гибкое» объявление «Умед хонахо» (03.10.2026): внутри одного
 * объявления лежат четыре ролика про четыре разные квартиры, а CRM видела у него
 * один пост и весь расход записывала на первый объект. Чтобы привязать каждый ролик
 * к своему объекту, креатив нужно разобрать на материалы.
 *
 * Поля креатива сверены с документацией Marketing API (AdCreative, asset_feed_spec,
 * object_story_spec.link_data.child_attachments). ВСЁ ЗДЕСЬ НЕОБЯЗАТЕЛЬНО: ни одно
 * поле не имеет права ломать разбор — Meta отдаёт разные формы в зависимости от
 * того, как объявление запускали.
 *
 * Модуль чистый (без сети и базы): сходить за подписями роликов — отдельная
 * функция в metaAdsApi.ts, чтобы разбор можно было проверять без моков Graph.
 */

export type AdAssetKind = "video" | "image" | "post" | "carousel_card";

/** Один материал объявления — то, что лежит в Ad.creativeAssets. */
export interface AdCreativeAsset {
  kind: AdAssetKind;
  /** video_id / хеш картинки / адрес карточки / код публикации — что нашлось. */
  id: string;
  permalink?: string;
  thumbnailUrl?: string;
  /** Подпись материала: описание ролика, текст карточки, текст публикации. */
  text?: string;
  /** Объект, к которому материал привязан доказанно (заполняет матчер). */
  propertyId?: string;
  /**
   * Ролик внутри карточки карусели. Хранится ВНУТРИ карточки, а не отдельным материалом:
   * карточка с роликом — один материал, а не два (иначе assetCount вдвое больше числа
   * карточек и объявление вечно «неполное»). Подпись ролика подмешивается в text карточки
   * (applyVideoDetails), чтобы матчер узнал объект и по описанию ролика.
   */
  videoId?: string;
}

/** Креатив объявления в той форме, в какой его отдаёт Graph (все поля необязательны). */
export interface GraphCreative {
  instagram_permalink_url?: string;
  effective_instagram_media_id?: string;
  source_instagram_media_id?: string;
  effective_object_story_id?: string;
  thumbnail_url?: string;
  image_url?: string;
  video_id?: string;
  body?: string;
  asset_feed_spec?: {
    videos?: { video_id?: string; thumbnail_url?: string }[];
    images?: { hash?: string; url?: string }[];
    bodies?: { text?: string }[];
    titles?: { text?: string }[];
    link_urls?: { website_url?: string }[];
  };
  object_story_spec?: {
    link_data?: {
      message?: string;
      name?: string;
      description?: string;
      child_attachments?: {
        link?: string;
        name?: string;
        description?: string;
        picture?: string;
        video_id?: string;
      }[];
    };
    video_data?: { message?: string; title?: string; video_id?: string };
    photo_data?: { caption?: string };
  };
}

/** Предел материалов на объявление: защита от аномального ответа Meta. */
const MAX_ASSETS = 30;

function clean(value: string | null | undefined): string | undefined {
  const text = value?.trim();
  return text ? text : undefined;
}

/**
 * Разбирает креатив на материалы. Порядок: ролики и картинки гибкого формата,
 * карточки карусели, одиночный ролик. Если ничего из этого нет, а у объявления
 * есть публикация, — единственный материал «post».
 *
 * «post» НЕ добавляется рядом с роликами и карточками: это та же самая публикация,
 * и счёт материалов раздулся бы (один ролик + «его же пост» = два материала, один
 * из которых вечно «не привязан»). Публикация при этом не теряется — матчер читает
 * её на уровне объявления.
 */
export function parseCreativeAssets(creative: GraphCreative | null | undefined): AdCreativeAsset[] {
  if (!creative) return [];
  const out: AdCreativeAsset[] = [];
  const seen = new Set<string>();
  const push = (asset: AdCreativeAsset) => {
    const key = `${asset.kind}:${asset.id}`;
    if (!asset.id || seen.has(key) || out.length >= MAX_ASSETS) return;
    seen.add(key);
    out.push(asset);
  };

  const feed = creative.asset_feed_spec;
  for (const v of feed?.videos ?? []) {
    const id = clean(v?.video_id);
    if (id) push({ kind: "video", id, thumbnailUrl: clean(v.thumbnail_url) });
  }
  for (const img of feed?.images ?? []) {
    const id = clean(img?.hash) ?? clean(img?.url);
    if (id) push({ kind: "image", id, thumbnailUrl: clean(img.url) });
  }

  for (const card of creative.object_story_spec?.link_data?.child_attachments ?? []) {
    const videoId = clean(card?.video_id);
    const id = clean(card?.link) ?? videoId ?? clean(card?.picture);
    if (!id) continue;
    const text = [clean(card.name), clean(card.description)].filter(Boolean).join("\n") || undefined;
    push({
      kind: "carousel_card",
      id,
      permalink: clean(card.link),
      thumbnailUrl: clean(card.picture),
      text,
      // video_id остаётся в карточке: подпись ролика доспросят у Graph по нему, но
      // отдельным материалом ролик не считается (см. поле videoId).
      ...(videoId ? { videoId } : {}),
    });
  }

  const singleVideo = clean(creative.video_id) ?? clean(creative.object_story_spec?.video_data?.video_id);
  if (singleVideo) push({ kind: "video", id: singleVideo, thumbnailUrl: clean(creative.thumbnail_url) });

  if (out.length === 0) {
    const permalink = clean(creative.instagram_permalink_url);
    const mediaId = clean(creative.effective_instagram_media_id) ?? clean(creative.source_instagram_media_id);
    const storyId = clean(creative.effective_object_story_id);
    const id = permalink ?? mediaId ?? storyId;
    if (id) {
      push({
        kind: "post",
        id,
        permalink,
        thumbnailUrl: clean(creative.thumbnail_url) ?? clean(creative.image_url),
        text: creativeBodyText(creative),
      });
    }
  }
  return out;
}

/** Первый непустой текст креатива — тот же перебор полей, что и раньше для caption. */
export function creativeBodyText(creative: GraphCreative | null | undefined): string | undefined {
  const spec = creative?.object_story_spec;
  const candidates = [
    creative?.body,
    creative?.asset_feed_spec?.bodies?.[0]?.text,
    spec?.link_data?.message,
    spec?.video_data?.message,
    spec?.photo_data?.caption,
    spec?.link_data?.name,
    spec?.video_data?.title,
    creative?.asset_feed_spec?.titles?.[0]?.text,
  ];
  for (const value of candidates) {
    const text = clean(value);
    if (text) return text;
  }
  return undefined;
}

/** Подпись ролика, добытая у Graph: описание, а если его нет — название. */
export interface VideoDetails {
  text?: string;
  permalink?: string;
}

/** Вписывает подписи роликов в материалы; материалы без подписи остаются как есть. */
export function applyVideoDetails(
  assets: AdCreativeAsset[],
  details: ReadonlyMap<string, VideoDetails>
): AdCreativeAsset[] {
  return assets.map((a) => {
    if (a.kind === "carousel_card" && a.videoId) {
      const d = details.get(a.videoId);
      if (!d) return a;
      // Текст карточки + описание её ролика: матчеру нужны оба признака объекта.
      const text = [a.text, d.text].filter(Boolean).join("\n") || undefined;
      return { ...a, text, permalink: a.permalink ?? d.permalink };
    }
    if (a.kind !== "video") return a;
    const d = details.get(a.id);
    if (!d) return a;
    return { ...a, text: a.text ?? d.text, permalink: a.permalink ?? d.permalink };
  });
}
