import { isInstagramLink } from "@royal-home/shared";

/**
 * Сети, где ролик объекта вышел, — с учётом СТАРЫХ объектов (05.10.2026, ОБ-000088).
 *
 * `publishedChannels` заполняет только конвейер автопубликации. Объекты, выложенные
 * вручную до него, хранят одну ссылку на пост Instagram в `instagramUrl`, а список
 * сетей у них пуст. Карточка читала только список, считала такой объект «нигде не
 * опубликованным и без ролика» и сворачивала весь блок «Ролик и соцсети» до одних
 * историй: ни «Где вышел ролик», ни загрузки готового ролика, ни обновления подписей.
 * Ссылка на пост в Instagram — тот же факт, что галочка Instagram; берём оба источника.
 */
export function effectivePublishedChannels(property: {
  publishedChannels?: string[] | null;
  instagramUrl?: string | null;
}): string[] {
  const channels = property.publishedChannels ?? [];
  if (channels.includes("INSTAGRAM")) return channels;
  return property.instagramUrl && isInstagramLink(property.instagramUrl) ? [...channels, "INSTAGRAM"] : channels;
}
